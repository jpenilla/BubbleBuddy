import { Context, Effect, Layer, ScopedRef, Semaphore } from "effect";
import { GuestPath, IncusClient, IncusContainer } from "incus-api";
import type { IncusApi } from "incus-api";

export interface Interface {
  readonly cwd: GuestPath.GuestPath;
  readonly get: Effect.Effect<IncusContainer.Container, IncusApi.ApiError>;
}

export interface Options {
  readonly channelId: string;
  readonly cwd: string;
  readonly workspaceDir: string;
}

export class Service extends Context.Service<Service, Interface>()(
  "bubblebuddy/session/SessionContainer",
) {}

export const layer = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const incus = yield* IncusClient.Service;
      const cwd = yield* GuestPath.of(options.cwd);
      const containerRef = yield* ScopedRef.make<IncusContainer.Container | undefined>(
        () => undefined,
      );
      const containerLock = yield* Semaphore.make(1);

      const get = containerLock.withPermit(
        Effect.gen(function* () {
          const current = yield* ScopedRef.get(containerRef);
          if (current !== undefined) return current;

          yield* ScopedRef.set(
            containerRef,
            Effect.gen(function* () {
              yield* Effect.logInfo(`Starting Incus container for channel ${options.channelId}.`);
              const container = yield* incus.project("default").containers.scoped({
                image: {
                  type: "remote",
                  alias: "debian/13",
                  server: "https://images.linuxcontainers.org",
                },
                profiles: ["default"],
                mounts: [{ source: options.workspaceDir, path: cwd }],
              });
              yield* Effect.addFinalizer(() =>
                Effect.logInfo(`Closing Incus container for channel ${options.channelId}.`),
              );
              return container;
            }).pipe(
              Effect.tapError((error) =>
                Effect.logWarning(
                  `Failed to start Incus container for channel ${options.channelId}: ${String(error)}`,
                ),
              ),
            ),
          );

          const container = yield* ScopedRef.get(containerRef);
          if (container === undefined) {
            return yield* Effect.die(
              new Error("Incus container acquisition produced no container"),
            );
          }
          return container;
        }),
      );

      return Service.of({ cwd, get });
    }),
  );

export * as SessionContainer from "./session-container.ts";
