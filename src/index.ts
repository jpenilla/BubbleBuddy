import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import { program } from "./app.ts";

NodeRuntime.runMain(Effect.scoped(program));
