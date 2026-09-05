import {
  Client as SdkClient,
  isSpecType,
  StreamableHTTPClientTransport,
  type CacheableRequestOptions,
  type CallToolRequest,
  type CallToolRequestOptions,
  type CallToolResult,
  type ClientCapabilities,
  type ClientOptions as SdkClientOptions,
  type CompleteRequest,
  type CompleteResult,
  type CreateMessageRequest,
  type CreateMessageResult,
  type CreateMessageResultWithTools,
  type DiscoverResult,
  type ElicitRequest,
  type ElicitResult,
  type GetPromptRequest,
  type GetPromptResult,
  type Implementation,
  type ListPromptsRequest,
  type ListPromptsResult,
  type ListResourcesRequest,
  type ListResourcesResult,
  type ListResourceTemplatesRequest,
  type ListResourceTemplatesResult,
  type ListRootsRequest,
  type ListRootsResult,
  type ListToolsRequest,
  type ListToolsResult,
  type LoggingLevel,
  type ProtocolEra,
  type ReadResourceRequest,
  type ReadResourceResult,
  type RequestOptions,
  type ServerCapabilities,
  type ServerNotification,
  type StreamableHTTPClientTransportOptions,
  type SubscribeRequest,
  type SubscriptionFilter,
  type Transport as SdkTransport,
  type UnsubscribeRequest,
  type VersionNegotiationOptions,
} from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/client/stdio";
import { Data, Deferred, Effect, Option, PubSub, Schema, Scope, Stream } from "effect";

export type Transport = Data.TaggedEnum<{
  Http: {
    readonly url: string | URL;
    readonly options?: StreamableHTTPClientTransportOptions;
  };
  Stdio: {
    readonly options: StdioServerParameters;
  };
  Custom: {
    /** The client assumes ownership of this transport and closes it with its scope. */
    readonly transport: SdkTransport;
  };
}>;

export const Transport = Data.taggedEnum<Transport>();

export type ProtocolPolicy = VersionNegotiationOptions;

export interface Handlers<R = never> {
  /** @deprecated Deprecated by MCP 2026-07-28, but supported for legacy peers. */
  readonly sampling?: (
    request: CreateMessageRequest,
  ) => Effect.Effect<CreateMessageResult | CreateMessageResultWithTools, McpError, R>;
  readonly elicitation?: (request: ElicitRequest) => Effect.Effect<ElicitResult, McpError, R>;
  /** @deprecated Deprecated by MCP 2026-07-28, but supported for legacy peers. */
  readonly roots?: (request: ListRootsRequest) => Effect.Effect<ListRootsResult, McpError, R>;
}

export interface Options<R = never> {
  readonly clientInfo: Implementation;
  readonly transport: Transport;
  readonly handlers?: Handlers<R>;
  /** Additional host capabilities. Capabilities implied by handlers are merged into these. */
  readonly capabilities?: ClientCapabilities;
  /** Omission preserves the upstream client's protocol-negotiation default. */
  readonly protocol?: ProtocolPolicy;
  readonly clientOptions?: Omit<
    SdkClientOptions,
    "capabilities" | "listChanged" | "versionNegotiation"
  >;
}

export class McpError extends Schema.TaggedError<McpError>()("McpError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface Subscription {
  readonly honoredFilter: SubscriptionFilter;
  readonly closed: Effect.Effect<"local" | "graceful" | "remote">;
}

export interface Interface {
  readonly serverInfo: Option.Option<Implementation>;
  readonly serverCapabilities: ServerCapabilities;
  readonly protocolVersion: string;
  readonly protocolEra: ProtocolEra;
  readonly instructions: Option.Option<string>;
  readonly discoverResult: Option.Option<DiscoverResult>;

  /** Protocol notifications dispatched by the upstream client. */
  readonly notifications: Stream.Stream<ServerNotification>;
  /** Non-fatal, out-of-band errors reported by the upstream client. */
  readonly errors: Stream.Stream<McpError>;
  /** Completes when the underlying MCP connection closes. */
  readonly closed: Effect.Effect<void>;

