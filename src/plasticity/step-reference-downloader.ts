import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { constants, createWriteStream } from "node:fs";
import { link, mkdir, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { request as httpsRequest } from "node:https";
import { z } from "zod";

import { extractSingleCadArchiveMember, isZipArchiveHeader, MAX_CAD_ARCHIVE_BYTES } from "./cad-archive.ts";
import { validateObj } from "./obj.ts";
import { validateStl } from "./stl.ts";
import { validateReferenceThreeMfArchive } from "./three-mf.ts";

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
export const MAX_REFERENCE_MESH_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_REFERENCE_PAGE_HTML_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const STEP_HEADER = Buffer.from("ISO-10303-21;");
const STEP_TRAILER = Buffer.from("END-ISO-10303-21;");

export interface StepReferenceDownload {
  path: string;
  bytes: number;
  sha256: string;
  sourceUrl: string;
  finalUrl: string;
  format: "step" | "parasolid-text" | "parasolid-binary" | "reference-mesh-stl" | "reference-mesh-obj" | "reference-mesh-3mf";
  sourceArchive?: { sha256: string; bytes: number; memberPath: string };
}

export interface StepReferenceDownloaderLike {
  download(sourceUrl: string): Promise<StepReferenceDownload>;
  downloadParasolid(sourceUrl: string, representation: ParasolidRepresentation): Promise<StepReferenceDownload>;
  downloadReferenceMesh?(sourceUrl: string, representation: "stl" | "obj"): Promise<StepReferenceDownload>;
  downloadReferenceThreeMf?(sourceUrl: string): Promise<StepReferenceDownload>;
  listReferenceAssets?(sourcePageUrl: string, allowedDomains: string[]): Promise<ReferencePageAssetListing>;
}

export interface ReferencePageAssetListing {
  assets: Array<{ url: string; label: string; format: string; kind: "editable-cad" | "reference-mesh" | "dimensioned-document" }>;
  omittedQueryAssetCount: number;
  truncated: boolean;
}

export type ParasolidRepresentation = "x_t" | "x_b" | "xmt_txt" | "xmt_bin";

interface StepResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  close?(): void;
}

type LookupResult = Array<{ address: string; family: number }>;
type AddressLookup = (hostname: string) => Promise<LookupResult>;
type RequestStep = (url: URL, address: string, signal: AbortSignal) => Promise<StepResponse>;

interface StepReferenceDownloaderOptions {
  root?: string;
  maxBytes?: number;
  lookup?: AddressLookup;
  request?: RequestStep;
}

const urlSchema = z.string().url().max(4_096).superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:") context.addIssue({ code: "custom", message: "CAD reference URL must use HTTPS" });
  if (url.username || url.password) context.addIssue({ code: "custom", message: "CAD reference URL must not contain credentials" });
  if (url.hash) context.addIssue({ code: "custom", message: "CAD reference URL must not contain a fragment" });
  if (url.port && url.port !== "443") context.addIssue({ code: "custom", message: "CAD reference requests are limited to HTTPS port 443" });
  if (isIP(url.hostname) !== 0) context.addIssue({ code: "custom", message: "CAD reference URL must use a public DNS hostname" });
  if (!url.hostname.includes(".") || /(^|\.)(localhost|local|internal|test|invalid)$/i.test(url.hostname)) {
    context.addIssue({ code: "custom", message: "CAD reference URL must use a public DNS hostname" });
  }
});

export class StepReferenceDownloader {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly lookup: AddressLookup;
  private readonly request: RequestStep;

