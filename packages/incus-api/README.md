# incus-api

Effect-based Incus client for scoped container operations.

```typescript
import { Effect, Stream } from "effect";
import { IncusClient, IncusContainer } from "incus-api";

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
    const file = yield* container.files.openRead("/tmp/hello.txt");
    const text = yield* file.bytes.pipe(Stream.decodeText(), Stream.runFold("", (a, b) => a + b));
    console.log(text);

    const result = yield* container.exec(["/bin/cat", "/tmp/hello.txt"], {
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    });
    console.log(`Process exited with code ${result.exitCode}`);
  }),
);

Effect.runPromise(program.pipe(Effect.provide(IncusClient.layerLocal())));
```

`IncusClient.Service` exposes projects and their `IncusContainer.ContainerCollection`s.
`containers.scoped` creates an ephemeral container and cleans it up when its enclosing scope closes.
File paths are absolute guest paths. `openRead` and `write` use `Stream.Stream<Uint8Array, ...>`;
`readBytes` and `readText` are buffered helpers.
`exec` streams output through callbacks and returns the process exit code.

Connection layers are `IncusClient.layer`, `IncusClient.layerLocal({ socketPath })`, and
`IncusClient.layerRemote({ baseUrl, tls })`.
