/** Version of the closed D08 Copilot surface-profile catalog. */
export const COPILOT_PROFILE_CONTRACT_VERSION = "0.1.0" as const;

export const COPILOT_PROFILE_IDS = [
  "copilot-cli",
  "copilot-vscode",
  "copilot-cloud-agent",
  "copilot-code-review",
] as const;

export const COPILOT_SURFACE_IDS = [
  "copilot-cli/local-terminal",
  "copilot-vscode/local-chat",
  "copilot-cloud-agent/github-hosted",
  "copilot-code-review/github-hosted",
] as const;

export const COPILOT_PROFILE_FORMAT_IDS = [
  "agents-markdown",
  "claude-memory-markdown",
  "copilot-path-instructions",
  "copilot-repository-markdown",
  "gemini-context-markdown",
] as const;

export type CopilotProfileId = (typeof COPILOT_PROFILE_IDS)[number];
export type CopilotSurfaceId = (typeof COPILOT_SURFACE_IDS)[number];
export type CopilotProfileFormatId = (typeof COPILOT_PROFILE_FORMAT_IDS)[number];
export type CopilotProfileSupport = "conditional" | "not-listed" | "supported" | "unknown";
export type CopilotActivationMechanism =
  "event-always" | "path-glob" | "runtime-conditional" | "unknown";
export type CopilotReferenceBehavior =
  "copilot-cli-relative-at" | "markdown-links-setting" | "unsupported" | "unknown";
export type CopilotProfileUncertainty = "conditional" | "contradiction" | "known" | "unknown";

export interface CopilotFormatProfileClaim {
  readonly activation: CopilotActivationMechanism;
  readonly evidenceRefs: readonly string[];
  readonly formatId: CopilotProfileFormatId;
  readonly globDialectId: string | null;
  readonly references: CopilotReferenceBehavior;
  readonly support: CopilotProfileSupport;
  readonly uncertainty: CopilotProfileUncertainty;
}

export interface CopilotProfileDescriptor {
  readonly clientVersion: null;
  readonly contractVersion: typeof COPILOT_PROFILE_CONTRACT_VERSION;
  readonly evidenceRefs: readonly string[];
  readonly formats: readonly CopilotFormatProfileClaim[];
  readonly profileId: CopilotProfileId;
  readonly releaseClass: "ga-required" | "recognized-evidence-only";
  readonly repositoryRootModel: string;
  readonly retrievedAt: "2026-08-02";
  readonly specSnapshotId: "copilot-surfaces/2026-08-01.0";
  readonly surfaceId: CopilotSurfaceId;
  readonly versionStatus: "hosted-service-date-2026-08-02" | "living-docs-pending-observation";
}

function claim(value: CopilotFormatProfileClaim): CopilotFormatProfileClaim {
  return Object.freeze({ ...value, evidenceRefs: Object.freeze([...value.evidenceRefs]) });
}

function descriptor(
  value: Omit<
    CopilotProfileDescriptor,
    "clientVersion" | "contractVersion" | "retrievedAt" | "specSnapshotId"
  >,
): CopilotProfileDescriptor {
  return Object.freeze({
    ...value,
    clientVersion: null,
    contractVersion: COPILOT_PROFILE_CONTRACT_VERSION,
    evidenceRefs: Object.freeze([...value.evidenceRefs]),
    formats: Object.freeze(value.formats.map(claim)),
    retrievedAt: "2026-08-02",
    specSnapshotId: "copilot-surfaces/2026-08-01.0",
  });
}