  readonly ping: (options?: RequestOptions) => Effect.Effect<void, McpError>;
  readonly discover: (options?: RequestOptions) => Effect.Effect<DiscoverResult, McpError>;
  readonly listTools: (
    params?: ListToolsRequest["params"],
    options?: CacheableRequestOptions,
  ) => Effect.Effect<ListToolsResult, McpError>;
  readonly callTool: (
    params: CallToolRequest["params"],
    options?: CallToolRequestOptions,
  ) => Effect.Effect<CallToolResult, McpError>;
  readonly listResources: (
    params?: ListResourcesRequest["params"],
    options?: CacheableRequestOptions,
  ) => Effect.Effect<ListResourcesResult, McpError>;
  readonly listResourceTemplates: (
    params?: ListResourceTemplatesRequest["params"],
    options?: CacheableRequestOptions,
  ) => Effect.Effect<ListResourceTemplatesResult, McpError>;
  readonly readResource: (
    params: ReadResourceRequest["params"],
    options?: CacheableRequestOptions,
  ) => Effect.Effect<ReadResourceResult, McpError>;
  readonly subscribeResource: (
    params: SubscribeRequest["params"],
    options?: RequestOptions,
  ) => Effect.Effect<void, McpError>;
  readonly unsubscribeResource: (
    params: UnsubscribeRequest["params"],
    options?: RequestOptions,
  ) => Effect.Effect<void, McpError>;
  readonly listPrompts: (
    params?: ListPromptsRequest["params"],
    options?: CacheableRequestOptions,
  ) => Effect.Effect<ListPromptsResult, McpError>;
  readonly getPrompt: (
    params: GetPromptRequest["params"],
    options?: RequestOptions,
  ) => Effect.Effect<GetPromptResult, McpError>;
  readonly complete: (
    params: CompleteRequest["params"],
    options?: RequestOptions,
  ) => Effect.Effect<CompleteResult, McpError>;
  readonly setLoggingLevel: (
    level: LoggingLevel,
    options?: RequestOptions,
  ) => Effect.Effect<void, McpError>;
  readonly sendRootsListChanged: Effect.Effect<void, McpError>;
  readonly listen: (
    filter: SubscriptionFilter,
    options?: RequestOptions,
  ) => Effect.Effect<Subscription, McpError, Scope.Scope>;
}

const messageFromCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const mcpError = (operation: string, cause: unknown): McpError =>
  new McpError({
    operation,
    message: messageFromCause(cause),
    cause,
  });

const withEffectSignal = (
  options: RequestOptions | undefined,
  signal: AbortSignal,
): RequestOptions => {
  const combinedSignal = options?.signal ? AbortSignal.any([signal, options.signal]) : signal;
  return { ...options, signal: combinedSignal };
};

const trySdkPromise = <A>(
  operation: string,
  run: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, McpError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => mcpError(operation, cause),
  }).pipe(Effect.withSpan(`McpClient.${operation}`));

const createTransport = (transport: Transport): Effect.Effect<SdkTransport, McpError> =>
  Effect.try({
    try: () =>
      Transport.$match(transport, {
        Http: ({ url, options }) =>
          new StreamableHTTPClientTransport(typeof url === "string" ? new URL(url) : url, options),
        Stdio: ({ options }) => new StdioClientTransport(options),
        Custom: ({ transport }) => transport,
      }),
    catch: (cause) => mcpError("createTransport", cause),
  });

const mergeHandlerCapabilities = <R>(options: Options<R>): ClientCapabilities => {
  const capabilities = options.capabilities ?? {};
  return {
    ...capabilities,
    ...(options.handlers?.sampling === undefined ? {} : { sampling: capabilities.sampling ?? {} }),
    ...(options.handlers?.elicitation === undefined
      ? {}
      : { elicitation: capabilities.elicitation ?? {} }),
    ...(options.handlers?.roots === undefined ? {} : { roots: capabilities.roots ?? {} }),
  };
};

