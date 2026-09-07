import { NodeServices } from "@effect/platform-node";
import { Buffer } from "node:buffer";

import { Context, Effect, Layer } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import { IncusContainerOperations } from "./incus-container-operations.ts";
import { IncusContainer } from "./incus-container.ts";
import { IncusApi } from "./transport/incus-api.ts";
import { IncusConfig } from "./transport/incus-config.ts";
import { IncusHttpClient } from "./transport/incus-http-client.ts";

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

export interface ConnectionOptions {
  readonly endpoint?: Endpoint;
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined;
}

export interface LocalConnectionOptions extends Omit<ConnectionOptions, "endpoint"> {
  readonly socketPath?: string;
}

export interface RemoteConnectionOptions
  extends
    Omit<ConnectionOptions, "endpoint">,
    Omit<Extract<Endpoint, { readonly type: "https" }>, "type"> {}

export interface Project {
  readonly name: string;
  readonly containers: IncusContainer.ContainerCollection;
}

export interface Interface {
  readonly project: (name: string) => Project;
}

export class Service extends Context.Service<Service, Interface>()("incus-api/IncusClient") {}

const layerNoDeps = Layer.effect(
  Service,
  Effect.gen(function* () {
    const api = yield* IncusApi.Service;
    const config = yield* IncusConfig.Service;
    return Service.of({
      project: (name) => ({
        name,
        containers: IncusContainerOperations.create(name, api, config),
      }),
    });
  }),
);

export const layer = (options: ConnectionOptions = {}): Layer.Layer<Service> =>
  layerNoDeps.pipe(
    Layer.provide(IncusApi.layer),
    Layer.provide(IncusHttpClient.layer),
    Layer.provide(IncusHttpClient.nodeHttpLayer),
    Layer.provide(IncusConfig.layer(options)),
    Layer.provide(NodeServices.layer),
  );

export const layerLocal = (options: LocalConnectionOptions = {}): Layer.Layer<Service> => {
  const { socketPath, ...rest } = options;
  return layer({ ...rest, endpoint: { type: "unix", socketPath } });
};

export const layerRemote = (options: RemoteConnectionOptions): Layer.Layer<Service> =>
  layer({
    ...options,
    endpoint: { type: "https", baseUrl: options.baseUrl, tls: options.tls },
  });

export * as IncusClient from "./incus-client.ts";
