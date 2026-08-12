import { describe, expect, test } from "vitest";

import {
  COPILOT_PROFILE_CONTRACT_VERSION,
  COPILOT_PROFILE_FORMAT_IDS,
  COPILOT_PROFILE_IDS,
  COPILOT_PROFILES,
  COPILOT_SURFACE_IDS,
  copilotProfile,
  type CopilotFormatProfileClaim,
  type CopilotProfileDescriptor,
} from "../src/index.js";

describe("D08 Copilot surface profile catalog", () => {
  test("keeps four surfaces separate, closed, immutable, and evidence-bound", () => {
    expect(COPILOT_PROFILES.map((profile) => profile.profileId)).toEqual(COPILOT_PROFILE_IDS);
    expect(COPILOT_PROFILES.map((profile) => profile.surfaceId)).toEqual(COPILOT_SURFACE_IDS);
    expect(new Set(COPILOT_PROFILE_IDS).size).toBe(COPILOT_PROFILE_IDS.length);
    expect(new Set(COPILOT_SURFACE_IDS).size).toBe(COPILOT_SURFACE_IDS.length);
    expect(Object.isFrozen(COPILOT_PROFILES)).toBe(true);

    for (const profile of COPILOT_PROFILES) {
      expect(profile.contractVersion).toBe(COPILOT_PROFILE_CONTRACT_VERSION);
      expect(profile.surfaceId.startsWith(`${profile.profileId}/`)).toBe(true);
      expect(profile.specSnapshotId).toBe("copilot-surfaces/2026-08-01.0");
      expect(profile.clientVersion).toBeNull();
      expect(profile.evidenceRefs.length).toBeGreaterThan(0);
      expect(profile.formats.map((claim) => claim.formatId)).toEqual(COPILOT_PROFILE_FORMAT_IDS);
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.evidenceRefs)).toBe(true);
      expect(Object.isFrozen(profile.formats)).toBe(true);
      expect(copilotProfile(profile.profileId)).toBe(profile);
      for (const claim of profile.formats) {
        expect(Object.isFrozen(claim)).toBe(true);
        expect(Object.isFrozen(claim.evidenceRefs)).toBe(true);
        expect(claim.evidenceRefs.length).toBeGreaterThan(0);
      }
    }
  });

  test("marks only local profiles GA-required and hosted surfaces evidence-only", () => {
    expect(copilotProfile("copilot-cli")?.releaseClass).toBe("ga-required");
    expect(copilotProfile("copilot-vscode")?.releaseClass).toBe("ga-required");
    expect(copilotProfile("copilot-cloud-agent")?.releaseClass).toBe("recognized-evidence-only");
    expect(copilotProfile("copilot-code-review")?.releaseClass).toBe("recognized-evidence-only");
  });

  test("does not transfer path, reference, exclusion, or support behavior between surfaces", () => {
    const cli = copilotProfile("copilot-cli");
    const vscode = copilotProfile("copilot-vscode");
    const cloud = copilotProfile("copilot-cloud-agent");
    const review = copilotProfile("copilot-code-review");
    if (cli === undefined || vscode === undefined || cloud === undefined || review === undefined)
      throw new Error("built-in Copilot profiles are missing");
    const format = (
      profile: CopilotProfileDescriptor,
      formatId: string,
    ): CopilotFormatProfileClaim | undefined =>
      profile.formats.find((claim) => claim.formatId === formatId);

    expect(format(cli, "copilot-path-instructions")).toMatchObject({
      globDialectId: "copilot-cli/apply-to/2026-08-01",
      references: "unsupported",
      uncertainty: "unknown",
    });
    expect(format(vscode, "copilot-path-instructions")).toMatchObject({
      globDialectId: "copilot-vscode/apply-to/2026-08-01",
      references: "markdown-links-setting",
      uncertainty: "contradiction",
    });
    expect(format(cloud, "copilot-path-instructions")?.globDialectId).toBe(
      "copilot-cloud-agent/apply-to/2026-08-01",
    );
    expect(format(review, "copilot-path-instructions")?.globDialectId).toBe(
      "copilot-code-review/apply-to/2026-08-01",
    );
    expect(format(review, "claude-memory-markdown")?.support).toBe("not-listed");
    expect(format(cloud, "claude-memory-markdown")?.support).toBe("supported");
  });

  test("has no executable hook or fallback for an unknown profile", () => {
    expect(copilotProfile("copilot")).toBeUndefined();
    expect(copilotProfile("")).toBeUndefined();
    for (const profile of COPILOT_PROFILES) {
      expect(Object.values(profile).some((value) => typeof value === "function")).toBe(false);
      expect(
        profile.formats.some((claim) =>
          Object.values(claim).some((value) => typeof value === "function"),
        ),
      ).toBe(false);
    }
  });
});
