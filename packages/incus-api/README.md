# incus-api

Effect-based Incus client for scoped container operations.

```typescript
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Crypto, Effect, Layer, Stream } from "effect";
import { GuestPath, IncusClient, IncusContainer } from "incus-api";

const IncusClientLayer = IncusClient.layer({ endpoint: { type: "unix" } });

const image: IncusContainer.ImageSource = {
  type: "remote",
  alias: "debian/13",
};

const program = Effect.gen(function* () {
  const incus = yield* IncusClient.Service;
  const crypto = yield* Crypto.Crypto;
  const container = yield* incus.project("default").containers.scoped({
    name: `example-${(yield* crypto.randomUUIDv4).slice(0, 8)}`,
    image,
    profiles: ["default"],
  });

  const path = yield* GuestPath.of("/tmp/hello.txt");
  yield* container.files.write(path, Stream.make(new TextEncoder().encode("hello")));
  const file = yield* container.files.readFile(path);
  const text = yield* file.bytes.pipe(Stream.decodeText(), Stream.runFold("", (a, b) => a + b));
  console.log(text);

  const result = yield* container.exec(["/bin/cat", "/tmp/hello.txt"], {
    onStdout: (chunk) => Effect.sync(() => {
      process.stdout.write(chunk);
    }),
    onStderr: (chunk) => Effect.sync(() => {
      process.stderr.write(chunk);
    }),
  });
  console.log(`Process exited with code ${result.exitCode}`);
});

const AppLayer = Layer.effectDiscard(program).pipe(
  Layer.provide(IncusClientLayer),
  Layer.provide(NodeCrypto.layer),
);

NodeRuntime.runMain(Layer.launch(AppLayer));
```
