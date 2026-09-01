import Mime from "@effect/platform-node/Mime";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import type { DualPath } from "../../shared/workspace.ts";

export class AssetSaveError extends Schema.TaggedError<AssetSaveError>()("AssetSaveError", {
  message: Schema.String,
}) {}

const fetchAsset = Effect.fn("fetchAsset")(function* (url: string) {
  const http = yield* HttpClient.HttpClient;
  return yield* http.get(url).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
});

const writeAsset = Effect.fn("writeAsset")(function* (
  response: HttpClientResponse.HttpClientResponse,
  directory: string,
  filename: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (path.basename(filename) !== filename || filename === "." || filename === "..") {
    return yield* new AssetSaveError({ message: "Invalid asset filename." });
  }
  const destination = path.join(directory, filename);
  const temporaryPath = `${destination}.${crypto.randomUUID()}.tmp`;
  yield* Stream.run(response.stream, fs.sink(temporaryPath)).pipe(
    Effect.andThen(fs.rename(temporaryPath, destination)),
    Effect.ensuring(fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
  );
});

export const downloadAsset = Effect.fn("downloadAsset")(function* (
  url: string,
  directory: DualPath,
  filename: string,
) {
  const asset = yield* fetchAsset(url);
  yield* writeAsset(asset, directory.host, filename);
  return `${directory.container}/${filename}`;
});

export const downloadAssetByContentType = Effect.fn("downloadAssetByContentType")(function* (
  url: string,
  directory: DualPath,
  filenameStem: string,
) {
  const response = yield* fetchAsset(url);
  const contentType = response.headers["content-type"];
  if (contentType === undefined || contentType.trim().length === 0) {
    return yield* new AssetSaveError({ message: "Asset response has no Content-Type." });
  }
  const normalized = contentType.split(";", 1)[0]!.trim().toLowerCase();
  const extension = Mime.getExtension(normalized);
  if (extension === null) {
    return yield* new AssetSaveError({
      message: `Asset has an unknown Content-Type: ${normalized}.`,
    });
  }
  const filename = `${filenameStem}.${extension}`;
  yield* writeAsset(response, directory.host, filename);
  return `${directory.container}/${filename}`;
});

export type AssetJob<E, R> = {
  readonly label: string;
  readonly save: Effect.Effect<string, E, R>;
};

export const runAssetJobs = Effect.fn("runAssetJobs")(function* <E, R>(jobs: AssetJob<E, R>[]) {
  if (jobs.length === 0) {
    return yield* new AssetSaveError({
      message: "Select at least one asset to save.",
    });
  }
  const results = yield* Effect.forEach(
    jobs,
    ({ label, save }) =>
      save.pipe(
        Effect.match({
          onFailure: (error) =>
            `[${label}] error: ${error instanceof Error ? error.message : String(error)}`,
          onSuccess: (path) => `[${label}] ${path}`,
        }),
      ),
    { concurrency: 3 },
  );
  return results.join("\n");
});
