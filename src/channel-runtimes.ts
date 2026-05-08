import { Context, Deferred, Effect, Exit, Layer, RcMap, Scope } from "effect";

import {
  ChannelStateRepository,
  type ChannelStateRepositoryError,
} from "./channel-state-repository.ts";
import { AppConfig } from "./config.ts";
import {
  makeChannelRuntime,
  type ChannelRuntime,
  type ChannelRuntimeError,
} from "./channel-runtime.ts";
import { PiChannelSessionFactory } from "./pi/channel-session-factory.ts";
import type { SessionKeepAlive } from "./session-keep-alive.ts";

export interface ChannelRuntimesShape {
  readonly get: (
    channelId: string,
  ) => Effect.Effect<ChannelRuntime, ChannelRuntimeError, Scope.Scope>;
}

const makeChannelRuntimes = (): Effect.Effect<
  ChannelRuntimesShape,
  never,
  AppConfig | ChannelStateRepository | PiChannelSessionFactory | Scope.Scope
> => {
  return Effect.gen(function* () {
    const config = yield* AppConfig;
    const runtimesDeferred =
      yield* Deferred.make<RcMap.RcMap<string, ChannelRuntime, ChannelStateRepositoryError>>();

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

    return {
      get: (channelId: string) => RcMap.get(runtimes, channelId),
    };
  });
};

export class ChannelRuntimes extends Context.Service<ChannelRuntimes, ChannelRuntimesShape>()(
  "bubblebuddy/ChannelRuntimes",
) {
  static readonly layer = Layer.effect(ChannelRuntimes, makeChannelRuntimes());
}
