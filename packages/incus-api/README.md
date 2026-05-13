# incus-api

Small Effect-based Incus client for BubbleBuddy's ephemeral container workspaces.

```typescript
import { Effect } from "effect";
import { Incus } from "incus-api";

const program = Effect.scoped(
  Effect.gen(function* () {
    const incus = yield* Incus;
    const container = yield* incus.project("default").containers.scoped({
      image: {
        type: "remote",
        alias: "debian/12",
      },
      profiles: ["default"],
    });

    const result = yield* container.exec(["/bin/sh", "-lc", "echo hello"]);
    console.log(result.stdout);
  }),
);

Effect.runPromise(program.pipe(Effect.provide(Incus.liveLocal())));
```

`containers.scoped` creates an Incus ephemeral container and cleans it up when the scope closes.
The first draft intentionally exposes only the operations BubbleBuddy needs: exec plus simple file read/write/mkdir helpers.

Remote Incus is available with `Incus.liveRemote({ baseUrl, tls })`.
