export interface SessionRuntime {
  close(): void;
  reconnect?(): Promise<void>;
}

export interface SessionOperations<State> {
  state(): Promise<State>;
}

export interface SessionOwnership {
  release(): Promise<void>;
}

export interface SessionConnection<
  State,
  Runtime extends SessionRuntime = SessionRuntime,
  Operations extends SessionOperations<State> = SessionOperations<State>,
  Ownership extends SessionOwnership = SessionOwnership,
> {
  targetId: string;
  runtime: Runtime;
  operations: Operations;
  ownership: Ownership;
}

export async function connectSessionWindow<
  Target,
  State,
  Runtime extends SessionRuntime,
  Operations extends SessionOperations<State>,
  Ownership extends SessionOwnership,
>(options: {
  targetId: string;
  target: Target;
  current: SessionConnection<State, Runtime, Operations, Ownership> | undefined;
  acquireOwnership(targetId: string): Promise<Ownership>;
  connectRuntime(target: Target): Promise<Runtime>;
  createOperations(runtime: Runtime): Operations;
}): Promise<{ connection: SessionConnection<State, Runtime, Operations, Ownership>; state: State }> {
  const { targetId, target, current } = options;
  if (current?.targetId === targetId) {
    await current.runtime.reconnect?.();
    return { connection: current, state: await current.operations.state() };
  }

  const ownership = await options.acquireOwnership(targetId);
  let runtime: Runtime | undefined;
  try {
    runtime = await options.connectRuntime(target);
    const operations = options.createOperations(runtime);
    const state = await operations.state();
    current?.runtime.close();
    await current?.ownership.release();
    return { connection: { targetId, runtime, operations, ownership }, state };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try { runtime?.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { await ownership.release(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Plasticity connection failed and candidate cleanup was incomplete");
    }
    throw error;
  }
}
