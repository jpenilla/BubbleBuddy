import { Schema } from "effect";

export class ConfigError extends Schema.TaggedError<
  ConfigError,
  { readonly brand: unique symbol }
>()("ConfigError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
