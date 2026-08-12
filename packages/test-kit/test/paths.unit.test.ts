import { describe, expect, test } from "vitest";

import { createPathService } from "../src/paths.js";

describe("explicit-platform path service", () => {
  test.each([
    {
      flavor: "posix" as const,
      input: "/repo/packages/api/../web/AGENTS.md",
      normalized: "/repo/packages/web/AGENTS.md",
      separator: "/",
    },
    {
      flavor: "win32" as const,
      input: "C:\\repo\\packages\\api\\..\\web\\AGENTS.md",
      normalized: "C:\\repo\\packages\\web\\AGENTS.md",
      separator: "\\",
    },
    {
      flavor: "win32" as const,
      input: "\\\\server\\share\\repo\\..\\AGENTS.md",
      normalized: "\\\\server\\share\\AGENTS.md",
      separator: "\\",
    },
  ])("normalizes $flavor paths without consulting the host platform", (fixture) => {
    const paths = createPathService(fixture.flavor);

    expect(paths.normalize(fixture.input)).toBe(fixture.normalized);
    expect(paths.separator).toBe(fixture.separator);
    expect(paths.flavor).toBe(fixture.flavor);
    expect(paths.isAbsolute(fixture.input)).toBe(true);
  });

  test("resolves contained POSIX and Windows fixture paths", () => {
    const posix = createPathService("posix");
    const windows = createPathService("win32");

    expect(posix.resolveWithinRoot("/repo", "packages/core/index.ts")).toBe(
      "/repo/packages/core/index.ts",
    );
    expect(windows.resolveWithinRoot("C:\\repo", "packages\\core\\index.ts")).toBe(
      "C:\\repo\\packages\\core\\index.ts",
    );
    expect(windows.relative("C:\\repo", "C:\\repo\\src\\é.ts")).toBe("src\\é.ts");
    expect(posix.join("/repo", "src", "日本語.ts")).toBe("/repo/src/日本語.ts");
  });

  test("rejects absolute, escaping, cross-drive, and malformed fixture paths", () => {
    const posix = createPathService("posix");
    const windows = createPathService("win32");

    expect(() => posix.resolveWithinRoot("relative", "src/a.ts")).toThrow(/root must be absolute/);
    expect(() => posix.resolveWithinRoot("/repo", "/etc/passwd")).toThrow(/must be relative/);
    expect(() => posix.resolveWithinRoot("/repo", "../escape")).toThrow(/escapes its root/);
    expect(() => windows.resolveWithinRoot("C:\\repo", "D:\\escape")).toThrow(/must be relative/);
    expect(() => posix.normalize("bad\0path")).toThrow(/null byte/);
    expect(() => posix.isAbsolute("bad\0path")).toThrow(/null byte/);
  });
});
