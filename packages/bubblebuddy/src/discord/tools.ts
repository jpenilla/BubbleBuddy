import { Effect } from "effect";

import { fetchMessageTool } from "./tools/fetch-message.ts";
import { listCustomEmojisTool } from "./tools/list-custom-emojis.ts";
import { listStickersTool } from "./tools/list-stickers.ts";
import { reactTool } from "./tools/react.ts";
import { saveAttachmentsTool } from "./tools/save-attachments.ts";
import { sendStickerTool } from "./tools/send-sticker.ts";
import { uploadFileTool } from "./tools/upload-file.ts";

export const discordCoreTools = Effect.fn("discordCoreTools")(function* () {
  return [
    yield* listCustomEmojisTool,
    yield* listStickersTool,
    yield* sendStickerTool,
    yield* reactTool,
    yield* fetchMessageTool,
  ];
});

export const discordWorkspaceTools = Effect.fn("discordWorkspaceTools")(function* () {
  return [yield* saveAttachmentsTool, yield* uploadFileTool];
});
