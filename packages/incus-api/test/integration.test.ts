import { assert, describe, layer } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";

import { Incus, IncusContainerExecTimeoutError, type IncusImage } from "../src/index.ts";

const describeIntegration = process.env.INCUS_API_INTEGRATION === "1" ? describe : describe.skip;

const integrationImage: IncusImage = {
  type: "remote",
  alias: process.env.INCUS_API_INTEGRATION_IMAGE ?? "debian/12",
  server: process.env.INCUS_API_INTEGRATION_IMAGE_SERVER ?? "https://images.linuxcontainers.org",
};

const projectName = process.env.INCUS_API_INTEGRATION_PROJECT ?? "default";
const socketPath = process.env.INCUS_API_INTEGRATION_SOCKET;

describeIntegration("Incus integration", () => {
  layer(Incus.liveLocal({ socketPath }), { excludeTestServices: true })("incus", (it) => {
    it.effect("creates a scoped container, executes commands, and uses file helpers", () =>
      Effect.gen(function* () {
        const incus = yield* Incus;
        const project = incus.project(projectName);
        const container = yield* project.containers.scoped({
          image: integrationImage,
          profiles: ["default"],
        });

        let stdout = "";
        let stderr = "";
        const exec = yield* container.exec(["/bin/sh", "-lc", "printf hello"], {
          onStdout: (chunk) => {
            stdout += new TextDecoder().decode(chunk);
          },
          onStderr: (chunk) => {
            stderr += new TextDecoder().decode(chunk);
          },
        });
        assert.strictEqual(exec.exitCode, 0);
        assert.strictEqual(stdout, "hello");
        assert.strictEqual(stderr, "");

        const stdinEof = yield* container.exec(["/bin/sh", "-lc", "cat >/tmp/stdin-eof"], {
          timeoutSeconds: 1,
        });
        assert.strictEqual(stdinEof.exitCode, 0);

        yield* container.files.mkdir("/tmp/incus-api-integration", { recursive: true });
        yield* container.files.write("/tmp/incus-api-integration/message.txt", "from file api", {
          createParents: true,
        });
        assert.strictEqual(
          yield* container.files.readText("/tmp/incus-api-integration/message.txt"),
          "from file api",
        );

        const exit = yield* Effect.exit(
          container.exec(["/bin/sh", "-lc", "sleep 999"], {
            timeoutSeconds: 1,
          }),
        );
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          assert.instanceOf(Cause.squash(exit.cause), IncusContainerExecTimeoutError);
        }
      }),
    );
  });
});