  constructor(options: StepReferenceDownloaderOptions = {}) {
    this.root = options.root ?? join(process.cwd(), ".plasticity-mcp", "reference-artifacts");
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.lookup = options.lookup ?? lookupPublicIpv4;
    this.request = options.request ?? requestPinnedHttps;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > DEFAULT_MAX_BYTES) {
      throw new Error(`STEP download limit must be between 1 and ${DEFAULT_MAX_BYTES} bytes`);
    }
  }

  async download(sourceUrl: string): Promise<StepReferenceDownload> {
    return await this.downloadWithFormat(sourceUrl, "step");
  }

  async downloadParasolid(sourceUrl: string, representation: ParasolidRepresentation): Promise<StepReferenceDownload> {
    return await this.downloadWithFormat(sourceUrl, representation === "x_t" || representation === "xmt_txt" ? "parasolid-text" : "parasolid-binary");
  }

  async downloadReferenceMesh(sourceUrl: string, representation: "stl" | "obj"): Promise<StepReferenceDownload> {
    return await this.downloadWithFormat(sourceUrl, representation === "stl" ? "reference-mesh-stl" : "reference-mesh-obj", Math.min(this.maxBytes, MAX_REFERENCE_MESH_DOWNLOAD_BYTES));
  }

  async downloadReferenceThreeMf(sourceUrl: string): Promise<StepReferenceDownload> {
    return await this.downloadWithFormat(sourceUrl, "reference-mesh-3mf", Math.min(this.maxBytes, MAX_REFERENCE_MESH_DOWNLOAD_BYTES));
  }

  async listReferenceAssets(sourcePageUrl: string, allowedDomains: string[]): Promise<ReferencePageAssetListing> {
    const domains = normalizeAssetDomains(allowedDomains);
    if (domains.length === 0) throw new Error("At least one selected source domain is required");
    let currentUrl = new URL(urlSchema.parse(sourcePageUrl));
    if (!isAllowedHostname(currentUrl.hostname, domains)) throw new Error("Reference page host is outside the selected domains");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("CAD reference page request timed out")), 20_000);
    let response: StepResponse | undefined;
    let hops = 0;
    try {
      while (true) {
        if (!isAllowedHostname(currentUrl.hostname, domains)) throw new Error("Reference page redirected to a host outside the selected domains");
        let addresses: LookupResult;
        try { addresses = await awaitWithAbort(this.lookup(currentUrl.hostname), controller.signal); }
        catch {
          if (controller.signal.aborted) throw new Error("Reference page request timed out");
          throw new Error("Reference page hostname could not be resolved");
        }
        if (addresses.length === 0 || addresses.some(({ family, address }) => family !== 4 || !isPublicIpv4(address))) {
          throw new Error("Reference page hostname did not resolve exclusively to public IPv4 addresses");
        }
        try { response = await this.request(currentUrl, addresses[0]!.address, controller.signal); }
        catch { throw new Error("Reference page request failed or timed out"); }
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const location = header(response.headers, "location");
          response.close?.();
          response = undefined;
          if (!location || hops >= MAX_REDIRECTS) throw new Error("Reference page returned an invalid or excessive redirect chain");
          const nextUrl = new URL(location, currentUrl);
          if (nextUrl.protocol !== "https:" || nextUrl.username || nextUrl.password || (nextUrl.port && nextUrl.port !== "443") || nextUrl.hash) {
            throw new Error("Reference page redirected outside the permitted HTTPS route");
          }
          if (!isAllowedHostname(nextUrl.hostname, domains)) throw new Error("Reference page redirected to a host outside the selected domains");
          currentUrl = nextUrl;
          hops += 1;
          continue;
        }
        if (response.statusCode !== 200) throw new Error(`Reference page returned HTTP ${response.statusCode}`);
        const contentType = header(response.headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (contentType !== "text/html" && contentType !== "application/xhtml+xml") throw new Error("Selected source must return an HTML page");
        const encoding = header(response.headers, "content-encoding");
        if (encoding && encoding.toLowerCase() !== "identity") throw new Error("Compressed reference pages are not accepted");
        const contentLength = header(response.headers, "content-length");
        if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_REFERENCE_PAGE_HTML_BYTES)) {
          throw new Error("Reference page exceeds the 2 MiB size limit");
        }
        const html = await readBoundedBody(response.body, MAX_REFERENCE_PAGE_HTML_BYTES, controller.signal);
        return parseReferencePageAssets(html.toString("utf8"), currentUrl, domains);
      }
    } finally {
      clearTimeout(timer);
      response?.close?.();
    }
  }

  private async downloadWithFormat(
    sourceUrl: string,
    format: StepReferenceDownload["format"],
    maxBytes = this.maxBytes,
  ): Promise<StepReferenceDownload> {
    const parsedUrl = urlSchema.parse(sourceUrl);
    const originalUrl = parsedUrl;
    let currentUrl = new URL(parsedUrl);
    let response: StepResponse | undefined;
    let hops = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("CAD reference download timed out")), 120_000);
    try {
      while (true) {
        let addresses: LookupResult;
        try {
          addresses = await this.lookup(currentUrl.hostname);
        } catch {
          throw new Error("CAD reference hostname could not be resolved");
        }
        if (addresses.length === 0 || addresses.some(({ family, address }) => family !== 4 || !isPublicIpv4(address))) {
          throw new Error("CAD reference hostname did not resolve exclusively to public IPv4 addresses");
        }
        try {
          response = await this.request(currentUrl, addresses[0]!.address, controller.signal);
        } catch {
          throw new Error("CAD reference request failed or timed out");
        }
        const status = response.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = header(response.headers, "location");
          response.close?.();
          response = undefined;
          if (!location || hops >= MAX_REDIRECTS) throw new Error("CAD reference source returned an invalid or excessive redirect chain");
          const next = new URL(location, currentUrl);
          if (next.protocol !== "https:" || next.username || next.password || (next.port && next.port !== "443")) {
            throw new Error("CAD reference source redirected outside the permitted HTTPS route");
          }
          currentUrl = new URL(urlSchema.parse(next.href));
          hops += 1;
          continue;
        }
        if (status !== 200) throw new Error(`CAD reference source returned HTTP ${status}`);
        const encoding = header(response.headers, "content-encoding");
        if (encoding && encoding.toLowerCase() !== "identity") throw new Error("Compressed CAD reference responses are not accepted");
        const contentLength = header(response.headers, "content-length");
        if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
          throw new Error("CAD reference source exceeds the download size limit");
        }
        return await this.persistResponse(response, originalUrl, currentUrl.href, controller.signal, format, maxBytes);
      }
    } finally {
      clearTimeout(timer);
      response?.close?.();
    }
  }

  private async persistResponse(
    response: StepResponse,
    sourceUrl: string,
    finalUrl: string,
    signal: AbortSignal,
    format: StepReferenceDownload["format"],
    maxBytes: number,
  ): Promise<StepReferenceDownload> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.root);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) throw new Error("Reference artifact store is not a directory");
    const temporary = join(root, `.download-${randomUUID()}.partial`);
    let extractedTemporary: string | undefined;
    const hash = createHash("sha256");
    let bytes = 0;
    const first = Buffer.alloc(512);
    let firstLength = 0;
    const tail: Buffer[] = [];
    let tailLength = 0;
    const measure = new Transform({
      transform: (chunk: Buffer | Uint8Array, _encoding, callback) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.length;
        if (bytes > maxBytes) return callback(new Error("CAD reference source exceeds the download size limit"));
        hash.update(data);
        if (firstLength < first.length) {
          const count = Math.min(first.length - firstLength, data.length);
          data.copy(first, firstLength, 0, count);
          firstLength += count;
        }
        if (isZipArchiveHeader(first.subarray(0, firstLength)) && bytes > MAX_CAD_ARCHIVE_BYTES) {
          return callback(new Error(`CAD ZIP archive exceeds the ${MAX_CAD_ARCHIVE_BYTES}-byte size limit`));
        }
        tail.push(Buffer.from(data));
        tailLength += data.length;
        while (tailLength > STEP_TRAILER.length + 64) {
          const excess = tailLength - (STEP_TRAILER.length + 64);
          const head = tail[0]!;
          if (head.length <= excess) {
            tail.shift();
            tailLength -= head.length;
          } else {
            tail[0] = head.subarray(excess);
            tailLength -= excess;
          }
        }
        callback(null, data);
      },
    });
    const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    try {
      await pipeline(Readable.from(response.body), measure, output, { signal });
      const handle = await open(temporary, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        await handle.sync();
        const temporaryStat = await handle.stat();
        if (!temporaryStat.isFile() || temporaryStat.size !== bytes) throw new Error("Downloaded CAD reference failed its temporary-file check");
      } finally {
        await handle.close();
      }
      const prefix = first.subarray(0, firstLength);
      const rawSha256 = hash.digest("hex");
      if (format === "reference-mesh-3mf") {
        if (!isZipArchiveHeader(prefix)) throw new Error("Downloaded 3MF reference is not a ZIP package");
        const payload = await readBoundedNoFollow(temporary, maxBytes);
        validateReferenceThreeMfArchive(payload);
        const target = await storeContentAddressed(temporary, root, rawSha256, bytes, "3mf");
        return { path: target, bytes, sha256: rawSha256, sourceUrl, finalUrl, format };
      }
      if (isZipArchiveHeader(prefix)) {
        if (format === "reference-mesh-stl" || format === "reference-mesh-obj") {
          throw new Error("Reference mesh downloads must be direct STL or OBJ files; ZIP archives are not accepted");
        }
        if (bytes > MAX_CAD_ARCHIVE_BYTES) throw new Error(`CAD ZIP archive exceeds the ${MAX_CAD_ARCHIVE_BYTES}-byte size limit`);
        const archive = await readNoFollow(temporary);
        const member = extractSingleCadArchiveMember(archive, format);
        await storeContentAddressed(temporary, root, rawSha256, bytes, "zip");
        extractedTemporary = join(root, `.extract-${randomUUID()}.partial`);
        await writeFile(extractedTemporary, member.contents, { flag: "wx", mode: 0o600 });
        const extractedHandle = await open(extractedTemporary, constants.O_RDWR | constants.O_NOFOLLOW);
        try {
          await extractedHandle.sync();
        } finally {
          await extractedHandle.close();
        }
        const importedHash = createHash("sha256").update(member.contents).digest("hex");
        const extractedPath = await storeContentAddressed(extractedTemporary, root, importedHash, member.contents.length, member.extension);
        return {
          path: extractedPath,
          bytes: member.contents.length,
          sha256: importedHash,
          sourceUrl,
          finalUrl,
          format,
          sourceArchive: { sha256: rawSha256, bytes, memberPath: member.memberPath },
        };
      }
      const extension = format === "step" ? "step"
        : format === "parasolid-text" ? "x_t"
          : format === "parasolid-binary" ? "x_b"
            : format === "reference-mesh-stl" ? "stl" : "obj";
      if (format === "reference-mesh-stl" || format === "reference-mesh-obj") {
        const payload = await readBoundedNoFollow(temporary, maxBytes);
        if (format === "reference-mesh-stl") validateStl(payload);
        else validateObj(payload);
      } else {
        validateDownloadedPayload(prefix, bytes, tail, tailLength, format);
      }
      const target = await storeContentAddressed(temporary, root, rawSha256, bytes, extension);
      return { path: target, bytes, sha256: rawSha256, sourceUrl, finalUrl, format };
    } catch (error) {
      output.destroy();
      throw error;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (extractedTemporary) await rm(extractedTemporary, { force: true }).catch(() => undefined);
    }
  }
}

