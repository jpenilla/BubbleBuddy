import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";

import { AppConfig } from "./config.ts";
import { ActivationLive } from "./discord/activation.ts";
import { DatabaseLive } from "./database.ts";
import { Discord } from "./discord/client.ts";
import { SlashCommandsLive } from "./discord/commands/index.ts";
import { LoadedResources } from "./resources.ts";
import { ChannelStateRepository } from "./channels/state-repository.ts";
import { PiChannelSessionFactory } from "./pi-session/session-factory.ts";
import { PiContext } from "./pi-session/context.ts";
import { ChannelRuntimes } from "./channels/channel-runtimes.ts";

const AppLayer = Layer.mergeAll(ActivationLive, SlashCommandsLive).pipe(
  Layer.provideMerge(ChannelRuntimes.layer),
  Layer.provideMerge(PiChannelSessionFactory.layer),
  Layer.provideMerge(LoadedResources.layer),
  Layer.provideMerge(ChannelStateRepository.layer),
  Layer.provideMerge(DatabaseLive),
  Layer.provideMerge(PiContext.layer),
  Layer.provideMerge(AppConfig.layer),
  Layer.provideMerge(Discord.layer),
  Layer.provideMerge(NodeServices.layer),
);

NodeRuntime.runMain(Layer.launch(AppLayer));
