import { Context, Deferred, Effect, Exit, Layer, RcMap, Scope } from "effect";

import { FileConfig } from "../config/file.ts";
import {
  makeChannelRuntime,
  type ChannelRuntime,
  type ChannelRuntimeError,
} from "./channel-runtime.ts";
import { ChannelStateRepository } from "./state-repository.ts";
import { PiChannelSessionFactory } from "../pi-session/session-factory.ts";

const makeChannelRuntimes = Effect.gen(function* () {
  const config = yield* FileConfig;
  const runtimesDeferred =
    yield* Deferred.make<RcMap.RcMap<string, ChannelRuntime, ChannelRuntimeError>>();

  const makeKeepAlive = Effect.fn("ChannelRuntimes.makeKeepAlive")(function* (channelId: string) {
    const runtimes = yield* Deferred.await(runtimesDeferred);
    const keepAliveScope = yield* Scope.make();
    yield* Effect.forkIn(keepAliveScope)(
      RcMap.get(runtimes, channelId).pipe(Scope.provide(keepAliveScope)),
    );
    return {
      release: Scope.close(keepAliveScope, Exit.void),
    };
  });

  const runtimes = yield* RcMap.make({
    lookup: (channelId: string) =>
      makeChannelRuntime({
        channelId,
        makeKeepAlive: () => makeKeepAlive(channelId),
      }),
    idleTimeToLive: config.channelIdleTimeoutMs,
  });
  yield* Deferred.complete(runtimesDeferred, Effect.succeed(runtimes));

  const get = Effect.fn("ChannelRuntimes.get")(function* (channelId: string) {
    return yield* RcMap.get(runtimes, channelId);
  });

  return ChannelRuntimes.of({
    get,
  });
});

export class ChannelRuntimes extends Context.Service<
  ChannelRuntimes,
  {
    readonly get: (
      channelId: string,
    ) => Effect.Effect<ChannelRuntime, ChannelRuntimeError, Scope.Scope>;
  }
>()("bubblebuddy/ChannelRuntimes") {
  static readonly layerNoDeps = Layer.effect(ChannelRuntimes, makeChannelRuntimes);
  static readonly layer = ChannelRuntimes.layerNoDeps.pipe(
    Layer.provide(FileConfig.layer),
    Layer.provide(ChannelStateRepository.layer),
    Layer.provide(PiChannelSessionFactory.layer),
  );
}