export const create = <R = never>(
  options: Options<R>,
): Effect.Effect<Interface, McpError, Scope.Scope | R> =>
  Effect.gen(function* () {
    const handlerContext = yield* Effect.context<R>();
    const notificationPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ServerNotification>(),
      PubSub.shutdown,
    );
    const errorPubSub = yield* Effect.acquireRelease(PubSub.unbounded<McpError>(), PubSub.shutdown);
    const connectionClosed = yield* Deferred.make<void>();
    const transport = yield* createTransport(options.transport);
    const sdk = new SdkClient(options.clientInfo, {
      ...options.clientOptions,
      capabilities: mergeHandlerCapabilities(options),
      versionNegotiation: options.protocol,
    });

    const runPromise = Effect.runPromiseWith(handlerContext);
    const runFork = Effect.runForkWith(handlerContext);

    const sampling = options.handlers?.sampling;
    if (sampling !== undefined) {
      sdk.setRequestHandler("sampling/createMessage", (request, context) =>
        runPromise(sampling(request), { signal: context.mcpReq.signal }),
      );
    }
    const elicitation = options.handlers?.elicitation;
    if (elicitation !== undefined) {
      sdk.setRequestHandler("elicitation/create", (request, context) =>
        runPromise(elicitation(request), { signal: context.mcpReq.signal }),
      );
    }
    const roots = options.handlers?.roots;
    if (roots !== undefined) {
      sdk.setRequestHandler("roots/list", (request, context) =>
        runPromise(roots(request), { signal: context.mcpReq.signal }),
      );
    }

    sdk.fallbackNotificationHandler = (notification) => {
      if (!isSpecType.ServerNotification(notification)) return Promise.resolve();
      return runPromise(PubSub.publish(notificationPubSub, notification)).then(() => undefined);
    };
    sdk.onerror = (cause) => {
      runFork(PubSub.publish(errorPubSub, mcpError("onerror", cause)));
    };
    sdk.onclose = () => {
      runFork(Deferred.succeed(connectionClosed, undefined));
    };

    const close = trySdkPromise("close", () => sdk.close()).pipe(
      Effect.ignore({ log: "Warn", message: "Error closing MCP client" }),
    );
    yield* Effect.acquireRelease(
      trySdkPromise("connect", (signal) => sdk.connect(transport, { signal })).pipe(
        Effect.onError(() => close),
      ),
      () => close,
      { interruptible: true },
    );

    const request = <A>(
      operation: string,
      requestOptions: RequestOptions | undefined,
      run: (options: RequestOptions) => PromiseLike<A>,
    ): Effect.Effect<A, McpError> =>
      trySdkPromise(operation, (signal) => run(withEffectSignal(requestOptions, signal)));

    const listen: Interface["listen"] = (filter, requestOptions) =>
      Effect.acquireRelease(
        request("listen", requestOptions, (withSignal) => sdk.listen(filter, withSignal)),
        (subscription) =>
          trySdkPromise("closeSubscription", () => subscription.close()).pipe(
            Effect.ignore({ log: "Warn", message: "Error closing MCP subscription" }),
          ),
      ).pipe(
        Effect.map((subscription) => ({
          honoredFilter: subscription.honoredFilter,
          closed: Effect.promise(() => subscription.closed),
        })),
      );

    const protocolVersion = sdk.getNegotiatedProtocolVersion();
    const protocolEra = sdk.getProtocolEra();
    const serverCapabilities = sdk.getServerCapabilities();
    if (
      protocolVersion === undefined ||
      protocolEra === undefined ||
      serverCapabilities === undefined
    ) {
      return yield* mcpError(
        "connect",
        new Error("MCP client connected without negotiated metadata"),
      );
    }

    return {
      serverInfo: Option.fromNullishOr(sdk.getServerVersion()),
      serverCapabilities,
      protocolVersion,
      protocolEra,
      instructions: Option.fromNullishOr(sdk.getInstructions()),
      discoverResult: Option.fromNullishOr(sdk.getDiscoverResult()),
      notifications: Stream.fromPubSub(notificationPubSub),
      errors: Stream.fromPubSub(errorPubSub),
      closed: Deferred.await(connectionClosed),
      ping: (requestOptions) =>
        request("ping", requestOptions, (withSignal) => sdk.ping(withSignal)).pipe(Effect.asVoid),
      discover: (requestOptions) =>
        request("discover", requestOptions, (withSignal) => sdk.discover(withSignal)),
      listTools: (params, requestOptions) =>
        request("listTools", requestOptions, (withSignal) => sdk.listTools(params, withSignal)),
      callTool: (params, requestOptions) =>
        request("callTool", requestOptions, (withSignal) => sdk.callTool(params, withSignal)),
      listResources: (params, requestOptions) =>
        request("listResources", requestOptions, (withSignal) =>
          sdk.listResources(params, withSignal),
        ),
      listResourceTemplates: (params, requestOptions) =>
        request("listResourceTemplates", requestOptions, (withSignal) =>
          sdk.listResourceTemplates(params, withSignal),
        ),
      readResource: (params, requestOptions) =>
        request("readResource", requestOptions, (withSignal) =>
          sdk.readResource(params, withSignal),
        ),
      subscribeResource: (params, requestOptions) =>
        request("subscribeResource", requestOptions, (withSignal) =>
          sdk.subscribeResource(params, withSignal),
        ).pipe(Effect.asVoid),
      unsubscribeResource: (params, requestOptions) =>
        request("unsubscribeResource", requestOptions, (withSignal) =>
          sdk.unsubscribeResource(params, withSignal),
        ).pipe(Effect.asVoid),
      listPrompts: (params, requestOptions) =>
        request("listPrompts", requestOptions, (withSignal) => sdk.listPrompts(params, withSignal)),
      getPrompt: (params, requestOptions) =>
        request("getPrompt", requestOptions, (withSignal) => sdk.getPrompt(params, withSignal)),
      complete: (params, requestOptions) =>
        request("complete", requestOptions, (withSignal) => sdk.complete(params, withSignal)),
      setLoggingLevel: (level, requestOptions) =>
        request("setLoggingLevel", requestOptions, (withSignal) =>
          sdk.setLoggingLevel(level, withSignal),
        ).pipe(Effect.asVoid),
      sendRootsListChanged: trySdkPromise("sendRootsListChanged", () => sdk.sendRootsListChanged()),
      listen,
    } satisfies Interface;
  });

export * as McpClient from "./client.ts";
