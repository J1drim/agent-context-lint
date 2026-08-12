import { describe, expect, test } from "vitest";

import {
  CURSOR_GLOB_DIALECT_ID,
  CURSOR_PROFILE_ID,
  CURSOR_SPEC_SNAPSHOT_ID,
  CURSOR_SURFACE_PROFILES,
  cursorSurfaceProfile,
} from "../src/index.js";

describe("D13 Cursor surface profile catalog", () => {
  test("publishes separate immutable IDE and CLI surface claims", () => {
    expect(CURSOR_SURFACE_PROFILES.map((profile) => profile.surfaceId)).toEqual([
      "cursor-agent/ide",
      "cursor-agent/cli",
    ]);
    for (const profile of CURSOR_SURFACE_PROFILES) {
      expect(profile).toMatchObject({
        contractVersion: "0.1.0",
        externalContext: "out-of-repository",
        globDialectId: CURSOR_GLOB_DIALECT_ID,
        profileId: CURSOR_PROFILE_ID,
        releaseClass: "ga-required",
        specSnapshotId: CURSOR_SPEC_SNAPSHOT_ID,
        versionStatus: "observed-metadata-only",
      });
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.formats)).toBe(true);
      expect(Object.isFrozen(profile.versionBoundaries)).toBe(true);
    }
    expect(cursorSurfaceProfile("cursor-agent/ide")?.clientVersion).toBe("3.12.30");
    expect(
      cursorSurfaceProfile("cursor-agent/cli")?.formats.find(
        (format) => format.formatId === "cursor-legacy-rules",
      )?.support,
    ).toBe("unknown");
    expect(cursorSurfaceProfile("cursor-agent/unknown")).toBeUndefined();
  });
});