function validateDownloadedPayload(
  prefix: Buffer,
  bytes: number,
  tail: Buffer[],
  tailLength: number,
  format: "step" | "parasolid-text" | "parasolid-binary",
): void {
  if (format === "step") {
    if (bytes === 0 || prefix.length < STEP_HEADER.length || !prefix.subarray(0, STEP_HEADER.length).equals(STEP_HEADER)) {
      throw new Error("Downloaded file is not a valid ISO-10303-21 STEP document");
    }
    if (!Buffer.concat(tail, tailLength).includes(STEP_TRAILER)) throw new Error("Downloaded STEP document is incomplete");
    return;
  }
  const header = prefix.subarray(0, 512).toString("latin1");
  if (bytes < 96 || !header.startsWith("**") || !header.includes("PARASOLID")) {
    throw new Error("Downloaded file is not a valid Parasolid exchange document");
  }
}

async function storeContentAddressed(sourcePath: string, root: string, sha256: string, bytes: number, extension: string): Promise<string> {
  const target = join(root, `${sha256}.${extension}`);
  try {
    await link(sourcePath, target);
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
    const existing = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const existingStat = await existing.stat();
      if (!existingStat.isFile() || existingStat.size !== bytes) throw new Error("Existing content-addressed reference artifact is invalid");
      const existingHash = createHash("sha256").update(await existing.readFile()).digest("hex");
      if (existingHash !== sha256) throw new Error("Existing content-addressed reference artifact has unexpected content");
    } finally {
      await existing.close();
    }
  }
  const finalStat = await stat(target);
  if (!finalStat.isFile() || finalStat.size !== bytes) throw new Error("Stored reference artifact failed verification");
  return target;
}

