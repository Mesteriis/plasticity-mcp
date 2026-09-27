import { basename } from "node:path";

import type { PrinterProfile, PrinterStatus, PrinterSubmissionObservation } from "../../shared/contracts.ts";
import { printerProfileSchema } from "../../shared/schemas.ts";

export interface PrinterSubmissionResult {
  remoteFilename: string;
}

export interface PrinterAdapter {
  readonly connectionKind: NonNullable<PrinterProfile["connection"]>["kind"];
  status(profile: PrinterProfile): Promise<PrinterStatus>;
  uploadAndStart(profile: PrinterProfile, gcode: Uint8Array, requestedName: string): Promise<PrinterSubmissionResult>;
  reconcileSubmission(profile: PrinterProfile, expectedRemoteFilename: string): Promise<PrinterSubmissionObservation>;
}

export class MoonrakerPrinter implements PrinterAdapter {
  readonly connectionKind = "moonraker" as const;
  private readonly fetcher: typeof fetch;

  constructor(fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher;
  }

  async status(rawProfile: PrinterProfile): Promise<PrinterStatus> {
    const profile = printerProfileSchema.parse(rawProfile);
    const origin = originFor(profile);
    const [printerInfo, printStatsPayload, deviceInfo] = await Promise.all([
      this.json(`${origin}/printer/info`),
      this.json(`${origin}/printer/objects/query?print_stats`),
      this.json(`http://${profile.connection!.host}/info`).catch(() => undefined),
    ]);
    const result = recordValue(printerInfo, "result");
    const printStats = nestedRecord(printStatsPayload, ["result", "status", "print_stats"]);
    const device = isRecord(deviceInfo) ? deviceInfo : {};
    const model = typeof device.model === "string" ? device.model : profile.model;
    if (!model.toLowerCase().includes(profile.model.toLowerCase().replace("creality ", ""))) {
      throw new Error(`Printer identity mismatch: expected ${profile.model}, received ${model}`);
    }
    return {
      identity: {
        vendor: profile.vendor,
        model,
        ...(typeof result.hostname === "string" ? { hostname: result.hostname } : {}),
        host: profile.connection!.host!,
      },
      connected: true,
      state: typeof printStats?.state === "string" ? printStats.state : typeof result.state === "string" ? result.state : "unknown",
      ...(typeof printStats?.message === "string" && printStats.message
        ? { stateMessage: printStats.message }
        : typeof result.state_message === "string" ? { stateMessage: result.state_message } : {}),
      observedAt: new Date().toISOString(),
    };
  }

