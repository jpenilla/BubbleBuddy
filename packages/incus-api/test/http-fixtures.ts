import { Effect, Layer } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { IncusApi } from "../src/incus-api.ts";
import { IncusTransport } from "../src/incus-transport.ts";

export type HttpHandler = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

export const layerWith = (handler: HttpHandler) =>
  IncusApi.layer.pipe(
    Layer.provide(
      Layer.succeed(IncusTransport.Service, {
        httpClient: HttpClient.makeWith<
          HttpClientError.HttpClientError,
          never,
          HttpClientError.HttpClientError,
          never
        >(Effect.flatMap(handler), Effect.succeed),
        makeWebSocket: () => Effect.die(new Error("Unexpected websocket request")),
      }),
    ),
  );
