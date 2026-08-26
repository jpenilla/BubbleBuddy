import {
  defineTool,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import type { Static, TSchema } from "typebox";

const INTERNAL_TOOL_ERROR_MESSAGE = "This tool encountered an internal error.";

const internalToolError = (): Error => new Error(INTERNAL_TOOL_ERROR_MESSAGE);

export class AgentToolError extends Schema.TaggedError<AgentToolError>()("AgentToolError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface EffectTool<TParams extends TSchema = TSchema, Details = unknown, E = never> {
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
  ): Effect.Effect<AgentToolResult<Details>, E>;
}

export type AnyEffectTool = EffectTool<TSchema, unknown, unknown>;

export const defineEffectTool = <TParams extends TSchema, Details, E>(
  tool: EffectTool<TParams, Details, E>,
): AnyEffectTool => tool;

export const toPiToolDefinition = <TParams extends TSchema, Details, E>(
  tool: EffectTool<TParams, Details, E>,
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context();
    return defineTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines:
        tool.promptGuidelines === undefined ? undefined : [...tool.promptGuidelines],
      parameters: tool.parameters,
      execute: async (toolCallId, input, signal, onUpdate, ctx) =>
        Effect.runPromiseWith(context)(
          tool.execute(toolCallId, input, onUpdate, ctx).pipe(
            Effect.tapError((error) =>
              Effect.logDebug("Tool failed", { toolName: tool.name, toolCallId, error }),
            ),
            Effect.catchDefect((defect) =>
              Effect.logError("Tool defect", { toolName: tool.name, toolCallId, defect }).pipe(
                Effect.andThen(Effect.fail(internalToolError())),
              ),
            ),
            Effect.withSpan("EffectTool.execute", {
              attributes: { toolName: tool.name, toolCallId },
            }),
          ),
          { signal },
        ),
    });
  });
