import { Effect, Ref } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { IncusContainerOperations } from "../src/incus-container-operations.ts";
import { IncusContainer } from "../src/incus-container.ts";
import { IncusApi } from "../src/transport/incus-api.ts";
import type { IncusConfig } from "../src/transport/incus-config.ts";
import { apiFixture, errorFrom } from "./incus-fixtures.ts";

const config: IncusConfig.Interface = {
  endpoint: { type: "unix", socketPath: "/unused/incus.socket" },
  transformClient: undefined,
};

const image: IncusContainer.ImageSource = {
  type: "remote",
  alias: "debian/12",
  server: "https://images.linuxcontainers.org",
};

const successfulOperation: IncusApi.OperationWaitResult = {
  status: "success",
  metadata: { return: 0 },
};

const invalidWebsocketSecretsApi = (cancel: IncusApi.Interface["operations"]["cancel"]) =>
  apiFixture({
    create: () => Effect.succeed({ id: "start" }),
    setState: () => Effect.succeed({ id: "stop" }),
    exec: () => Effect.succeed({ id: "exec-operation", websocketSecrets: { "0": "stdin" } }),
    wait: () => Effect.succeed(successfulOperation),
    cancel,
  });

describe("Incus container operations", () => {
  it.effect("deletes a container after start acquisition fails even when stop cleanup fails", () =>
    Effect.gen(function* () {
      const present = yield* Ref.make(false);
      const startFailure = new IncusApi.OperationError({
        operation: "start",
        message: "image unpack failed",
        metadata: { phase: "start" },
      });
      const cleanupFailure = new IncusApi.OperationError({
        operation: "stop",
        message: "stop failed",
        metadata: { phase: "cleanup" },
      });
      const api = apiFixture({
        create: () => Ref.set(present, true).pipe(Effect.as({ id: "start" })),
        setState: () => Effect.succeed({ id: "stop" }),
        delete: () => Effect.succeed({ id: "delete" }),
        wait: (operation) => {
          if (operation === "start") return Effect.fail(startFailure);
          if (operation === "stop") return Effect.fail(cleanupFailure);
          if (operation === "delete") {
            return Ref.set(present, false).pipe(Effect.as(successfulOperation));
          }
          return Effect.die(new Error(`Unexpected operation wait: ${operation}`));
        },
      });

      const exit = yield* Effect.scoped(
        IncusContainerOperations.create("default", api, config).scoped({
          name: "failed-start",
          image,
        }),
      ).pipe(Effect.exit);

      expect(yield* Ref.get(present)).toBe(false);
      expect(errorFrom(exit)).toBe(startFailure);
    }),
  );

  it.effect("cancels the spawned exec when websocket metadata is invalid", () =>
    Effect.gen(function* () {
      const pending = yield* Ref.make(new Set(["exec-operation"]));
      const api = invalidWebsocketSecretsApi((operation) =>
        operation === "exec-operation"
          ? Ref.update(pending, (operations) => {
              const next = new Set(operations);
              next.delete(operation);
              return next;
            })
          : Effect.die(new Error(`Unexpected cancelled operation: ${operation}`)),
      );

      const exit = yield* Effect.scoped(
        IncusContainerOperations.create("default", api, config)
          .scoped({ name: "container", image })
          .pipe(Effect.flatMap((container) => container.exec(["true"]))),
      ).pipe(Effect.exit);

      expect(yield* Ref.get(pending)).toEqual(new Set());
      const error = errorFrom(exit);
      expect(error).toBeInstanceOf(IncusApi.OperationError);
      if (error instanceof IncusApi.OperationError) {
        expect(error.operation).toBe("exec-operation");
        expect(error.metadata).toMatchObject({ websocketSecrets: { "0": "stdin" } });
      }
    }),
  );

  it.effect("preserves invalid websocket metadata errors when cancellation fails", () =>
    Effect.gen(function* () {
      const cancellationFailure = new IncusApi.OperationError({
        operation: "exec-operation",
        message: "cancel failed",
        metadata: { phase: "cancel" },
      });
      const api = invalidWebsocketSecretsApi((operation) =>
        operation === "exec-operation"
          ? Effect.fail(cancellationFailure)
          : Effect.die(new Error(`Unexpected cancelled operation: ${operation}`)),
      );

      const exit = yield* Effect.scoped(
        IncusContainerOperations.create("default", api, config)
          .scoped({ name: "container", image })
          .pipe(Effect.flatMap((container) => container.exec(["true"]))),
      ).pipe(Effect.exit);

      const error = errorFrom(exit);
      expect(error).toBeInstanceOf(IncusApi.OperationError);
      if (error instanceof IncusApi.OperationError) {
        expect(error.operation).toBe("exec-operation");
        expect(error.metadata).toMatchObject({ websocketSecrets: { "0": "stdin" } });
      }
    }),
  );
});
