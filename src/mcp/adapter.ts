import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { Data, Effect, Scope } from "effect";
import { Type } from "typebox";

import type { McpServerConfigEntry } from "../config.ts";

export type McpServerConfig = McpServerConfigEntry & { readonly name: string };

class McpConfigurationError extends Data.TaggedError("McpConfigurationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  constructor(message: string, options?: ErrorOptions) {
    super({ message, cause: options?.cause });
  }
}

class McpServerConnectionError extends Data.TaggedError("McpServerConnectionError")<{
  readonly serverName: string;
  readonly operation: string;
  readonly cause: unknown;
}> {
  get message(): string {
    return `MCP ${this.operation} for server ${this.serverName} failed`;
  }
}

type McpConnectError = McpConfigurationError | McpServerConnectionError;

const formatError = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : String(error);

const sanitizeNamePart = (name: string): string =>
  name
    .replaceAll(/[^A-Za-z0-9_]/g, "_")
    .replaceAll(/_+/g, "_")
    .replaceAll(/^_|_$/g, "");

const sanitizeToolNamePart = (
  kind: "server" | "tool",
  name: string,
): Effect.Effect<string, McpConfigurationError> =>
  Effect.gen(function* () {
    const sanitized = sanitizeNamePart(name);
    if (sanitized.length === 0) {
      return yield* new McpConfigurationError(
        `Invalid MCP ${kind} name "${name}": no valid characters after sanitizing.`,
      );
    }
    return sanitized;
  });

const formatToolName = (
  toolName: string,
  serverName: string,
): Effect.Effect<string, McpConfigurationError> =>
  Effect.gen(function* () {
    const sanitizedServerName = yield* sanitizeToolNamePart("server", serverName);
    const sanitizedToolName = yield* sanitizeToolNamePart("tool", toolName);
    return `${sanitizedServerName}_${sanitizedToolName}`;
  });

const formatBearerTokenEnvName = (
  serverName: string,
): Effect.Effect<string, McpConfigurationError> =>
  Effect.gen(function* () {
    const sanitized = sanitizeNamePart(serverName).toUpperCase();
    if (sanitized.length === 0) {
      return yield* new McpConfigurationError(
        `Invalid MCP server name "${serverName}": cannot derive bearer token environment variable.`,
      );
    }
    return `${sanitized}_API_KEY`;
  });

const CONNECT_TIMEOUT = 10_000;

const runMcpRequest = <T>(
  serverName: string,
  label: string,
  request: () => PromiseLike<T>,
): Effect.Effect<T, McpServerConnectionError> =>
  Effect.tryPromise({
    try: request,
    catch: (error) => new McpServerConnectionError({ serverName, operation: label, cause: error }),
  });

interface McpConnection {
  readonly client: Client;
  readonly transport: Transport;
}

interface McpToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

interface McpConnectedServer {
  readonly client: Client;
  readonly connection: McpConnection;
  readonly serverName: string;
  readonly tools: McpToolInfo[];
}

const closeConnection = ({ client, transport }: McpConnection): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore);
    yield* Effect.tryPromise(() => transport.close()).pipe(Effect.ignore);
  });

const formatToolError = (
  serverName: string,
  toolName: string,
  content: (TextContent | ImageContent)[],
): string => {
  const text = content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : `MCP tool ${serverName}.${toolName} failed.`;
};

const transformContent = (mcpContent: unknown[]): (TextContent | ImageContent)[] =>
  mcpContent.map((c: unknown) => {
    if (typeof c !== "object" || c === null) {
      return { type: "text", text: String(c) };
    }

    const block = c as Record<string, unknown>;

    if (block.type === "text") {
      return { type: "text", text: String(block.text ?? "") };
    }

    if (block.type === "image") {
      return {
        type: "image",
        data: String(block.data ?? ""),
        mimeType: String(block.mimeType ?? "image/png"),
      };
    }

    if (block.type === "resource_link") {
      const linkName = String(block.name ?? block.uri ?? "unknown");
      const linkUri = String(block.uri ?? "(no URI)");
      return {
        type: "text",
        text: `[Resource Link: ${linkName}]\nURI: ${linkUri}`,
      };
    }

    if (block.type === "audio") {
      return {
        type: "text",
        text: `[Audio content: ${String(block.mimeType ?? "audio/*")}]`,
      };
    }

    if (block.type === "resource") {
      const resource = block.resource as Record<string, unknown> | undefined;
      const resourceUri = String(resource?.uri ?? "(no URI)");
      const resourceContent = String(
        resource?.text ?? (resource ? JSON.stringify(resource) : "(no content)"),
      );
      return { type: "text", text: `[Resource: ${resourceUri}]\n${resourceContent}` };
    }

    return { type: "text", text: JSON.stringify(c) };
  });

