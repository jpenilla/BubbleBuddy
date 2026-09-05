import { type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { CallToolResult, ContentBlock, Tool } from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { Type } from "typebox";

import { AgentToolError, defineEffectTool } from "../pi/effect-tool.ts";
import { McpClient } from "./client.ts";

export interface FromClientOptions<E, R> {
  readonly name?: (tool: Tool) => Effect.Effect<string, E, R>;
}

type PiContent = AgentToolResult<CallToolResult>["content"][number];

const formatResourceLink = (content: Extract<ContentBlock, { type: "resource_link" }>): string => {
  const label = content.title ?? content.name;
  const metadata = [content.mimeType, content.description].filter((value) => value !== undefined);
  return metadata.length === 0
    ? `${label}: ${content.uri}`
    : `${label}: ${content.uri} (${metadata.join(", ")})`;
};

const toPiContent = (content: ContentBlock): PiContent => {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "image":
      return { type: "image", data: content.data, mimeType: content.mimeType };
    case "audio":
      return {
        type: "text",
        text: `[Audio content (${content.mimeType}) is available in the structured tool details.]`,
      };
    case "resource_link":
      return { type: "text", text: formatResourceLink(content) };
    case "resource":
      return "text" in content.resource
        ? { type: "text", text: content.resource.text }
        : {
            type: "text",
            text: `[Binary resource ${content.resource.uri} (${content.resource.mimeType ?? "unknown MIME type"}) is available in the structured tool details.]`,
          };
  }
};

const resultContent = (result: CallToolResult): PiContent[] => {
  const content = result.content.map(toPiContent);
  if (content.length > 0 || result.structuredContent === undefined) return content;
  return [{ type: "text", text: JSON.stringify(result.structuredContent, undefined, 2) }];
};

const errorMessage = (result: CallToolResult): string => {
  const text = result.content
    .filter(
      (content): content is Extract<ContentBlock, { type: "text" }> => content.type === "text",
    )
    .map((content) => content.text)
    .join("\n");
  if (text.length > 0) return text;
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent, undefined, 2);
  }
  return "The MCP tool reported an error.";
};

export const createPiTool = Effect.fn("McpPiTools.createPiTool")(function* (
  client: McpClient.Interface,
  tool: Tool,
  name: string = tool.name,
) {
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
      if (result.isError === true) {
        return yield* new AgentToolError({ message: errorMessage(result) });
      }
      return {
        content: resultContent(result),
        details: result,
      };
    }),
  });
});

export const createPiTools = Effect.fn("McpPiTools.createPiTools")(function* <E = never, R = never>(
  client: McpClient.Interface,
  options?: FromClientOptions<E, R>,
) {
  const { tools } = yield* client.listTools();
  return yield* Effect.forEach(tools, (tool) =>
    Effect.gen(function* () {
      const name = options?.name === undefined ? tool.name : yield* options.name(tool);
      return yield* createPiTool(client, tool, name);
    }),
  );
});

export * as McpPiTools from "./pi-tools.ts";
