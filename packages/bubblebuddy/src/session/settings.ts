import { Context, Duration, Effect, Layer, RcMap, type Scope, SynchronizedRef } from "effect";

import { ChannelStateRepository } from "./state-repository.ts";
import { type ReplyMode } from "./state.ts";

export interface Entry {
  readonly getShowThinking: Effect.Effect<boolean, never>;
  readonly toggleShowThinking: Effect.Effect<boolean, ChannelStateRepository.Error>;
  readonly getReplyMode: Effect.Effect<ReplyMode, never>;
  readonly setReplyMode: (value: ReplyMode) => Effect.Effect<void, ChannelStateRepository.Error>;
}

const load = Effect.fn("ChannelSettings.load")(function* (channelId: string) {
  const repository = yield* ChannelStateRepository.Service;
  const showThinkingRef = yield* SynchronizedRef.make(yield* repository.getShowThinking(channelId));
  const replyModeRef = yield* SynchronizedRef.make(yield* repository.getReplyMode(channelId));

  const toggleShowThinking = SynchronizedRef.updateAndGetEffect(showThinkingRef, (current) =>
    Effect.gen(function* () {
      const next = !current;
      yield* repository.setShowThinking(channelId, next);
      return next;
    }),
  ).pipe(Effect.withSpan("ChannelSettings.toggleShowThinking"));

  const setReplyMode = Effect.fn("ChannelSettings.setReplyMode")(function* (value: ReplyMode) {
    yield* SynchronizedRef.updateEffect(replyModeRef, () =>
      repository.setReplyMode(channelId, value).pipe(Effect.as(value)),
    );
  });

  return {
    getShowThinking: SynchronizedRef.get(showThinkingRef),
    toggleShowThinking,
    getReplyMode: SynchronizedRef.get(replyModeRef),
    setReplyMode,
  } satisfies Entry;
});

const createChannelSettings = Effect.gen(function* () {
  const settings = yield* RcMap.make({
    idleTimeToLive: Duration.minutes(5),
    lookup: load,
  });

  return Service.of({
    get: (channelId) => RcMap.get(settings, channelId),
  });
});

export class Service extends Context.Service<
  Service,
  {
    readonly get: (
      channelId: string,
    ) => Effect.Effect<Entry, ChannelStateRepository.Error, Scope.Scope>;
  }
>()("bubblebuddy/session/ChannelSettings") {}

export const layerNoDeps = Layer.effect(Service, createChannelSettings);
export const layer = layerNoDeps.pipe(Layer.provide(ChannelStateRepository.layer));

export * as ChannelSettings from "./settings.ts";
