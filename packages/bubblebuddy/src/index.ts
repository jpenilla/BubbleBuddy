import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";

import { AppHome } from "./config/env.ts";
import { ActivationLive } from "./discord/activation.ts";
import { DatabaseLive } from "./database.ts";
import { SlashCommandsLive } from "./discord/commands/index.ts";

const AppLayer = Layer.mergeAll(ActivationLive, SlashCommandsLive).pipe(
  Layer.provide(DatabaseLive.pipe(Layer.provide(AppHome.layer))),
  Layer.provide(NodeServices.layer),
);

NodeRuntime.runMain(Layer.launch(AppLayer));
