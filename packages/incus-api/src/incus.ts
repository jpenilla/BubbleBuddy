import { NodeServices } from "@effect/platform-node";
import { Context, Effect, Layer } from "effect";

import * as Api from "./api.ts";
import * as Config from "./config.ts";
import * as Containers from "./containers.ts";
import * as Http from "./http-client.ts";
import * as Operations from "./operations.ts";

export interface IncusProject {
  readonly name: string;
  readonly containers: Containers.IncusContainers;
}

export class Incus extends Context.Service<
  Incus,
  {
    readonly project: (name: string) => IncusProject;
  }
>()("incus-api/Incus") {
  static layer = Layer.effect(
    Incus,
    Effect.gen(function* () {
      const api = yield* Api.IncusApi;
      const operations = yield* Operations.IncusOperations;
      return Incus.of({
        project: (name) => ({
          name,
          containers: Containers.make(name, api, operations),
        }),
      });
    }),
  );
  static readonly live = (options: Config.IncusConfigOptions = {}): Layer.Layer<Incus> =>
    Incus.layer.pipe(
      Layer.provide(Operations.IncusOperations.layer),
      Layer.provide(Api.IncusApi.layer),
      Layer.provide(Http.IncusHttpClient.layer),
      Layer.provide(Http.IncusHttpClient.nodeHttpLayer),
      Layer.provide(Config.IncusConfig.layer(options)),
      Layer.provideMerge(NodeServices.layer),
    );
  static readonly liveLocal = (
    options: Omit<Config.IncusConfigOptions, "endpoint"> & { readonly socketPath?: string } = {},
  ): Layer.Layer<Incus> => {
    const { socketPath, ...rest } = options;
    return Incus.live({ ...rest, endpoint: { type: "unix", socketPath } });
  };
  static readonly liveRemote = (
    options: Omit<Config.IncusConfigOptions, "endpoint"> &
      Omit<Extract<Config.IncusEndpoint, { readonly type: "https" }>, "type">,
  ): Layer.Layer<Incus> =>
    Incus.live({
      ...options,
      endpoint: { type: "https", baseUrl: options.baseUrl, tls: options.tls },
    });
}
