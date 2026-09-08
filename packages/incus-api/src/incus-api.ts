import { Cause, Context, Data, Effect, Layer, Match, Option, Schema, Scope, Stream } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import {
  Headers,
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpMethod,
} from "effect/unstable/http";

import { IncusTransport } from "./incus-transport.ts";

const ImageSource = Schema.Struct({
  type: Schema.Literal("image"),
  alias: Schema.optionalKey(Schema.String),
  fingerprint: Schema.optionalKey(Schema.String),
  server: Schema.optionalKey(Schema.String),
  protocol: Schema.optionalKey(Schema.String),
});

const InstanceCreateRequest = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["container", "virtual-machine"]),
  ephemeral: Schema.optionalKey(Schema.Boolean),
  profiles: Schema.optionalKey(Schema.Array(Schema.String)),
  config: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devices: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
  ),
  source: ImageSource,
  start: Schema.optionalKey(Schema.Boolean),
});

export interface InstanceCreateRequest extends Schema.Schema.Type<typeof InstanceCreateRequest> {}

const InstanceStateRequest = Schema.Struct({
  action: Schema.Literals(["start", "stop", "restart", "freeze", "unfreeze"]),
  timeout: Schema.optionalKey(Schema.Int),
  force: Schema.optionalKey(Schema.Boolean),
});

export interface InstanceStateRequest extends Schema.Schema.Type<typeof InstanceStateRequest> {}

