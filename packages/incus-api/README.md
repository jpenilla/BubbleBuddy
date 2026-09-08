# incus-api

Effect-based Incus client for scoped container operations.

```typescript
import { Effect, Layer, Stream } from "effect";
import { IncusApi, IncusClient, IncusContainer, IncusTransport } from "incus-api";

const IncusClientLayer = IncusClient.layer.pipe(
  Layer.provide(IncusApi.layer),
  Layer.provide(IncusTransport.layer({ endpoint: { type: "unix" } })),
);

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

Effect.runPromise(program.pipe(Effect.provide(IncusClientLayer)));
```

`IncusClient.Service` exposes projects and their `IncusContainer.ContainerCollection`s.
`containers.scoped` creates an ephemeral container and cleans it up when its enclosing scope closes.
File paths are absolute guest paths. `openRead` and `write` use `Stream.Stream<Uint8Array, ...>`;
`readBytes` and `readText` are buffered helpers.
`exec` streams output through callbacks and returns the process exit code.

The Unix endpoint uses Incus's default socket path when `socketPath` is omitted. Pass an HTTPS
endpoint and TLS options to connect to a remote Incus server.

With a running local Incus daemon, run `pnpm --filter incus-api run test:integration` for the
opt-in integration scenario.
