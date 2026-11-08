import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
  type Conversation,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "@effect/vitest";
import {
  type APIEmbed,
  type APIMessageTopLevelComponent,
  type GuildTextBasedChannel,
  Routes,
} from "discord.js";
import { Effect, FiberSet } from "effect";

import { ChannelFeed } from "../src/discord/feed/channel-feed.ts";
import { FeedDoc } from "../src/discord/feed/state.ts";
import { Posting } from "../src/discord/posting.ts";
import { EMBED_COLOR } from "../src/discord/utils.ts";
import { tryDurablePromise } from "../src/pi/durable.ts";

interface MessageBody {
  readonly nonce?: string;
  readonly enforce_nonce?: boolean;
  readonly content?: string;
  readonly embeds?: APIEmbed[];
  readonly components?: APIMessageTopLevelComponent[];
}

/** A message the channel shows: its ID, and its content after every edit, oldest first. */
interface Shown {
  readonly id: string;
  readonly revisions: MessageBody[];
}

/** A channel that records what is posted to it and how each message is edited, enforcing nonces as Discord does. */
const recordingChannel = (
  options: {
    /** Fails the first post this matches after recording it, as when Discord's response is lost. */
    readonly losesResponse?: (body: MessageBody) => boolean;
  } = {},
) => {
  let lostResponse = false;
  const shown: Shown[] = [];
  const nonces = new Map<string, Shown>();
  const posted = new Set<() => void>();
  const channel = {
    id: "channel",
    client: {
      options: {},
      rest: {
        post: async (route: string, request: { body: MessageBody }) => {
          if (route !== Routes.channelMessages("channel")) return undefined;
          const { nonce, enforce_nonce } = request.body;
          const repeated =
            enforce_nonce === true && nonce !== undefined ? nonces.get(nonce) : undefined;
          if (repeated !== undefined) return { id: repeated.id };
          const message = { id: String(shown.length + 1), revisions: [request.body] };
          shown.push(message);
          if (nonce !== undefined) nonces.set(nonce, message);
          for (const notify of posted) notify();
          if (!lostResponse && options.losesResponse?.(request.body) === true) {
            lostResponse = true;
            throw new Error("Connection reset");
          }
          return { id: message.id };
        },
        patch: async (route: string, request: { body: MessageBody }) => {
          const message = shown.find(({ id }) => route === Routes.channelMessage("channel", id));
          if (message === undefined) throw new Error(`Edit of an unknown message: ${route}`);
          message.revisions.push(request.body);
        },
      },
    },
  } as unknown as GuildTextBasedChannel;
  /** Waits until the channel shows a message that `predicate` matches. */
  const awaitShown = (predicate: (message: Shown) => boolean) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (!shown.some(predicate)) return;
        posted.delete(check);
        resolve();
      };
      posted.add(check);
      check();
    });
  return { channel, shown, awaitShown };
};

type Recording = ReturnType<typeof recordingChannel>;

const latest = (message: Shown) => message.revisions.at(-1)!;
const embedOf = (message: Shown) => latest(message).embeds?.[0];

/** A card's text displays, heading first. */
const cardTexts = (body: MessageBody): string[] => {
  const [container] = body.components ?? [];
  if (container === undefined || !("components" in container)) return [];
  return container.components.flatMap((component) =>
    "content" in component ? [component.content] : [],
  );
};

/** A tools card's rows: the text displays after its heading. */
const toolRows = (message: Shown): string[] => cardTexts(latest(message)).slice(1);
/** A card built from components: a tools card, or a tool's own card. */
const isComponentCard = (message: Shown) => latest(message).components !== undefined;

const SERVICE_UNAVAILABLE = fauxAssistantMessage([], {
  stopReason: "error",
  errorMessage: "503 Service Unavailable",
});
const OVERLOADED = fauxAssistantMessage([], {
  stopReason: "error",
  errorMessage: "529 Overloaded",
});

