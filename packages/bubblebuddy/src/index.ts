import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { AppHome } from "./config/env.ts";
import { FileConfig } from "./config/file.ts";
import { ActivationLive } from "./discord/activation.ts";
import { Discord } from "./discord/client.ts";
import { DatabaseLive } from "./database.ts";
import { SlashCommandsLive } from "./discord/commands/index.ts";
import { PiContext } from "./pi/context.ts";
import { LoadedResources } from "./resources.ts";
import { ChannelSessions } from "./session/registry.ts";
import { ChannelStateRepository } from "./session/state.ts";

const ChannelSessionsLive = ChannelSessions.layer.pipe(
  Layer.provide(ChannelStateRepository.layer),
  Layer.provide(LoadedResources.layer),
  Layer.provide(PiContext.layer),
  Layer.provide(FileConfig.layer),
  Layer.provide(AppHome.layer),
  Layer.provide(FetchHttpClient.layer),
);

const AppLayer = Layer.mergeAll(ActivationLive, SlashCommandsLive).pipe(
  Layer.provide(Discord.layer),
  Layer.provide(ChannelSessionsLive),
  Layer.provide(DatabaseLive.pipe(Layer.provide(AppHome.layer))),
  Layer.provide(NodeServices.layer),
);

NodeRuntime.runMain(Layer.launch(AppLayer));
