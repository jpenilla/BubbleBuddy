import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";

import { AppConfig } from "./config.ts";
import { ActivationLive } from "./discord/activation.ts";
import { Discord } from "./discord/client.ts";
import { SlashCommandsLive } from "./discord/commands.ts";
import { LoadedResources } from "./resources.ts";
import { ChannelRepository } from "./channel-repository.ts";
import { PiContext } from "./pi/context.ts";
import { ChannelSessions } from "./sessions.ts";

const AppLayer = Layer.mergeAll(ActivationLive, SlashCommandsLive).pipe(
  Layer.provideMerge(ChannelSessions.layer),
  Layer.provideMerge(LoadedResources.layer),
  Layer.provideMerge(ChannelRepository.layer),
  Layer.provideMerge(PiContext.layer),
  Layer.provideMerge(AppConfig.layer),
  Layer.provideMerge(Discord.layer),
  Layer.provideMerge(NodeServices.layer),
);

NodeRuntime.runMain(Layer.launch(AppLayer));
