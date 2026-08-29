import {
  defineTool,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Cause, Effect, Exit, Schema } from "effect";
import type { Static, TSchema } from "typebox";

export class AgentToolError extends Schema.TaggedError<AgentToolError>()("AgentToolError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface EffectTool<TParams extends TSchema, Details, E, R> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: TParams;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    onUpdate: AgentToolUpdateCallback<Details> | undefined,
    ctx: ExtensionContext,
  ): Effect.Effect<AgentToolResult<Details>, E, R>;
}

export const defineEffectTool = <TParams extends TSchema, Details, E, R>(
  tool: EffectTool<TParams, Details, E, R>,
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    return defineTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines:
        tool.promptGuidelines === undefined ? undefined : [...tool.promptGuidelines],
      parameters: tool.parameters,
      execute: async (toolCallId, input, signal, onUpdate, ctx) => {
        const exit = await Effect.runPromiseExitWith(context)(
          tool.execute(toolCallId, input, onUpdate, ctx).pipe(
            Effect.scoped,
            Effect.tapError((error) =>
              Effect.logDebug("Tool failed", { toolName: tool.name, toolCallId, error }),
            ),
            Effect.catchDefect((defect) =>
              Effect.logError("Tool defect", { toolName: tool.name, toolCallId, defect }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new AgentToolError({ message: "This tool encountered an internal error." }),
                  ),
                ),
              ),
            ),
            Effect.withSpan("EffectTool.execute", {
              attributes: { toolName: tool.name, toolCallId },
            }),
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
