import { Context, Data, Effect, Layer, Option, Schema } from "effect";

import { IncusHttpClient } from "./http-client.ts";
import {
  HttpMethod,
  HttpClientResponse,
  HttpClientRequest,
  HttpClientError,
  HttpClient,
  HttpBody,
  Headers,
} from "effect/unstable/http";

export class IncusApiStatusCodeError extends Data.TaggedError("IncusApiStatusCodeError")<{
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body: string;
}> {}

export class IncusApiOperationError extends Data.TaggedError("IncusApiOperationError")<{
  readonly operation: string;
  readonly message: string;
  readonly metadata: unknown;
}> {}

export class IncusApiTimeoutError extends Data.TaggedError("IncusApiTimeoutError")<{
  readonly method: string;
  readonly path: string;
  readonly requestedTimeoutSeconds: number;
  readonly clientTimeoutSeconds: number;
}> {}

export type IncusApiError =
  | HttpBody.HttpBodyError
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | IncusApiStatusCodeError
  | IncusApiOperationError
  | IncusApiTimeoutError;

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

export interface IncusExecFds {
  readonly stdin: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly control: string;
}

export interface IncusExecOperationRef extends OperationRef {
  readonly fds: IncusExecFds;
}

export type OperationWaitResult =
  | {
      readonly status: "running";
      readonly metadata?: unknown;
    }
  | {
      readonly status: "success";
      readonly metadata?: unknown;
    }
  | {
      readonly status: "failure";
      readonly error?: string;
      readonly metadata?: unknown;
    };

export interface IncusFileInfo {
  readonly type?: string;
  readonly uid?: number;
  readonly gid?: number;
  readonly mode?: number;
  readonly modified?: string;
}

export interface IncusApiService {
  readonly instances: {
    readonly create: (
      payload: unknown,
      options: ProjectOptions,
    ) => Effect.Effect<OperationRef, IncusApiError>;
    readonly exists: (
      name: string,
      options: ProjectOptions,
    ) => Effect.Effect<boolean, IncusApiError>;
    readonly delete: (
      name: string,
      options: ProjectOptions,
    ) => Effect.Effect<OperationRef, IncusApiError>;
    readonly setState: (
      name: string,
      payload: unknown,
      options: ProjectOptions,
    ) => Effect.Effect<OperationRef, IncusApiError>;
    readonly exec: (
      name: string,
      payload: unknown,
      options: ProjectOptions,
    ) => Effect.Effect<IncusExecOperationRef, IncusApiError>;
    readonly files: {
      readonly readBytes: (
        name: string,
        path: string,
        options: ProjectOptions,
      ) => Effect.Effect<Uint8Array, IncusApiError>;
      readonly readText: (
        name: string,
        path: string,
        options: ProjectOptions,
      ) => Effect.Effect<string, IncusApiError>;
      readonly stat: (
        name: string,
        path: string,
        options: ProjectOptions,
      ) => Effect.Effect<IncusFileInfo | null, IncusApiError>;
      readonly write: (
        name: string,
        path: string,
        body: Uint8Array | string | undefined,
        headers: Record<string, string>,
        options: ProjectOptions,
      ) => Effect.Effect<void, IncusApiError>;
    };
  };
  readonly operations: {
    readonly wait: (
      operationId: string,
      options: WaitOperationOptions,
    ) => Effect.Effect<OperationWaitResult, IncusApiError>;
    readonly cancel: (
      operationId: string,
      options: ProjectOptions,
    ) => Effect.Effect<void, IncusApiError>;
  };
}

