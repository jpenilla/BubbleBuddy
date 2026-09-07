import { NodeHttpClient } from "@effect/platform-node";
import { Context, Effect, Layer } from "effect";
import { identity } from "effect/Function";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Http from "node:http";
import * as Https from "node:https";
import * as net from "node:net";

import { IncusConfig } from "./incus-config.ts";

export interface Interface extends HttpClient.HttpClient {}

export class Service extends Context.Service<Service, Interface>()("incus-api/IncusHttpClient") {}

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient | IncusConfig.Service> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const baseClient = yield* HttpClient.HttpClient;
      const config = yield* IncusConfig.Service;
      const baseUrl = config.endpoint.type === "unix" ? "http://incus" : config.endpoint.baseUrl;
      return Service.of(
        baseClient.pipe(
          HttpClient.mapRequest(HttpClientRequest.prependUrl(baseUrl)),
          config.transformClient ?? identity,
        ),
      );
    }),
  );

export const nodeHttpLayer: Layer.Layer<HttpClient.HttpClient, never, IncusConfig.Service> =
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* IncusConfig.Service;
      return NodeHttpClient.layerNodeHttpNoAgent.pipe(
        Layer.provide(
          Layer.effect(
            NodeHttpClient.HttpAgent,
            Effect.acquireRelease(
              Effect.sync(() => createAgents(config.endpoint)),
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

const createAgents = (endpoint: IncusConfig.Interface["endpoint"]) => {
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

export * as IncusHttpClient from "./incus-http-client.ts";