const InstanceExecRequest = Schema.Struct({
  command: Schema.Array(Schema.String),
  interactive: Schema.optionalKey(Schema.Boolean),
  "wait-for-websocket": Schema.optionalKey(Schema.Boolean),
  cwd: Schema.optionalKey(Schema.String),
  environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

export interface InstanceExecRequest extends Schema.Schema.Type<typeof InstanceExecRequest> {}

export class StatusCodeError extends Schema.TaggedError<StatusCodeError>()(
  "IncusApi.StatusCodeError",
  {
    method: Schema.String,
    path: Schema.String,
    status: Schema.Finite,
    body: Schema.String,
  },
) {}

export class OperationError extends Schema.TaggedError<OperationError>()(
  "IncusApi.OperationError",
  {
    operation: Schema.String,
    message: Schema.String,
    metadata: Schema.Unknown,
  },
) {}

export class TimeoutError extends Schema.TaggedError<TimeoutError>()("IncusApi.TimeoutError", {
  method: Schema.String,
  path: Schema.String,
  requestedTimeoutSeconds: Schema.Finite,
  clientTimeoutSeconds: Schema.Finite,
}) {}

export type ApiError =
  | HttpBody.HttpBodyError
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | StatusCodeError
  | OperationError
  | TimeoutError;

export interface ProjectOptions {
  readonly project: string;
}

export interface WaitOperationOptions extends ProjectOptions {
  readonly timeoutSeconds?: number;
  readonly failureMode?: "fail" | "return";
}

export interface OperationRef {
  readonly id: string;
}

export interface ExecOperationRef extends OperationRef {
  readonly websocketSecrets?: Readonly<Record<string, string>>;
}

export type OperationWaitResult =
  | { readonly status: "running"; readonly metadata?: unknown }
  | { readonly status: "success"; readonly metadata?: unknown }
  | { readonly status: "failure"; readonly error?: string; readonly metadata?: unknown };

const FileType = Schema.Literals(["file", "symlink", "directory"]);

const DirectoryResponse = Schema.Struct({
  type: Schema.Literal("sync"),
  metadata: Schema.Array(Schema.String),
});

export interface FileInfo {
  readonly type: typeof FileType.Type;
  readonly uid?: number;
  readonly gid?: number;
  readonly mode?: number;
  readonly modified?: string;
}

export type FileRead = Data.TaggedEnum<{
  File: {
    readonly size: bigint | undefined;
    /** Consume before the scope that acquired this response closes. */
    readonly bytes: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>;
  };
  Symlink: {
    /** Target path returned by Incus; not guaranteed to be fully dereferenced. */
    readonly target: string;
  };
  Directory: {
    /** Immediate entry names, not full paths. */
    readonly entries: readonly string[];
  };
}>;

export const FileRead = Data.taggedEnum<FileRead>();

export interface Interface {
  readonly instances: {
    readonly create: (
      payload: InstanceCreateRequest,
      options: ProjectOptions,
    ) => Effect.Effect<OperationRef, ApiError>;
    readonly exists: (name: string, options: ProjectOptions) => Effect.Effect<boolean, ApiError>;
    readonly delete: (
      name: string,
      options: ProjectOptions,
    ) => Effect.Effect<OperationRef, ApiError>;
    readonly setState: (
      name: string,
      payload: InstanceStateRequest,
      options: ProjectOptions,
    ) => Effect.Effect<OperationRef, ApiError>;
    readonly exec: (
      name: string,
      payload: InstanceExecRequest,
      options: ProjectOptions,
    ) => Effect.Effect<ExecOperationRef, ApiError>;
    readonly files: {
      readonly read: (
        name: string,
        path: string,
        options: ProjectOptions,
      ) => Effect.Effect<FileRead, ApiError, Scope.Scope>;
      readonly stat: (
        name: string,
        path: string,
        options: ProjectOptions,
      ) => Effect.Effect<FileInfo | null, ApiError>;
      readonly write: (
        name: string,
        path: string,
        body: Stream.Stream<Uint8Array, unknown> | undefined,
        headers: Record<string, string>,
        options: ProjectOptions,
      ) => Effect.Effect<void, ApiError>;
    };
  };
  readonly operations: {
    readonly makeWebSocket: (
      operationId: string,
      secret: string,
      options?: IncusTransport.WebSocketOptions,
    ) => Effect.Effect<Socket.Socket>;
    readonly wait: (
      operationId: string,
      options: WaitOperationOptions,
    ) => Effect.Effect<OperationWaitResult, ApiError>;
    readonly cancel: (
      operationId: string,
      options: ProjectOptions,
    ) => Effect.Effect<void, ApiError>;
  };
}

export class Service extends Context.Service<Service, Interface>()("incus-api/IncusApi") {}

export const layer: Layer.Layer<Service, never, IncusTransport.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const transport = yield* IncusTransport.Service;
    const client = transport.httpClient;

    const operationFromBody = (
      response: AsyncOperationResponse,
    ): Effect.Effect<OperationRef, OperationError> =>
      operationIdFromPath("operationFromBody", response.operation).pipe(
        Effect.map((id) => ({ id })),
      );

    const execOperationFromBody = (
      response: ExecAsyncOperationResponse,
    ): Effect.Effect<ExecOperationRef, OperationError> =>
      operationIdFromPath("execOperationFromBody", response.operation).pipe(
        Effect.map((id) => ({
          id,
          ...(response.metadata.metadata.fds === undefined
            ? {}
            : { websocketSecrets: response.metadata.metadata.fds }),
        })),
      );

    return Service.of({
      instances: {
        create: Effect.fn("IncusApi.instances.create")(function* (payload, options) {
          const body = yield* request(client, {
            method: "POST",
            path: `/1.0/instances${projectQuery(options.project)}`,
            body: yield* HttpBody.jsonSchema(InstanceCreateRequest)(payload),
          }).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(AsyncOperationResponse)),
            Effect.scoped,
          );
          return yield* operationFromBody(body);
        }),
        exists: Effect.fn("IncusApi.instances.exists")((name, options) =>
          request(client, {
            method: "GET",
            path: `/1.0/instances/${encodeURIComponent(name)}${projectQuery(options.project)}`,
          }).pipe(
            Effect.as(true),
            Effect.scoped,
            Effect.catchIf(isNotFound, () => Effect.succeed(false)),
          ),
        ),
        delete: Effect.fn("IncusApi.instances.delete")(function* (name, options) {
          const body = yield* request(client, {
            method: "DELETE",
            path: `/1.0/instances/${encodeURIComponent(name)}${projectQuery(options.project)}`,
          }).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(AsyncOperationResponse)),
            Effect.scoped,
          );
          return yield* operationFromBody(body);
        }),
        setState: Effect.fn("IncusApi.instances.setState")(function* (name, payload, options) {
          const body = yield* request(client, {
            method: "PUT",
            path: `/1.0/instances/${encodeURIComponent(name)}/state${projectQuery(options.project)}`,
            body: yield* HttpBody.jsonSchema(InstanceStateRequest)(payload),
          }).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(AsyncOperationResponse)),
            Effect.scoped,
          );
          return yield* operationFromBody(body);
        }),
        exec: Effect.fn("IncusApi.instances.exec")(function* (name, payload, options) {
          const body = yield* request(client, {
            method: "POST",
            path: `/1.0/instances/${encodeURIComponent(name)}/exec${projectQuery(options.project)}`,
            body: yield* HttpBody.jsonSchema(InstanceExecRequest)(payload),
          }).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecAsyncOperationResponse)),
            Effect.scoped,
          );
          return yield* execOperationFromBody(body);
        }),
        files: {
          read: Effect.fn("IncusApi.instances.files.read")(function* (name, path, options) {
            const response = yield* request(client, {
              method: "GET",
              path: instanceFilePath(name, path, options.project),
            });
            const type = yield* Schema.decodeUnknownEffect(FileType)(
              header(response, "x-incus-type"),
            );
            return yield* Match.value(type).pipe(
              Match.when("file", () =>
                Effect.succeed(
                  FileRead.File({
                    size: bigintHeader(response, "content-length"),
                    bytes: response.stream,
                  }),
                ),
              ),
              Match.when("symlink", () =>
                response.text.pipe(Effect.map((target) => FileRead.Symlink({ target }))),
              ),
              Match.when("directory", () =>
                HttpClientResponse.schemaBodyJson(DirectoryResponse)(response).pipe(
                  Effect.map((body) => FileRead.Directory({ entries: body.metadata })),
                ),
              ),
              Match.exhaustive,
            );
          }),
          stat: Effect.fn("IncusApi.instances.files.stat")((name, path, options) =>
            instanceFileHead(client, name, path, options).pipe(
              Effect.catchIf(isNotFound, () => Effect.succeed(null)),
            ),
          ),
          write: Effect.fn("IncusApi.instances.files.write")((name, path, body, headers, options) =>
            request(client, {
              method: "POST",
              path: instanceFilePath(name, path, options.project),
              body: body === undefined ? HttpBody.empty : HttpBody.stream(body),
              headers,
            }).pipe(Effect.asVoid, Effect.scoped),
          ),
        },
      },
      operations: {
        makeWebSocket: Effect.fn("IncusApi.operations.makeWebSocket")(
          (operationId, secret, options) =>
            transport.makeWebSocket(
              `/1.0/operations/${encodeURIComponent(operationId)}/websocket?secret=${encodeURIComponent(secret)}`,
              options,
            ),
        ),
        wait: Effect.fn("IncusApi.operations.wait")(function* (operationId, options) {
          const wait = Effect.gen(function* () {
            const body = yield* operationWaitGet(client, operationId, options);
            const result = yield* operationWaitResult(operationId, body);
            return yield* options.failureMode === "return"
              ? Effect.succeed(result)
              : failOperationWaitResult(operationId, result, body);
          });
          if (options.timeoutSeconds === undefined) return yield* wait;
          const requestedTimeoutSeconds = options.timeoutSeconds;
          const clientTimeoutSeconds = requestedTimeoutSeconds + OperationWaitGraceSeconds;
          return yield* wait.pipe(
            Effect.timeout(`${clientTimeoutSeconds} seconds`),
            Effect.mapError((error) =>
              Cause.isTimeoutError(error)
                ? new TimeoutError({
                    method: "GET",
                    path: `/1.0/operations/${encodeURIComponent(operationId)}/wait`,
                    requestedTimeoutSeconds,
                    clientTimeoutSeconds,
                  })
                : error,
            ),
          );
        }),
        cancel: Effect.fn("IncusApi.operations.cancel")((operationId, options) =>
          request(client, {
            method: "DELETE",
            path: `/1.0/operations/${encodeURIComponent(operationId)}${projectQuery(options.project)}`,
          }).pipe(Effect.asVoid, Effect.scoped),
        ),
      },
    });
  }),
);

