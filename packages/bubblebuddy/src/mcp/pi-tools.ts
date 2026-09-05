import { isDeepStrictEqual } from "node:util";

import { type AgentToolResult, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CallToolResult, ContentBlock, Tool } from "@modelcontextprotocol/client";
import { Effect, Match, Predicate } from "effect";
import { Type } from "typebox";

import { defineEffectTool } from "../pi/effect-tool.ts";
import { McpClient } from "./client.ts";
import { formatToolName } from "./names.ts";

const detailsTag = "bubblebuddy/mcp/pi-tool-details";

interface ResultDetails {
  readonly _tag: typeof detailsTag;
  readonly source: {
    readonly server: string;
    readonly tool: string;
  };
  readonly result: CallToolResult;
}

const resultDetails = (source: ResultDetails["source"], result: CallToolResult): ResultDetails => ({
  _tag: detailsTag,
  source,
  result,
});

const isResultDetails = (value: unknown): value is ResultDetails =>
  Predicate.isTagged(detailsTag)(value);

type PiContent = AgentToolResult<ResultDetails>["content"][number];

const resourceHeader = (uri: string, mimeType: string | undefined): string =>
  [
    "MCP resource",
    `URI: ${uri}`,
    ...(mimeType === undefined ? [] : [`MIME type: ${mimeType}`]),
  ].join("\n");

const formatResourceLink = (content: Extract<ContentBlock, { type: "resource_link" }>): string =>
  [
    "MCP resource",
    `Name: ${content.title ?? content.name}`,
    `URI: ${content.uri}`,
    ...(content.mimeType === undefined ? [] : [`MIME type: ${content.mimeType}`]),
    ...(content.description === undefined ? [] : [`Description: ${content.description}`]),
  ].join("\n");

const toPiContent = (content: ContentBlock): PiContent | undefined =>
  Match.value(content).pipe(
    Match.withReturnType<PiContent | undefined>(),
    Match.discriminatorsExhaustive("type")({
      text: (content) =>
        content.text.trim().length === 0 ? undefined : { type: "text", text: content.text },
      image: (content) => ({
        type: "image",
        data: content.data,
        mimeType: content.mimeType,
      }),
      audio: (content) => ({
        type: "text",
        text: `MCP returned audio (${content.mimeType}). Audio content cannot be provided to the model.`,
      }),
      resource_link: (content) => ({ type: "text", text: formatResourceLink(content) }),
      resource: (content) => {
        const header = resourceHeader(content.resource.uri, content.resource.mimeType);
        if ("text" in content.resource) {
          return { type: "text", text: `${header}\n\n${content.resource.text}` };
        }
        return {
          type: "text",
          text: `${header}\n\nMCP returned binary content. Binary content cannot be provided to the model.`,
        };
      },
    }),
  );

const parsesTo = (text: string, value: unknown): boolean => {
  try {
    return isDeepStrictEqual(JSON.parse(text), value);
  } catch {
    return false;
  }
};

const hasStructuredContent = (content: readonly PiContent[], structuredContent: unknown): boolean =>
  content.some((block) => block.type === "text" && parsesTo(block.text, structuredContent));

const resultContent = (result: CallToolResult, source: ResultDetails["source"]): PiContent[] => {
  const content: PiContent[] = [];
  for (const block of result.content) {
    const converted = toPiContent(block);
    if (converted !== undefined) content.push(converted);
  }

  if (
    result.structuredContent !== undefined &&
    !hasStructuredContent(content, result.structuredContent)
  ) {
    content.push({
      type: "text",
      text: JSON.stringify(result.structuredContent),
    });
  }

  if (content.length > 0) return content;
  return [
    {
      type: "text",
      text:
        result.isError === true
          ? `MCP tool ${source.server}/${source.tool} reported an error without output.`
          : `MCP tool ${source.server}/${source.tool} completed without output.`,
    },
  ];
};

const createPiTool = Effect.fn("McpPiTools.createPiTool")(function* (
  client: McpClient.Interface,
  tool: Tool,
  server: string,
) {
  const source = { server, tool: tool.name };
  const name = yield* formatToolName(server, tool.name);
  const parameters = Type.Unsafe<Record<string, unknown>>(tool.inputSchema);
  return yield* defineEffectTool({
    name,
    label: tool.annotations?.title ?? tool.title ?? tool.name,
    description: tool.description ?? tool.title ?? tool.annotations?.title ?? tool.name,
    parameters,
    execute: Effect.fnUntraced(function* (_toolCallId: string, params: Record<string, unknown>) {
      const result = yield* client.callTool(
        { name: tool.name, arguments: params },
        { toolDefinition: tool },
      );
      return {
        content: resultContent(result, source),
        details: resultDetails(source, result),
      };
    }),
  });
});

export const createPiTools = Effect.fn("McpPiTools.createPiTools")(function* (
  client: McpClient.Interface,
  server: string,
) {
  const { tools } = yield* client.listTools();
  return yield* Effect.forEach(tools, (tool) => createPiTool(client, tool, server));
});

/**
 * Pi tools signal failures by throwing, which discards tool details. MCP returns
 * structured error results, so mark those after execution to retain their content
 * and host details.
 */
export const createMcpToolResultExtension = (): ExtensionFactory => (pi) => {
  pi.on("tool_result", (event) => {
    if (isResultDetails(event.details) && event.details.result.isError) {
      return { isError: true };
    }
  });
};

export * as McpPiTools from "./pi-tools.ts";
