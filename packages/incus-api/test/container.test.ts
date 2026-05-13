import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import {
  Incus,
  IncusContainerMetadataError,
  IncusContainerPathError,
  type IncusImage,
} from "../src/index.ts";
import { IncusApi, type IncusApiService } from "../src/api.ts";
import { IncusOperations, type IncusOperationsService } from "../src/operations.ts";

const debianImage: IncusImage = {
  type: "remote",
  alias: "debian/12",
  server: "https://images.linuxcontainers.org",
};

const operation = { id: "op" };

const notImplemented = (method: string) =>
  Effect.die(new Error(`Unexpected Incus API call: ${method}`));

const makeFakeApi = (overrides: {
  readonly create?: IncusApiService["instances"]["create"];
  readonly exists?: IncusApiService["instances"]["exists"];
  readonly delete?: IncusApiService["instances"]["delete"];
  readonly setState?: IncusApiService["instances"]["setState"];
  readonly exec?: IncusApiService["instances"]["exec"];
  readonly readBytes?: IncusApiService["instances"]["files"]["readBytes"];
  readonly readText?: IncusApiService["instances"]["files"]["readText"];
  readonly stat?: IncusApiService["instances"]["files"]["stat"];
  readonly write?: IncusApiService["instances"]["files"]["write"];
  readonly readExecOutput?: IncusApiService["instances"]["files"]["readExecOutput"];
}): IncusApiService => ({
  instances: {
    create: overrides.create ?? (() => notImplemented("instances.create")),
    exists: overrides.exists ?? (() => notImplemented("instances.exists")),
    delete: overrides.delete ?? (() => notImplemented("instances.delete")),
    setState: overrides.setState ?? (() => notImplemented("instances.setState")),
    exec: overrides.exec ?? (() => notImplemented("instances.exec")),
    files: {
      readBytes: overrides.readBytes ?? (() => notImplemented("instances.files.readBytes")),
      readText: overrides.readText ?? (() => notImplemented("instances.files.readText")),
      stat: overrides.stat ?? (() => notImplemented("instances.files.stat")),
      write: overrides.write ?? (() => notImplemented("instances.files.write")),
      readExecOutput:
        overrides.readExecOutput ?? (() => notImplemented("instances.files.readExecOutput")),
    },
  },
  operations: {
    wait: () => notImplemented("operations.wait"),
    cancel: () => notImplemented("operations.cancel"),
  },
});

const makeFakeOperations = (
  overrides: Partial<IncusOperationsService> = {},
): IncusOperationsService => ({
  wait: () => Effect.succeed({ metadata: { status_code: 200 } }),
  waitInterruptible: () =>
    Effect.succeed({ metadata: { status_code: 200, metadata: { return: 0 } } }),
  ...overrides,
});

const makeLayer = (
  api: IncusApiService,
  operations: IncusOperationsService = makeFakeOperations(),
) =>
  Incus.layer.pipe(
    Layer.provide(Layer.succeed(IncusApi, api)),
    Layer.provide(Layer.succeed(IncusOperations, operations)),
  );

const extractError = <E>(exit: Exit.Exit<unknown, E>): E | undefined => {
  if (exit._tag !== "Failure") return undefined;
  const option = Cause.findErrorOption(exit.cause);
  return Option.isSome(option) ? option.value : undefined;
};

