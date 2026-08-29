import { Context, Effect, Layer, RcMap, Scope } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { AppHome } from "../config/env.ts";
import { FileConfig } from "../config/file.ts";
import { PiContext } from "../pi/context.ts";
import { LoadedResources } from "../resources.ts";
import { createChannelSession, type ChannelSession, type ChannelSessionError } from "./channel.ts";
import { ChannelStateRepository } from "./state.ts";

const createChannelSessions = Effect.gen(function* () {
  const config = yield* FileConfig;
  let sessions: RcMap.RcMap<string, ChannelSession, ChannelSessionError>;

  const retain = (channelId: string) =>
    RcMap.get(sessions, channelId).pipe(Effect.asVoid, Effect.orDie);

  sessions = yield* RcMap.make({
    lookup: (channelId: string) =>
      createChannelSession({
        channelId,
        retain: retain(channelId),
      }),
    idleTimeToLive: config.channelIdleTimeoutMs,
  });

  const get = Effect.fn("ChannelSessions.get")(function* (channelId: string) {
    return yield* RcMap.get(sessions, channelId);
  });

  return ChannelSessions.of({ get });
});

export class ChannelSessions extends Context.Service<
  ChannelSessions,
  {
    readonly get: (
      channelId: string,
    ) => Effect.Effect<ChannelSession, ChannelSessionError, Scope.Scope>;
  }
>()("bubblebuddy/ChannelSessions") {
  static readonly layerNoDeps = Layer.effect(ChannelSessions, createChannelSessions);
  static readonly layer = ChannelSessions.layerNoDeps.pipe(
    Layer.provide(ChannelStateRepository.layer),
    Layer.provide(LoadedResources.layer),
    Layer.provide(PiContext.layer),
    Layer.provide(FileConfig.layer),
    Layer.provide(AppHome.layer),
    Layer.provide(FetchHttpClient.layer),
  );
}
