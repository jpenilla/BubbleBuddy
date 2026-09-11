const longestBacktickRun = (value: string): number =>
  Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));

export const inlineCode = (value: string): string => {
  const delimiter = "`".repeat(longestBacktickRun(value) + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${delimiter}${pad}${value}${pad}${delimiter}`;
};