const IncusOperation = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  status_code: Schema.optionalKey(Schema.Int),
  err: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.Unknown),
});
type IncusOperation = typeof IncusOperation.Type;

const ExecOperationMetadata = Schema.Struct({
  fds: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const ExecOperation = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  status_code: Schema.optionalKey(Schema.Int),
  err: Schema.optionalKey(Schema.String),
  metadata: ExecOperationMetadata,
});

const AsyncOperationResponse = Schema.Struct({
  type: Schema.Literal("async"),
  operation: Schema.String,
  metadata: Schema.optionalKey(IncusOperation),
});
type AsyncOperationResponse = typeof AsyncOperationResponse.Type;

const ExecAsyncOperationResponse = Schema.Struct({
  type: Schema.Literal("async"),
  operation: Schema.String,
  metadata: ExecOperation,
});
type ExecAsyncOperationResponse = typeof ExecAsyncOperationResponse.Type;

const OperationWaitResponse = Schema.Struct({
  type: Schema.Literal("sync"),
  metadata: IncusOperation,
});
type OperationWaitResponse = typeof OperationWaitResponse.Type;

const operationWaitGet = (
  client: HttpClient.HttpClient,
  operationId: string,
  options: WaitOperationOptions,
) => {
  const params = new URLSearchParams();
  params.set("timeout", String(options.timeoutSeconds ?? -1));
  params.set("project", options.project);
  const path = `/1.0/operations/${encodeURIComponent(operationId)}/wait?${params.toString()}`;
  return request(client, { method: "GET", path }).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(OperationWaitResponse)),
    Effect.scoped,
  );
};

