import { Effect } from "effect";

import type {
  ChannelRepositoryError,
  ChannelRepositoryShape,
  ChannelSettings,
  PersistentChannelState,
} from "./channel-repository.ts";

export interface ChannelState {
  readonly settings: Readonly<ChannelSettings>;
  readonly activeSession: string | undefined;
  setActiveSession(sessionFileName: string): void;
  clearActiveSession(): void;
  modifySettings(mutator: (draft: ChannelSettings) => void): void;
  persistIfDirty(): Effect.Effect<void, ChannelRepositoryError>;
}

export const makeChannelState = (
  channelId: string,
  repository: ChannelRepositoryShape,
  persistent: PersistentChannelState,
): ChannelState => {
  let dirty = false;

  return {
    get settings() {
      return persistent.settings;
    },
    get activeSession() {
      return persistent.activeSession;
    },
    setActiveSession(sessionFileName) {
      persistent.activeSession = sessionFileName;
      dirty = true;
    },
    clearActiveSession() {
      if (persistent.activeSession !== undefined) {
        delete persistent.activeSession;
        dirty = true;
      }
    },
    modifySettings(mutator) {
      mutator(persistent.settings);
      dirty = true;
    },
    persistIfDirty() {
      if (!dirty) {
        return Effect.void;
      }
      return repository.save(channelId, persistent).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            dirty = false;
          }),
        ),
      );
    },
  };
};

export const loadChannelState = (
  channelId: string,
  repository: ChannelRepositoryShape,
): Effect.Effect<ChannelState, ChannelRepositoryError> =>
  repository
    .load(channelId)
    .pipe(Effect.map((persistent) => makeChannelState(channelId, repository, persistent)));
