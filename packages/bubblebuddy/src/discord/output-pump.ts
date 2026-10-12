import {
  type GuildTextBasedChannel,
  type MessageCreateOptions,
  type MessageEditOptions,
  type MessageMentionOptions,
  type ReplyOptions,
  type Snowflake,
} from "discord.js";
import { Cause, Context, Deferred, Effect, type Scope, type Tracer } from "effect";

import { createPriorityDrainableWorker } from "../shared/priority-drainable-worker.ts";
import { type DiscordJsError, editMessage, sendChunkedMessage, sendMessage } from "./utils.ts";

/** Posting to the channel, provided only to the pump's units so every post is ordered. */
export class Posting extends Context.Service<
  Posting,
  {
    /** Posts a message and returns its ID. */
    readonly send: (options: MessageCreateOptions) => Effect.Effect<Snowflake, DiscordJsError>;
    /** Posts text split across as many messages as it needs. */
    readonly sendChunked: (options: {
      readonly content: string;
      readonly reply?: ReplyOptions;
      readonly allowedMentions?: MessageMentionOptions;
    }) => Effect.Effect<void, DiscordJsError>;
    readonly edit: (
      id: Snowflake,
      options: MessageEditOptions,
    ) => Effect.Effect<void, DiscordJsError>;
    /** Whether the message `id` is the pump's latest post. */
    readonly isLatest: (id: Snowflake) => boolean;
  }
>()("bubblebuddy/discord/OutputPump.Posting") {}

export type ExecuteOrdered = <A, E>(operation: Effect.Effect<A, E, Posting>) => Effect.Effect<A, E>;

export interface Interface {
  /** Queues a unit of session output; units run in order, ahead of tool actions. */
  readonly enqueue: (unit: Effect.Effect<void, unknown, Posting>) => Effect.Effect<void>;
  /** Runs a tool's Discord action after the queued session output and waits for its result. */
  readonly executeOrdered: ExecuteOrdered;
}

export const send = (options: MessageCreateOptions) =>
  Posting.use((posting) => posting.send(options));

export const sendChunked = (options: {
  readonly content: string;
  readonly reply?: ReplyOptions;
  readonly allowedMentions?: MessageMentionOptions;
}) => Posting.use((posting) => posting.sendChunked(options));

interface WorkItem {
  readonly operation: Effect.Effect<void, unknown, Posting>;
  readonly producerSpan: Tracer.Span;
}

const createWorkItem = Effect.fnUntraced(function* (
  operation: Effect.Effect<void, unknown, Posting>,
) {
  const producerSpan = yield* Effect.currentSpan.pipe(Effect.orDie);
  return { operation, producerSpan } satisfies WorkItem;
});

export const create = (
  channel: GuildTextBasedChannel,
): Effect.Effect<Interface, never, Scope.Scope> =>
  Effect.gen(function* () {
    let latest: Snowflake | undefined;

    const record = (id: Snowflake) =>
      Effect.sync(() => {
        latest = id;
      });
    const posting = Posting.of({
      send: (options) => sendMessage(channel, options).pipe(Effect.tap(record)),
      sendChunked: (options) => sendChunkedMessage({ channel, ...options, onSent: record }),
      edit: (id, options) => editMessage(channel, id, options),
      isLatest: (id) => id === latest,
    });

    const worker = yield* createPriorityDrainableWorker((item: WorkItem) =>
      item.operation.pipe(
        Effect.provideService(Posting, posting),
        Effect.onError((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.logDebug("Discord output action interrupted", cause)
            : Effect.logError("Discord output action failed", cause),
        ),
        Effect.withSpan("OutputPump.process", {
          root: true,
          attributes: { channelId: channel.id },
          links: [{ span: item.producerSpan, attributes: { relationship: "enqueued-by" } }],
        }),
        Effect.ignoreCause(),
      ),
    );

    const enqueue = (unit: Effect.Effect<void, unknown, Posting>): Effect.Effect<void> =>
      createWorkItem(unit).pipe(
        Effect.flatMap(worker.enqueueHigh),
        Effect.withSpan("OutputPump.enqueue", { root: true }),
      );

    const executeOrdered: ExecuteOrdered = Effect.fn("OutputPump.executeOrdered")(function* <A, E>(
      operation: Effect.Effect<A, E, Posting>,
    ) {
      const result = yield* Deferred.make<A, E>();
      const canceled = yield* Deferred.make<void>();
      const queuedOperation = operation.pipe(
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(result, exit)),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(canceled)),
      );

      return yield* worker.enqueueLow(yield* createWorkItem(queuedOperation)).pipe(
        Effect.andThen(Deferred.await(result)),
        Effect.onInterrupt(() => Deferred.succeed(canceled, undefined)),
      );
    });

    yield* Effect.addFinalizer(() =>
      worker.drain.pipe(
        Effect.timeout("3 seconds"),
        Effect.ignore({
          log: "Warn",
          message: "Timed out waiting for Discord output queue to drain",
        }),
      ),
    );

    return { enqueue, executeOrdered };
  }).pipe(Effect.annotateLogs({ channelId: channel.id }));

export * as OutputPump from "./output-pump.ts";
