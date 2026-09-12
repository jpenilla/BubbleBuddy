import { GuestPath } from "../src/guest-path.ts";
import { randomUUID } from "node:crypto";

import { assert, describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";

import { IncusApi, IncusClient, IncusContainer } from "../src/index.ts";

const IncusClientLayer = IncusClient.layer({ endpoint: { type: "unix" } });

const describeIntegration = process.env.INCUS_API_INTEGRATION === "1" ? describe : describe.skip;

const integrationImage: IncusContainer.ImageSource = {
  type: "remote",
  alias: "debian/12",
  server: "https://images.linuxcontainers.org",
};

const concatenate = (chunks: Iterable<Uint8Array>): Uint8Array => {
  const values = Array.from(chunks);
  const result = new Uint8Array(values.reduce((length, chunk) => length + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of values) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const binaryFixture = (): Uint8Array => {
  const bytes = new Uint8Array(1024 * 1024);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = (index * 31 + Math.floor(index / 257)) % 256;
  }
  return bytes;
};

const expectedStdout = Array.from(
  { length: 4096 },
  (_, index) => `stdout-${String(index).padStart(4, "0")}\n`,
).join("");

const processIdentityScript = (pidPath: string) =>
  [
    `pid_path=${JSON.stringify(pidPath)}`,
    "pid=$$",
    "case \"$pid\" in ''|*[!0-9]*) exit 92 ;; esac",
    "start_time=$(awk '{ print $22 }' \"/proc/$$/stat\")",
    "case \"$start_time\" in ''|*[!0-9]*) exit 93 ;; esac",
    'printf "%s %s\\n" "$$" "$start_time" > "$pid_path"',
    'identity=$(cat "$pid_path") || exit 94',
    "set -- $identity",
    '[ "$#" -eq 2 ] || exit 95',
    '[ "$1" = "$pid" ] && [ "$2" = "$start_time" ] || exit 96',
    'printf "ready\\n"',
  ].join("; ");

// Records a PID/start-time identity, signals readiness, then blocks until killed.
const blockingProcessCommand = (pidPath: string): string[] => [
  "/bin/sh",
  "-lc",
  [processIdentityScript(pidPath), "exec sleep 60"].join("; "),
];

const processTerminationCheckScript = (pidPath: string) =>
  [
    `pid_path=${JSON.stringify(pidPath)}`,
    'identity=$(cat "$pid_path") || exit 20',
    "set -- $identity",
    '[ "$#" -eq 2 ] || exit 21',
    "pid=$1",
    "start_time=$2",
    "case \"$pid\" in ''|*[!0-9]*) exit 22 ;; esac",
    "case \"$start_time\" in ''|*[!0-9]*) exit 23 ;; esac",
    "attempt=0",
    'while [ "$attempt" -lt 10 ]; do',
    '  stat_path="/proc/$pid/stat"',
    '  if [ ! -e "$stat_path" ]; then exit 0; fi',
    '  if [ ! -r "$stat_path" ]; then',
    '    [ ! -e "$stat_path" ] && exit 0',
    "    exit 24",
    "  fi",
    "  current_start_time=$(awk '{ print $22 }' \"$stat_path\") || {",
    '    [ ! -e "$stat_path" ] && exit 0',
    "    exit 25",
    "  }",
    "  case \"$current_start_time\" in ''|*[!0-9]*) exit 26 ;; esac",
    '  if [ "$current_start_time" != "$start_time" ]; then exit 0; fi',
    "  attempt=$((attempt + 1))",
    "  sleep 1",
    "done",
    "exit 1",
  ].join("\n");

const withContainer = <A, E>(
  body: (container: IncusContainer.Container) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const incus = yield* IncusClient.Service;
    const containers = incus.project("default").containers;
    const name = `incus-api-integration-${randomUUID().slice(0, 8)}`;
    const scenarioExit = yield* Effect.scoped(
      Effect.gen(function* () {
        const container = yield* containers.scoped({
          name,
          image: integrationImage,
          profiles: ["default"],
        });
        return yield* body(container);
      }),
    ).pipe(Effect.exit);
    expect(yield* containers.exists(name)).toBe(false);
    return yield* Exit.match(scenarioExit, {
      onSuccess: Effect.succeed,
      onFailure: Effect.failCause,
    });
  }).pipe(Effect.provide(IncusClientLayer));

const assertProcessTerminated = Effect.fn("assertProcessTerminated")(function* (
  container: IncusContainer.Container,
  pidPath: string,
) {
  const result = yield* container.exec(["/bin/sh", "-lc", processTerminationCheckScript(pidPath)], {
    timeoutSeconds: 15,
  });
  expect(result.exitCode).toBe(0);
});

describeIntegration("Incus integration", () => {
  it.live(
    "round-trips binary files and reads directories and symlinks",
    () =>
      withContainer((container) =>
        Effect.gen(function* () {
          const payload = binaryFixture();
          // Keep fixtures outside /tmp, which the guest may mount during early boot.
          const directoryPath = yield* GuestPath.of("/root/incus api integration/nested #?");
          const payloadPath = yield* GuestPath.resolve(directoryPath, "payload #?.bin");
          yield* container.files.write(
            payloadPath,
            Stream.fromIterable([
              payload.subarray(0, 127_111),
              payload.subarray(127_111, 734_003),
              payload.subarray(734_003),
            ]),
            { createParents: true },
          );
          const file = yield* container.files.readFile(payloadPath);
          const read = concatenate(Array.from(yield* file.bytes.pipe(Stream.runCollect)));
          expect(read.byteLength).toBe(payload.byteLength);
          expect(read).toEqual(payload);

          const linkPath = yield* GuestPath.resolve(directoryPath, "latest.bin");
          const linkErrors: Uint8Array[] = [];
          const link = yield* container.exec(["/bin/ln", "-s", "payload #?.bin", linkPath], {
            onStderr: (chunk) =>
              Effect.sync(() => {
                linkErrors.push(chunk);
              }),
          });
          expect(link.exitCode, new TextDecoder().decode(concatenate(linkErrors))).toBe(0);

          const directory = yield* container.files.read(directoryPath);
          assert(IncusApi.FileRead.$is("Directory")(directory), "Expected a directory");
          expect([...directory.entries].sort()).toEqual(["latest.bin", "payload #?.bin"]);

          const symlink = yield* container.files.read(linkPath);
          assert(IncusApi.FileRead.$is("Symlink")(symlink), "Expected a symlink");
          expect(symlink.target).toBe(payloadPath);
          const target = yield* container.files.read(yield* GuestPath.of(symlink.target));
          assert(IncusApi.FileRead.$is("File")(target), "Expected a regular file");
          expect(concatenate(yield* target.bytes.pipe(Stream.runCollect))).toEqual(payload);
        }),
      ),
    120_000,
  );

  it.live(
    "preserves exec output and exit code with cwd and environment",
    () =>
      withContainer((container) =>
        Effect.gen(function* () {
          const cwd = yield* GuestPath.of("/tmp/incus api integration/cwd");
          yield* container.files.mkdir(cwd, { recursive: true });
          const stdout: Uint8Array[] = [];
          const stderr: Uint8Array[] = [];
          const command = yield* container.exec(
            [
              "/bin/sh",
              "-lc",
              [
                'test "$PWD" = "/tmp/incus api integration/cwd" || exit 90',
                'test "$INTEGRATION_VALUE" = "present" || exit 91',
                "i=0",
                'while [ "$i" -lt 4096 ]; do printf "stdout-%04d\\n" "$i"; i=$((i + 1)); done',
                'printf "stderr-marker\\n" >&2',
                "exit 7",
              ].join("\n"),
            ],
            {
              cwd,
              environment: { INTEGRATION_VALUE: "present" },
              onStdout: (chunk) =>
                Effect.sync(() => {
                  stdout.push(chunk);
                }),
              onStderr: (chunk) =>
                Effect.sync(() => {
                  stderr.push(chunk);
                }),
            },
          );
          const stdoutText = new TextDecoder().decode(concatenate(stdout));
          const stderrText = new TextDecoder().decode(concatenate(stderr));
          expect(command.exitCode).toBe(7);
          expect(stdoutText).toBe(expectedStdout);
          expect(stderrText).toBe("stderr-marker\n");
        }),
      ),
    120_000,
  );

  it.live(
    "returns exit code 127 for a missing command",
    () =>
      withContainer((container) =>
        Effect.gen(function* () {
          const missing = yield* container.exec(["/definitely-not-an-incus-api-command"]);
          expect(missing.exitCode).toBe(127);
        }),
      ),
    120_000,
  );

  it.live(
    "sends stdin EOF to commands that wait for input",
    () =>
      withContainer((container) =>
        Effect.gen(function* () {
          const cat = yield* container.exec(["/bin/cat"], { timeoutSeconds: 10 });
          expect(cat.exitCode).toBe(0);
        }),
      ),
    120_000,
  );

  it.live(
    "terminates the process on exec timeout",
    () =>
      withContainer((container) =>
        Effect.gen(function* () {
          const pidPath = "/root/incus-api-timeout-process";
          const timeoutOutput: Uint8Array[] = [];
          const timeoutError = yield* container
            .exec(blockingProcessCommand(pidPath), {
              timeoutSeconds: 1,
              onStdout: (chunk) =>
                Effect.sync(() => {
                  timeoutOutput.push(chunk);
                }),
            })
            .pipe(Effect.flip);
          expect(timeoutError).toBeInstanceOf(IncusContainer.ExecTimeoutError);
          expect(new TextDecoder().decode(concatenate(timeoutOutput))).toBe("ready\n");

          yield* assertProcessTerminated(container, pidPath);
        }),
      ),
    120_000,
  );

  it.live(
    "terminates the process on caller interruption",
    () =>
      withContainer((container) =>
        Effect.gen(function* () {
          const interruptedPidPath = "/root/incus-api-interrupted-process";
          const ready = yield* Deferred.make<void>();
          const interrupted = yield* container
            .exec(blockingProcessCommand(interruptedPidPath), {
              onStdout: () => Deferred.succeed(ready, undefined),
            })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(ready).pipe(Effect.timeout("10 seconds"));
          yield* Fiber.interrupt(interrupted);
          yield* assertProcessTerminated(container, interruptedPidPath);
        }),
      ),
    120_000,
  );

  it.live(
    "preserves callback failures and terminates the process",
    () =>
      withContainer((container) =>
        Effect.gen(function* () {
          const failedPidPath = "/root/incus-api-callback-failed-process";
          const callbackFailure = new Error("output consumer failed");
          const callbackError = yield* container
            .exec(blockingProcessCommand(failedPidPath), {
              onStdout: () => Effect.fail(callbackFailure),
            })
            .pipe(Effect.flip, Effect.timeout("10 seconds"));
          assert(callbackError instanceof IncusContainer.ExecCallbackError);
          expect(callbackError.cause).toBe(callbackFailure);
          yield* assertProcessTerminated(container, failedPidPath);
        }),
      ),
    120_000,
  );

  it.live(
    "waits for asynchronous output callbacks before returning",
    () =>
      withContainer((container) =>
        Effect.gen(function* () {
          // Hold the consumer until the real producer has exited. Receiving the
          // operation result must not let exec return before callbacks drain.
          const drainedPidPath = "/root/incus-api-drained-process";
          const callbackEntered = yield* Deferred.make<void>();
          const releaseCallback = yield* Deferred.make<void>();
          const drainedChunks: Uint8Array[] = [];
          const draining = yield* container
            .exec(
              [
                "/bin/sh",
                "-lc",
                [
                  processIdentityScript(drainedPidPath),
                  'i=0; while [ "$i" -lt 4096 ]; do printf "stdout-%04d\\n" "$i"; i=$((i + 1)); done',
                ].join("; "),
              ],
              {
                onStdout: (chunk) =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(callbackEntered, undefined);
                    yield* Deferred.await(releaseCallback);
                    drainedChunks.push(chunk);
                  }),
              },
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(callbackEntered).pipe(Effect.timeout("10 seconds"));
          yield* assertProcessTerminated(container, drainedPidPath);
          expect(draining.pollUnsafe()).toBeUndefined();
          expect(drainedChunks).toEqual([]);
          yield* Deferred.succeed(releaseCallback, undefined);
          expect((yield* Fiber.join(draining)).exitCode).toBe(0);
          expect(new TextDecoder().decode(concatenate(drainedChunks))).toBe(
            `ready\n${expectedStdout}`,
          );
        }),
      ),
    120_000,
  );
});
