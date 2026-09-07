import { Context, Layer } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import type { IncusClient } from "../incus-client.ts";

export interface Interface {
  readonly endpoint:
    | Required<Extract<IncusClient.Endpoint, { readonly type: "unix" }>>
    | Extract<IncusClient.Endpoint, { readonly type: "https" }>;
  readonly transformClient: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined;
}

export class Service extends Context.Service<Service, Interface>()("incus-api/IncusConfig") {}

export const layer = (options: IncusClient.ConnectionOptions = {}) =>
  Layer.succeed(Service, normalize(options));

const normalize = (options: IncusClient.ConnectionOptions): Interface => ({
  endpoint:
    options.endpoint?.type === "https"
      ? options.endpoint
      : { type: "unix", socketPath: options.endpoint?.socketPath ?? "/var/lib/incus/unix.socket" },
  transformClient: options.transformClient,
});

export * as IncusConfig from "./incus-config.ts";
