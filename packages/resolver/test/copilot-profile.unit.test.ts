import {
  canonicalizeRepositoryRelativePath,
  type RepositoryRelativePath,
} from "@agent-context/core";
import { readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";

import {
  COPILOT_PROFILE_RESOLVER_CONTRACT_VERSION,
  CopilotProfileError,
  CopilotProfileErrorCode,
  resolveCopilotProfile,
  type CopilotInstructionCandidateSnapshot,
  type ResolveCopilotProfileInput,
} from "../src/index.js";

const encoder = new TextEncoder();
const VSCODE_DESCRIPTION_FIXTURE = new URL(
  "../../../conformance/fixtures/v0/copilot-vscode-description-ambiguity.fixture.json",
  import.meta.url,
);

interface VscodeDescriptionFixture {
  readonly profile: { readonly profileId: string; readonly surfaceId: string };
  readonly repository: {
    readonly files: readonly { readonly content: string; readonly path: string }[];
  };
  readonly targets: readonly { readonly path: string }[];
}

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function candidate(
  value: string,
  format: "path-specific" | "repository-wide",
  text: string,
): CopilotInstructionCandidateSnapshot {
  return { bytes: encoder.encode(text), format, path: path(value) };
}

function cliInput(
  candidates: readonly CopilotInstructionCandidateSnapshot[],
  overrides: Partial<Extract<ResolveCopilotProfileInput["runtime"], { kind: "copilot-cli" }>> = {},
): ResolveCopilotProfileInput {
  return {
    candidates,
    profileId: "copilot-cli",
    runtime: {
      disabledPaths: [],
      eventState: "present",
      kind: "copilot-cli",
      standardLocations: [{ kind: "repository-root", path: path(".") }],
      targetPaths: [path("src/api.ts")],
      ...overrides,
    },
  };
}

function vscodeInput(
  candidates: readonly CopilotInstructionCandidateSnapshot[],
  overrides: Partial<
    Extract<ResolveCopilotProfileInput["runtime"], { kind: "copilot-vscode" }>
  > = {},
): ResolveCopilotProfileInput {
  return {
    candidates,
    profileId: "copilot-vscode",
    runtime: {
      applyingInstructions: "enabled",
      eventState: "present",
      instructionFolders: [{ path: path(".github/instructions"), workspaceRoot: path(".") }],
      kind: "copilot-vscode",
      manualAttachments: [],
      targetPaths: [path("src/api.ts")],
      workspaceRoots: [path(".")],
      ...overrides,
    },
  };
}

function cloudInput(
  candidates: readonly CopilotInstructionCandidateSnapshot[],
  overrides: Partial<
    Extract<ResolveCopilotProfileInput["runtime"], { kind: "copilot-cloud-agent" }>
  > = {},
): ResolveCopilotProfileInput {
  return {
    candidates,
    profileId: "copilot-cloud-agent",
    runtime: {
      eventState: "present",
      kind: "copilot-cloud-agent",
      repositoryRoot: path("."),
      targetPaths: [path("src/api.ts")],
      ...overrides,
    },
  };
}

function reviewInput(
  candidates: readonly CopilotInstructionCandidateSnapshot[],
  overrides: Partial<
    Extract<ResolveCopilotProfileInput["runtime"], { kind: "copilot-code-review" }>
  > = {},
): ResolveCopilotProfileInput {
  return {
    candidates,
    profileId: "copilot-code-review",
    runtime: {
      customInstructions: "enabled",
      eventState: "present",
      kind: "copilot-code-review",
      repositoryRoot: path("."),
      targetPaths: [path("src/api.ts")],
      ...overrides,
    },
  };
}

const REPOSITORY = candidate(
  ".github/copilot-instructions.md",
  "repository-wide",
  "Use stable APIs.\n@docs/policy.md\n",
);

function scoped(applyTo = "src/**/*.ts", extra = ""): CopilotInstructionCandidateSnapshot {
  return candidate(
    ".github/instructions/typescript.instructions.md",
    "path-specific",
    `---\napplyTo: '${applyTo}'\n${extra}---\nUse TypeScript.\n`,
  );
}

describe("D08 Copilot CLI profile", () => {
  test("activates documented repository instructions but retains unknown CLI glob base", () => {
    const result = resolveCopilotProfile(cliInput([scoped(), REPOSITORY]));

    expect(result).toMatchObject({
      analysisStatus: "partial",
      contractVersion: COPILOT_PROFILE_RESOLVER_CONTRACT_VERSION,
      profile: { profileId: "copilot-cli", releaseClass: "ga-required" },
      recordKind: "agent-context-copilot-profile-resolution",
      runtimeKind: "copilot-cli",
    });
    expect(result.candidates.map((entry) => [entry.path, entry.activation, entry.code])).toEqual([
      [".github/copilot-instructions.md", "active", "documented-auto"],
      [
        ".github/instructions/typescript.instructions.md",
        "indeterminate",
        "unknown-glob-semantics",
      ],
    ]);
    expect(result.candidates[0]?.syntax.imports).toHaveLength(1);
    expect(result.candidates[1]?.targetDecisions).toEqual([
      expect.objectContaining({ state: "indeterminate", targetPath: "src/api.ts" }),
    ]);
  });

  test("honors explicit session disable and excludes modular files from intermediate roots", () => {
    const disabled = resolveCopilotProfile(
      cliInput([REPOSITORY], { disabledPaths: [path(".github/copilot-instructions.md")] }),
    );
    expect(disabled.candidates[0]).toMatchObject({
      activation: "inactive",
      code: "documented-disabled",
      eligibility: "denied",
    });

    const intermediate = candidate(
      "packages/api/.github/instructions/api.instructions.md",
      "path-specific",
      "---\napplyTo: '**'\n---\nBody\n",
    );
    const result = resolveCopilotProfile(
      cliInput([intermediate], {
        standardLocations: [{ kind: "intermediate-directory", path: path("packages/api") }],
      }),
    );
    expect(result.candidates[0]).toMatchObject({
      activation: "inactive",
      code: "documented-not-discovered",
      discovery: "not-discovered",
    });
  });

  test("does not claim activation when the session event is absent or unknown", () => {
    expect(
      resolveCopilotProfile(cliInput([REPOSITORY], { eventState: "absent" })).candidates[0],
    ).toMatchObject({ activation: "inactive", code: "missing-runtime-event" });
    expect(
      resolveCopilotProfile(cliInput([REPOSITORY], { eventState: "unknown" })).candidates[0],
    ).toMatchObject({ activation: "indeterminate", code: "unknown-event-state" });
  });
});

describe("D08 VS Code profile", () => {
  test("preserves the versioned description-only conformance ambiguity", async () => {
    const fixture = JSON.parse(
      await readFile(VSCODE_DESCRIPTION_FIXTURE, "utf8"),
    ) as VscodeDescriptionFixture;
    expect(fixture.profile).toMatchObject({
      profileId: "copilot-vscode",
      surfaceId: "copilot-vscode/local-chat",
    });
    const instruction = fixture.repository.files.find((entry) =>
      entry.path.endsWith(".instructions.md"),
    );
    if (instruction === undefined) throw new Error("fixture instruction is missing");
    const result = resolveCopilotProfile(
      vscodeInput([candidate(instruction.path, "path-specific", instruction.content)], {
        targetPaths: fixture.targets.map((entry) => path(entry.path)),
      }),
    );
    expect(result.analysisStatus).toBe("partial");
    expect(result.candidates[0]).toMatchObject({
      activation: "indeterminate",
      code: "vscode-description-contradiction",
      discovery: "documented",
      eligibility: "indeterminate",
    });
  });

  test("resolves workspace-root repository instructions and documented glob matches", () => {
    const result = resolveCopilotProfile(
      vscodeInput([REPOSITORY, scoped()], {
        targetPaths: [path("docs/readme.md"), path("src/api.ts")],
      }),
    );
    expect(result.analysisStatus).toBe("complete");
    expect(result.candidates[0]).toMatchObject({ activation: "active", code: "documented-auto" });
    expect(result.candidates[1]).toMatchObject({ activation: "active", code: "documented-auto" });
    expect(result.candidates[1]?.targetDecisions).toEqual([
      expect.objectContaining({ state: "inactive", targetPath: "docs/readme.md" }),
      expect.objectContaining({ state: "active", targetPath: "src/api.ts" }),
    ]);

    const nonMatch = resolveCopilotProfile(
      vscodeInput([scoped()], { targetPaths: [path("docs/readme.md")] }),
    );
    expect(nonMatch.candidates[0]).toMatchObject({
      activation: "inactive",
      code: "documented-no-match",
    });
  });

  test("keeps missing applyTo contradictory unless explicitly attached", () => {
    const descriptionOnly = candidate(
      ".github/instructions/api.instructions.md",
      "path-specific",
      "---\ndescription: API guidance\n---\nBody\n",
    );
    const automatic = resolveCopilotProfile(vscodeInput([descriptionOnly]));
    expect(automatic.candidates[0]).toMatchObject({
      activation: "indeterminate",
      code: "vscode-description-contradiction",
      eligibility: "indeterminate",
    });

    const manual = resolveCopilotProfile(
      vscodeInput([descriptionOnly], {
        applyingInstructions: "disabled",
        manualAttachments: [path(".github/instructions/api.instructions.md")],
      }),
    );
    expect(manual.candidates[0]).toMatchObject({
      activation: "active",
      code: "manual-attachment",
      eligibility: "allowed",
    });
  });

  test("separates explicit automatic-setting states from repository-wide activation", () => {
    const disabled = resolveCopilotProfile(
      vscodeInput([REPOSITORY, scoped()], { applyingInstructions: "disabled" }),
    );
    expect(disabled.candidates.map((entry) => [entry.format, entry.activation])).toEqual([
      ["repository-wide", "active"],
      ["path-specific", "inactive"],
    ]);

    const unknown = resolveCopilotProfile(
      vscodeInput([scoped()], { applyingInstructions: "unknown" }),
    );
    expect(unknown.candidates[0]).toMatchObject({
      activation: "indeterminate",
      code: "unknown-setting-state",
    });
  });

  test("does not discover candidates outside exact workspace and configured folder boundaries", () => {
    const outside = candidate(
      "other/.github/instructions/api.instructions.md",
      "path-specific",
      "---\napplyTo: '**'\n---\nBody\n",
    );
    expect(resolveCopilotProfile(vscodeInput([outside])).candidates[0]).toMatchObject({
      activation: "inactive",
      discovery: "not-discovered",
    });

    const ambiguous = resolveCopilotProfile(
      vscodeInput([scoped()], {
        instructionFolders: [
          { path: path(".github/instructions"), workspaceRoot: path(".") },
          { path: path(".github/instructions"), workspaceRoot: path(".github") },
        ],
        workspaceRoots: [path("."), path(".github")],
      }),
    );
    expect(ambiguous.candidates[0]).toMatchObject({
      activation: "indeterminate",
      code: "unknown-discovery",
      discovery: "unknown",
    });
  });
});

describe("D08 hosted evidence-only profiles", () => {
  test("recognizes documented repository instructions only for explicit hosted events", () => {
    const cloud = resolveCopilotProfile(cloudInput([REPOSITORY]));
    const review = resolveCopilotProfile(reviewInput([REPOSITORY]));
    expect(cloud.profile.releaseClass).toBe("recognized-evidence-only");
    expect(review.profile.releaseClass).toBe("recognized-evidence-only");
    expect(cloud.candidates[0]).toMatchObject({ activation: "active", code: "documented-auto" });
    expect(review.candidates[0]).toMatchObject({ activation: "active", code: "documented-auto" });

    expect(
      resolveCopilotProfile(cloudInput([REPOSITORY], { eventState: "unknown" })).candidates[0],
    ).toMatchObject({ activation: "indeterminate", code: "unknown-event-state" });
    expect(
      resolveCopilotProfile(reviewInput([REPOSITORY], { eventState: "absent" })).candidates[0],
    ).toMatchObject({ activation: "inactive", code: "missing-runtime-event" });
  });

  test("applies only the exclusion owned by the selected hosted surface", () => {
    const cloudExcluded = scoped("**", "excludeAgent: cloud-agent\n");
    const reviewExcluded = scoped("**", "excludeAgent: code-review\n");
    expect(resolveCopilotProfile(cloudInput([cloudExcluded])).candidates[0]).toMatchObject({
      activation: "inactive",
      code: "documented-exclusion",
    });
    expect(resolveCopilotProfile(reviewInput([reviewExcluded])).candidates[0]).toMatchObject({
      activation: "inactive",
      code: "documented-exclusion",
    });

    expect(resolveCopilotProfile(cloudInput([reviewExcluded])).candidates[0]).toMatchObject({
      activation: "indeterminate",
      code: "unknown-glob-semantics",
    });
    expect(resolveCopilotProfile(reviewInput([cloudExcluded])).candidates[0]).toMatchObject({
      activation: "indeterminate",
      code: "unknown-glob-semantics",
    });
  });

  test("honors explicit code-review settings without inventing cloud-agent settings", () => {
    const disabled = resolveCopilotProfile(
      reviewInput([REPOSITORY], { customInstructions: "disabled" }),
    );
    expect(disabled.candidates[0]).toMatchObject({
      activation: "inactive",
      code: "documented-disabled",
    });

    const unknown = resolveCopilotProfile(
      reviewInput([REPOSITORY], { customInstructions: "unknown" }),
    );
    expect(unknown.candidates[0]).toMatchObject({
      activation: "indeterminate",
      code: "unknown-setting-state",
    });
  });
});

describe("D08 malformed, hostile, and deterministic inputs", () => {
  test("denies malformed scope authority without reporting definite client inactivity", () => {
    const malformed = candidate(
      ".github/instructions/bad.instructions.md",
      "path-specific",
      "---\napplyTo: [\n---\nBody\n",
    );
    const result = resolveCopilotProfile(vscodeInput([malformed]));
    expect(result.candidates[0]).toMatchObject({
      activation: "indeterminate",
      code: "malformed-syntax",
      eligibility: "denied",
      syntax: { scopeAuthority: "denied", state: "malformed" },
    });
  });

  test("sorts candidate and target snapshots deterministically without mutating bytes", () => {
    const firstBytes = encoder.encode("---\napplyTo: 'src/**'\n---\nBody\n");
    const before = Uint8Array.from(firstBytes);
    const input = vscodeInput(
      [
        {
          bytes: firstBytes,
          format: "path-specific",
          path: path(".github/instructions/z.instructions.md"),
        },
        REPOSITORY,
      ],
      { targetPaths: [path("src/z.ts"), path("docs/a.md")] },
    );
    const first = resolveCopilotProfile(input);
    const serialized = JSON.stringify(first);
    for (let index = 0; index < 100; index += 1)
      expect(JSON.stringify(resolveCopilotProfile(input))).toBe(serialized);
    expect(firstBytes).toEqual(before);
    expect(first.candidates.map((entry) => entry.path)).toEqual([
      ".github/copilot-instructions.md",
      ".github/instructions/z.instructions.md",
    ]);
    expect(first.candidates[1]?.targetDecisions.map((entry) => entry.targetPath)).toEqual([
      "docs/a.md",
      "src/z.ts",
    ]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.candidates)).toBe(true);
    expect(Object.isFrozen(first.candidates[0]?.syntax)).toBe(true);
  });

  test("rejects mismatched profiles, extra fields, proxies, accessors, Buffers, and duplicates", () => {
    expect(() => resolveCopilotProfile({ ...cliInput([]), profileId: "copilot-vscode" })).toThrow(
      CopilotProfileError,
    );
    expect(() => resolveCopilotProfile({ ...cliInput([]), extra: true } as never)).toThrow(
      CopilotProfileError,
    );
    expect(() => resolveCopilotProfile(new Proxy(cliInput([]), {}))).toThrow(CopilotProfileError);
    expect(() =>
      resolveCopilotProfile(
        cliInput([
          {
            bytes: Buffer.from("body"),
            format: "repository-wide",
            path: path(".github/copilot-instructions.md"),
          },
        ]),
      ),
    ).toThrow(CopilotProfileError);
    expect(() => resolveCopilotProfile(cliInput([REPOSITORY, REPOSITORY]))).toThrow(
      CopilotProfileError,
    );

    const getter = vi.fn(() => []);
    const hostile = { ...cliInput([]) } as Record<string, unknown>;
    Object.defineProperty(hostile, "candidates", { enumerable: true, get: getter });
    expect(() => resolveCopilotProfile(hostile as never)).toThrow(CopilotProfileError);
    expect(getter).not.toHaveBeenCalled();
  });

  test("rejects malformed arrays, paths, runtime states, locations, folders, and identities", () => {
    const arrayWithExtra: unknown[] = [];
    Object.defineProperty(arrayWithExtra, "extra", { enumerable: true, value: true });
    const nonEnumerableIndex: unknown[] = [];
    Object.defineProperty(nonEnumerableIndex, "0", {
      configurable: true,
      enumerable: false,
      value: REPOSITORY,
      writable: true,
    });
    const bytesWithExtra = encoder.encode("Body");
    Object.defineProperty(bytesWithExtra, "extra", { enumerable: true, value: true });
    const invalidCandidate = {
      bytes: encoder.encode("Body"),
      format: "invalid",
      path: path(".github/copilot-instructions.md"),
    };
    const malformed: readonly (() => unknown)[] = [
      (): unknown => resolveCopilotProfile({ ...cliInput([]), candidates: {} as never }),
      (): unknown =>
        resolveCopilotProfile({ ...cliInput([]), candidates: arrayWithExtra as never }),
      (): unknown =>
        resolveCopilotProfile({ ...cliInput([]), candidates: nonEnumerableIndex as never }),
      (): unknown => resolveCopilotProfile(cliInput([], { targetPaths: [] })),
      (): unknown => resolveCopilotProfile(cliInput([], { targetPaths: [path("a"), path("a")] })),
      (): unknown =>
        resolveCopilotProfile(
          cliInput([
            {
              bytes: bytesWithExtra,
              format: "repository-wide",
              path: path(".github/copilot-instructions.md"),
            },
          ]),
        ),
      (): unknown => resolveCopilotProfile(cliInput([], { eventState: "invalid" as never })),
      (): unknown => resolveCopilotProfile(cliInput([], { standardLocations: [] })),
      (): unknown =>
        resolveCopilotProfile(
          cliInput([], {
            standardLocations: [{ kind: "invalid" as never, path: path(".") }],
          }),
        ),
      (): unknown =>
        resolveCopilotProfile(
          cliInput([], {
            standardLocations: [
              { kind: "repository-root", path: path(".") },
              { kind: "repository-root", path: path(".") },
            ],
          }),
        ),
      (): unknown =>
        resolveCopilotProfile(vscodeInput([], { applyingInstructions: "invalid" as never })),
      (): unknown =>
        resolveCopilotProfile(
          vscodeInput([], {
            instructionFolders: [{ path: path("outside"), workspaceRoot: path("workspace") }],
          }),
        ),
      (): unknown =>
        resolveCopilotProfile(
          vscodeInput([], {
            instructionFolders: [
              { path: path(".github/instructions"), workspaceRoot: path(".") },
              { path: path(".github/instructions"), workspaceRoot: path(".") },
            ],
          }),
        ),
      (): unknown => resolveCopilotProfile({ ...cliInput([]), runtime: null as never }),
      (): unknown =>
        resolveCopilotProfile({ ...cliInput([]), runtime: { kind: "invalid" } as never }),
      (): unknown =>
        resolveCopilotProfile({ ...cliInput([]), candidates: [invalidCandidate] as never }),
      (): unknown => resolveCopilotProfile({ ...cliInput([]), profileId: 7 as never }),
      (): unknown => resolveCopilotProfile({ ...cliInput([]), profileId: "unknown" as never }),
      (): unknown =>
        resolveCopilotProfile({
          ...cliInput([]),
          runtime: {
            ...cliInput([]).runtime,
            targetPaths: ["a".repeat(16_385) as never],
          },
        }),
    ];

    for (const invoke of malformed) expect(invoke).toThrow(CopilotProfileError);
  });

  test("returns documented non-discovery for each concrete surface boundary", () => {
    const cliOutside = candidate("outside/copilot.md", "repository-wide", "Body");
    const vscodeOutside = candidate("outside/copilot.md", "repository-wide", "Body");
    const hostedOutside = candidate("outside/copilot.md", "repository-wide", "Body");
    expect(resolveCopilotProfile(cliInput([cliOutside])).candidates[0]?.code).toBe(
      "documented-not-discovered",
    );
    expect(resolveCopilotProfile(vscodeInput([vscodeOutside])).candidates[0]?.code).toBe(
      "documented-not-discovered",
    );
    expect(resolveCopilotProfile(cloudInput([hostedOutside])).candidates[0]?.code).toBe(
      "documented-not-discovered",
    );
  });

  test("keeps missing path scope indeterminate on non-VS Code surfaces", () => {
    const missing = candidate(
      ".github/instructions/missing.instructions.md",
      "path-specific",
      "Body\n",
    );
    expect(resolveCopilotProfile(cliInput([missing])).candidates[0]).toMatchObject({
      activation: "indeterminate",
      code: "unknown-target-state",
    });
  });

  test("returns typed resource failures before parsing oversized candidates or inventories", () => {
    const oversized = new Uint8Array(262_145);
    expect(() =>
      resolveCopilotProfile(
        cliInput([
          {
            bytes: oversized,
            format: "repository-wide",
            path: path(".github/copilot-instructions.md"),
          },
        ]),
      ),
    ).toThrow(expect.objectContaining({ code: CopilotProfileErrorCode.resourceLimit }));

    const tooManyTargets = Array.from({ length: 4_097 }, (_, index) =>
      path(`src/${String(index)}.ts`),
    );
    expect(() => resolveCopilotProfile(cliInput([], { targetPaths: tooManyTargets }))).toThrow(
      expect.objectContaining({ code: CopilotProfileErrorCode.resourceLimit }),
    );
  });
});
