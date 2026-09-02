import { Option, Schema } from "effect";

const DESCRIPTION_LIMIT = 180;

const CommandInput = Schema.Struct({ command: Schema.NonEmptyString });
const PathInput = Schema.Struct({ path: Schema.NonEmptyString });

const decodeCommandInput = Schema.decodeUnknownOption(CommandInput);
const decodePathInput = Schema.decodeUnknownOption(PathInput);

const truncate = (value: string): string =>
  value.length <= DESCRIPTION_LIMIT ? value : `${value.slice(0, DESCRIPTION_LIMIT - 1)}…`;

const oneLine = (value: string): string => truncate(value.replaceAll(/\s+/g, " ").trim());

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
      return input === undefined ? undefined : truncate(input.path);
    }
    default:
      return undefined;
  }
};
