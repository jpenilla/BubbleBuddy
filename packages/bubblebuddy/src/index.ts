import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";

import { AppDatabase } from "./database.ts";
import { ActivationLayer } from "./discord/activation.ts";
import { Discord } from "./discord/client.ts";
import { SlashCommandsLayer } from "./discord/commands/index.ts";
import { ChannelSessions } from "./session/registry.ts";
import { ScheduledWakeupsLayer } from "./discord/scheduled-wakeups.ts";
import { Schedules } from "./scheduling/schedules.ts";

const AppLayer = Layer.mergeAll(ActivationLayer, SlashCommandsLayer, ScheduledWakeupsLayer).pipe(
  Layer.provide(ChannelSessions.layer),
  Layer.provide(Schedules.layer),
  Layer.provide(AppDatabase.layer),
  Layer.provide(Discord.layer),
  Layer.provide(NodeServices.layer),
);

NodeRuntime.runMain(Layer.launch(AppLayer));
