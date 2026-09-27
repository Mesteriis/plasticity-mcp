export interface PlasticityTarget {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export async function discoverPlasticityTargets(
  endpoint: string,
): Promise<PlasticityTarget[]> {
  const baseUrl = parseLoopbackUrl(endpoint, ["http:", "https:"]);
  const response = await fetch(new URL("/json/list", baseUrl), {
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("CDP discovery refused an HTTP redirect");
  }
  if (!response.ok) {
    throw new Error(`CDP discovery failed with HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("CDP target response is malformed: expected an array");
  }

  return payload.map(parseTarget).flatMap((target) => {
    if (target === null || !target.url.includes("/renderer/app_window/index.html")) {
      return [];
    }
    const { type: _type, ...publicTarget } = target;
    return [publicTarget];
  });
}

interface CdpTarget extends PlasticityTarget {
  type: string;
}

function parseTarget(value: unknown): CdpTarget | null {
  if (!isRecord(value)) {
    throw new Error("CDP target response is malformed: expected an object");
  }

  const id = readString(value, "id");
  const type = readString(value, "type");
  const title = readString(value, "title");
  const url = readString(value, "url");
  const webSocketDebuggerUrl = readString(value, "webSocketDebuggerUrl");

  if (type !== "page") {
    return null;
  }

  parseLoopbackUrl(webSocketDebuggerUrl, ["ws:", "wss:"]);
  return {
    id,
    type,
    title,
    url,
    webSocketDebuggerUrl,
  };
}

function readString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error(`CDP target response is malformed: ${key} must be a string`);
  }
  return field;
}

function parseLoopbackUrl(value: string, protocols: string[]): URL {
  const url = new URL(value);
  const isLoopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "localhost";
  if (!protocols.includes(url.protocol) || !isLoopback || url.username || url.password) {
    throw new Error("CDP access is restricted to unauthenticated loopback URLs");
  }
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