const operationWaitResult = (
  operationId: string,
  body: OperationWaitResponse,
): Effect.Effect<OperationWaitResult, OperationError> => {
  const statusCode = body.metadata.status_code;
  if (statusCode === undefined) {
    return Effect.fail(
      new OperationError({
        operation: operationId,
        message: "Incus operation wait response did not include a status code",
        metadata: body,
      }),
    );
  }
  if (statusCode >= 400) {
    return Effect.succeed({
      status: "failure",
      error: body.metadata.err,
      metadata: body.metadata.metadata,
    });
  }
  if (statusCode < 200) {
    return Effect.succeed({ status: "running", metadata: body.metadata.metadata });
  }
  return Effect.succeed({ status: "success", metadata: body.metadata.metadata });
};

const failOperationWaitResult = (
  operationId: string,
  result: OperationWaitResult,
  body: OperationWaitResponse,
): Effect.Effect<OperationWaitResult, OperationError> =>
  result.status === "failure"
    ? Effect.fail(
        new OperationError({
          operation: operationId,
          message: result.error ?? "Incus operation failed",
          metadata: body,
        }),
      )
    : Effect.succeed(result);

const operationIdFromPath = (
  operation: string,
  path: string,
): Effect.Effect<string, OperationError> => {
  const id = path.split("/").pop();
  if (id) return Effect.succeed(id);
  return Effect.fail(
    new OperationError({
      operation,
      message: "Incus async operation response did not include an operation id",
      metadata: { operation: path },
    }),
  );
};

const instanceFileHead = (
  client: HttpClient.HttpClient,
  name: string,
  path: string,
  options: ProjectOptions,
) =>
  request(client, {
    method: "HEAD",
    path: instanceFilePath(name, path, options.project),
  }).pipe(
    Effect.flatMap((response) =>
      Schema.decodeUnknownEffect(FileType)(header(response, "x-incus-type")).pipe(
        Effect.map((type): FileInfo => ({
          type,
          uid: numberHeader(response, "x-incus-uid"),
          gid: numberHeader(response, "x-incus-gid"),
          mode: numberHeader(response, "x-incus-mode"),
          modified: header(response, "x-incus-modified"),
        })),
      ),
    ),
    Effect.scoped,
  );

interface RequestOptions {
  readonly method: HttpMethod.HttpMethod;
  readonly path: string;
  readonly body?: HttpBody.HttpBody;
  readonly headers?: Record<string, string>;
}

const request = (
  client: HttpClient.HttpClient,
  options: RequestOptions,
): Effect.Effect<HttpClientResponse.HttpClientResponse, ApiError, Scope.Scope> =>
  Effect.gen(function* () {
    const req = HttpClientRequest.make(options.method)(options.path, {
      body: options.body ?? HttpBody.empty,
      headers: options.headers,
    });

    const response = yield* HttpClient.withScope(client).execute(req);
    if (response.status >= 200 && response.status < 300) return response;
    return yield* statusError(options.method, options.path, response);
  });

const statusError = (
  method: string,
  path: string,
  response: HttpClientResponse.HttpClientResponse,
) =>
  response.text.pipe(
    Effect.flatMap((body) =>
      Effect.fail(
        new StatusCodeError({
          method,
          path,
          status: response.status,
          body,
        }),
      ),
    ),
  );

const instanceFilePath = (name: string, path: string, project: string) => {
  const params = new URLSearchParams();
  params.set("path", path);
  params.set("project", project);
  return `/1.0/instances/${encodeURIComponent(name)}/files?${params.toString()}`;
};

const projectQuery = (project: string) => {
  const params = new URLSearchParams();
  params.set("project", project);
  return `?${params.toString()}`;
};

const isNotFound = (error: unknown): error is StatusCodeError =>
  error instanceof StatusCodeError && error.status === 404;

const header = (response: HttpClientResponse.HttpClientResponse, name: string) =>
  Option.getOrUndefined(Headers.get(response.headers, name));

const numberHeader = (response: HttpClientResponse.HttpClientResponse, name: string) => {
  const value = header(response, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const bigintHeader = (response: HttpClientResponse.HttpClientResponse, name: string) => {
  const value = header(response, name);
  if (value === undefined) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
};

const OperationWaitGraceSeconds = 5;

export * as IncusApi from "./incus-api.ts";
