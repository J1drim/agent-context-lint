/** Version of the closed D13 Cursor surface-profile catalog. */
export const CURSOR_PROFILE_CONTRACT_VERSION = "0.1.0" as const;
export const CURSOR_PROFILE_ID = "cursor-agent" as const;
export const CURSOR_SPEC_SNAPSHOT_ID = "cursor/2026-08-01" as const;
export const CURSOR_GLOB_DIALECT_ID = "cursor-agent/mdc-globs/2026-08-01" as const;
export const CURSOR_SURFACE_IDS = ["cursor-agent/ide", "cursor-agent/cli"] as const;

export type CursorSurfaceId = (typeof CURSOR_SURFACE_IDS)[number];
export type CursorFormatId = "cursor-legacy-rules" | "cursor-mdc";
export type CursorFormatSupport = "supported" | "unknown";

export interface CursorFormatClaim {
  readonly evidenceRefs: readonly string[];
  readonly formatId: CursorFormatId;
  readonly support: CursorFormatSupport;
}

export interface CursorVersionBoundary {
  readonly change: string;
  readonly evidenceRefs: readonly string[];
  readonly minimumVersion: string;
  readonly surfaceId: CursorSurfaceId;
}

export interface CursorSurfaceProfileDescriptor {
  readonly clientVersion: string;
  readonly contractVersion: typeof CURSOR_PROFILE_CONTRACT_VERSION;
  readonly evidenceRefs: readonly string[];
  readonly externalContext: "out-of-repository";
  readonly formats: readonly CursorFormatClaim[];
  readonly globDialectId: typeof CURSOR_GLOB_DIALECT_ID;
  readonly profileId: typeof CURSOR_PROFILE_ID;
  readonly releaseClass: "ga-required";
  readonly repositoryRootModel: string;
  readonly retrievedAt: "2026-08-02";
  readonly specSnapshotId: typeof CURSOR_SPEC_SNAPSHOT_ID;
  readonly surfaceId: CursorSurfaceId;
  readonly versionBoundaries: readonly CursorVersionBoundary[];
  readonly versionStatus: "observed-metadata-only";
}

function claim(value: CursorFormatClaim): CursorFormatClaim {
  return Object.freeze({ ...value, evidenceRefs: Object.freeze([...value.evidenceRefs]) });
}

function boundary(value: CursorVersionBoundary): CursorVersionBoundary {
  return Object.freeze({ ...value, evidenceRefs: Object.freeze([...value.evidenceRefs]) });
}

function descriptor(
  value: Omit<
    CursorSurfaceProfileDescriptor,
    | "contractVersion"
    | "externalContext"
    | "globDialectId"
    | "profileId"
    | "releaseClass"
    | "retrievedAt"
    | "specSnapshotId"
    | "versionStatus"
  >,
): CursorSurfaceProfileDescriptor {
  return Object.freeze({
    ...value,
    contractVersion: CURSOR_PROFILE_CONTRACT_VERSION,
    evidenceRefs: Object.freeze([...value.evidenceRefs]),
    externalContext: "out-of-repository",
    formats: Object.freeze(value.formats.map(claim)),
    globDialectId: CURSOR_GLOB_DIALECT_ID,
    profileId: CURSOR_PROFILE_ID,
    releaseClass: "ga-required",
    retrievedAt: "2026-08-02",
    specSnapshotId: CURSOR_SPEC_SNAPSHOT_ID,
    versionBoundaries: Object.freeze(value.versionBoundaries.map(boundary)),
    versionStatus: "observed-metadata-only",
  });
}

const IDE_PROFILE = descriptor({
  clientVersion: "3.12.30",
  evidenceRefs: [
    "CURSOR-RULES",
    "CURSOR-CHANGE-045",
    "CURSOR-CHANGE-049",
    "LOCAL-CURSOR-2026-08-02",
  ],
  formats: [
    { evidenceRefs: ["CURSOR-SURFACE-04"], formatId: "cursor-mdc", support: "supported" },
    {
      evidenceRefs: ["CURSOR-SURFACE-01", "CURSOR-SURFACE-03"],
      formatId: "cursor-legacy-rules",
      support: "supported",
    },
  ],
  repositoryRootModel: "supplied IDE workspace roots with nested .cursor/rules scope roots",
  surfaceId: "cursor-agent/ide",
  versionBoundaries: [
    {
      change: "MDC project-rule release",
      evidenceRefs: ["CURSOR-CHANGE-045"],
      minimumVersion: "0.45.0",
      surfaceId: "cursor-agent/ide",
    },
    {
      change: "Auto attachment on Agent read/write events",
      evidenceRefs: ["CURSOR-CHANGE-049"],
      minimumVersion: "0.49.0",
      surfaceId: "cursor-agent/ide",
    },
  ],
});

const CLI_PROFILE = descriptor({
  clientVersion: "2026.05.24-dda726e",
  evidenceRefs: [
    "CURSOR-RULES",
    "CURSOR-CLI",
    "CURSOR-CLI-CHANGE-2026-01-08",
    "LOCAL-CURSOR-2026-08-02",
  ],
  formats: [
    { evidenceRefs: ["CURSOR-SURFACE-05"], formatId: "cursor-mdc", support: "supported" },
    {
      evidenceRefs: ["CURSOR-SURFACE-01", "CURSOR-SURFACE-05"],
      formatId: "cursor-legacy-rules",
      support: "unknown",
    },
  ],
  repositoryRootModel: "supplied CLI workspace root; subdirectory-launch root discovery unknown",
  surfaceId: "cursor-agent/cli",
  versionBoundaries: [
    {
      change: "agent entry point and rule-management command",
      evidenceRefs: ["CURSOR-CLI-CHANGE-2026-01-08"],
      minimumVersion: "2026-01-08",
      surfaceId: "cursor-agent/cli",
    },
  ],
});

export const CURSOR_SURFACE_PROFILES: readonly CursorSurfaceProfileDescriptor[] = Object.freeze([
  IDE_PROFILE,
  CLI_PROFILE,
]);

const PROFILE_BY_SURFACE: ReadonlyMap<string, CursorSurfaceProfileDescriptor> = new Map(
  CURSOR_SURFACE_PROFILES.map((profile) => [profile.surfaceId, profile]),
);

export function cursorSurfaceProfile(
  surfaceId: string,
): CursorSurfaceProfileDescriptor | undefined {
  return PROFILE_BY_SURFACE.get(surfaceId);
}
