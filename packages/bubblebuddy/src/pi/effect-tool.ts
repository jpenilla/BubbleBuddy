import { type ConstrainedSamplingConfig } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionToolContext,
  type ToolAnnotations,
  type ToolExecutionMode,
  type ToolExposure,
  type ToolLoadout,
  type ToolLoadoutChanges,
  type ToolNamespace,
} from "@earendil-works/pi-coding-agent";
import { Cause, Effect, Exit, Schema } from "effect";
import { type Static, type TSchema } from "typebox";

export class AgentToolError extends Schema.TaggedError<AgentToolError>()("AgentToolError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface EffectToolDefinition<TParams extends TSchema, Details, E, R> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TParams;
  constrainedSampling?: false | ConstrainedSamplingConfig;
  prepareArguments?: (args: unknown) => Static<TParams>;
  outputSchema?: TSchema;
  exposure?: ToolExposure;
  namespace?: ToolNamespace;
  annotations?: ToolAnnotations;
  defaultActive?: boolean;
  prepareLoadout?: (loadout: ToolLoadout) => ToolLoadoutChanges | undefined;
  executionMode?: ToolExecutionMode;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    onUpdate: AgentToolUpdateCallback<Details> | undefined,
    ctx: ExtensionToolContext,
  ): Effect.Effect<AgentToolResult<Details>, E, R>;
}

export const defineEffectTool = <TParams extends TSchema, Details, E, R>(
  tool: EffectToolDefinition<TParams, Details, E, R>,
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    return defineTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: tool.promptGuidelines,
      parameters: tool.parameters,
      constrainedSampling: tool.constrainedSampling,
      prepareArguments: tool.prepareArguments,
      outputSchema: tool.outputSchema,
      exposure: tool.exposure,
      namespace: tool.namespace,
      annotations: tool.annotations,
      defaultActive: tool.defaultActive,
      prepareLoadout: tool.prepareLoadout,
      executionMode: tool.executionMode,
      // @effect-diagnostics-next-line asyncFunction:off -- Pi requires a promise-returning tool callback.
      execute: async (toolCallId, input, signal, onUpdate, ctx) => {
        const exit = await Effect.runPromiseExitWith(context)(
          Effect.suspend(() => tool.execute(toolCallId, input, onUpdate, ctx)).pipe(
            Effect.scoped,
            Effect.onError((cause) =>
              (Cause.hasDies(cause)
                ? Effect.logError("Tool defect", cause)
                : Effect.logDebug(
                    Cause.hasInterruptsOnly(cause) ? "Tool interrupted" : "Tool failed",
                    cause,
                  )
              ).pipe(Effect.annotateLogs({ toolName: tool.name, toolCallId })),
            ),
            Effect.withSpan("EffectTool.execute", {
              // The captured runtime belongs to tool construction, not this invocation.
              root: true,
              attributes: { toolName: tool.name, toolCallId },
            }),
            Effect.catchDefect(() =>
              Effect.fail(
                new AgentToolError({ message: "This tool encountered an internal error." }),
              ),
            ),
          ),
          { signal },
        );
        if (Exit.isSuccess(exit)) return exit.value;
        // Pi surfaces the thrown message verbatim; keep aborts readable instead of Effect's squashed interrupt error.
        if (Cause.hasInterruptsOnly(exit.cause)) throw new Error("Operation aborted.");
        throw Cause.squash(exit.cause);
      },
    });
  });
