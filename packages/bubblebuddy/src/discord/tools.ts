import { Effect } from "effect";

import { currentDateTimeTool } from "./tools/current-date-time.ts";
import { fetchMessageTool } from "./tools/fetch-message.ts";
import { ScheduleTools } from "./tools/schedules.ts";
import { listCustomEmojisTool } from "./tools/list-custom-emojis.ts";
import { listStickersTool } from "./tools/list-stickers.ts";
import { reactTool } from "./tools/react.ts";
import { replyTool } from "./tools/reply.ts";
import { saveAssetsTool } from "./tools/save-assets.ts";
import { saveMessageAssetsTool } from "./tools/save-message-assets.ts";
import { sendStickerTool } from "./tools/send-sticker.ts";
import { uploadFileTool } from "./tools/upload-file.ts";

export const makeDiscordTools = Effect.fn("makeDiscordTools")(function* (options: {
  readonly enableAgenticWorkspace: boolean;
}) {
  const coreTools = yield* Effect.all([
    currentDateTimeTool,
    listCustomEmojisTool,
    listStickersTool,
    sendStickerTool,
    reactTool,
    replyTool,
    fetchMessageTool,
    ScheduleTools.create,
    ScheduleTools.update,
    ScheduleTools.list,
    ScheduleTools.cancel,
  ]);

  const agenticWorkspaceTools = options.enableAgenticWorkspace
    ? yield* makeAgenticWorkspaceTools
    : [];

  return [...coreTools, ...agenticWorkspaceTools];
});

const makeAgenticWorkspaceTools = Effect.all([
  saveMessageAssetsTool,
  saveAssetsTool,
  uploadFileTool,
]);
