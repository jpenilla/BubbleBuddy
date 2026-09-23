import { Schema } from "effect";

export const SHOW_THINKING_DEFAULT = false;
export const REPLY_MODE_DEFAULT = "mention-only" as const;
export const ReplyModeSchema = Schema.Literals(["mention-only", "automatic"]);
export type ReplyMode = typeof ReplyModeSchema.Type;