async function readNoFollow(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_CAD_ARCHIVE_BYTES) throw new Error("CAD ZIP archive failed its bounded regular-file check");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readBoundedNoFollow(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maxBytes) throw new Error("Downloaded reference mesh failed its bounded regular-file check");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function lookupPublicIpv4(hostname: string): Promise<LookupResult> {
  const records = await dnsLookup(hostname, { all: true, family: 4, verbatim: true });
  return records;
}

async function requestPinnedHttps(url: URL, address: string, signal: AbortSignal): Promise<StepResponse> {
  return await new Promise<StepResponse>((resolveRequest, rejectRequest) => {
    const request = httpsRequest(url, {
      method: "GET",
      agent: false,
      signal,
      headers: { accept: "application/step, application/octet-stream;q=0.9, */*;q=0.1", "accept-encoding": "identity" },
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      },
    }, (response) => {
      resolveRequest({
        statusCode: response.statusCode ?? 0,
        headers: response.headers as Record<string, string | string[] | undefined>,
        body: response,
        close: () => response.destroy(),
      });
    });
    request.once("error", rejectRequest);
    request.end();
  });
}

function isPublicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  if (a === undefined || b === undefined || c === undefined) return false;
  return !(
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a! >= 224
  );
}

function normalizeAssetDomains(domains: string[]): string[] {
  if (!Array.isArray(domains) || domains.length > 20) throw new Error("At most 20 selected reference domains are supported");
  const normalized = new Set<string>();
  for (const entry of domains) {
    const domain = entry.trim().toLowerCase().replace(/\.$/, "");
    const labels = domain.split(".");
    if (!domain || domain.length > 253 || isIP(domain) !== 0 || labels.length < 2
      || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error(`Invalid selected reference domain: ${entry}`);
    }
    normalized.add(domain);
  }
  return [...normalized];
}