const toolRound = (...names: string[]) =>
  fauxAssistantMessage(
    names.map((name) => fauxToolCall(name, {})),
    { stopReason: "toolUse" },
  );

/** A tool that does nothing beyond `execute`. */
const testTool = (name: string, execute: () => Promise<void> = async () => {}) =>
  defineTool({
    name,
    description: name,
    parameters: obj({}),
    execute: async () => {
      await execute();
      return { output: [] };
    },
  });

const SCHEDULE = "Water the plants";

/** `create_schedule` with the real tool's result details: a schedule created to run once. */
const createScheduleTool = defineTool({
  name: "create_schedule",
  description: "create_schedule",
  parameters: obj({ description: str() }),
  execute: async ({ description }) => {
    const schedule = {
      id: "schedule-1",
      channelId: "channel",
      description,
      note: "",
      nextRunAt: 0,
      recurrence: { kind: "once" },
    };
    return { output: [], details: { _tag: "Created", schedule } };
  },
});

const TOOL_POST = "Posted by the tool";

/** The shown channel's feed, which the test `discord_send` posts through, as the real one does. */
interface ToolPosting {
  executeOrdered?: Posting.ExecuteOrdered;
}

/**
 * A conversation on the faux model, with a grouped tool (`bash`), one that posts itself (`discord_send`), and one with
 * its own card (`create_schedule`).
 */
const openConversation = Effect.fnUntraced(function* (options: {
  readonly maxRetries: number;
  /** Tokens a compaction keeps unsummarized; compactions only run when asked. */
  readonly keepRecentTokens?: number;
  /** What a `bash` call waits for before it finishes. */
  readonly bash?: () => Promise<void>;
}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const posting: ToolPosting = {};
  const runTool = yield* FiberSet.makeRuntimePromise();
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "test-tools",
      tools: [
        testTool("bash", options.bash),
        testTool("discord_send", () =>
          runTool(posting.executeOrdered?.(Posting.send({ content: TOOL_POST })) ?? Effect.void),
        ),
        createScheduleTool,
      ],
    }),
  );
  const harness = yield* Effect.acquireRelease(
    tryDurablePromise((context) =>
      Harness.open(
        new MemoryStorage(),
        {
          models,
          registry,
          settings: {
            retry: { enabled: true, maxRetries: options.maxRetries, baseDelayMs: 1 },
            compaction: {
              enabled: false,
              reserveTokens: 1000,
              keepRecentTokens: options.keepRecentTokens ?? 20_000,
              backgroundTokens: 0,
            },
          },
        },
        context,
      ),
    ),
    (harness) => tryDurablePromise((context) => harness.close(context)).pipe(Effect.orDie),
  );
  const root = yield* tryDurablePromise((context) =>
    harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } }),
  );

  /** Sends a message the model answers with `responses` in turn, and waits for the conversation to settle. */
  const converse = (responses: FauxResponseStep[]) =>
    tryDurablePromise(async (context) => {
      faux.setResponses(responses);
      const submission = await root.submit({ type: "input", content: "hi" }, context);
      await submission.wait(context);
      await root.waitForIdle(context);
    });

  return { harness, root, faux, posting, converse };
});

/** Shows `conversation` in a recording channel while `during` runs, as a channel session does. */
const showChannel = <A, E, R>(
  conversation: {
    readonly harness: Harness;
    readonly root: Conversation;
    readonly posting: ToolPosting;
  },
  during: Effect.Effect<A, E, R>,
  {
    recording: { channel, shown } = recordingChannel(),
    showThinking = Effect.succeed(false),
  }: {
    readonly recording?: Recording;
    /** Read on every projection of the conversation. */
    readonly showThinking?: Effect.Effect<boolean>;
  } = {},
) =>
  Effect.gen(function* () {
    const feed = yield* ChannelFeed.make({
      channel,
      showThinking,
      sessionName: "session",
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            conversation.posting.executeOrdered = feed.executeOrdered;
          }),
          () =>
            Effect.sync(() => {
              delete conversation.posting.executeOrdered;
            }),
        );
        yield* feed.show({ harness: conversation.harness, conversation: conversation.root });
        yield* during;
      }),
    );
    return shown;
  });

