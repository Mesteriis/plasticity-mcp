/** Acceptance suites need detailed topology; MCP mutation responses are compact. */
export async function hydrateNativeState(result: any, bodyInfo: (id: number) => Promise<any>): Promise<any> {
  if (!result?.documentToken || !result.revision || !Number.isInteger(result.undoDepth) || !Array.isArray(result.bodies)) return result;
  const bodies = [];
  for (const body of result.bodies) {
    if (Array.isArray(body.faces)) { bodies.push(body); continue; }
    const detailed = await bodyInfo(body.id);
    if (detailed.documentToken !== result.documentToken || detailed.revision !== result.revision || detailed.body?.id !== body.id) {
      throw new Error("Document changed while acceptance topology was being read");
    }
    bodies.push(detailed.body);
  }
  return { ...result, bodies };
}
