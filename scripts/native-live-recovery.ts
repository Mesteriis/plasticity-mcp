/** A known failure still requires the caller's document/revision/journal gates.
 * Unknown outcomes never authorize Undo or any other recovery mutation. */
export function permitsNativeFailureRecovery(error: unknown): boolean {
  if (!(error instanceof Error) || !error.message.trim()) return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  if (/timeout|timed.?out|uncertain|disconnect|closed|transport|socket|ECONN|EPIPE|cancel|abort/i.test(`${error.name} ${error.message} ${code}`)) return false;
  if (error.cause !== undefined && !permitsNativeFailureRecovery(error.cause)) return false;
  return true;
}
