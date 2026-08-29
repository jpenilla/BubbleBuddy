import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";

import { ActivationLive } from "./discord/activation.ts";
import { Discord } from "./discord/client.ts";
import { SlashCommandsLive } from "./discord/commands/index.ts";
import { ChannelSessions } from "./session/registry.ts";

const AppLayer = Layer.mergeAll(ActivationLive, SlashCommandsLive).pipe(
  Layer.provide(Discord.layer),
  Layer.provide(ChannelSessions.layer),
  Layer.provide(NodeServices.layer),
);

NodeRuntime.runMain(Layer.launch(AppLayer));