export class IncusApi extends Context.Service<IncusApi, IncusApiService>()("incus-api/IncusApi", {
  make: Effect.gen(function* () {
    const client = yield* IncusHttpClient;

    const operationFromBody = (
      response: AsyncOperationResponse,
    ): Effect.Effect<OperationRef, IncusApiOperationError> =>
      operationIdFromPath("operationFromBody", response.operation).pipe(
        Effect.map((id) => ({ id })),
      );

    const execOperationFromBody = (
      response: ExecAsyncOperationResponse,
    ): Effect.Effect<IncusExecOperationRef, IncusApiOperationError> =>
      operationIdFromPath("execOperationFromBody", response.operation).pipe(
        Effect.map((id) => ({
          id,
          fds: {
            stdin: response.metadata.metadata.fds["0"],
            stdout: response.metadata.metadata.fds["1"],
            stderr: response.metadata.metadata.fds["2"],
            control: response.metadata.metadata.fds.control,
          },
        })),
      );

    return {
      instances: {
        create: Effect.fn("IncusApi.instances.create")(function* (payload, options) {
          const response = yield* request(client, {
            method: "POST",
            path: `/1.0/instances${projectQuery(options.project)}`,
            body: yield* HttpBody.json(payload),
          });
          const body = yield* HttpClientResponse.schemaBodyJson(AsyncOperationResponse)(response);
          return yield* operationFromBody(body);
        }),
        exists: Effect.fn("IncusApi.instances.exists")(function* (name, options) {
          return yield* emptyRequest(
            client,
            "GET",
            `/1.0/instances/${encodeURIComponent(name)}${projectQuery(options.project)}`,
          ).pipe(
            Effect.as(true),
            Effect.catchIf(isNotFound, () => Effect.succeed(false)),
          );
        }),
        delete: Effect.fn("IncusApi.instances.delete")(function* (name, options) {
          const response = yield* request(client, {
            method: "DELETE",
            path: `/1.0/instances/${encodeURIComponent(name)}${projectQuery(options.project)}`,
          });
          const body = yield* HttpClientResponse.schemaBodyJson(AsyncOperationResponse)(response);
          return yield* operationFromBody(body);
        }),
        setState: Effect.fn("IncusApi.instances.setState")(function* (name, payload, options) {
          const response = yield* request(client, {
            method: "PUT",
            path: `/1.0/instances/${encodeURIComponent(name)}/state${projectQuery(options.project)}`,
            body: yield* HttpBody.json(payload),
          });
          const body = yield* HttpClientResponse.schemaBodyJson(AsyncOperationResponse)(response);
          return yield* operationFromBody(body);
        }),
        exec: Effect.fn("IncusApi.instances.exec")(function* (name, payload, options) {
          const response = yield* request(client, {
            method: "POST",
            path: `/1.0/instances/${encodeURIComponent(name)}/exec${projectQuery(options.project)}`,
            body: yield* HttpBody.json(payload),
          });
          const body = yield* HttpClientResponse.schemaBodyJson(ExecAsyncOperationResponse)(
            response,
          );
          return yield* execOperationFromBody(body);
        }),
        files: {
          readBytes: Effect.fn("IncusApi.instances.files.readBytes")(
            function* (name, path, options) {
              return yield* bytesRequest(
                client,
                "GET",
                instanceFilePath(name, path, options.project),
              );
            },
          ),
          readText: Effect.fn("IncusApi.instances.files.readText")(function* (name, path, options) {
            return yield* textRequest(client, "GET", instanceFilePath(name, path, options.project));
          }),
          stat: Effect.fn("IncusApi.instances.files.stat")(function* (name, path, options) {
            return yield* instanceFileHead(client, name, path, options).pipe(
              Effect.catchIf(isNotFound, () => Effect.succeed(null)),
            );
          }),
          write: Effect.fn("IncusApi.instances.files.write")(
            function* (name, path, body, headers, options) {
              return yield* request(client, {
                method: "POST",
                path: instanceFilePath(name, path, options.project),
                body: fileBody(body),
                headers,
              }).pipe(Effect.asVoid);
            },
          ),
        },
      },
      operations: {
        wait: Effect.fn("IncusApi.operations.wait")(function* (operationId, options) {
          const body = yield* operationWaitGet(client, operationId, options);
          const result = yield* operationWaitResult(operationId, body);
          return yield* options.failureMode === "return"
            ? Effect.succeed(result)
            : failOperationWaitResult(operationId, result, body);
        }),
        cancel: Effect.fn("IncusApi.operations.cancel")(function* (operationId, options) {
          return yield* emptyRequest(
            client,
            "DELETE",
            `/1.0/operations/${encodeURIComponent(operationId)}${projectQuery(options.project)}`,
          ).pipe(Effect.asVoid);
        }),
      },
    };
  }),
}) {
  static readonly layer: Layer.Layer<IncusApi, never, IncusHttpClient> = Layer.effect(
    this,
    this.make,
  );
}

