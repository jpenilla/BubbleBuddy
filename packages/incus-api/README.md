# incus-api

Effect-based Incus client for scoped container operations.

```typescript
import { Effect, Stream } from "effect";
import { IncusClient, IncusContainer } from "incus-api";

const IncusClientLayer = IncusClient.layer({ endpoint: { type: "unix" } });

const image: IncusContainer.ImageSource = {
  type: "remote",
  alias: "debian/12",
};

const program = Effect.scoped(
  Effect.gen(function* () {
    const incus = yield* IncusClient.Service;
    const container = yield* incus.project("default").containers.scoped({
      image,
      profiles: ["default"],
    });

    yield* container.files.write(
      "/tmp/hello.txt",
      Stream.make(new TextEncoder().encode("hello")),
    );
    const file = yield* container.files.readFile("/tmp/hello.txt");
    const text = yield* file.bytes.pipe(Stream.decodeText(), Stream.runFold("", (a, b) => a + b));
    console.log(text);

    const result = yield* container.exec(["/bin/cat", "/tmp/hello.txt"], {
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    });
    console.log(`Process exited with code ${result.exitCode}`);
  }),
);

Effect.runPromise(program.pipe(Effect.provide(IncusClientLayer)));
```
