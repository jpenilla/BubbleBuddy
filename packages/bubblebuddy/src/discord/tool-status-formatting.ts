import { Option, Schema } from "effect";

import { collapseWhitespace, truncate } from "../shared/text.ts";

const DESCRIPTION_LIMIT = 180;

const CommandInput = Schema.Struct({ command: Schema.NonEmptyString });
const PathInput = Schema.Struct({ path: Schema.NonEmptyString });

const decodeCommandInput = Schema.decodeUnknownOption(CommandInput);
const decodePathInput = Schema.decodeUnknownOption(PathInput);

const oneLine = (value: string): string => truncate(collapseWhitespace(value), DESCRIPTION_LIMIT);

export const formatToolDescription = (toolName: string, args: unknown): string | undefined => {
  switch (toolName) {
    case "bash": {
      const input = Option.getOrUndefined(decodeCommandInput(args));
      return input === undefined ? undefined : oneLine(input.command);
    }
    case "read":
    case "write":
    case "edit": {
      const input = Option.getOrUndefined(decodePathInput(args));
      return input === undefined ? undefined : truncate(input.path, DESCRIPTION_LIMIT);
    }
    default:
      return undefined;
  }
};
