import { describe, expect, it } from "vitest";
import { sanitizeAttachmentFilename } from "../src/shared/workspace.ts";

describe("attachment filenames", () => {
  it.each([
    ["report.pdf", "report.pdf"],
    ["../../report.pdf", "report.pdf"],
    ["..\\folder\\report.pdf", "report.pdf"],
    [" \0re\nport\t.pdf ", "report.pdf"],
    ["", "file"],
    [" . ", "file"],
    ["..", "file"],
    ["\0\n\t", "file"],
  ])("sanitizes %j to %j", (input, expected) => {
    expect(sanitizeAttachmentFilename(input)).toBe(expected);
  });

  it("bounds long names while preserving a usable extension", () => {
    const stem = "a".repeat(150);
    const withExtension = sanitizeAttachmentFilename(`${stem}.pdf`);
    expect(withExtension).toHaveLength(120);
    expect(withExtension.endsWith(".pdf")).toBe(true);
    expect(sanitizeAttachmentFilename(stem)).toHaveLength(120);
  });
});