function isAllowedHostname(hostname: string, domains: string[]): boolean {
  const normalizedHost = hostname.toLowerCase().replace(/\.$/, "");
  return domains.some((domain) => normalizedHost === domain || normalizedHost.endsWith(`.${domain}`));
}

async function readBoundedBody(body: AsyncIterable<Uint8Array>, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of body) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Reference page request aborted");
    const data = Buffer.from(chunk);
    bytes += data.length;
    if (bytes > maxBytes) throw new Error("Reference page exceeds the 2 MiB size limit");
    chunks.push(data);
  }
  return Buffer.concat(chunks, bytes);
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Reference page request aborted");
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = (): void => rejectPromise(signal.reason instanceof Error ? signal.reason : new Error("Reference page request aborted"));
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => { cleanup(); resolvePromise(value); },
      (error: unknown) => { cleanup(); rejectPromise(error); },
    );
  });
}

function parseReferencePageAssets(html: string, pageUrl: URL, allowedDomains: string[]): ReferencePageAssetListing {
  const assets: ReferencePageAssetListing["assets"] = [];
  const seen = new Set<string>();
  let omittedQueryAssetCount = 0;
  let total = 0;
  const anchors = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/giu;
  for (const match of html.matchAll(anchors)) {
    const attributes = parseHtmlAttributes(match[1] ?? "");
    const rawHref = attributes.get("href");
    if (!rawHref) continue;
    let assetUrl: URL;
    try { assetUrl = new URL(decodeHtmlEntities(rawHref).trim(), pageUrl); }
    catch { continue; }
    if (assetUrl.protocol !== "https:" || assetUrl.username || assetUrl.password || (assetUrl.port && assetUrl.port !== "443")) continue;
    if (!isAllowedHostname(assetUrl.hostname, allowedDomains)) continue;
    const assetType = classifyReferenceAsset(assetUrl.pathname);
    if (!assetType) continue;
    if (assetUrl.search) {
      omittedQueryAssetCount += 1;
      continue;
    }
    assetUrl.hash = "";
    const canonicalUrl = assetUrl.toString();
    if (seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    total += 1;
    if (assets.length >= 64) continue;
    const label = decodeHtmlEntities((match[2] ?? "").replace(/<[^>]*>/gu, " ")).replaceAll(/\s+/gu, " ").trim();
    const fileName = assetUrl.pathname.slice(assetUrl.pathname.lastIndexOf("/") + 1);
    assets.push({ url: canonicalUrl, label: (label || fileName).slice(0, 300), ...assetType });
  }
  return { assets, omittedQueryAssetCount, truncated: total > assets.length };
}

function parseHtmlAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu;
  for (const match of text.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (!name || attributes.has(name)) continue;
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|nbsp|#\d+|#x[\da-f]+);/giu, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&quot;": "\"", "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };
    const key = entity.toLowerCase();
    if (named[key] !== undefined) return named[key]!;
    const hex = /^&#x([\da-f]+);$/iu.exec(entity);
    const decimal = /^&#(\d+);$/u.exec(entity);
    const codePoint = hex ? Number.parseInt(hex[1]!, 16) : decimal ? Number.parseInt(decimal[1]!, 10) : NaN;
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return "";
    return String.fromCodePoint(codePoint);
  });
}

