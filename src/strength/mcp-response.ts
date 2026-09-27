const RESPONSE_LIMIT_BYTES = 1024 * 1024;

export function strengthToolResult(value: unknown): { content: [{ type: "text"; text: string }] } {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > RESPONSE_LIMIT_BYTES) throw new Error("Strength tool response exceeds 1 MiB");
  return { content: [{ type: "text", text }] };
}
