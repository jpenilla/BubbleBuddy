import { Context, Effect, Layer, RcMap, Scope } from "effect";

import { FileConfig } from "../config/file.ts";
import { makePiSession, type PiSessionServices } from "../pi/session.ts";
import { makeChannelSession, type ChannelSession, type ChannelSessionError } from "./channel.ts";

const makeChannelSessions = Effect.gen(function* () {
  const config = yield* FileConfig;
  const piServices = yield* Effect.context<PiSessionServices>();
  let sessions: RcMap.RcMap<string, ChannelSession, ChannelSessionError>;

  const retain = (channelId: string) =>
    RcMap.get(sessions, channelId).pipe(Effect.asVoid, Effect.orDie);

  sessions = yield* RcMap.make({
    lookup: (channelId: string) =>
      makeChannelSession({
        channelId,
        retain: retain(channelId),
        openPiSession: (input) => makePiSession(input).pipe(Effect.provide(piServices)),
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
  static readonly layer = Layer.effect(ChannelSessions, makeChannelSessions);
}
