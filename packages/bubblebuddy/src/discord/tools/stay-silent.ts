import { obj } from "@earendil-works/pi-schema";
import { Effect } from "effect";

import { defineEffectTool } from "../../pi/effect-tool.ts";

export const staySilentTool = defineEffectTool({
  name: "stay_silent",
  description: "End the turn without sending a Discord message when no response is useful.",
  parameters: obj({}),
  replay: "safe",
  executionMode: "sequential",
  execute: () =>
    Effect.succeed({
      output: [{ type: "text", text: "Staying silent." }],
      control: { terminate: true },
    }),
});
