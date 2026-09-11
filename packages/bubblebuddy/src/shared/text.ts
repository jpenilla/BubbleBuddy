export const normalizeLineEndings = (value: string): string => value.replaceAll("\r\n", "\n");

export const collapseWhitespace = (value: string): string => value.replaceAll(/\s+/g, " ").trim();

export const truncate = (value: string, limit: number, suffix = "…"): string =>
  value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
