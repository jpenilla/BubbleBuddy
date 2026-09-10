import { GuestPath } from "incus-api";
import Mime from "@effect/platform-node/Mime";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { posix } from "node:path";

import { SessionContainer } from "../../session/session-container.ts";

export class AssetSaveError extends Schema.TaggedError<AssetSaveError>()("AssetSaveError", {
  message: Schema.String,
}) {}

const fetchAsset = Effect.fn("fetchAsset")(function* (url: string) {
  const http = yield* HttpClient.HttpClient;
  return yield* HttpClient.withScope(http)
    .get(url)
    .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
});

export const prepareAssetDirectory = Effect.fn("prepareAssetDirectory")(function* (
  ...segments: string[]
) {
  const sessionContainer = yield* SessionContainer.Service;
  const directory = yield* GuestPath.resolve(sessionContainer.cwd, ...segments);
  const container = yield* sessionContainer.get;
  yield* container.files.mkdir(directory, { recursive: true });
  return directory;
});

const writeAsset = Effect.fn("writeAsset")(function* (
  response: HttpClientResponse.HttpClientResponse,
  directory: GuestPath.GuestPath,
  filename: string,
) {
  if (posix.basename(filename) !== filename || filename === "." || filename === "..") {
    return yield* new AssetSaveError({ message: "Invalid asset filename." });
  }

  const sessionContainer = yield* SessionContainer.Service;
  const container = yield* sessionContainer.get;
  const destination = yield* GuestPath.resolve(directory, filename);
  const temporaryPath = yield* GuestPath.resolve(
    directory,
    `${filename}.${crypto.randomUUID()}.tmp`,
  );
  yield* container.files
    .write(temporaryPath, response.stream)
    .pipe(
      Effect.andThen(
        container
          .exec(["/bin/mv", "-fT", "--", temporaryPath, destination])
          .pipe(
            Effect.flatMap((result) =>
              result.exitCode === 0
                ? Effect.void
                : Effect.fail(new AssetSaveError({ message: `Could not replace ${destination}.` })),
            ),
          ),
      ),
      Effect.ensuring(
        container
          .exec(["/bin/rm", "-f", "--", temporaryPath], { timeoutSeconds: 2 })
          .pipe(Effect.timeout("3 seconds"), Effect.ignore),
      ),
    );
  return destination;
});

export const downloadAsset = Effect.fn("downloadAsset")(function* (
  url: string,
  directory: GuestPath.GuestPath,
  filename: string,
) {
  const asset = yield* fetchAsset(url);
  return yield* writeAsset(asset, directory, filename);
});

export const downloadAssetByContentType = Effect.fn("downloadAssetByContentType")(function* (
  url: string,
  directory: GuestPath.GuestPath,
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
  return yield* writeAsset(response, directory, filename);
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
