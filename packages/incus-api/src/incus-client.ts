import { Context, Effect, Layer } from "effect";

import { GuestPath } from "./guest-path.ts";
import { IncusApi } from "./incus-api.ts";
import { IncusContainerOperations } from "./incus-container-operations.ts";
import { type IncusContainer } from "./incus-container.ts";
import { IncusTransport } from "./incus-transport.ts";

export interface Project {
  readonly name: string;
  readonly containers: IncusContainer.ContainerCollection;
}

export interface Interface {
  readonly project: (name: string) => Project;
}

export class Service extends Context.Service<Service, Interface>()("incus-api/IncusClient") {}

export const layerNoDeps: Layer.Layer<Service, never, IncusApi.Service | GuestPath.Service> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const api = yield* IncusApi.Service;
      const guestPath = yield* GuestPath.Service;
      return Service.of({
        project: (name) => ({
          name,
          containers: IncusContainerOperations.create(name, api, guestPath),
        }),
      });
    }),
  );

export const layer = (options: IncusTransport.ConnectionOptions): Layer.Layer<Service> =>
  layerNoDeps.pipe(
    Layer.provide(IncusApi.layer),
    Layer.provide(IncusTransport.layer(options)),
    Layer.provide(GuestPath.layer),
  );

export * as IncusClient from "./incus-client.ts";