  async uploadAndStart(rawProfile: PrinterProfile, gcode: Uint8Array, requestedName: string): Promise<PrinterSubmissionResult> {
    const profile = printerProfileSchema.parse(rawProfile);
    const status = await this.status(profile);
    if (!status.connected || !isIdlePrintState(status.state)) throw new Error(`Printer is not idle: ${status.state}`);
    const origin = originFor(profile);
    const remoteFilename = safeGcodeName(requestedName);
    const form = new FormData();
    const bytes = new Uint8Array(gcode.byteLength);
    bytes.set(gcode);
    form.append("file", new Blob([bytes.buffer], { type: "application/octet-stream" }), remoteFilename);
    const crealityUpload = isCrealityK1(profile);
    const uploadUrl = crealityUpload
      ? `http://${profile.connection!.host}/upload/${encodeURIComponent(remoteFilename)}`
      : `${origin}/server/files/upload`;
    const upload = await this.fetcher(uploadUrl, { method: "POST", body: form });
    if (!upload.ok) throw new Error(`Printer upload failed with HTTP ${upload.status}: ${await responseDetail(upload)}`);
    let acceptedName = remoteFilename;
    if (!crealityUpload) {
      const payload = await upload.json() as unknown;
      const item = isRecord(payload) && isRecord(payload.item) ? payload.item : undefined;
      acceptedName = item && typeof item.path === "string" ? item.path : remoteFilename;
    }
    const start = await this.fetcher(`${origin}/printer/print/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: acceptedName }),
    });
    if (!start.ok) throw new Error(`Printer start failed with HTTP ${start.status}: ${await responseDetail(start)}`);
    return { remoteFilename: acceptedName };
  }

  async reconcileSubmission(rawProfile: PrinterProfile, requestedName: string): Promise<PrinterSubmissionObservation> {
    const profile = printerProfileSchema.parse(rawProfile);
    const origin = originFor(profile);
    const expectedRemoteFilename = safeGcodeName(requestedName);
    const observedAt = new Date().toISOString();
    try {
      const [printStatsPayload, filesPayload] = await Promise.all([
        this.json(`${origin}/printer/objects/query?print_stats`),
        this.json(`${origin}/server/files/list?root=gcodes`),
      ]);
      const printStats = nestedRecord(printStatsPayload, ["result", "status", "print_stats"]);
      const observedActiveFilename = typeof printStats?.filename === "string" && printStats.filename
        ? normalizeRemotePath(printStats.filename)
        : undefined;
      const printerState = typeof printStats?.state === "string" ? printStats.state : undefined;
      const files = fileRecords(filesPayload);
      const stored = files.some((file) => typeof file.path === "string" && normalizeRemotePath(file.path) === expectedRemoteFilename);

      if (observedActiveFilename === expectedRemoteFilename) {
        return {
          outcome: "submitted",
          expectedRemoteFilename,
          observedActiveFilename,
          ...(printerState ? { printerState } : {}),
          message: "The printer reports the exact G-code as its current or most recent print job.",
          observedAt,
        };
      }
      if (stored) {
        return {
          outcome: "stored",
          expectedRemoteFilename,
          ...(observedActiveFilename ? { observedActiveFilename } : {}),
          ...(printerState ? { printerState } : {}),
          message: "The exact G-code exists on the printer, but the printer does not report it as the current job.",
          observedAt,
        };
      }
      if (!printStats || typeof printStats.filename !== "string" || !printerState) {
        return {
          outcome: "unknown",
          expectedRemoteFilename,
          message: "Printer status did not contain a complete print_stats object.",
          observedAt,
        };
      }
      if (observedActiveFilename && isActivePrintState(printerState)) {
        return {
          outcome: "unknown",
          expectedRemoteFilename,
          observedActiveFilename,
          printerState,
          message: "Another G-code is active; absence of the expected file is not sufficient to permit a retry.",
          observedAt,
        };
      }
      return {
        outcome: "absent",
        expectedRemoteFilename,
        ...(observedActiveFilename ? { observedActiveFilename } : {}),
        ...(printerState ? { printerState } : {}),
        message: "The exact G-code is absent from printer storage and is not the current job.",
        observedAt,
      };
    } catch (error) {
      return {
        outcome: "unknown",
        expectedRemoteFilename,
        message: error instanceof Error ? error.message : String(error),
        observedAt,
      };
    }
  }

  private async json(url: string): Promise<unknown> {
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`Printer returned HTTP ${response.status} for ${new URL(url).pathname}`);
    return await response.json();
  }
}

async function responseDetail(response: Response): Promise<string> {
  const detail = (await response.text()).trim().replace(/\s+/g, " ");
  return detail ? detail.slice(0, 1_000) : "empty response";
}

function originFor(profile: PrinterProfile): string {
  const connection = profile.connection;
  if (connection?.kind !== "moonraker" || !connection.host) throw new Error("A Moonraker host is required");
  return `http://${connection.host}:${connection.port ?? 7125}`;
}

function isCrealityK1(profile: PrinterProfile): boolean {
  return profile.vendor.toLowerCase() === "creality" && /^(?:creality\s+)?k1(?:c|\s*max)?$/i.test(profile.model.trim());
}

function safeGcodeName(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!base.toLowerCase().endsWith(".gcode")) throw new Error("Printer filename must end with .gcode");
  return base.slice(0, 180);
}

function normalizeRemotePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/, "");
}

function isActivePrintState(state: string): boolean {
  return !["standby", "complete", "cancelled", "error"].includes(state.toLowerCase());
}

function isIdlePrintState(state: string): boolean {
  return ["standby", "complete", "cancelled"].includes(state.toLowerCase());
}

function nestedRecord(value: unknown, keys: string[]): Record<string, unknown> | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

function fileRecords(value: unknown): Array<Record<string, unknown>> {
  const direct = Array.isArray(value) ? value : undefined;
  const result = isRecord(value) ? value.result : undefined;
  const wrapped = Array.isArray(result) ? result : isRecord(result) && Array.isArray(result.files) ? result.files : undefined;
  const files = direct ?? wrapped;
  if (!files) throw new Error("Printer file-list response is not recognized");
  return files.filter(isRecord);
}

function recordValue(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value[key])) throw new Error(`Printer response does not contain ${key}`);
  return value[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
