import { Context, Effect, Layer, RcMap, Scope } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { AppHome } from "../config/env.ts";
import { FileConfig } from "../config/file.ts";
import { PiContext } from "../pi/context.ts";
import { LoadedResources } from "../resources.ts";
import { createChannelSession, type ChannelSession, type ChannelSessionError } from "./channel.ts";
import { ChannelStateRepository } from "./state-repository.ts";

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

  const get = Effect.fnUntraced(
    function* (channelId: string) {
      return yield* RcMap.get(sessions, channelId);
    },
    Effect.withSpan("ChannelSessions.get", (channelId) => ({ attributes: { channelId } })),
  );

  return Service.of({ get });
});

export interface Interface {
  readonly get: (
    channelId: string,
  ) => Effect.Effect<ChannelSession, ChannelSessionError, Scope.Scope>;
}

export class Service extends Context.Service<Service, Interface>()(
  "bubblebuddy/session/ChannelSessions",
) {}

export const layerNoDeps = Layer.effect(Service, createChannelSessions);
export const layer = layerNoDeps.pipe(
  Layer.provide(ChannelStateRepository.layer),
  Layer.provide(LoadedResources.layer),
  Layer.provide(PiContext.layer),
  Layer.provide(FileConfig.layer),
  Layer.provide(AppHome.layer),
  Layer.provide(FetchHttpClient.layer),
);

export * as ChannelSessions from "./registry.ts";
