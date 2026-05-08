import type { ChannelSettings, PersistentChannelState } from "./channel-state-repository.ts";

export interface ChannelState {
  readonly settings: Readonly<ChannelSettings>;
  readonly activeSession: string | undefined;
  readonly dirty: boolean;
  setActiveSession(sessionFileName: string): void;
  clearActiveSession(): void;
  modifySettings(mutator: (draft: ChannelSettings) => void): void;
}

export const makeChannelState = (persistent: PersistentChannelState): ChannelState => {
  let dirty = false;

  return {
    get settings() {
      return persistent.settings;
    },
    get activeSession() {
      return persistent.activeSession;
    },
    get dirty() {
      return dirty;
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
  };
};
