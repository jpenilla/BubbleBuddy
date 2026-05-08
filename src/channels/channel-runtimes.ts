import { Context, Deferred, Effect, Exit, Layer, RcMap, Scope } from "effect";

import { AppConfig } from "../config.ts";
import {
  makeChannelRuntime,
  type ChannelRuntime,
  type ChannelRuntimeError,
} from "./channel-runtime.ts";
import type { SessionKeepAlive } from "./keep-alive.ts";

const makeChannelRuntimes = () => {
  return Effect.gen(function* () {
    const config = yield* AppConfig;
    const runtimesDeferred =
      yield* Deferred.make<RcMap.RcMap<string, ChannelRuntime, ChannelRuntimeError>>();

    const makeKeepAlive = (channelId: string): Effect.Effect<SessionKeepAlive> =>
      Effect.gen(function* () {
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

    return ChannelRuntimes.of({
      get: (channelId: string) => RcMap.get(runtimes, channelId),
    });
  });
};

export class ChannelRuntimes extends Context.Service<
  ChannelRuntimes,
  {
    readonly get: (
      channelId: string,
    ) => Effect.Effect<ChannelRuntime, ChannelRuntimeError, Scope.Scope>;
  }
>()("bubblebuddy/ChannelRuntimes") {
  static readonly layer = Layer.effect(ChannelRuntimes, makeChannelRuntimes());
}
