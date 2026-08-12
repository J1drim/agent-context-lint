import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  CLAUDE_CODE_PROFILE,
  CODEX_CLI_PROFILE,
  COPILOT_PROFILES,
  CURSOR_SURFACE_PROFILES,
  GEMINI_CLI_PROFILE,
} from "../packages/profiles/dist/index.js";

interface Capability {
  readonly formatId: string;
  readonly id: string;
  readonly positive: { readonly expectedState: string };
  readonly supportStatus: string;
  readonly surfaceId: string;
}

interface Corpus {
  readonly capabilities: readonly Capability[];
  readonly fixtures: readonly {
    readonly path: string;
    readonly profileId: string;
    readonly surfaceId: string;
  }[];
}

interface Fixture {
  readonly profile: {
    readonly clientVersion: string | null;
    readonly profileId: string;
    readonly specSnapshotId: string;
    readonly surfaceId: string;
  };
}

interface SummaryGolden {
  readonly capabilityCount: number;
  readonly capabilityIds: readonly string[];
  readonly contractVersion: string;
  readonly fixtureCount: number;
  readonly positiveStateCounts: Readonly<Record<string, number>>;
  readonly recordKind: string;
  readonly supportStatusCounts: Readonly<Record<string, number>>;
  readonly surfaceCapabilityCounts: Readonly<Record<string, number>>;
}

interface SharedProfileDescriptor {
  readonly clientVersion?: string | null;
  readonly profileId: string;
  readonly specSnapshotId: string;
  readonly surfaceId: string;
}

function load(relativePath: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"),
  ) as unknown;
}

function counts(values: readonly string[]): Readonly<Record<string, number>> {
  return Object.fromEntries(
    [...new Set(values)]
      .sort()
      .map((value) => [value, values.filter((candidate) => candidate === value).length]),
  );
}

describe("K01 official-example conformance corpus", () => {
  test("binds every generated fixture to the public GA profile identity", () => {
    const corpus = load("conformance/official-examples/v0/corpus.json") as Corpus;
    const descriptors: readonly SharedProfileDescriptor[] = [
      CODEX_CLI_PROFILE,
      CLAUDE_CODE_PROFILE,
      ...COPILOT_PROFILES.filter((profile) => profile.releaseClass === "ga-required"),
      GEMINI_CLI_PROFILE,
      ...CURSOR_SURFACE_PROFILES,
    ];
    const bySurface = new Map(descriptors.map((descriptor) => [descriptor.surfaceId, descriptor]));

    expect([...bySurface.keys()].sort()).toEqual(
      [...new Set(corpus.fixtures.map((fixture) => fixture.surfaceId))].sort(),
    );
    for (const reference of corpus.fixtures) {
      const fixture = load(reference.path) as Fixture;
      const descriptor = bySurface.get(reference.surfaceId);
      expect(descriptor, reference.surfaceId).toBeDefined();
      expect(fixture.profile).toMatchObject({
        clientVersion: descriptor?.clientVersion ?? null,
        profileId: descriptor?.profileId,
        specSnapshotId: descriptor?.specSnapshotId,
        surfaceId: descriptor?.surfaceId,
      });
    }
  });

  test("keeps Copilot and Cursor public format claims aligned with canonical capabilities", () => {
    const corpus = load("conformance/official-examples/v0/corpus.json") as Corpus;
    for (const profile of COPILOT_PROFILES.filter(
      (candidate) => candidate.releaseClass === "ga-required",
    )) {
      expect(
        corpus.capabilities
          .filter((capability) => capability.surfaceId === profile.surfaceId)
          .map((capability) => [capability.formatId, capability.supportStatus])
          .sort(),
      ).toEqual(profile.formats.map((claim) => [claim.formatId, claim.support]).sort());
    }
    for (const profile of CURSOR_SURFACE_PROFILES) {
      const publicFormats = new Set<string>(profile.formats.map((claim) => claim.formatId));
      expect(
        corpus.capabilities
          .filter(
            (capability) =>
              capability.surfaceId === profile.surfaceId && publicFormats.has(capability.formatId),
          )
          .map((capability) => [capability.formatId, capability.supportStatus])
          .sort(),
      ).toEqual(profile.formats.map((claim) => [claim.formatId, claim.support]).sort());
    }
  });

  test("matches the checked golden coverage projection", () => {
    const corpus = load("conformance/official-examples/v0/corpus.json") as Corpus;
    const golden = load("conformance/official-examples/v0/summary.golden.json") as SummaryGolden;
    expect({
      capabilityCount: corpus.capabilities.length,
      capabilityIds: corpus.capabilities.map((capability) => capability.id),
      contractVersion: "0.1.0",
      fixtureCount: corpus.fixtures.length,
      positiveStateCounts: counts(
        corpus.capabilities.map((capability) => capability.positive.expectedState),
      ),
      recordKind: "official-example-conformance-summary-golden",
      supportStatusCounts: counts(
        corpus.capabilities.map((capability) => capability.supportStatus),
      ),
      surfaceCapabilityCounts: counts(
        corpus.capabilities.map((capability) => capability.surfaceId),
      ),
    }).toEqual(golden);
  });
});
