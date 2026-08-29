import { Context, Effect, Exit, Layer, RcMap, Scope } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { AppHome } from "../config/env.ts";
import { FileConfig } from "../config/file.ts";
import { PiContext } from "../pi-session/context.ts";
import { makePiSession, type PiSessionServices } from "../pi-session/session.ts";
import { LoadedResources } from "../resources.ts";
import {
  makeChannelSession,
  type ChannelSession,
  type ChannelSessionError,
} from "./channel-session.ts";
import { ChannelStateRepository } from "./state-repository.ts";

export interface ChannelSessionLookupOptions {
  readonly channelId: string;
  readonly acquireLease: Parameters<typeof makeChannelSession>[0]["acquireLease"];
}

type ChannelSessionLookup<R> = (
  options: ChannelSessionLookupOptions,
) => Effect.Effect<ChannelSession, ChannelSessionError, R>;

const makeChannelSessions = <R>(lookup: ChannelSessionLookup<R>) =>
  Effect.gen(function* () {
    const config = yield* FileConfig;
    let sessions: RcMap.RcMap<string, ChannelSession, ChannelSessionError>;

    const acquireLease = (channelId: string) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          yield* restore(
            RcMap.get(sessions, channelId).pipe(Scope.provide(scope), Effect.orDie),
          ).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))));
          return { release: Scope.close(scope, Exit.void) };
        }),
      );

    sessions = yield* RcMap.make({
      lookup: (channelId: string) =>
        lookup({
          channelId,
          acquireLease: acquireLease(channelId),
        }),
      idleTimeToLive: config.channelIdleTimeoutMs,
    });

    const get = Effect.fn("ChannelSessions.get")(function* (channelId: string) {
      return yield* RcMap.get(sessions, channelId);
    });

    return ChannelSessions.of({ get });
  });

const makeLiveChannelSessions = Effect.gen(function* () {
  const piServices = yield* Effect.context<PiSessionServices>();
  return yield* makeChannelSessions((options) =>
    makeChannelSession({
      ...options,
      makeAgent: (input) => makePiSession(input).pipe(Effect.provide(piServices)),
    }),
  );
});

export class ChannelSessions extends Context.Service<
  ChannelSessions,
  {
    readonly get: (
      channelId: string,
    ) => Effect.Effect<ChannelSession, ChannelSessionError, Scope.Scope>;
  }
>()("bubblebuddy/ChannelSessions") {
  static readonly layerWith = <R>(lookup: ChannelSessionLookup<R>) =>
    Layer.effect(ChannelSessions, makeChannelSessions(lookup));
  static readonly layerNoDeps = Layer.effect(ChannelSessions, makeLiveChannelSessions);
  static readonly layer = ChannelSessions.layerNoDeps.pipe(
    Layer.provide(FileConfig.layer),
    Layer.provide(ChannelStateRepository.layer),
    Layer.provide(LoadedResources.layer),
    Layer.provide(PiContext.layer),
    Layer.provide(AppHome.layer),
    Layer.provide(FetchHttpClient.layer),
  );
}
