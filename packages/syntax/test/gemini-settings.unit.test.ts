import { describe, expect, it } from "vitest";

import {
  GEMINI_SETTINGS_DEFAULTS,
  GEMINI_SETTINGS_LIMITS,
  GeminiSettingsError,
  mergeGeminiSettingsLayers,
  parseGeminiSettings,
  type GeminiSettingsLayerInput,
  type GeminiSettingsParseResult,
  type ParseGeminiSettingsInput,
} from "../src/index.js";

const encoder = new TextEncoder();

function parse(text: string): GeminiSettingsParseResult {
  return parseGeminiSettings({
    bytes: encoder.encode(text),
    path: ".gemini/settings.json" as never,
  });
}

function layer(
  kind: GeminiSettingsLayerInput["kind"],
  value: unknown,
  trustState: GeminiSettingsLayerInput["trustState"] = "not-applicable",
): GeminiSettingsLayerInput {
  return {
    bytes: encoder.encode(JSON.stringify(value)),
    kind,
    path: `${kind}.json` as never,
    trustState,
  };
}

describe("Gemini settings reader", () => {
  it("returns no overrides for unrelated settings", () => {
    expect(parse('{"theme":"dark"}')).toMatchObject({ state: "complete", values: {} });
  });

  it("parses every D10 context setting and retains the default filename", () => {
    const result = parse(
      JSON.stringify({
        context: {
          discoveryMaxDirs: 7,
          fileFiltering: { respectGeminiIgnore: false, respectGitIgnore: false },
          fileName: ["TEAM.md", "TEAM.md"],
          importFormat: "flat",
          includeDirectories: ["vendor", "packages/docs"],
          loadMemoryFromIncludeDirectories: true,
          memoryBoundaryMarkers: [".git", ".workspace/root"],
        },
      }),
    );
    expect(result).toMatchObject({
      state: "complete",
      values: {
        discoveryMaxDirs: 7,
        fileNames: ["TEAM.md", "GEMINI.md"],
        importFormat: "flat",
        includeDirectories: ["vendor", "packages/docs"],
        loadMemoryFromIncludeDirectories: true,
        memoryBoundaryMarkers: [".git", ".workspace/root"],
        respectGeminiIgnore: false,
        respectGitIgnore: false,
      },
    });
  });

  it("rejects duplicate keys, malformed JSON, non-object roots, and malformed UTF-8", () => {
    expect(parse('{"context":{"fileName":"A"},"context":{}}').issues[0]?.code).toBe(
      "duplicate-key",
    );
    expect(parse("{oops").state).toBe("malformed");
    expect(parse("[]").state).toBe("malformed");
    expect(
      parseGeminiSettings({
        bytes: new Uint8Array([0xff]),
        path: ".gemini/settings.json" as never,
      }).issues[0]?.code,
    ).toBe("invalid-json");
  });

  it("keeps environment expressions inert and rejects unsafe repository paths", () => {
    const result = parse(
      JSON.stringify({
        context: {
          fileName: ["$SECRET.md", "../escape.md", "SAFE.md"],
          includeDirectories: ["${HOME}", ".", "../outside", "safe"],
          memoryBoundaryMarkers: ["/absolute", "../up", ".git"],
        },
      }),
    );
    expect(result.values.fileNames).toEqual(["SAFE.md", "GEMINI.md"]);
    expect(result.values.includeDirectories).toEqual(["safe"]);
    expect(result.values.memoryBoundaryMarkers).toEqual([".git"]);
    expect(result.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["environment-placeholder", "unsafe-path"]),
    );
  });

  it("reports unknown and malformed context fields without inventing values", () => {
    const result = parse(
      '{"context":{"unknown":1,"fileName":7,"includeDirectories":"x","memoryBoundaryMarkers":7,"loadMemoryFromIncludeDirectories":"yes","discoveryMaxDirs":-1,"importFormat":"other","fileFiltering":{"respectGitIgnore":"yes"}}}',
    );
    expect(result.state).toBe("partial");
    expect(result.values).toEqual({});
    expect(result.issues.map((entry) => entry.code)).toContain("unknown-context-setting");
  });

  it("merges scalar replacements and concatenated include directories in layer order", () => {
    const merged = mergeGeminiSettingsLayers([
      layer("system-defaults", { context: { fileName: "SYSTEM.md", includeDirectories: ["one"] } }),
      layer("user", { context: { fileName: "USER.md", includeDirectories: ["two"] } }),
      layer(
        "workspace",
        { context: { fileName: "PROJECT.md", includeDirectories: ["three"] } },
        "trusted",
      ),
      layer("system-override", { context: { importFormat: "flat", includeDirectories: ["four"] } }),
    ]);
    expect(merged.values.fileNames).toEqual(["PROJECT.md", "GEMINI.md"]);
    expect(merged.values.includeDirectories).toEqual(["one", "two", "three", "four"]);
    expect(merged.values.importFormat).toBe("flat");
    expect(merged.layersApplied).toEqual([
      "system-defaults",
      "user",
      "workspace",
      "system-override",
    ]);
  });

  it("omits untrusted workspace settings and malformed layers", () => {
    const malformed = { ...layer("user", {}), bytes: encoder.encode("{") };
    const merged = mergeGeminiSettingsLayers([
      malformed,
      layer("workspace", { context: { fileName: "UNTRUSTED.md" } }, "untrusted"),
    ]);
    expect(merged.values).toMatchObject(GEMINI_SETTINGS_DEFAULTS);
    expect(merged.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["invalid-json", "untrusted-workspace-layer"]),
    );
  });

  it("rejects hostile inputs, ordering errors, and resource excess", () => {
    expect(() =>
      parseGeminiSettings(new Proxy({ bytes: encoder.encode("{}"), path: "x" as never }, {})),
    ).toThrow(GeminiSettingsError);
    expect(() =>
      parseGeminiSettings({ bytes: encoder.encode("{}"), path: "." as never }),
    ).toThrow();
    expect(() =>
      mergeGeminiSettingsLayers([layer("workspace", {}, "trusted"), layer("user", {})]),
    ).toThrow(GeminiSettingsError);
    expect(() =>
      mergeGeminiSettingsLayers(
        Array.from({ length: GEMINI_SETTINGS_LIMITS.maximumLayers + 1 }, () => layer("user", {})),
      ),
    ).toThrow(GeminiSettingsError);
    expect(() =>
      parseGeminiSettings({
        bytes: new Uint8Array(GEMINI_SETTINGS_LIMITS.maximumBytes + 1),
        path: "settings.json" as never,
      }),
    ).toThrow(GeminiSettingsError);
  });

  it("does not invoke accessors in public inputs", () => {
    let invoked = false;
    const hostile = { bytes: encoder.encode("{}"), path: "settings.json" };
    Object.defineProperty(hostile, "bytes", {
      enumerable: true,
      get() {
        invoked = true;
        return encoder.encode("{}");
      },
    });
    expect(() => parseGeminiSettings(hostile as never)).toThrow(GeminiSettingsError);
    expect(invoked).toBe(false);
  });

  it("rejects non-records, non-byte views, extra fields, and non-enumerable fields", () => {
    const cases: unknown[] = [
      null,
      [],
      { bytes: "{}", path: "settings.json" },
      { bytes: encoder.encode("{}"), extra: true, path: "settings.json" },
    ];
    const hidden = { bytes: encoder.encode("{}"), path: "settings.json" };
    Object.defineProperty(hidden, "path", { enumerable: false, value: "settings.json" });
    cases.push(hidden);
    for (const candidate of cases)
      expect(() => parseGeminiSettings(candidate as never)).toThrow(GeminiSettingsError);
  });

  it("bounds scalar values and collection sizes", () => {
    const long = "x".repeat(GEMINI_SETTINGS_LIMITS.maximumStringBytes + 1);
    const result = parse(
      JSON.stringify({
        context: {
          fileName: ["", long],
          includeDirectories: Array.from(
            { length: GEMINI_SETTINGS_LIMITS.maximumIncludeDirectories + 1 },
            () => "x",
          ),
          memoryBoundaryMarkers: Array.from(
            { length: GEMINI_SETTINGS_LIMITS.maximumMarkerCount + 1 },
            () => ".git",
          ),
        },
      }),
    );
    expect(result.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["invalid-setting", "resource-limit"]),
    );
  });

  it("caps issue accumulation while scanning hostile unknown fields", () => {
    const context = Object.fromEntries(
      Array.from({ length: GEMINI_SETTINGS_LIMITS.maximumIssues + 32 }, (_, index) => [
        `unknown${String(index)}`,
        true,
      ]),
    );
    const result = parse(JSON.stringify({ context }));
    expect(result.state).toBe("partial");
    expect(result.issues).toHaveLength(GEMINI_SETTINGS_LIMITS.maximumIssues);
  });

  it("rejects invalid layer kind, trust state, shapes, and byte snapshots", () => {
    const valid = layer("user", {});
    const cases: unknown[] = [
      [{ ...valid, kind: "invalid" }],
      [{ ...valid, trustState: "invalid" }],
      [{ ...valid, bytes: "{}" }],
      [new Proxy(valid, {})],
    ];
    for (const candidate of cases)
      expect(() => mergeGeminiSettingsLayers(candidate as never)).toThrow(GeminiSettingsError);
  });

  it("accepts null-prototype records but still closes their field set", () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, {
      bytes: encoder.encode("{}"),
      path: "settings.json",
    });
    expect(parseGeminiSettings(input as unknown as ParseGeminiSettingsInput).state).toBe(
      "complete",
    );
  });
});
