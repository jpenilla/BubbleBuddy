import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";

import { program } from "./app.ts";
import { AppConfig } from "./config.ts";
import { Discord } from "./discord/client.ts";
import { LoadedResources } from "./resources.ts";

const AppServicesLayer = LoadedResources.layer.pipe(Layer.provideMerge(AppConfig.layer));

const AppLayer = Layer.mergeAll(AppServicesLayer, Discord.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

NodeRuntime.runMain(Effect.scoped(program).pipe(Effect.provide(AppLayer)));
