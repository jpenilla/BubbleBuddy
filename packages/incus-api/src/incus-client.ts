import { Context, Effect, Layer } from "effect";

import { IncusContainerOperations } from "./incus-container-operations.ts";
import { IncusContainer } from "./incus-container.ts";
import { IncusApi } from "./incus-api.ts";
import { IncusTransport } from "./incus-transport.ts";

export interface Project {
  readonly name: string;
  readonly containers: IncusContainer.ContainerCollection;
}

export interface Interface {
  readonly project: (name: string) => Project;
}

export class Service extends Context.Service<Service, Interface>()("incus-api/IncusClient") {}

export const layerNoDeps: Layer.Layer<Service, never, IncusApi.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const api = yield* IncusApi.Service;
    return Service.of({
      project: (name) => ({
        name,
        containers: IncusContainerOperations.create(name, api),
      }),
    });
  }),
);

export const layer = (options: IncusTransport.ConnectionOptions): Layer.Layer<Service> =>
  layerNoDeps.pipe(Layer.provide(IncusApi.layer), Layer.provide(IncusTransport.layer(options)));

export * as IncusClient from "./incus-client.ts";
