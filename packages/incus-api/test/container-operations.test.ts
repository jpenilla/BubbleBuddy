import { Effect, Ref } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { assertInstanceOf } from "@effect/vitest/utils";

import { IncusContainerOperations } from "../src/incus-container-operations.ts";
import { IncusContainer } from "../src/incus-container.ts";
import { IncusApi } from "../src/incus-api.ts";
import { exec } from "../src/incus-exec-session.ts";
import { apiFixture, errorFrom } from "./incus-fixtures.ts";

const image: IncusContainer.ImageSource = {
  type: "remote",
  alias: "debian/12",
  server: "https://images.linuxcontainers.org",
};

const successfulOperation = IncusApi.OperationWaitResult.Success({});

const invalidWebSocketSecretsApi = () =>
  apiFixture({
    create: () => Effect.succeed({ id: "start" }),
    setState: () => Effect.succeed({ id: "stop" }),
    exec: (_name, _payload, _options, release) =>
      Effect.acquireRelease(
        Effect.succeed({ id: "exec-operation", websocketSecrets: { "0": "stdin" } }),
        release,
      ),
    wait: () => Effect.succeed(successfulOperation),
  });

describe("Incus container operations", () => {
  it.effect("rejects an invalid exec timeout before starting a remote operation", () =>
    Effect.gen(function* () {
      let started = false;
      const api = apiFixture({
        exec: () =>
          Effect.sync(() => {
            started = true;
            return { id: "unexpected" };
          }),
      });
      const error = yield* exec("container", "default", api, ["true"], {
        timeoutSeconds: 0.5,
      }).pipe(Effect.flip);
      assertInstanceOf(error, IncusContainer.ExecInvalidOptionsError);
      expect(started).toBe(false);
    }),
  );

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
        IncusContainerOperations.create("default", api).scoped({
          name: "failed-start",
          image,
        }),
      ).pipe(Effect.exit);

      expect(yield* Ref.get(present)).toBe(false);
      expect(errorFrom(exit)).toBe(startFailure);
    }),
  );

  it.effect("rejects invalid exec websocket metadata", () =>
    Effect.gen(function* () {
      const api = invalidWebSocketSecretsApi();
      const exit = yield* Effect.scoped(
        IncusContainerOperations.create("default", api)
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
