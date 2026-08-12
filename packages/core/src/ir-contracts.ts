import type {
  ClientProfileId,
  DocumentFormatId,
  EvidenceRefId,
  SpecSnapshotId,
  SurfaceId,
  Uncertainty,
} from "./profile-contracts.js";
import type { RepositoryRelativePath } from "./repository-path.js";

export const INSTRUCTION_IR_CONTRACT_VERSION = "0.1.0" as const;

export const AST_NODE_KINDS = [
  "root",
  "heading",
  "paragraph",
  "list",
  "list-item",
  "block-quote",
  "code-block",
  "inline-code",
  "link",
  "html-comment",
  "frontmatter",
  "text",
  "unknown",
] as const;

export const IMPORT_KINDS = ["vendor-import", "markdown-link", "reference-token"] as const;
export const IMPORT_TARGET_KINDS = [
  "repository-path-candidate",
  "absolute-path-candidate",
  "url",
  "fragment",
  "malformed",
  "unknown",
] as const;
export const IMPORT_STATES = ["recognized", "malformed", "ambiguous"] as const;
export const ACTIVATION_KINDS = [
  "always",
  "directory-tree",
  "glob",
  "manual",
  "conditional",
  "unknown",
] as const;
export const RESOLUTION_EVENT_KINDS = [
  "launch",
  "reference-path",
  "read-path",
  "write-path",
  "list-directory",
  "manual-rule-mention",
  "rule-selection",
  "memory-show",
  "memory-list",
  "memory-reload",
  "compact",
  "directory-add",
  "review-request",
  "review-push",
  "hosted-task-start",
  "settings-change",
  "client-restart",
] as const;

declare const sourceDocumentIdBrand: unique symbol;
declare const instructionDocumentIdBrand: unique symbol;
declare const astNodeIdBrand: unique symbol;
declare const importReferenceIdBrand: unique symbol;
declare const instructionStatementIdBrand: unique symbol;
declare const activationRuleIdBrand: unique symbol;
declare const resolutionEventIdBrand: unique symbol;
declare const resolutionTargetIdBrand: unique symbol;

export type SourceDocumentId = string & { readonly [sourceDocumentIdBrand]: "SourceDocumentId" };
export type InstructionDocumentId = string & {
  readonly [instructionDocumentIdBrand]: "InstructionDocumentId";
};
export type AstNodeId = string & { readonly [astNodeIdBrand]: "AstNodeId" };
export type ImportReferenceId = string & {
  readonly [importReferenceIdBrand]: "ImportReferenceId";
};
export type InstructionStatementId = string & {
  readonly [instructionStatementIdBrand]: "InstructionStatementId";
};
export type ActivationRuleId = string & { readonly [activationRuleIdBrand]: "ActivationRuleId" };
export type ResolutionEventId = string & {
  readonly [resolutionEventIdBrand]: "ResolutionEventId";
};
export type ResolutionTargetId = string & {
  readonly [resolutionTargetIdBrand]: "ResolutionTargetId";
};

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type AstNodeKind = (typeof AST_NODE_KINDS)[number];
export type ImportKind = (typeof IMPORT_KINDS)[number];
export type ImportTargetKind = (typeof IMPORT_TARGET_KINDS)[number];
export type ImportState = (typeof IMPORT_STATES)[number];
export type ActivationKind = (typeof ACTIVATION_KINDS)[number];
export type ResolutionEventKind = (typeof RESOLUTION_EVENT_KINDS)[number];

/** Zero-based source coordinate. UTF-16 offsets match JavaScript string slicing. */
export interface SourcePosition {
  readonly byteOffset: number;
  readonly utf16Offset: number;
  readonly line: number;
  readonly utf16Column: number;
}