const COPILOT_CLI_PROFILE = descriptor({
  evidenceRefs: ["GH-CLI", "GH-MATRIX", "COP-PRE-002", "COP-PRE-004", "COP-PRE-005"],
  formats: [
    {
      activation: "runtime-conditional",
      evidenceRefs: ["GH-CLI", "COP-PRE-002"],
      formatId: "agents-markdown",
      globDialectId: null,
      references: "copilot-cli-relative-at",
      support: "supported",
      uncertainty: "conditional",
    },
    {
      activation: "runtime-conditional",
      evidenceRefs: ["GH-CLI", "COP-PRE-002"],
      formatId: "claude-memory-markdown",
      globDialectId: null,
      references: "copilot-cli-relative-at",
      support: "supported",
      uncertainty: "conditional",
    },
    {
      activation: "path-glob",
      evidenceRefs: ["GH-CLI", "COP-GAP-004"],
      formatId: "copilot-path-instructions",
      globDialectId: "copilot-cli/apply-to/2026-08-01",
      references: "unsupported",
      support: "supported",
      uncertainty: "unknown",
    },
    {
      activation: "event-always",
      evidenceRefs: ["GH-CLI"],
      formatId: "copilot-repository-markdown",
      globDialectId: null,
      references: "copilot-cli-relative-at",
      support: "supported",
      uncertainty: "known",
    },
    {
      activation: "runtime-conditional",
      evidenceRefs: ["GH-CLI", "COP-PRE-005"],
      formatId: "gemini-context-markdown",
      globDialectId: null,
      references: "unsupported",
      support: "supported",
      uncertainty: "conditional",
    },
  ],
  profileId: "copilot-cli",
  releaseClass: "ga-required",
  repositoryRootModel:
    "repository, current-working, intermediate, and runtime-working directories with unresolved general order",
  surfaceId: "copilot-cli/local-terminal",
  versionStatus: "living-docs-pending-observation",
});

const COPILOT_VSCODE_PROFILE = descriptor({
  evidenceRefs: ["VSC-INSTRUCTIONS", "VSC-OVERVIEW", "VSC-SETTINGS", "GH-MATRIX", "COP-GAP-001"],
  formats: [
    {
      activation: "runtime-conditional",
      evidenceRefs: ["VSC-INSTRUCTIONS"],
      formatId: "agents-markdown",
      globDialectId: null,
      references: "markdown-links-setting",
      support: "supported",
      uncertainty: "conditional",
    },
    {
      activation: "runtime-conditional",
      evidenceRefs: ["VSC-INSTRUCTIONS", "GH-MATRIX", "COP-GAP-002"],
      formatId: "claude-memory-markdown",
      globDialectId: null,
      references: "unknown",
      support: "conditional",
      uncertainty: "contradiction",
    },
    {
      activation: "path-glob",
      evidenceRefs: ["VSC-INSTRUCTIONS", "COP-GAP-001"],
      formatId: "copilot-path-instructions",
      globDialectId: "copilot-vscode/apply-to/2026-08-01",
      references: "markdown-links-setting",
      support: "supported",
      uncertainty: "contradiction",
    },
    {
      activation: "event-always",
      evidenceRefs: ["VSC-INSTRUCTIONS"],
      formatId: "copilot-repository-markdown",
      globDialectId: null,
      references: "markdown-links-setting",
      support: "supported",
      uncertainty: "known",
    },
    {
      activation: "unknown",
      evidenceRefs: ["GH-MATRIX"],
      formatId: "gemini-context-markdown",
      globDialectId: null,
      references: "unknown",
      support: "not-listed",
      uncertainty: "unknown",
    },
  ],
  profileId: "copilot-vscode",
  releaseClass: "ga-required",
  repositoryRootModel: "explicit workspace roots with optional trusted parent-repository discovery",
  surfaceId: "copilot-vscode/local-chat",
  versionStatus: "living-docs-pending-observation",
});

