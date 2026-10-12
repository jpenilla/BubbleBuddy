import { Effect } from "effect";
import { Type } from "typebox";

import { defineEffectTool } from "../../pi/effect-tool.ts";

export const staySilentTool = defineEffectTool({
  name: "stay_silent",
  description: "End the turn without sending a Discord message when no response is useful.",
  parameters: Type.Object({}),
  replay: "safe",
  executionMode: "sequential",
  execute: () =>
    Effect.succeed({
      content: [{ type: "text", text: "Staying silent." }],
      control: { terminate: true },
    }),
});
