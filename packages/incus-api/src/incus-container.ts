import { Effect, Schema, Scope, Stream } from "effect";

import type { GuestPath } from "./guest-path.ts";

import type { IncusApi } from "./incus-api.ts";

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

export type FileError = IncusApi.ApiError | MetadataError;
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

/** Receives one binary output frame; failures abort the exec as `ExecCallbackError`. */
export type OutputCallback = (chunk: Uint8Array) => Effect.Effect<void, unknown>;

export interface ExecOptions {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutSeconds?: number;
  readonly onStdout?: OutputCallback;
  readonly onStderr?: OutputCallback;
}

export interface ExecResult {
  readonly exitCode: number;
}

/** Paths must be validated, lexically normalized absolute guest paths. */
export interface FileOperations {
  readonly read: (path: GuestPath) => Effect.Effect<IncusApi.FileRead, FileError, Scope.Scope>;
  /** Rejects directories and symlinks. */
  readonly readFile: (
    path: GuestPath,
  ) => Effect.Effect<Extract<IncusApi.FileRead, { readonly _tag: "File" }>, FileError, Scope.Scope>;
  /** Rejects directories and symlinks. */
  readonly readBytes: (path: GuestPath) => Effect.Effect<Uint8Array, FileError>;
  /** Decodes UTF-8; rejects directories and symlinks. */
  readonly readText: (path: GuestPath) => Effect.Effect<string, FileError>;
  readonly write: <E, R>(
    path: GuestPath,
    content: Stream.Stream<Uint8Array, E, R>,
    options?: FileWriteOptions,
  ) => Effect.Effect<void, FileError | E, R>;
  readonly mkdir: (
    path: GuestPath,
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
  /** Creates an ephemeral container; scope closure attempts cleanup, logging any cleanup failure. */
  readonly scoped: (
    options: CreateOptions,
  ) => Effect.Effect<Container, IncusApi.ApiError, Scope.Scope>;
  readonly exists: (name: string) => Effect.Effect<boolean, IncusApi.ApiError>;
}

export * as IncusContainer from "./incus-container.ts";
