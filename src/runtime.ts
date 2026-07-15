import { NodeServices } from "@effect/platform-node";
import { Cause, type Effect, Exit, Layer, ManagedRuntime } from "effect";

const PiTasksLayer = Layer.mergeAll(NodeServices.layer);

export function createPiTasksRuntime() {
  return ManagedRuntime.make(PiTasksLayer);
}

export type PiTasksRuntime = ReturnType<typeof createPiTasksRuntime>;

export async function runTaskEffect<A, E>(
  runtime: PiTasksRuntime,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal; interruptMessage?: string } = {},
): Promise<A> {
  const exit = await runtime.runPromiseExit(effect, options.signal ? { signal: options.signal } : undefined);
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error(options.interruptMessage ?? "Operation was aborted.");
  }
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
