import { NodeHttpClient } from "@effect/platform-node";
import { Context, Effect, Layer } from "effect";
import { identity } from "effect/Function";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Http from "node:http";
import * as Https from "node:https";
import * as net from "node:net";

import { IncusConfig, type IncusConfigService } from "./config.ts";

export class IncusHttpClient extends Context.Service<IncusHttpClient, HttpClient.HttpClient>()(
  "incus-api/IncusHttpClient",
  {
    make: Effect.gen(function* () {
      const baseClient = yield* HttpClient.HttpClient;
      const config = yield* IncusConfig;
      const baseUrl = config.endpoint.type === "unix" ? "http://incus" : config.endpoint.baseUrl;
      return baseClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(baseUrl)),
        config.transformClient ?? identity,
      );
    }),
  },
) {
  static readonly layer: Layer.Layer<IncusHttpClient, never, HttpClient.HttpClient | IncusConfig> =
    Layer.effect(this, this.make);

  static readonly nodeHttpLayer: Layer.Layer<HttpClient.HttpClient, never, IncusConfig> =
    Layer.unwrap(
      Effect.gen(function* () {
        const config = yield* IncusConfig;
        return NodeHttpClient.layerNodeHttpNoAgent.pipe(
          Layer.provide(
            Layer.effect(
              NodeHttpClient.HttpAgent,
              Effect.acquireRelease(
                Effect.sync(() => makeAgents(config.endpoint)),
                ({ http, https }) =>
                  Effect.sync(() => {
                    http.destroy();
                    https.destroy();
                  }),
              ),
            ),
          ),
        );
      }),
    );
}

const makeAgents = (endpoint: IncusConfigService["endpoint"]) => {
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
