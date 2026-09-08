import { Cause, Effect, Exit, Option } from "effect";

import type { IncusApi } from "../src/incus-api.ts";

export interface ApiOverrides {
  readonly create?: IncusApi.Interface["instances"]["create"];
  readonly exists?: IncusApi.Interface["instances"]["exists"];
  readonly delete?: IncusApi.Interface["instances"]["delete"];
  readonly setState?: IncusApi.Interface["instances"]["setState"];
  readonly exec?: IncusApi.Interface["instances"]["exec"];
  readonly openRead?: IncusApi.Interface["instances"]["files"]["openRead"];
  readonly stat?: IncusApi.Interface["instances"]["files"]["stat"];
  readonly write?: IncusApi.Interface["instances"]["files"]["write"];
  readonly wait?: IncusApi.Interface["operations"]["wait"];
  readonly cancel?: IncusApi.Interface["operations"]["cancel"];
  readonly makeWebSocket?: IncusApi.Interface["operations"]["makeWebSocket"];
}

const unavailable = (method: string) =>
  Effect.die(new Error(`Unexpected Incus API call: ${method}`));

export const apiFixture = (overrides: ApiOverrides = {}): IncusApi.Interface => ({
  instances: {
    create: overrides.create ?? (() => unavailable("instances.create")),
    exists: overrides.exists ?? (() => unavailable("instances.exists")),
    delete: overrides.delete ?? (() => unavailable("instances.delete")),
    setState: overrides.setState ?? (() => unavailable("instances.setState")),
    exec: overrides.exec ?? (() => unavailable("instances.exec")),
    files: {
      openRead: overrides.openRead ?? (() => unavailable("instances.files.openRead")),
      stat: overrides.stat ?? (() => unavailable("instances.files.stat")),
      write: overrides.write ?? (() => unavailable("instances.files.write")),
    },
  },
  operations: {
    makeWebSocket: overrides.makeWebSocket ?? (() => unavailable("operations.makeWebSocket")),
    wait: overrides.wait ?? (() => unavailable("operations.wait")),
    cancel: overrides.cancel ?? (() => unavailable("operations.cancel")),
  },
});

export const errorFrom = <E>(exit: Exit.Exit<unknown, E>): E | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const error = Cause.findErrorOption(exit.cause);
  return Option.isSome(error) ? error.value : undefined;
};
