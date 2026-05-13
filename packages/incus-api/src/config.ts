import { Buffer } from "node:buffer";

import { Context, Layer } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";

export type IncusEndpoint =
  | {
      readonly type: "unix";
      readonly socketPath?: string;
    }
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

export interface IncusConfigOptions {
  readonly endpoint?: IncusEndpoint;
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined;
}

export interface IncusConfigService {
  readonly endpoint:
    | Required<Extract<IncusEndpoint, { readonly type: "unix" }>>
    | Extract<IncusEndpoint, { readonly type: "https" }>;
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined;
}

const make = (options: IncusConfigOptions = {}): IncusConfigService => ({
  endpoint:
    options.endpoint?.type === "https"
      ? options.endpoint
      : { type: "unix", socketPath: options.endpoint?.socketPath ?? "/var/lib/incus/unix.socket" },
  transformClient: options.transformClient,
});

export class IncusConfig extends Context.Service<IncusConfig, IncusConfigService>()(
  "incus-api/IncusConfig",
) {
  static layer = (options: IncusConfigOptions = {}) =>
    Layer.succeed(IncusConfig, IncusConfig.of(make(options)));
}
