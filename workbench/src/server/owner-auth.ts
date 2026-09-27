import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OWNER_TOKEN_FILE = "owner-token";

export async function loadOrCreateOwnerToken(projectsRoot: string): Promise<string> {
  await mkdir(projectsRoot, { recursive: true, mode: 0o700 });
  const path = join(projectsRoot, OWNER_TOKEN_FILE);
  const temporary = join(projectsRoot, `.owner-token-${randomUUID()}`);
  try {
    await writeFile(temporary, `${randomBytes(32).toString("base64url")}\n`, { flag: "wx", mode: 0o600 });
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return readOwnerToken(projectsRoot);
}

export async function readOwnerToken(projectsRoot: string): Promise<string> {
  const path = join(projectsRoot, OWNER_TOKEN_FILE);
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Workbench owner token must be a private regular file");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const token = (await handle.readFile("utf8")).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Workbench owner token is invalid");
    return token;
  } finally { await handle.close(); }
}

export function ownerTokenMatches(expected: string, presented: string | undefined): boolean {
  if (!presented || presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
}