const COPILOT_CLOUD_AGENT_PROFILE = descriptor({
  evidenceRefs: ["GH-REPO", "GH-MATRIX", "COP-PRE-003", "COP-PRE-004"],
  formats: [
    {
      activation: "runtime-conditional",
      evidenceRefs: ["GH-REPO"],
      formatId: "agents-markdown",
      globDialectId: null,
      references: "unknown",
      support: "supported",
      uncertainty: "conditional",
    },
    {
      activation: "runtime-conditional",
      evidenceRefs: ["GH-REPO"],
      formatId: "claude-memory-markdown",
      globDialectId: null,
      references: "unknown",
      support: "supported",
      uncertainty: "conditional",
    },
    {
      activation: "path-glob",
      evidenceRefs: ["GH-REPO", "COP-GAP-004"],
      formatId: "copilot-path-instructions",
      globDialectId: "copilot-cloud-agent/apply-to/2026-08-01",
      references: "unknown",
      support: "supported",
      uncertainty: "unknown",
    },
    {
      activation: "event-always",
      evidenceRefs: ["GH-REPO"],
      formatId: "copilot-repository-markdown",
      globDialectId: null,
      references: "unknown",
      support: "supported",
      uncertainty: "conditional",
    },
    {
      activation: "runtime-conditional",
      evidenceRefs: ["GH-REPO"],
      formatId: "gemini-context-markdown",
      globDialectId: null,
      references: "unknown",
      support: "supported",
      uncertainty: "conditional",
    },
  ],
  profileId: "copilot-cloud-agent",
  releaseClass: "recognized-evidence-only",
  repositoryRootModel: "hosted repository checkout with incompletely documented task lifecycle",
  surfaceId: "copilot-cloud-agent/github-hosted",
  versionStatus: "hosted-service-date-2026-08-02",
});

const COPILOT_CODE_REVIEW_PROFILE = descriptor({
  evidenceRefs: ["GH-REPO", "GH-REVIEW", "GH-MATRIX", "COP-PRE-003", "COP-GAP-003"],
  formats: [
    {
      activation: "runtime-conditional",
      evidenceRefs: ["GH-REVIEW", "COP-GAP-003"],
      formatId: "agents-markdown",
      globDialectId: null,
      references: "unknown",
      support: "conditional",
      uncertainty: "unknown",
    },
    {
      activation: "unknown",
      evidenceRefs: ["GH-MATRIX"],
      formatId: "claude-memory-markdown",
      globDialectId: null,
      references: "unknown",
      support: "not-listed",
      uncertainty: "unknown",
    },
    {
      activation: "path-glob",
      evidenceRefs: ["GH-REPO", "GH-REVIEW", "COP-GAP-004"],
      formatId: "copilot-path-instructions",
      globDialectId: "copilot-code-review/apply-to/2026-08-01",
      references: "unknown",
      support: "supported",
      uncertainty: "unknown",
    },
    {
      activation: "runtime-conditional",
      evidenceRefs: ["GH-REPO", "GH-REVIEW"],
      formatId: "copilot-repository-markdown",
      globDialectId: null,
      references: "unknown",
      support: "supported",
      uncertainty: "conditional",
    },
    {
      activation: "unknown",
      evidenceRefs: ["GH-MATRIX"],
      formatId: "gemini-context-markdown",
      globDialectId: null,
      references: "unknown",
      support: "not-listed",
      uncertainty: "unknown",
    },
  ],
  profileId: "copilot-code-review",
  releaseClass: "recognized-evidence-only",
  repositoryRootModel: "pull-request head-branch repository snapshot",
  surfaceId: "copilot-code-review/github-hosted",
  versionStatus: "hosted-service-date-2026-08-02",
});

/** Four separate surface profiles. Hosted profiles are evidence-only until D16 observations exist. */
export const COPILOT_PROFILES: readonly CopilotProfileDescriptor[] = Object.freeze([
  COPILOT_CLI_PROFILE,
  COPILOT_VSCODE_PROFILE,
  COPILOT_CLOUD_AGENT_PROFILE,
  COPILOT_CODE_REVIEW_PROFILE,
]);

const PROFILE_BY_ID: ReadonlyMap<string, CopilotProfileDescriptor> = new Map(
  COPILOT_PROFILES.map((profile) => [profile.profileId, profile]),
);

export function copilotProfile(profileId: string): CopilotProfileDescriptor | undefined {
  return PROFILE_BY_ID.get(profileId);
}
