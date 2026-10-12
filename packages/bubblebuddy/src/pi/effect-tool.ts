import { type JsonValue } from "@earendil-works/chord";
import { type ConstrainedSamplingConfig } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionMode,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Cause, Effect, Exit, Schema } from "effect";
import { type Static, type TSchema } from "typebox";

export class AgentToolError extends Schema.TaggedError<AgentToolError>()("AgentToolError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface EffectToolDefinition<TParams extends TSchema, Details extends JsonValue, E, R> {
  name: string;
  description: string;
  parameters: TParams;
  constrainedSampling?: false | ConstrainedSamplingConfig;
  replay?: "safe" | "unsafe";
  executionMode?: ToolExecutionMode;
  prepareArguments?: (args: unknown) => Static<TParams>;
  outputLimits?: ToolRegistration["outputLimits"];
  execute(
    params: Static<TParams>,
    api: ToolExecutionApi<Details>,
  ): Effect.Effect<ToolExecutionResult<Details>, E, R>;
}

export const defineEffectTool = <TParams extends TSchema, Details extends JsonValue, E, R>(
  tool: EffectToolDefinition<TParams, Details, E, R>,
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    return defineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      constrainedSampling: tool.constrainedSampling,
      replay: tool.replay,
      executionMode: tool.executionMode,
      prepareArguments: tool.prepareArguments,
      outputLimits: tool.outputLimits,
      execute: (params, api, callContext) =>
        Effect.runPromiseExitWith(context)(
          Effect.suspend(() => tool.execute(params, api)).pipe(
            Effect.scoped,
            Effect.onError((cause) =>
              (Cause.hasDies(cause)
                ? Effect.logError("Tool defect", cause)
                : Effect.logDebug(
                    Cause.hasInterruptsOnly(cause) ? "Tool interrupted" : "Tool failed",
                    cause,
                  )
              ).pipe(Effect.annotateLogs({ toolName: tool.name, toolCallId: api.callId })),
            ),
            Effect.withSpan("EffectTool.execute", {
              // The captured runtime belongs to tool construction, not this invocation.
              root: true,
              attributes: { toolName: tool.name, toolCallId: api.callId },
            }),
            Effect.catchDefect(() =>
              Effect.fail(
                new AgentToolError({ message: "This tool encountered an internal error." }),
              ),
            ),
          ),
          { signal: callContext.abortSignal },
        ).then((exit) => {
          if (Exit.isSuccess(exit)) return exit.value;
          // pi-durable reports the thrown message verbatim; keep aborts readable instead of Effect's squashed interrupt error.
          if (Cause.hasInterruptsOnly(exit.cause)) throw new Error("Operation aborted.");
          throw Cause.squash(exit.cause);
        }),
    });
  });
