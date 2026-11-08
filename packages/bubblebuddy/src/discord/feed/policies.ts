/**
 * How a tool call shows in the channel:
 * - `card`: its own card, named after the tool;
 * - `hidden`: not shown;
 * - `posts`: not shown, but posts to the channel itself: once it has, later calls start a new tools card below its post;
 * - `grouped`: a row in the run's tools card.
 */
export type Policy = "card" | "hidden" | "posts" | "grouped";

/** Tools that do not show as a grouped row. */
const policies = {
  create_schedule: "card",
  update_schedule: "card",
  cancel_schedule: "card",
  list_schedules: "hidden",
  discord_list_custom_emojis: "hidden",
  discord_list_stickers: "hidden",
  discord_fetch_message: "hidden",
  discord_react: "hidden",
  discord_send: "posts",
  stay_silent: "hidden",
  discord_save_assets: "hidden",
  discord_save_message_assets: "hidden",
} as const satisfies Record<string, Policy>;

type Policies = typeof policies;

export type StandaloneCard = {
  [Name in keyof Policies]: Policies[Name] extends "card" ? Name : never;
}[keyof Policies];

const byName: Readonly<Record<string, Policy>> = policies;

export const forTool = (name: string): Policy =>
  Object.hasOwn(byName, name) ? byName[name] : "grouped";

export const isStandaloneCard = (name: string): name is StandaloneCard => forTool(name) === "card";

export * as ToolPolicy from "./policies.ts";
