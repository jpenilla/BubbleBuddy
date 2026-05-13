import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { IncusHttpClient } from "./http-client.ts";

export class IncusApiTransportError extends Data.TaggedError("IncusApiTransportError")<{
  readonly method: string;
  readonly path: string;
  readonly cause: unknown;
}> {}

export class IncusApiStatusCodeError extends Data.TaggedError("IncusApiStatusCodeError")<{
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body: string;
}> {}

export class IncusApiBodyError extends Data.TaggedError("IncusApiBodyError")<{
  readonly method: string;
  readonly path: string;
  readonly bodyType: "json" | "text" | "arrayBuffer";
  readonly cause: unknown;
}> {}

export class IncusApiOperationError extends Data.TaggedError("IncusApiOperationError")<{
  readonly operation: string;
  readonly message: string;
  readonly metadata: unknown;
}> {}

export class IncusApiTimeoutError extends Data.TaggedError("IncusApiTimeoutError")<{
  readonly method: string;
  readonly path: string;
  readonly requestedTimeoutMs: number;
  readonly clientTimeoutMs: number;
}> {}

export type IncusApiError =
  | IncusApiTransportError
  | IncusApiStatusCodeError
  | IncusApiBodyError
  | IncusApiOperationError
  | IncusApiTimeoutError;

export interface ProjectOptions {
  readonly project: string;
}

export interface WaitOperationOptions extends ProjectOptions {
  readonly timeoutMs?: number;
}

export interface OperationRef {
  readonly id: string;
}

export interface IncusFileInfo {
  readonly type?: string;
  readonly uid?: number;
  readonly gid?: number;
  readonly mode?: number;
  readonly modified?: string;
}

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "TRACE";

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
    ) => Effect.Effect<OperationRef, IncusApiError>;
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
      readonly readExecOutput: (
        path: string,
        options: ProjectOptions,
      ) => Effect.Effect<string, IncusApiError>;
    };
  };
  readonly operations: {
    readonly wait: (
      operationId: string,
      options: WaitOperationOptions,
    ) => Effect.Effect<OperationWaitResponse, IncusApiError>;
    readonly cancel: (
      operationId: string,
      options: ProjectOptions,
    ) => Effect.Effect<void, IncusApiError>;
  };
}

export class IncusApi extends Context.Service<IncusApi, IncusApiService>()("incus-api/IncusApi", {
  make: Effect.gen(function* () {
    const client = yield* IncusHttpClient;

    const operationFromBody = (body: unknown) =>
      operationIdFromBody(body).pipe(Effect.map((id): OperationRef => ({ id })));

    return {
      instances: {
        create: Effect.fn("IncusApi.instances.create")(function* (payload, options) {
          return yield* jsonRequest(
            client,
            "POST",
            `/1.0/instances${projectQuery(options.project)}`,
            payload,
          ).pipe(Effect.flatMap(({ body }) => operationFromBody(body)));
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
          return yield* jsonRequest(
            client,
            "DELETE",
            `/1.0/instances/${encodeURIComponent(name)}${projectQuery(options.project)}`,
          ).pipe(Effect.flatMap(({ body }) => operationFromBody(body)));
        }),
        setState: Effect.fn("IncusApi.instances.setState")(function* (name, payload, options) {
          return yield* jsonRequest(
            client,
            "PUT",
            `/1.0/instances/${encodeURIComponent(name)}/state${projectQuery(options.project)}`,
            payload,
          ).pipe(Effect.flatMap(({ body }) => operationFromBody(body)));
        }),
        exec: Effect.fn("IncusApi.instances.exec")(function* (name, payload, options) {
          return yield* jsonRequest(
            client,
            "POST",
            `/1.0/instances/${encodeURIComponent(name)}/exec${projectQuery(options.project)}`,
            payload,
          ).pipe(Effect.flatMap(({ body }) => operationFromBody(body)));
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
                body,
                headers,
              }).pipe(Effect.asVoid);
            },
          ),
          readExecOutput: Effect.fn("IncusApi.instances.files.readExecOutput")(
            function* (path, options) {
              return yield* textRequest(client, "GET", `${path}${projectQuery(options.project)}`);
            },
          ),
        },
      },
      operations: {
        wait: Effect.fn("IncusApi.operations.wait")(function* (operationId, options) {
          return yield* operationWaitGet(client, operationId, options);
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

const operationIdFromBody = (body: unknown): Effect.Effect<string, IncusApiOperationError> =>
  Schema.decodeUnknownEffect(IncusResponseEnvelope)(body).pipe(
    Effect.mapError(
      (cause) =>
        new IncusApiOperationError({
          operation: "operationIdFromBody",
          message: "Failed to decode Incus operation response",
          metadata: { cause, body },
        }),
    ),
    Effect.flatMap((envelope) => {
      const operation =
        envelope.operation ??
        (typeof envelope.metadata === "string" ? envelope.metadata : undefined);
      const id = operation?.split("/").pop();
      if (id) return Effect.succeed(id);
      return Effect.fail(
        new IncusApiOperationError({
          operation: "operationIdFromBody",
          message: "Incus operation response did not include an operation id",
          metadata: envelope,
        }),
      );
    }),
  );

const IncusResponseEnvelopeFields = {
  type: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  status_code: Schema.optionalKey(Schema.Number),
  operation: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  error_code: Schema.optionalKey(Schema.Number),
  metadata: Schema.optionalKey(Schema.Unknown),
};

const IncusResponseEnvelope = Schema.Struct(IncusResponseEnvelopeFields);

const OperationMetadata = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  status_code: Schema.optionalKey(Schema.Number),
  err: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.Unknown),
});

const OperationWaitResponse = Schema.Struct({
  ...IncusResponseEnvelopeFields,
  metadata: OperationMetadata,
});
export type OperationWaitResponse = typeof OperationWaitResponse.Type;

const operationWaitGet = (
  client: HttpClient.HttpClient,
  operationId: string,
  options: WaitOperationOptions,
) => {
  const params = new URLSearchParams();
  params.set("timeout", String(timeoutSecondsFromMs(options.timeoutMs)));
  params.set("project", options.project);
  const path = `/1.0/operations/${encodeURIComponent(operationId)}/wait?${params.toString()}`;
  const effect = jsonRequest(client, "GET", path).pipe(
    Effect.flatMap(({ body }) =>
      Schema.decodeUnknownEffect(OperationWaitResponse)(body).pipe(
        Effect.mapError(
          (cause) =>
            new IncusApiOperationError({
              operation: operationId,
              message: "Failed to decode Incus operation wait response",
              metadata: { cause, body },
            }),
        ),
      ),
    ),
    Effect.flatMap((body) => validateOperationWaitResponse(operationId, body)),
  );
  return effect;
};

const validateOperationWaitResponse = (
  operationId: string,
  body: OperationWaitResponse,
): Effect.Effect<OperationWaitResponse, IncusApiOperationError> => {
  const statusCode = body.metadata.status_code ?? body.status_code ?? body.error_code;
  if (statusCode !== undefined && statusCode >= 400) {
    return Effect.fail(
      new IncusApiOperationError({
        operation: operationId,
        message: body.metadata.err ?? body.error ?? "Incus operation failed",
        metadata: body,
      }),
    );
  }
  return Effect.succeed(body);
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

const jsonRequest = (
  client: HttpClient.HttpClient,
  method: HttpMethod,
  path: string,
  payload?: unknown,
) =>
  request(client, { method, path, payload }).pipe(
    Effect.flatMap((response) =>
      response.json.pipe(
        Effect.mapError(
          (cause) => new IncusApiBodyError({ method, path, bodyType: "json", cause }),
        ),
        Effect.map((body) => ({ response, body })),
      ),
    ),
  );

const emptyRequest = (client: HttpClient.HttpClient, method: HttpMethod, path: string) =>
  request(client, { method, path });

const textRequest = (client: HttpClient.HttpClient, method: HttpMethod, path: string) =>
  request(client, { method, path }).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.mapError(
          (cause) => new IncusApiBodyError({ method, path, bodyType: "text", cause }),
        ),
      ),
    ),
  );

