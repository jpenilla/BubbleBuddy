import type { SessionSink } from "../../src/pi/discord-output-pump.ts";

const stub = (name: keyof SessionSink) => async () => {
  throw new Error(`unexpected ${name}`);
};

export const makeSink = (overrides: Partial<SessionSink>): SessionSink => ({
  onCompactionStatus: stub("onCompactionStatus"),
  onFinal: stub("onFinal"),
  onIntermediate: stub("onIntermediate"),
  onRetryStatus: stub("onRetryStatus"),
  onRunAborted: stub("onRunAborted"),
  onRunEnd: stub("onRunEnd"),
  onRunError: stub("onRunError"),
  onRunStart: stub("onRunStart"),
  onStatus: stub("onStatus"),
  onThinking: stub("onThinking"),
  ...overrides,
});