describe("Incus project container API", () => {
  it.effect("creates a scoped ephemeral container bound to a project", () => {
    const calls: Array<unknown> = [];
    const api = makeFakeApi({
      create: (payload, options) => {
        calls.push({ payload, options });
        return Effect.succeed(operation);
      },
      setState: () => Effect.succeed(operation),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const incus = yield* Incus;
        const container = yield* incus.project("ci").containers.scoped({ image: debianImage });

        assert.strictEqual(container.project, "ci");
        assert.match(container.name, /^incus-api-/);
        assert.strictEqual(calls.length, 1);
      }),
    ).pipe(Effect.provide(makeLayer(api)));
  });

  it.effect("exec reads recorded output from the project-bound API", () => {
    const api = makeFakeApi({
      create: () => Effect.succeed(operation),
      setState: () => Effect.succeed(operation),
      exec: () => Effect.succeed(operation),
      readExecOutput: (path) =>
        Effect.succeed(
          path === "/1.0/instances/test/logs/exec-output/exec_123.stdout" ? "hello" : "",
        ),
    });
    const operations = makeFakeOperations({
      waitInterruptible: () =>
        Effect.succeed({
          metadata: {
            status_code: 200,
            metadata: {
              return: 0,
              output: {
                "1": "/1.0/instances/test/logs/exec-output/exec_123.stdout",
                "2": "/1.0/instances/test/logs/exec-output/exec_123.stderr",
              },
            },
          },
        }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const incus = yield* Incus;
        const container = yield* incus.project("ci").containers.scoped({
          name: "test",
          image: debianImage,
        });
        const result = yield* container.exec(["printf", "hello"]);

        assert.deepStrictEqual(result, { exitCode: 0, stdout: "hello", stderr: "" });
      }),
    ).pipe(Effect.provide(makeLayer(api, operations)));
  });

  it.effect("stops an ephemeral container when the scope closes", () => {
    let stopped = false;
    let deleted = false;
    const api = makeFakeApi({
      create: () => Effect.succeed(operation),
      setState: () =>
        Effect.sync(() => {
          stopped = true;
          return operation;
        }),
      delete: () =>
        Effect.sync(() => {
          deleted = true;
          return operation;
        }),
    });

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const incus = yield* Incus;
          yield* incus.project("ci").containers.scoped({ name: "test", image: debianImage });
        }),
      );

      assert.strictEqual(stopped, true);
      assert.strictEqual(deleted, false);
    }).pipe(Effect.provide(makeLayer(api)));
  });

  it.effect("attempts delete when stopping during cleanup fails", () => {
    let deleted = false;
    const api = makeFakeApi({
      create: () => Effect.succeed(operation),
      setState: () => Effect.fail(new Error("stop failed") as never),
      delete: () =>
        Effect.sync(() => {
          deleted = true;
          return operation;
        }),
    });

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const incus = yield* Incus;
          yield* incus.project("ci").containers.scoped({ name: "test", image: debianImage });
        }),
      );

      assert.strictEqual(deleted, true);
    }).pipe(Effect.provide(makeLayer(api)));
  });

  it.effect("cleans up when creation succeeds but waiting for start fails", () => {
    let stopped = false;
    const api = makeFakeApi({
      create: () => Effect.succeed(operation),
      setState: () =>
        Effect.sync(() => {
          stopped = true;
          return operation;
        }),
    });
    const operations = makeFakeOperations({
      wait: () => Effect.fail(new Error("wait failed") as never),
    });

    return Effect.gen(function* () {
      const incus = yield* Incus;
      const exit = yield* Effect.exit(
        Effect.scoped(incus.project("ci").containers.scoped({ name: "test", image: debianImage })),
      );

      assert.strictEqual(exit._tag, "Failure");
      assert.strictEqual(stopped, true);
    }).pipe(Effect.provide(makeLayer(api, operations)));
  });

  it.effect("creates parent directories before writing files when requested", () => {
    const calls: Array<unknown> = [];
    const api = makeFakeApi({
      create: () => Effect.succeed(operation),
      setState: () => Effect.succeed(operation),
      stat: (_name, path) => {
        calls.push({ method: "stat", path });
        return Effect.succeed(null);
      },
      write: (_name, path, body, headers) => {
        calls.push({ method: "write", path, body, headers });
        return Effect.void;
      },
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const incus = yield* Incus;
        const container = yield* incus.project("ci").containers.scoped({
          name: "test",
          image: debianImage,
        });
        yield* container.files.write("tmp/a/b.txt", "hello", {
          createParents: true,
          uid: 1000,
          gid: 1000,
          mode: 0o644,
        });

        assert.deepStrictEqual(calls, [
          { method: "stat", path: "/tmp" },
          {
            method: "write",
            path: "/tmp",
            body: undefined,
            headers: { "x-incus-type": "directory", "x-incus-uid": "1000", "x-incus-gid": "1000" },
          },
          { method: "stat", path: "/tmp/a" },
          {
            method: "write",
            path: "/tmp/a",
            body: undefined,
            headers: { "x-incus-type": "directory", "x-incus-uid": "1000", "x-incus-gid": "1000" },
          },
          {
            method: "write",
            path: "tmp/a/b.txt",
            body: "hello",
            headers: {
              "x-incus-type": "file",
              "x-incus-uid": "1000",
              "x-incus-gid": "1000",
              "x-incus-mode": "420",
            },
          },
        ]);
      }),
    ).pipe(Effect.provide(makeLayer(api)));
  });

  it.effect("mkdir recursive fails when an existing path is not a directory", () => {
    const api = makeFakeApi({
      create: () => Effect.succeed(operation),
      setState: () => Effect.succeed(operation),
      stat: (_name, path) =>
        Effect.succeed(path === "/tmp" ? { type: "file" } : { type: "directory" }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const incus = yield* Incus;
        const container = yield* incus.project("ci").containers.scoped({
          name: "test",
          image: debianImage,
        });
        const exit = yield* Effect.exit(container.files.mkdir("/tmp/a", { recursive: true }));

        assert.strictEqual(exit._tag, "Failure");
        assert.instanceOf(extractError(exit), IncusContainerPathError);
      }),
    ).pipe(Effect.provide(makeLayer(api)));
  });

  it.effect("exec fails with a metadata error when operation metadata is malformed", () => {
    const api = makeFakeApi({
      create: () => Effect.succeed(operation),
      setState: () => Effect.succeed(operation),
      exec: () => Effect.succeed(operation),
    });
    const operations = makeFakeOperations({
      waitInterruptible: () =>
        Effect.succeed({ metadata: { status_code: 200, metadata: { output: {} } } }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const incus = yield* Incus;
        const container = yield* incus.project("ci").containers.scoped({
          name: "test",
          image: debianImage,
        });
        const exit = yield* Effect.exit(container.exec(["true"]));

        assert.strictEqual(exit._tag, "Failure");
        assert.instanceOf(extractError(exit), IncusContainerMetadataError);
      }),
    ).pipe(Effect.provide(makeLayer(api, operations)));
  });
});
