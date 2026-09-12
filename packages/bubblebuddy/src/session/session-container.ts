import { Cause, Context, Effect, Layer, ScopedRef, Semaphore } from "effect";
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

      const get = containerLock
        .withPermit(
          Effect.gen(function* () {
            const current = yield* ScopedRef.get(containerRef);
            if (current !== undefined) return current;

            yield* ScopedRef.set(
              containerRef,
              Effect.gen(function* () {
                const container = yield* incus.project("default").containers.scoped({
                  image: {
                    type: "remote",
                    alias: "debian/13",
                    server: "https://images.linuxcontainers.org",
                  },
                  profiles: ["default"],
                  mounts: [{ source: options.workspaceDir, path: cwd }],
                });
                const attributes = {
                  channelId: options.channelId,
                  containerName: container.name,
                  incusProject: container.project,
                };
                yield* Effect.annotateCurrentSpan(attributes);
                yield* Effect.logInfo("Incus container started").pipe(
                  Effect.annotateLogs(attributes),
                );
                yield* Effect.addFinalizer(() =>
                  Effect.logInfo("Releasing Incus container").pipe(Effect.annotateLogs(attributes)),
                );
                return container;
              }).pipe(
                Effect.tapError((error) =>
                  Effect.logWarning("Failed to start Incus container", Cause.fail(error)),
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
        )
        .pipe(
          Effect.annotateLogs({ channelId: options.channelId }),
          Effect.withSpan("SessionContainer.get", { attributes: { channelId: options.channelId } }),
        );

      return Service.of({ cwd, get });
    }),
  );

export * as SessionContainer from "./session-container.ts";
