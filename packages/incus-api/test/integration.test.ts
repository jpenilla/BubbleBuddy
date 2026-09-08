import { randomUUID } from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Stream } from "effect";

import { IncusApi, IncusClient, IncusContainer, IncusTransport } from "../src/index.ts";

const IncusClientLayer = IncusClient.layer.pipe(
  Layer.provide(IncusApi.layer),
  Layer.provide(IncusTransport.layer({ endpoint: { type: "unix" } })),
);

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

describeIntegration("Incus integration", () => {
  it.live(
    "uses scoped containers for streamed files and exec sessions",
    () =>
      Effect.gen(function* () {
        const incus = yield* IncusClient.Service;
        const containers = incus.project("default").containers;
        const name = `incus-api-integration-${randomUUID().slice(0, 8)}`;
        const payload = binaryFixture();
        const payloadPath = "/tmp/incus api integration/nested #?/payload #?.bin";
        const cwd = "/tmp/incus api integration/cwd";
        const pidPath = "/tmp/incus-api-timeout-process";

        const scenario = Effect.scoped(
          Effect.gen(function* () {
            const container = yield* containers.scoped({
              name,
              image: integrationImage,
              profiles: ["default"],
            });

            yield* container.files.write(
              payloadPath,
              Stream.fromIterable([
                payload.subarray(0, 127_111),
                payload.subarray(127_111, 734_003),
                payload.subarray(734_003),
              ]),
              { createParents: true },
            );
            const file = yield* container.files.openRead(payloadPath);
            const read = concatenate(Array.from(yield* file.bytes.pipe(Stream.runCollect)));
            expect(read.byteLength).toBe(payload.byteLength);
            expect(read).toEqual(payload);

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
                onStdout: (chunk) => {
                  stdout.push(chunk);
                },
                onStderr: (chunk) => {
                  stderr.push(chunk);
                },
              },
            );
            const stdoutText = new TextDecoder().decode(concatenate(stdout));
            const stderrText = new TextDecoder().decode(concatenate(stderr));
            expect(command.exitCode).toBe(7);
            expect(stdoutText).toBe(expectedStdout);
            expect(stderrText).toBe("stderr-marker\n");

            const missing = yield* container.exec(["/definitely-not-an-incus-api-command"]);
            expect(missing.exitCode).toBe(127);

            const cat = yield* container.exec(["/bin/cat"], { timeoutSeconds: 10 });
            expect(cat.exitCode).toBe(0);

            const timeoutOutput: Uint8Array[] = [];
            const timeoutError = yield* container
              .exec(
                [
                  "/bin/sh",
                  "-lc",
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
                    "exec sleep 60",
                  ].join("; "),
                ],
                {
                  timeoutSeconds: 1,
                  onStdout: (chunk) => {
                    timeoutOutput.push(chunk);
                  },
                },
              )
              .pipe(Effect.flip);
            expect(timeoutError).toBeInstanceOf(IncusContainer.ExecTimeoutError);
            expect(new TextDecoder().decode(concatenate(timeoutOutput))).toBe("ready\n");

            const processEnded = yield* container.exec(
              [
                "/bin/sh",
                "-lc",
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
                ].join("\n"),
              ],
              { timeoutSeconds: 15 },
            );
            expect(processEnded.exitCode).toBe(0);
          }),
        );

        const scenarioExit = yield* scenario.pipe(Effect.exit);
        expect(yield* containers.exists(name)).toBe(false);
        return yield* Exit.match(scenarioExit, {
          onSuccess: Effect.succeed,
          onFailure: Effect.failCause,
        });
      }).pipe(Effect.provide(IncusClientLayer)),
    120_000,
  );
});
