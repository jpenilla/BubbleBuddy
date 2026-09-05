import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";

import { ActivationLayer } from "./discord/activation.ts";
import { Discord } from "./discord/client.ts";
import { SlashCommandsLayer } from "./discord/commands/index.ts";
import { ChannelSessions } from "./session/registry.ts";

const AppLayer = Layer.mergeAll(ActivationLayer, SlashCommandsLayer).pipe(
  Layer.provide(Discord.layer),
  Layer.provide(ChannelSessions.layer),
  Layer.provide(NodeServices.layer),
);

NodeRuntime.runMain(Layer.launch(AppLayer));
