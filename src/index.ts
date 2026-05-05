import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";

import { AppConfig } from "./config.ts";
import { ActivationLive } from "./discord/activation.ts";
import { Discord } from "./discord/client.ts";
import { SlashCommandsLive } from "./discord/commands.ts";
import { LoadedResources } from "./resources.ts";
import { ChannelSessions } from "./sessions.ts";

const ResourcesLayer = LoadedResources.layer.pipe(Layer.provideMerge(AppConfig.layer));
const SessionsLayer = ChannelSessions.layer.pipe(Layer.provideMerge(ResourcesLayer));

const AppLayer = Layer.mergeAll(ActivationLive, SlashCommandsLive).pipe(
  Layer.provideMerge(SessionsLayer),
  Layer.provideMerge(Discord.layer),
  Layer.provideMerge(NodeServices.layer),
);

NodeRuntime.runMain(Layer.launch(AppLayer));
