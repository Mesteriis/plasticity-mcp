import { z } from "zod";

export const codexInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1) }).strict(),
  z.object({ type: z.literal("localImage"), path: z.string().min(1) }).strict(),
]);

export type CodexInput = z.infer<typeof codexInputSchema>;

export const initializeResultSchema = z.object({
  userAgent: z.string().min(1),
  codexHome: z.string().min(1),
  platformFamily: z.string().min(1),
  platformOs: z.string().min(1),
}).passthrough();

export const threadResultSchema = z.object({
  thread: z.object({ id: z.string().min(1) }).passthrough(),
}).passthrough();

export const turnResultSchema = z.object({
  turn: z.object({ id: z.string().min(1) }).passthrough(),
}).passthrough();

export type CodexEvent =
  | { type: "notification"; method: string; params: unknown }
  | { type: "request"; requestId: string | number; method: string; params: unknown };

export interface CodexTurnCompletion {
  threadId: string;
  turnId: string;
  status: string;
}