const buildToolDefinition = (
  serverName: string,
  client: Client,
  mcpTool: McpToolInfo,
  toolSources: Map<string, string>,
): Effect.Effect<ToolDefinition, McpConfigurationError> =>
  Effect.gen(function* () {
    const name = yield* formatToolName(mcpTool.name, serverName);
    const source = `${serverName}.${mcpTool.name}`;
    const existingSource = toolSources.get(name);
    if (existingSource) {
      return yield* new McpConfigurationError(
        `MCP tool name conflict for "${name}": ${existingSource} and ${source}.`,
      );
    }
    toolSources.set(name, source);

    return defineTool({
      name,
      label: `MCP: ${mcpTool.name}`,
      description: mcpTool.description || `MCP tool from ${serverName}`,
      promptSnippet: mcpTool.description || `MCP tool from ${serverName}`,
      parameters: Type.Unsafe<Record<string, unknown>>(
        mcpTool.inputSchema || { type: "object", properties: {} },
      ),
      execute: async (_toolCallId, params, signal) => {
        const result = await client.callTool(
          { name: mcpTool.name, arguments: params as Record<string, unknown> },
          undefined,
          { signal },
        );

        const content = transformContent(Array.isArray(result.content) ? result.content : []);
        if (result.isError) {
          throw new Error(formatToolError(serverName, mcpTool.name, content));
        }

        return {
          content: content.length > 0 ? content : [{ type: "text", text: "(empty result)" }],
          details: { server: serverName, tool: mcpTool.name },
        };
      },
    });
  });

const buildToolDefinitions = (
  serverName: string,
  client: Client,
  mcpTools: readonly McpToolInfo[],
  toolSources: Map<string, string>,
): Effect.Effect<ToolDefinition[], McpConfigurationError> =>
  Effect.forEach(mcpTools, (mcpTool) =>
    buildToolDefinition(serverName, client, mcpTool, toolSources),
  );

const createTransport = (server: McpServerConfig): Effect.Effect<Transport, McpConnectError> =>
  Effect.gen(function* () {
    if ("url" in server) {
      const url = yield* Effect.try({
        try: () => new URL(server.url),
        catch: (error) =>
          new McpConfigurationError(`Invalid MCP URL for server "${server.name}".`, {
            cause: error,
          }),
      });
      const headers: Record<string, string> = {};

      const envName = server.bearerTokenEnv ?? (yield* formatBearerTokenEnvName(server.name));
      const token = process.env[envName];
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
      return new StreamableHTTPClientTransport(url, { requestInit });
    }

    const params: StdioServerParameters = {
      command: server.command,
      args: server.args ? [...server.args] : [],
    };
    if (server.env) {
      params.env = { ...getDefaultEnvironment(), ...server.env };
    }
    return new StdioClientTransport(params);
  });

const connectServer = (
  server: McpServerConfig,
): Effect.Effect<McpConnectedServer, McpConnectError> =>
  Effect.gen(function* () {
    const transport = yield* createTransport(server);
    const client = new Client({ name: "bubblebuddy", version: "1.0.0" });
    const connection = { client, transport };
    return yield* Effect.gen(function* () {
      yield* runMcpRequest(server.name, "connect", () =>
        client.connect(transport, {
          maxTotalTimeout: CONNECT_TIMEOUT,
          timeout: CONNECT_TIMEOUT,
        }),
      );

      const { tools: mcpTools } = yield* runMcpRequest(server.name, "listTools", () =>
        client.listTools(undefined, {
          maxTotalTimeout: CONNECT_TIMEOUT,
          timeout: CONNECT_TIMEOUT,
        }),
      );

      return { client, connection, serverName: server.name, tools: mcpTools };
    }).pipe(Effect.onError(() => closeConnection(connection)));
  });

export const connectMcpServers = (
  servers: readonly McpServerConfig[],
): Effect.Effect<ToolDefinition[], McpConfigurationError, Scope.Scope> =>
  Effect.gen(function* () {
    const connectedServers = yield* Effect.forEach(
      servers,
      (server) =>
        Effect.acquireRelease(connectServer(server), ({ connection }) =>
          closeConnection(connection),
        ).pipe(
          Effect.catchTag("McpServerConnectionError", (error) =>
            Effect.logWarning(`MCP: skipping ${formatError(error)}`).pipe(Effect.as(undefined)),
          ),
        ),
      { concurrency: "unbounded" },
    );

    const allTools: ToolDefinition[] = [];
    const toolSources = new Map<string, string>();
    for (const connectedServer of connectedServers) {
      if (connectedServer === undefined) {
        continue;
      }

      const tools = yield* buildToolDefinitions(
        connectedServer.serverName,
        connectedServer.client,
        connectedServer.tools,
        toolSources,
      );
      allTools.push(...tools);
    }

    return allTools;
  });
