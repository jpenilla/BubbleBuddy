import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, Layer, References } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Otlp, OtlpSerialization } from "effect/unstable/observability";

import { AppDatabase } from "./database.ts";
import { ActivationLayer } from "./discord/activation.ts";
import { DiscordEvents } from "./discord/discord-events.ts";
import { DiscordClient } from "./discord/discord-client.ts";
import { SlashCommandsLayer } from "./discord/commands/index.ts";
import { ChannelSessions } from "./session/registry.ts";
import { ChannelSettings } from "./session/settings.ts";
import { ScheduledActivationsLayer } from "./discord/scheduled-activations.ts";
import { Schedules } from "./scheduling/schedules.ts";
import { EnvConfig } from "./config/env.ts";

const DiscordClientLayer = Layer.unwrap(
  Effect.gen(function* () {
    const env = yield* EnvConfig;
    return DiscordClient.layer(env.discordToken);
  }),
).pipe(Layer.provide(EnvConfig.layer));

const DiscordLayer = DiscordEvents.layer.pipe(Layer.provideMerge(DiscordClientLayer));

const AppLayer = Layer.mergeAll(
  ActivationLayer,
  SlashCommandsLayer,
  ScheduledActivationsLayer,
).pipe(
  Layer.provide(ChannelSessions.layer),
  Layer.provide(ChannelSettings.layer),
  Layer.provide(Schedules.layer),
  Layer.provide(AppDatabase.layer),
  Layer.provide(DiscordLayer),
  Layer.provide(NodeServices.layer),
);

const ObservabilityLayer = Otlp.layerFromConfig().pipe(
  Layer.provide(OtlpSerialization.layerProtobuf),
  Layer.provide(FetchHttpClient.layer),
);

const LogLevelLayer = Layer.unwrap(
  Config.LogLevel("MINIMUM_LOG_LEVEL").pipe(
    Config.withDefault("Info"),
    Effect.map((level) => Layer.succeed(References.MinimumLogLevel, level)),
  ),
);

NodeRuntime.runMain(
  Layer.launch(AppLayer).pipe(Effect.provide(Layer.merge(ObservabilityLayer, LogLevelLayer))),
);
