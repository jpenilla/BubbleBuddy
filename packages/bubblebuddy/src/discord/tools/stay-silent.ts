import { Effect } from "effect";
import { Type } from "typebox";

import { defineEffectTool } from "../../pi/effect-tool.ts";

export const staySilentTool = defineEffectTool({
  name: "stay_silent",
  label: "Stay silent",
  description: "End the turn without sending a Discord message when no response is useful.",
  promptGuidelines: [
    "Use stay_silent when the user's message does not need a response. It must be called in its own tool-call batch.",
  ],
  parameters: Type.Object({}),
  executionMode: "sequential",
  execute: () =>
    Effect.succeed({
      content: [{ type: "text", text: "Staying silent." }],
      details: undefined,
      terminate: true,
    }),
});