const IncusOperation = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  status_code: Schema.optionalKey(Schema.Number),
  err: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.Unknown),
});
type IncusOperation = typeof IncusOperation.Type;

const ExecOperationMetadata = Schema.Struct({
  fds: Schema.Struct({
    "0": Schema.String,
    "1": Schema.String,
    "2": Schema.String,
    control: Schema.String,
  }),
});

const ExecOperation = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  status_code: Schema.optionalKey(Schema.Number),
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
  );
};

const operationWaitResult = (
  operationId: string,
  body: OperationWaitResponse,
): Effect.Effect<OperationWaitResult, IncusApiOperationError> => {
  const statusCode = body.metadata.status_code;
  if (statusCode === undefined) {
    return Effect.fail(
      new IncusApiOperationError({
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
): Effect.Effect<OperationWaitResult, IncusApiOperationError> =>
  result.status === "failure"
    ? Effect.fail(
        new IncusApiOperationError({
          operation: operationId,
          message: result.error ?? "Incus operation failed",
          metadata: body,
        }),
      )
    : Effect.succeed(result);

const operationIdFromPath = (
  operation: string,
  path: string,
): Effect.Effect<string, IncusApiOperationError> => {
  const id = path.split("/").pop();
  if (id) return Effect.succeed(id);
  return Effect.fail(
    new IncusApiOperationError({
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
  emptyRequest(client, "HEAD", instanceFilePath(name, path, options.project)).pipe(
    Effect.map(
      (response): IncusFileInfo => ({
        type: header(response, "x-incus-type"),
        uid: numberHeader(response, "x-incus-uid"),
        gid: numberHeader(response, "x-incus-gid"),
        mode: numberHeader(response, "x-incus-mode"),
        modified: header(response, "x-incus-modified"),
      }),
    ),
  );

const emptyRequest = (client: HttpClient.HttpClient, method: HttpMethod.HttpMethod, path: string) =>
  request(client, { method, path });

const textRequest = (client: HttpClient.HttpClient, method: HttpMethod.HttpMethod, path: string) =>
  request(client, { method, path }).pipe(Effect.flatMap((response) => response.text));

const bytesRequest = (client: HttpClient.HttpClient, method: HttpMethod.HttpMethod, path: string) =>
  request(client, { method, path }).pipe(
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((buffer) => new Uint8Array(buffer)),
  );

const request = (
  client: HttpClient.HttpClient,
  options: {
    readonly method: HttpMethod.HttpMethod;
    readonly path: string;
    readonly body?: HttpBody.HttpBody;
    readonly headers?: Record<string, string>;
  },
): Effect.Effect<HttpClientResponse.HttpClientResponse, IncusApiError> =>
  Effect.gen(function* () {
    const req = HttpClientRequest.make(options.method)(options.path, {
      body: options.body ?? HttpBody.empty,
      headers: options.headers,
    });

    const response = yield* client.execute(req);
    if (response.status >= 200 && response.status < 300) return response;
    return yield* statusError(options.method, options.path, response);
  });

const fileBody = (body: Uint8Array | string | undefined) =>
  body === undefined
    ? HttpBody.empty
    : typeof body === "string"
      ? HttpBody.text(body)
      : HttpBody.uint8Array(body);

const statusError = (
  method: string,
  path: string,
  response: HttpClientResponse.HttpClientResponse,
) =>
  response.text.pipe(
    Effect.flatMap((body) =>
      Effect.fail(
        new IncusApiStatusCodeError({
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

const isNotFound = (error: unknown): error is IncusApiStatusCodeError =>
  error instanceof IncusApiStatusCodeError && error.status === 404;

const header = (response: HttpClientResponse.HttpClientResponse, name: string) =>
  Option.getOrUndefined(Headers.get(response.headers, name));

const numberHeader = (response: HttpClientResponse.HttpClientResponse, name: string) => {
  const value = header(response, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
