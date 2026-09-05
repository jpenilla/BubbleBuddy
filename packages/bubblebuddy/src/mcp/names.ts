import { Effect, Schema } from "effect";

export class McpNameError extends Schema.TaggedError<McpNameError>()("McpNameError", {
  message: Schema.String,
}) {}

export const sanitizeNamePart = (name: string): string =>
  name
    .replaceAll(/[^A-Za-z0-9_]/g, "_")
    .replaceAll(/_+/g, "_")
    .replaceAll(/^_|_$/g, "");

const sanitizedNamePart = Effect.fnUntraced(function* (kind: "server" | "tool", name: string) {
  const sanitized = sanitizeNamePart(name);
  if (sanitized.length === 0) {
    return yield* new McpNameError({
      message: `Invalid MCP ${kind} name "${name}": no valid characters after sanitizing.`,
    });
  }
  return sanitized;
});

export const formatToolName = Effect.fnUntraced(function* (serverName: string, toolName: string) {
  const server = yield* sanitizedNamePart("server", serverName);
  const tool = yield* sanitizedNamePart("tool", toolName);
  return `${server}__${tool}`;
});

export const defaultBearerTokenEnv = Effect.fnUntraced(function* (serverName: string) {
  const server = yield* sanitizedNamePart("server", serverName);
  return `${server.toUpperCase()}_API_KEY`;
});
