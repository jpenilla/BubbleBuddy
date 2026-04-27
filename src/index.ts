import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";

import { program } from "./app.ts";

NodeRuntime.runMain(Effect.scoped(program).pipe(Effect.provide(NodeServices.layer)));
