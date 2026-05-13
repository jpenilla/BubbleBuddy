import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { Incus, type IncusImage } from "../src/index.ts";

const describeIntegration = process.env.INCUS_API_INTEGRATION === "1" ? describe : describe.skip;

const integrationImage: IncusImage = {
  type: "remote",
  alias: process.env.INCUS_API_INTEGRATION_IMAGE ?? "debian/12",
  server: process.env.INCUS_API_INTEGRATION_IMAGE_SERVER ?? "https://images.linuxcontainers.org",
};

const projectName = process.env.INCUS_API_INTEGRATION_PROJECT ?? "default";
const socketPath = process.env.INCUS_API_INTEGRATION_SOCKET;

describeIntegration("Incus integration", () => {
  it.effect("creates a scoped container, executes commands, and uses file helpers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const incus = yield* Incus;
        const project = incus.project(projectName);
        const container = yield* project.containers.scoped({
          image: integrationImage,
          profiles: ["default"],
        });

        const exec = yield* container.exec(["/bin/sh", "-lc", "printf hello"]);
        assert.deepStrictEqual(exec, { exitCode: 0, stdout: "hello", stderr: "" });

        yield* container.files.mkdir("/tmp/incus-api-integration", { recursive: true });
        yield* container.files.write("/tmp/incus-api-integration/message.txt", "from file api", {
          createParents: true,
        });
        assert.strictEqual(
          yield* container.files.readText("/tmp/incus-api-integration/message.txt"),
          "from file api",
        );
      }),
    ).pipe(Effect.provide(Incus.liveLocal({ socketPath }))),
  );
});
