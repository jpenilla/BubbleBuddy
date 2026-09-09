import { NodeHttpClient, NodeSocket } from "@effect/platform-node";
import { Buffer } from "node:buffer";
import * as Http from "node:http";
import * as Https from "node:https";
import * as net from "node:net";

import { Context, Duration, Effect, Layer } from "effect";
import { identity } from "effect/Function";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Socket from "effect/unstable/socket/Socket";

export type Endpoint =
  | { readonly type: "unix"; readonly socketPath?: string }
  | {
      readonly type: "https";
      readonly baseUrl: string;
      readonly tls?: {
        readonly caCert?: string | Buffer;
        readonly clientCert?: string | Buffer;
        readonly clientKey?: string | Buffer;
        readonly rejectUnauthorized?: boolean;
      };
    };

type ResolvedEndpoint =
  | Required<Extract<Endpoint, { readonly type: "unix" }>>
  | Extract<Endpoint, { readonly type: "https" }>;

export interface ConnectionOptions {
  readonly endpoint: Endpoint;
  readonly transformHttpClient?:
    | ((client: HttpClient.HttpClient) => HttpClient.HttpClient)
    | undefined;
}

export interface WebSocketOptions {
  readonly openTimeout?: Duration.Input;
  readonly closeCodeIsError?: (code: number) => boolean;
}

export interface Interface {
  readonly httpClient: HttpClient.HttpClient;
  readonly makeWebSocket: (
    path: string,
    options?: WebSocketOptions,
  ) => Effect.Effect<Socket.Socket>;
}

export class Service extends Context.Service<Service, Interface>()("incus-api/IncusTransport") {}

export const layer = (options: ConnectionOptions): Layer.Layer<Service> => {
  const endpoint =
    options.endpoint.type === "https"
      ? options.endpoint
      : {
          type: "unix" as const,
          socketPath: options.endpoint.socketPath ?? "/var/lib/incus/unix.socket",
        };
  const baseUrl = endpoint.type === "unix" ? "http://incus" : endpoint.baseUrl;

  const transportLayer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const baseClient = yield* HttpClient.HttpClient;
      const httpClient = baseClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(baseUrl)),
        options.transformHttpClient ?? identity,
      );

      const makeWebSocket = Effect.fn("IncusTransport.makeWebSocket")(function* (
        path: string,
        socketOptions?: WebSocketOptions,
      ) {
        const url = `${webSocketBaseUrl(endpoint)}${path}`;
        const acquire = Effect.acquireRelease(
          Effect.sync(() => createWebSocket(endpoint, url)),
          (webSocket) => Effect.sync(() => webSocket.close(1000)),
        );
        return yield* Socket.fromWebSocket(acquire, socketOptions);
      });

      return Service.of({ httpClient, makeWebSocket });
    }),
  );

  return transportLayer.pipe(Layer.provide(nodeHttpClientLayer(endpoint)));
};

const nodeHttpClientLayer = (endpoint: ResolvedEndpoint) =>
  NodeHttpClient.layerNodeHttpNoAgent.pipe(
    Layer.provide(
      Layer.effect(
        NodeHttpClient.HttpAgent,
        Effect.acquireRelease(
          Effect.sync(() => createAgents(endpoint)),
          ({ http, https }) =>
            Effect.sync(() => {
              http.destroy();
              https.destroy();
            }),
        ),
      ),
    ),
  );

const createAgents = (endpoint: ResolvedEndpoint) => {
  if (endpoint.type === "unix") {
    return {
      http: new UnixSocketAgent(endpoint.socketPath),
      https: new Https.Agent(),
    };
  }
  return {
    http: new Http.Agent({ keepAlive: true }),
    https: new Https.Agent({
      keepAlive: true,
      ca: endpoint.tls?.caCert,
      cert: endpoint.tls?.clientCert,
      key: endpoint.tls?.clientKey,
      rejectUnauthorized: endpoint.tls?.rejectUnauthorized,
    }),
  };
};

const webSocketBaseUrl = (endpoint: ResolvedEndpoint) =>
  endpoint.type === "unix"
    ? "ws://incus"
    : endpoint.baseUrl.replace(/^https?/, (protocol) => (protocol === "https" ? "wss" : "ws"));

const createWebSocket = (endpoint: ResolvedEndpoint, url: string): globalThis.WebSocket => {
  if (endpoint.type === "unix") {
    return new NodeSocket.NodeWS.WebSocket(url, undefined, {
      createConnection: () => net.createConnection({ path: endpoint.socketPath }),
    }) as unknown as globalThis.WebSocket;
  }
  return new NodeSocket.NodeWS.WebSocket(url, undefined, {
    ca: endpoint.tls?.caCert,
    cert: endpoint.tls?.clientCert,
    key: endpoint.tls?.clientKey,
    rejectUnauthorized: endpoint.tls?.rejectUnauthorized,
  }) as unknown as globalThis.WebSocket;
};

class UnixSocketAgent extends Http.Agent {
  readonly #socketPath: string;

  constructor(socketPath: string) {
    super({ keepAlive: true });
    this.#socketPath = socketPath;
  }

  override createConnection(
    _options: net.NetConnectOpts,
    callback?: (err: Error | null, stream: net.Socket) => void,
  ): net.Socket {
    let callbackCalled = false;
    const callCallback = (error: Error | null, socket: net.Socket) => {
      if (callbackCalled) return;
      callbackCalled = true;
      callback?.(error, socket);
    };
    const socket = net.createConnection({ path: this.#socketPath }, () =>
      callCallback(null, socket),
    );
    socket.once("error", (error) => callCallback(error, socket));
    return socket;
  }
}

export * as IncusTransport from "./incus-transport.ts";