describe("channel feed", () => {
  it.effect("edits one retry card through the attempts, then posts the answer", () =>
    Effect.gen(function* () {
      const conversation = yield* openConversation({ maxRetries: 3 });
      const shown = yield* showChannel(
        conversation,
        conversation.converse([SERVICE_UNAVAILABLE, OVERLOADED, fauxAssistantMessage("All good")]),
      );

      expect(shown).toHaveLength(2);
      const [card, answer] = shown;
      const colors = card.revisions.map((revision) => revision.embeds?.[0]?.color);
      expect(colors.slice(0, -1).every((color) => color === EMBED_COLOR.pending)).toBe(true);
      expect(colors.at(-1)).toBe(EMBED_COLOR.success);
      expect(colors.length).toBeGreaterThan(1);
      const description = embedOf(card)?.description ?? "";
      expect(description.match(/503 Service Unavailable/g)).toHaveLength(1);
      expect(description.match(/529 Overloaded/g)).toHaveLength(1);
      expect(latest(answer).content).toBe("All good");
    }).pipe(Effect.scoped),
  );

  it.effect("gives each tool round's retries their own card", () =>
    Effect.gen(function* () {
      const conversation = yield* openConversation({ maxRetries: 3 });
      const shown = yield* showChannel(
        conversation,
        conversation.converse([
          SERVICE_UNAVAILABLE,
          toolRound("bash"),
          OVERLOADED,
          fauxAssistantMessage("Done"),
        ]),
      );

      const retryCards = shown.filter((message) => embedOf(message) !== undefined);
      expect(retryCards.map((card) => embedOf(card)?.color)).toEqual([
        EMBED_COLOR.success,
        EMBED_COLOR.success,
      ]);
      const [first, second] = retryCards.map((card) => embedOf(card)?.description ?? "");
      expect(first).toContain("503 Service Unavailable");
      expect(first).not.toContain("529 Overloaded");
      expect(second).toContain("529 Overloaded");
      expect(second).not.toContain("503 Service Unavailable");
    }).pipe(Effect.scoped),
  );

  it.effect("reports a run that runs out of retries once, on its retry card", () =>
    Effect.gen(function* () {
      const conversation = yield* openConversation({ maxRetries: 1 });
      const shown = yield* showChannel(
        conversation,
        conversation.converse([SERVICE_UNAVAILABLE, SERVICE_UNAVAILABLE]),
      );

      expect(shown).toHaveLength(1);
      expect(embedOf(shown[0])?.color).toBe(EMBED_COLOR.danger);
      expect(embedOf(shown[0])?.description).toContain("Retry failed");
      expect(embedOf(shown[0])?.description).toContain("503 Service Unavailable");
    }).pipe(Effect.scoped),
  );

  it.effect("reports a failed run without retries as a notice with its error", () =>
    Effect.gen(function* () {
      const conversation = yield* openConversation({ maxRetries: 0 });
      const shown = yield* showChannel(conversation, conversation.converse([SERVICE_UNAVAILABLE]));

      expect(shown).toHaveLength(1);
      expect(embedOf(shown[0])?.color).toBe(EMBED_COLOR.danger);
      expect(embedOf(shown[0])?.description).toContain("503 Service Unavailable");
    }).pipe(Effect.scoped),
  );

  it.effect("reports an aborted run once", () =>
    Effect.gen(function* () {
      const conversation = yield* openConversation({ maxRetries: 3 });
      const shown = yield* showChannel(
        conversation,
        tryDurablePromise(async (context) => {
          const requested = Promise.withResolvers<void>();
          conversation.faux.setResponses([
            (_context, options) =>
              new Promise((resolve) => {
                requested.resolve();
                options?.signal?.addEventListener("abort", () =>
                  resolve(fauxAssistantMessage([], { stopReason: "aborted" })),
                );
              }),
          ]);
          const submission = await conversation.root.submit(
            { type: "input", content: "hi" },
            context,
          );
          await requested.promise;
          await conversation.root.abort(context);
          await submission.wait(context);
          await conversation.root.waitForIdle(context);
        }),
      );

      expect(shown).toHaveLength(1);
      expect(embedOf(shown[0])?.color).toBe(EMBED_COLOR.danger);
      expect(embedOf(shown[0])?.description).toContain("aborted");
    }).pipe(Effect.scoped),
  );

  it.effect("does not show the tool calls of an attempt that failed", () =>
    Effect.gen(function* () {
      const conversation = yield* openConversation({ maxRetries: 3 });
      const shown = yield* showChannel(
        conversation,
        conversation.converse([
          fauxAssistantMessage([fauxToolCall("bash", {})], {
            stopReason: "error",
            errorMessage: "503 Service Unavailable",
          }),
          toolRound("bash"),
          fauxAssistantMessage("Done"),
        ]),
      );

      const toolCards = shown.filter(isComponentCard);
      expect(toolCards).toHaveLength(1);
      expect(toolRows(toolCards[0])).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("starts a new tools card below a tool's own post", () =>
    Effect.gen(function* () {
      const conversation = yield* openConversation({ maxRetries: 3 });
      const shown = yield* showChannel(
        conversation,
        conversation.converse([
          toolRound("discord_send", "bash"),
          toolRound("bash"),
          fauxAssistantMessage("Done"),
        ]),
      );

      expect(
        shown.map((message) => (isComponentCard(message) ? "tools" : latest(message).content)),
      ).toEqual(["tools", TOOL_POST, "tools", "Done"]);
    }).pipe(Effect.scoped),
  );

  it.live("shows an answer's text before its tool's own post, however late the feed is", () =>
    Effect.gen(function* () {
      const conversation = yield* openConversation({ maxRetries: 0 });
      const shown = yield* showChannel(
        conversation,
        conversation.converse([
          fauxAssistantMessage([fauxText("Here it is"), fauxToolCall("discord_send", {})], {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("Done"),
        ]),
        // Each projection lags behind the conversation, so the tool posts before the feed sees its answer.
        { showThinking: Effect.as(Effect.sleep("20 millis"), false) },
      );

      expect(shown.map((message) => latest(message).content)).toEqual([
        "Here it is",
        TOOL_POST,
        "Done",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("shows a schedule's card, then what it scheduled", () =>
    Effect.gen(function* () {
      const conversation = yield* openConversation({ maxRetries: 0 });
      const shown = yield* showChannel(
        conversation,
        conversation.converse([
          fauxAssistantMessage([fauxToolCall("create_schedule", { description: SCHEDULE })], {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("Done"),
        ]),
      );

      const [card] = shown.filter(isComponentCard);
      const titles = card.revisions.map((revision) => cardTexts(revision)[0]);
      expect(titles[0]).toContain("Creating schedule");
      expect(titles.at(-1)).toContain("Schedule created");
      const details = cardTexts(latest(card)).join("\n");
      expect(details).toContain(SCHEDULE);
      // Only the result's details carry the timing.
      expect(details).toContain("Once at");
    }).pipe(Effect.scoped),
  );

  it.effect("edits a card whose failed post reached the channel anyway", () =>
    Effect.gen(function* () {
      const recording = recordingChannel({
        losesResponse: (body) => body.components !== undefined,
      });
      const conversation = yield* openConversation({
        maxRetries: 0,
        // Settles once its running card is posted.
        bash: () => recording.awaitShown(isComponentCard),
      });
      const shown = yield* showChannel(
        conversation,
        conversation.converse([toolRound("bash"), fauxAssistantMessage("Done")]),
        { recording },
      );

      const toolCards = shown.filter(isComponentCard);
      expect(toolCards).toHaveLength(1);
      expect(toolRows(toolCards[0])).toEqual([expect.stringContaining("✅")]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps tool rounds in one tools card when their thinking is hidden", () =>
    Effect.gen(function* () {
      const conversation = yield* openConversation({ maxRetries: 0 });
      const thinkingRound = () =>
        fauxAssistantMessage([fauxThinking("Planning"), fauxToolCall("bash", {})], {
          stopReason: "toolUse",
        });
      const shown = yield* showChannel(
        conversation,
        conversation.converse([thinkingRound(), thinkingRound(), fauxAssistantMessage("Done")]),
      );

      const toolCards = shown.filter(isComponentCard);
      expect(toolCards).toHaveLength(1);
      expect(toolRows(toolCards[0])).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("shows a compaction's card, then settles it with its outcome", () =>
    Effect.gen(function* () {
      const conversation = yield* openConversation({ maxRetries: 0, keepRecentTokens: 1 });
      yield* conversation.converse([fauxAssistantMessage("First")]);
      const recording = recordingChannel();
      // The summary waits until the channel shows the running compaction's card.
      conversation.faux.setResponses([
        () =>
          recording
            .awaitShown((message) => embedOf(message) !== undefined)
            .then(() => fauxAssistantMessage("Summary")),
      ]);
      const shown = yield* showChannel(
        conversation,
        tryDurablePromise(async (context) => {
          const compaction = await conversation.root.compact(undefined, context);
          await conversation.harness.waitForTask(compaction, context);
        }),
        { recording },
      );

      expect(shown).toHaveLength(1);
      expect(shown[0].revisions.map((revision) => revision.embeds?.[0]?.color)).toEqual([
        EMBED_COLOR.pending,
        EMBED_COLOR.success,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("resumes after what it showed when the channel reattaches", () =>
    Effect.gen(function* () {
      const conversation = yield* openConversation({ maxRetries: 0 });
      yield* showChannel(
        conversation,
        conversation.converse([toolRound("bash"), fauxAssistantMessage("First")]),
      );
      yield* conversation.converse([fauxAssistantMessage("Second")]);
      const shown = yield* showChannel(conversation, Effect.void);

      expect(shown.map((message) => latest(message).content)).toEqual(["Second"]);
    }).pipe(Effect.scoped),
  );

  it.live("shows what it stored without showing as soon as it reattaches", () =>
    Effect.gen(function* () {
      const conversation = yield* openConversation({ maxRetries: 0 });
      // As left by a final pass that timed out.
      yield* tryDurablePromise((context) =>
        conversation.root.commit(async (tx) => {
          const doc = await tx.doc(FeedDoc, conversation.root.id);
          doc.items = [
            {
              key: "answer:stored",
              revision: 1,
              shown: 0,
              view: { type: "answer", blocks: [{ type: "text", text: "Stored" }] },
            },
          ];
        }, context),
      );
      const recording = recordingChannel();
      yield* showChannel(
        conversation,
        Effect.promise(() =>
          recording.awaitShown((message) => latest(message).content === "Stored"),
        ).pipe(Effect.timeout("2 seconds")),
        { recording },
      );
    }).pipe(Effect.scoped),
  );

  it.live("shows output while the conversation is shown", () =>
    Effect.gen(function* () {
      const conversation = yield* openConversation({ maxRetries: 0 });
      const recording = recordingChannel();
      yield* showChannel(
        conversation,
        conversation
          .converse([fauxAssistantMessage("Hello")])
          .pipe(
            Effect.andThen(
              Effect.promise(() =>
                recording.awaitShown((message) => latest(message).content === "Hello"),
              ),
            ),
            Effect.timeout("2 seconds"),
          ),
        { recording },
      );
    }).pipe(Effect.scoped),
  );

  it.effect("does not report a failure from before the channel first attached", () =>
    Effect.gen(function* () {
      const conversation = yield* openConversation({ maxRetries: 0 });
      yield* conversation.converse([SERVICE_UNAVAILABLE]);
      const shown = yield* showChannel(conversation, Effect.void);

      expect(shown).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