const bytesRequest = (client: HttpClient.HttpClient, method: HttpMethod, path: string) =>
  request(client, { method, path }).pipe(
    Effect.flatMap((response) =>
      response.arrayBuffer.pipe(
        Effect.mapError(
          (cause) => new IncusApiBodyError({ method, path, bodyType: "arrayBuffer", cause }),
        ),
      ),
    ),
    Effect.map((buffer) => new Uint8Array(buffer)),
  );

const request = (
  client: HttpClient.HttpClient,
  options: {
    readonly method: HttpMethod;
    readonly path: string;
    readonly payload?: unknown;
    readonly body?: Uint8Array | string;
    readonly headers?: Record<string, string>;
  },
): Effect.Effect<HttpClientResponse.HttpClientResponse, IncusApiError> =>
  Effect.gen(function* () {
    const body =
      options.payload !== undefined
        ? yield* HttpBody.json(options.payload).pipe(
            Effect.mapError(
              (cause) =>
                new IncusApiBodyError({
                  method: options.method,
                  path: options.path,
                  bodyType: "json",
                  cause,
                }),
            ),
          )
        : options.body !== undefined
          ? typeof options.body === "string"
            ? HttpBody.text(options.body)
            : HttpBody.uint8Array(options.body)
          : HttpBody.empty;

    const req = HttpClientRequest.make(options.method)(options.path, {
      body,
      headers: options.headers,
    });

    const response = yield* client
      .execute(req)
      .pipe(
        Effect.mapError(
          (cause: HttpClientError.HttpClientError) =>
            new IncusApiTransportError({ method: options.method, path: options.path, cause }),
        ),
      );
    if (response.status >= 200 && response.status < 300) return response;
    return yield* statusError(options.method, options.path, response);
  });

const statusError = (
  method: string,
  path: string,
  response: HttpClientResponse.HttpClientResponse,
) =>
  response.text.pipe(
    Effect.mapError((cause) => new IncusApiBodyError({ method, path, bodyType: "text", cause })),
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

const timeoutSecondsFromMs = (timeoutMs?: number) =>
  timeoutMs === undefined ? -1 : Math.ceil(timeoutMs / 1000);

const header = (response: HttpClientResponse.HttpClientResponse, name: string) =>
  Option.getOrUndefined(Headers.get(response.headers, name));

const numberHeader = (response: HttpClientResponse.HttpClientResponse, name: string) => {
  const value = header(response, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
