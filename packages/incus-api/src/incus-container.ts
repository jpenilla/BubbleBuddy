import { Effect, Schema, Scope, Stream } from "effect";

import type { IncusApi } from "./incus-api.ts";

export class PathError extends Schema.TaggedError<PathError>()("IncusContainer.PathError", {
  path: Schema.String,
  message: Schema.String,
  metadata: Schema.optional(Schema.Unknown),
}) {}

export class MetadataError extends Schema.TaggedError<MetadataError>()(
  "IncusContainer.MetadataError",
  {
    operation: Schema.String,
    message: Schema.String,
    metadata: Schema.Unknown,
  },
) {}

export class ExecCallbackError extends Schema.TaggedError<ExecCallbackError>()(
  "IncusContainer.ExecCallbackError",
  {
    cause: Schema.Defect(),
  },
) {}

export class ExecInvalidOptionsError extends Schema.TaggedError<ExecInvalidOptionsError>()(
  "IncusContainer.ExecInvalidOptionsError",
  { message: Schema.String },
) {}

export class ExecTransportError extends Schema.TaggedError<ExecTransportError>()(
  "IncusContainer.ExecTransportError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class ExecTimeoutError extends Schema.TaggedError<ExecTimeoutError>()(
  "IncusContainer.ExecTimeoutError",
  {
    timeoutSeconds: Schema.Finite,
  },
) {}

export type FileError = IncusApi.ApiError | PathError | MetadataError;
export type ExecError =
  | IncusApi.ApiError
  | ExecCallbackError
  | ExecInvalidOptionsError
  | ExecTimeoutError
  | ExecTransportError;

export type ImageSource =
  | {
      readonly type: "local";
      /** Local image fingerprint known to the Incus server. */
      readonly fingerprint: string;
    }
  | {
      readonly type: "remote";
      readonly alias: string;
      readonly server?: string;
      /** Incus image source protocol, for example "simplestreams". */
      readonly protocol?: string;
    };

export interface MountOptions {
  readonly source: string;
  readonly path: string;
  readonly readonly?: boolean;
  readonly required?: boolean;
  /** Container-only uid/gid shifting overlay for host path mounts. Defaults to true in v1. */
  readonly shift?: boolean;
}

export interface ResourceLimits {
  readonly cpu?: string;
  readonly memory?: string;
}

export interface CreateOptions {
  readonly name?: string;
  readonly image: ImageSource;
  readonly profiles?: readonly string[];
  readonly mounts?: readonly MountOptions[];
  readonly limits?: ResourceLimits;
}

export interface FileWriteOptions {
  readonly mode?: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly createParents?: boolean;
}

export interface FileRead {
  readonly size: bigint | undefined;
  readonly bytes: Stream.Stream<Uint8Array, FileError>;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutSeconds?: number;
  readonly onStdout?: (chunk: Uint8Array) => void | Effect.Effect<void, unknown, never>;
  readonly onStderr?: (chunk: Uint8Array) => void | Effect.Effect<void, unknown, never>;
}

export interface ExecResult {
  readonly exitCode: number;
}

export interface FileOperations {
  readonly openRead: (path: string) => Effect.Effect<FileRead, FileError, Scope.Scope>;
  readonly readBytes: (path: string) => Effect.Effect<Uint8Array, FileError>;
  readonly readText: (path: string) => Effect.Effect<string, FileError>;
  readonly write: <E, R>(
    path: string,
    content: Stream.Stream<Uint8Array, E, R>,
    options?: FileWriteOptions,
  ) => Effect.Effect<void, FileError | E, R>;
  readonly mkdir: (
    path: string,
    options?: { readonly recursive?: boolean },
  ) => Effect.Effect<void, FileError>;
}

export interface Container {
  readonly name: string;
  readonly project: string;
  readonly exec: (
    command: readonly string[],
    options?: ExecOptions,
  ) => Effect.Effect<ExecResult, ExecError>;
  readonly files: FileOperations;
}

export interface ContainerCollection {
  readonly scoped: (
    options: CreateOptions,
  ) => Effect.Effect<Container, IncusApi.ApiError, Scope.Scope>;
  readonly exists: (name: string) => Effect.Effect<boolean, IncusApi.ApiError>;
}

export * as IncusContainer from "./incus-container.ts";