function classifyReferenceAsset(pathname: string): Pick<ReferencePageAssetListing["assets"][number], "format" | "kind"> | undefined {
  const name = pathname.toLowerCase();
  if (/\.(?:step|stp)$/u.test(name)) return { format: "step", kind: "editable-cad" };
  if (/(?:^|[_\-.])(?:step|stp)\.zip$/u.test(name)) return { format: "step-archive", kind: "editable-cad" };
  if (/\.x_t(?:\.zip)?$/u.test(name) || /\.xmt_txt(?:\.zip)?$/u.test(name)) return { format: "parasolid-text", kind: "editable-cad" };
  if (/\.x_b(?:\.zip)?$/u.test(name) || /\.xmt_bin(?:\.zip)?$/u.test(name)) return { format: "parasolid-binary", kind: "editable-cad" };
  if (/\.stl$/u.test(name)) return { format: "stl", kind: "reference-mesh" };
  if (/\.obj$/u.test(name)) return { format: "obj", kind: "reference-mesh" };
  if (/\.3mf$/u.test(name)) return { format: "3mf", kind: "reference-mesh" };
  if (/\.pdf$/u.test(name)) return { format: "pdf", kind: "dimensioned-document" };
  return undefined;
}

function header(headers: StepResponse["headers"], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
