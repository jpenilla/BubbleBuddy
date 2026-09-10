import { Brand, Effect, Schema } from "effect";
import { posix } from "node:path";

export class PathError extends Schema.TaggedError<PathError>()("GuestPath.PathError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/**
 * Lexically normalized absolute guest path; preserves trailing slashes.
 * Does not resolve symlinks or guarantee existence.
 */
export type GuestPath = string & Brand.Brand<"incus-api/GuestPath">;

const brand = Brand.nominal<GuestPath>();

export const of = Effect.fn("GuestPath.of")(function* (path: string) {
  if (!posix.isAbsolute(path) || path.includes("\0")) {
    return yield* new PathError({
      path,
      message: "Incus guest paths must be absolute and contain no NUL bytes",
    });
  }
  return brand(posix.normalize(path));
});

export const resolve = Effect.fn("GuestPath.resolve")(function* (
  base: GuestPath,
  ...segments: string[]
) {
  if (segments.length === 0) return base;
  let path: string = base;
  for (const segment of segments) {
    path = posix.isAbsolute(segment) ? segment : `${path}/${segment}`;
  }
  return yield* of(path);
});

export const dirname = (path: GuestPath) => brand(posix.dirname(path));

export const directoryChain = (path: GuestPath) => {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, index) => brand(`/${parts.slice(0, index + 1).join("/")}`));
};

export * as GuestPath from "./guest-path.ts";
