import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";

import { program } from "./app.ts";

BunRuntime.runMain(Effect.scoped(program));
