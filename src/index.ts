import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect } from "effect";

import { program } from "./app.ts";

NodeRuntime.runMain(Effect.scoped(program));