/** Half-open source range `[start, end)`. */
export interface SourceRange {
  readonly sourceId: SourceDocumentId;
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export type SourceParseState =
  | { readonly state: "complete" }
  | { readonly state: "partial" | "malformed"; readonly reason: string };

export interface SourceDocument {
  readonly id: SourceDocumentId;
  readonly path: RepositoryRelativePath;
  readonly encoding: "utf-8";
  readonly bom: "none" | "utf-8";
  readonly text: string;
  readonly byteLength: number;
  readonly utf16Length: number;
  readonly sha256: string;
  readonly lineEnding: "none" | "lf" | "cr" | "crlf" | "mixed";
  readonly parseState: SourceParseState;
  readonly rootNodeId: AstNodeId;
}

interface AstNodeBase {
  readonly id: AstNodeId;
  readonly sourceId: SourceDocumentId;
  readonly range: SourceRange;
  readonly childIds: readonly AstNodeId[];
}

export type AstNode =
  | (AstNodeBase & { readonly kind: "root" })
  | (AstNodeBase & { readonly kind: "heading"; readonly depth: 1 | 2 | 3 | 4 | 5 | 6 })
  | (AstNodeBase & { readonly kind: "paragraph" })
  | (AstNodeBase & {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly start: number | null;
    })
  | (AstNodeBase & { readonly kind: "list-item" })
  | (AstNodeBase & { readonly kind: "block-quote" })
  | (AstNodeBase & {
      readonly kind: "code-block";
      readonly language: string | null;
      readonly metadata: string | null;
    })
  | (AstNodeBase & { readonly kind: "inline-code" })
  | (AstNodeBase & {
      readonly kind: "link";
      readonly destination: string;
      readonly title: string | null;
    })
  | (AstNodeBase & { readonly kind: "html-comment" })
  | (AstNodeBase & { readonly kind: "frontmatter"; readonly format: "yaml" | "mdc" })
  | (AstNodeBase & { readonly kind: "text" })
  | (AstNodeBase & {
      readonly kind: "unknown";
      readonly syntaxKind: string;
      readonly reason: string;
    });

export interface InstructionDocument {
  readonly id: InstructionDocumentId;
  readonly sourceId: SourceDocumentId;
  readonly formatId: DocumentFormatId;
  readonly scopeRoot: RepositoryRelativePath;
  readonly rootNodeId: AstNodeId;
  readonly importIds: readonly ImportReferenceId[];
  readonly statementIds: readonly InstructionStatementId[];
  readonly activationRuleIds: readonly ActivationRuleId[];
}

export interface ImportReference {
  readonly id: ImportReferenceId;
  readonly documentId: InstructionDocumentId;
  readonly nodeId: AstNodeId;
  readonly kind: ImportKind;
  readonly range: SourceRange;
  readonly specifierRange: SourceRange;
  readonly rawSpecifier: string;
  readonly targetKind: ImportTargetKind;
  readonly state: ImportState;
  readonly uncertainty: Uncertainty;
}

export type StatementModality = "must" | "must-not" | "should" | "preference" | "information";

export type StatementClassification =
  | { readonly state: "unclassified" }
  | {
      readonly state: "classified";
      readonly normalizedText: string;
      readonly categoryId: string;
      readonly modality: StatementModality;
      readonly subject: string | null;
      readonly action: string | null;
      readonly object: string | null;
      readonly confidence: number;
    };

export interface InstructionStatement {
  readonly id: InstructionStatementId;
  readonly documentId: InstructionDocumentId;
  readonly nodeIds: readonly AstNodeId[];
  readonly range: SourceRange;
  readonly text: string;
  readonly classification: StatementClassification;
}

export interface ActivationEvidenceRef {
  readonly sourceId: EvidenceRefId;
  readonly factId: string | null;
}

export type ActivationSelector =
  | {
      readonly kind: "directory-tree";
      readonly path: RepositoryRelativePath;
      readonly sourceRange: SourceRange | null;
    }
  | {
      readonly kind: "glob";
      readonly pattern: string;
      readonly dialectId: string | null;
      readonly sourceRange: SourceRange | null;
      readonly uncertainty: Uncertainty;
    };

export interface ActivationRule {
  readonly id: ActivationRuleId;
  readonly documentId: InstructionDocumentId;
  readonly profileId: ClientProfileId;
  readonly surfaceId: SurfaceId;
  readonly specSnapshotId: SpecSnapshotId;
  readonly kind: ActivationKind;
  readonly scopeRoot: RepositoryRelativePath;
  readonly include: readonly ActivationSelector[];
  readonly exclude: readonly ActivationSelector[];
  readonly conditions: readonly string[];
  readonly unknownReason: string | null;
  readonly evidenceRefs: readonly ActivationEvidenceRef[];
  readonly uncertainty: Uncertainty;
}

export interface ResolutionSetting {
  readonly key: string;
  readonly value: JsonValue;
}

export interface ResolutionTarget {
  readonly id: ResolutionTargetId;
  readonly path: RepositoryRelativePath;
  readonly purpose: string;
}

interface ResolutionEventBase {
  readonly id: ResolutionEventId;
  readonly sequence: number;
  readonly targetId: ResolutionTargetId | null;
  readonly uncertainty: Uncertainty;
}

export type ResolutionEvent =
  | (ResolutionEventBase & {
      readonly kind: "launch";
      readonly path: RepositoryRelativePath;
      readonly workspaceRoots: readonly RepositoryRelativePath[];
      readonly settings: readonly ResolutionSetting[];
    })
  | (ResolutionEventBase & {
      readonly kind:
        "reference-path" | "read-path" | "write-path" | "list-directory" | "directory-add";
      readonly path: RepositoryRelativePath;
    })
  | (ResolutionEventBase & {
      readonly kind: "manual-rule-mention";
      readonly ruleId: ActivationRuleId;
    })
  | (ResolutionEventBase & {
      readonly kind: "rule-selection";
      readonly ruleIds: readonly ActivationRuleId[];
      readonly selectionSource: "profile" | "model" | "user" | "unknown";
    })
  | (ResolutionEventBase & {
      readonly kind: "settings-change";
      readonly settings: readonly ResolutionSetting[];
    })
  | (ResolutionEventBase & {
      readonly kind:
        | "memory-show"
        | "memory-list"
        | "memory-reload"
        | "compact"
        | "review-request"
        | "review-push"
        | "hosted-task-start"
        | "client-restart";
    });

/** Closed, JSON-safe v0 envelope. Relationships are references, never object cycles. */
export interface InstructionIr {
  readonly recordKind: "agent-context-instruction-ir";
  readonly contractVersion: typeof INSTRUCTION_IR_CONTRACT_VERSION;
  readonly sources: readonly SourceDocument[];
  readonly documents: readonly InstructionDocument[];
  readonly nodes: readonly AstNode[];
  readonly imports: readonly ImportReference[];
  readonly statements: readonly InstructionStatement[];
  readonly activationRules: readonly ActivationRule[];
  readonly targets: readonly ResolutionTarget[];
  readonly events: readonly ResolutionEvent[];
}

export type InstructionIrValidationCode =
  | "duplicate-id"
  | "invalid-digest"
  | "invalid-json"
  | "invalid-path"
  | "invalid-range"
  | "invalid-relationship"
  | "invalid-state"
  | "invalid-value"
  | "missing-field"
  | "resource-limit"
  | "unknown-field";

export interface InstructionIrValidationIssue {
  readonly code: InstructionIrValidationCode;
  readonly message: string;
  readonly path: string;
}

export type InstructionIrValidationResult =
  | { readonly ok: true; readonly value: InstructionIr }
  | { readonly ok: false; readonly issues: readonly InstructionIrValidationIssue[] };

export type SourceRangeValidationResult =
  | { readonly ok: true; readonly value: SourceRange }
  | { readonly ok: false; readonly issues: readonly InstructionIrValidationIssue[] };

export type SourceRangeSliceResult =
  | { readonly ok: true; readonly range: SourceRange; readonly text: string }
  | { readonly ok: false; readonly issues: readonly InstructionIrValidationIssue[] };
