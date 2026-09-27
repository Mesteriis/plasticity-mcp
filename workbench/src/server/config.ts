import { networkInterfaces } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";

export interface WorkbenchConfig {
  host: string;
  port: number;
  projectsRoot: string;
  maxJsonBytes: number;
}

export interface WorkbenchConfigInput {
  env: Record<string, string | undefined>;
  args: string[];
  cwd: string;
  home: string;
  lanAddresses?: string[];
}

export function resolveWorkbenchConfig(input: WorkbenchConfigInput): WorkbenchConfig {
  const wantsLan = input.args.includes("--lan");
  const host = input.env.WORKBENCH_HOST ?? (wantsLan ? selectLanAddress(input.lanAddresses ?? localIpv4Addresses()) : "127.0.0.1");
  if (!isPrivateIpv4(host)) throw new Error("WORKBENCH_HOST must be a loopback or private IPv4 address");

  const port = Number(input.env.WORKBENCH_PORT ?? "4317");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("WORKBENCH_PORT must be an integer from 1024 through 65535");
  }

  const projectsRoot = resolve(input.env.WORKBENCH_PROJECTS_ROOT ?? join(input.cwd, ".plasticity-workbench", "projects"));
  const filesystemRoot = parse(projectsRoot).root;
  if (!isAbsolute(projectsRoot) || projectsRoot === filesystemRoot || projectsRoot === resolve(input.home)) {
    throw new Error("Workbench projects root must be an absolute subdirectory, not the filesystem root or home directory");
  }

  return { host, port, projectsRoot, maxJsonBytes: 1024 * 1024 };
}

export function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts as [number, number, number, number];
  return first === 127
    || first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function localIpv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal)
    .map((address) => address.address);
}

function selectLanAddress(addresses: string[]): string {
  const address = addresses.find((candidate) => isPrivateIpv4(candidate) && !candidate.startsWith("127."));
  if (!address) throw new Error("No private LAN IPv4 address is available");
  return address;
}
