import { Config, Data, Effect, Option, Redacted } from "effect";

import { type McpServerConfigEntry, McpServerConfigEntrySchema } from "../config/file.ts";
import { McpClient } from "./client.ts";
import { defaultBearerTokenEnv } from "./names.ts";

const clientInfo = {
  name: "bubblebuddy",
  version: "0",
} as const;

type ResolvedServer = Data.TaggedEnum<{
  HTTP: {
    readonly url: string;
    readonly bearerToken: Option.Option<Redacted.Redacted<string>>;
  };
  Stdio: {
    readonly command: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
  };
}>;

const ResolvedServer = Data.taggedEnum<ResolvedServer>();

const resolveServer = Effect.fn("McpClientFactory.resolveServer")(function* (
  name: string,
  server: McpServerConfigEntry,
) {
  return yield* McpServerConfigEntrySchema.match(server, {
    HTTP: ({ url, bearerTokenEnv }) =>
      Effect.gen(function* () {
        const envName = bearerTokenEnv ?? (yield* defaultBearerTokenEnv(name));
        const bearerToken = yield* Config.option(Config.redacted(envName));
        return ResolvedServer.HTTP({ url, bearerToken });
      }),
    Stdio: ({ command, args, env }) => Effect.succeed(ResolvedServer.Stdio({ command, args, env })),
  });
});

const createTransport = Effect.fn("McpClientFactory.createTransport")(function* (
  server: ResolvedServer,
) {
  return yield* ResolvedServer.$match(server, {
    HTTP: ({ url, bearerToken }) =>
      Effect.succeed(
        McpClient.Transport.Http({
          url,
          options: Option.match(bearerToken, {
            onNone: () => undefined,
            onSome: (token) => ({
              authProvider: {
                token: () => Promise.resolve(Redacted.value(token)),
              },
            }),
          }),
        }),
      ),
    Stdio: ({ command, args, env }) =>
      Effect.succeed(
        McpClient.Transport.Stdio({
          options: {
            command,
            args: args === undefined ? undefined : [...args],
            env,
          },
        }),
      ),
  });
});

export const createClient = Effect.fn("McpClientFactory.createClient")(function* (
  name: string,
  server: McpServerConfigEntry,
) {
  const resolvedServer = yield* resolveServer(name, server);
  const transport = yield* createTransport(resolvedServer);
  const client = yield* McpClient.create({ clientInfo, transport });
  return client;
});

export * as McpClientFactory from "./client-factory.ts";
