import { describe, expect, test } from "vitest";

import { sanitizeAttachmentFilename } from "../src/shared/workspace.ts";

describe("sanitizeAttachmentFilename", () => {
  test("strips directory components and control characters", () => {
    expect(sanitizeAttachmentFilename("/etc/../secret/report.pdf")).toBe("report.pdf");
    expect(sanitizeAttachmentFilename("dir\\evil\\file.txt")).toBe("file.txt");
    expect(sanitizeAttachmentFilename("na\x00me\x1f.txt")).toBe("name.txt");
  });

  test("falls back to a placeholder for unusable names", () => {
    expect(sanitizeAttachmentFilename("")).toBe("file");
    expect(sanitizeAttachmentFilename("   ")).toBe("file");
    expect(sanitizeAttachmentFilename("..")).toBe("file");
  });

  test("preserves the extension when truncating long names", () => {
    const result = sanitizeAttachmentFilename(`${"a".repeat(200)}.tar.gz`);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith(".gz")).toBe(true);
  });

  test("truncates extensionless long names to the limit", () => {
    const result = sanitizeAttachmentFilename("b".repeat(200));
    expect(result).toBe("b".repeat(120));
  });

  test("drops absurdly long extensions when truncating", () => {
    const result = sanitizeAttachmentFilename(`stem.${"x".repeat(200)}`);
    expect(result).toBe(`stem.${"x".repeat(115)}`);
    expect(result.length).toBe(120);
  });
});
