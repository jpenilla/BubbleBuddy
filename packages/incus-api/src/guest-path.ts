import { Brand, Context, Effect, Layer, Path, Schema } from "effect";

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

export interface Interface {
  /** POSIX path operations for guest paths, including relative path fragments. */
  readonly path: Path.Path;
  /** Validate and normalize an absolute guest path. */
  readonly of: (path: string) => Effect.Effect<GuestPath, PathError>;
  /** Resolve segments against a guest path; absolute segments replace the base. */
  readonly resolve: (base: GuestPath, ...segments: string[]) => Effect.Effect<GuestPath, PathError>;
  /** Return the parent directory of a validated guest path. */
  readonly dirname: (path: GuestPath) => GuestPath;
  /** Return each absolute directory prefix, excluding the root. */
  readonly directoryChain: (path: GuestPath) => GuestPath[];
}

export class Service extends Context.Service<Service, Interface>()("incus-api/GuestPath") {}

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const of = Effect.fn("GuestPath.of")(function* (value: string) {
      if (!path.isAbsolute(value) || value.includes("\0")) {
        return yield* new PathError({
          path: value,
          message: "Incus guest paths must be absolute and contain no NUL bytes",
        });
      }
      return brand(path.normalize(value));
    });
    const resolve = Effect.fn("GuestPath.resolve")(function* (
      base: GuestPath,
      ...segments: string[]
    ) {
      if (segments.length === 0) return base;
      let value: string = base;
      for (const segment of segments) {
        value = path.isAbsolute(segment) ? segment : `${value}/${segment}`;
      }
      return yield* of(value);
    });
    return Service.of({
      path,
      of,
      resolve,
      dirname: (value) => brand(path.dirname(value)),
      directoryChain: (value) => {
        const parts = value.split("/").filter(Boolean);
        return parts.map((_, index) => brand(`/${parts.slice(0, index + 1).join("/")}`));
      },
    });
  }).pipe(Effect.provide(Path.layer)),
);

export * as GuestPath from "./guest-path.ts";
