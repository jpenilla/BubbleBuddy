import { ScheduleToolOutput } from "./schedule-tool-output.ts";
import { ToolOutput } from "./tool-output.ts";

const hidden = ToolOutput.Policy.Hidden();
const grouped = ToolOutput.Policy.Grouped();
const schedule = ToolOutput.Policy.Standalone({ formatter: ScheduleToolOutput.formatter });

const policies: Readonly<Record<string, ToolOutput.Policy>> = {
  create_schedule: schedule,
  update_schedule: schedule,
  cancel_schedule: schedule,
  list_schedules: hidden,
  discord_list_custom_emojis: hidden,
  discord_list_stickers: hidden,
  discord_fetch_message: hidden,
  discord_react: hidden,
  discord_reply: hidden,
  discord_save_assets: hidden,
  discord_save_message_assets: hidden,
  discord_send_sticker: hidden,
  discord_upload_file: hidden,
};

export const forTool = (name: string): ToolOutput.Policy =>
  Object.hasOwn(policies, name) ? policies[name] : grouped;

export * as ToolOutputPolicies from "./tool-output-policies.ts";
