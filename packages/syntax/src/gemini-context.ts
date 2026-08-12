import type {
  ImportReference,
  InstructionDocument,
  InstructionStatement,
} from "@agent-context/core";

import {
  AGENTS_MARKDOWN_MAX_BYTES,
  AGENTS_MARKDOWN_MAX_PATH_BYTES,
  parseAgentsMarkdown,
  type AgentsMarkdownContentStatus,
  type AgentsMarkdownIssue,
  type AgentsMarkdownParseResult,
} from "./agents-markdown.js";
import { lexImportReferences } from "./import-lexer.js";

export const GEMINI_CONTEXT_CONTRACT_VERSION = "0.1.0" as const;
export const GEMINI_CONTEXT_FORMAT_ID = "gemini-context-markdown" as const;
export const GEMINI_CONTEXT_MAX_BYTES: number = AGENTS_MARKDOWN_MAX_BYTES;
export const GEMINI_CONTEXT_MAX_PATH_BYTES: number = AGENTS_MARKDOWN_MAX_PATH_BYTES;

export interface ParseGeminiContextInput {
  readonly bytes: Uint8Array;
  readonly contentStatus: AgentsMarkdownContentStatus;
  readonly path: AgentsMarkdownParseResult["source"]["path"];
  readonly scopeRoot: AgentsMarkdownParseResult["document"]["scopeRoot"];
}

export interface GeminiContextParseResult extends Omit<
  AgentsMarkdownParseResult,
  "contractVersion" | "document" | "formatId" | "statements"
> {
  readonly contractVersion: typeof GEMINI_CONTEXT_CONTRACT_VERSION;
  readonly document: InstructionDocument;
  readonly formatId: typeof GEMINI_CONTEXT_FORMAT_ID;
  readonly imports: readonly ImportReference[];
  readonly issues: readonly AgentsMarkdownIssue[];
  readonly statements: readonly InstructionStatement[];
}

/**
 * Parses caller-authorized bytes as Gemini context Markdown. Markdown safety and exact ranges are
 * delegated to the C06 AGENTS adapter; only Gemini's C09 import dialect and format identity are
 * added here. Discovery, settings, imports, activation, filesystem reads, and execution remain out
 * of this syntax-only function.
 */
export function parseGeminiContext(input: ParseGeminiContextInput): GeminiContextParseResult {
  const parsed = parseAgentsMarkdown(input);
  const imports = lexImportReferences({
    documentId: parsed.document.id,
    sourceId: parsed.source.id,
    syntax: "gemini-cli",
    text: parsed.source.text,
  }).imports;
  const document = Object.freeze({
    ...parsed.document,
    formatId: GEMINI_CONTEXT_FORMAT_ID,
    importIds: Object.freeze(imports.map((reference) => reference.id)),
  });
  return Object.freeze({
    contractVersion: GEMINI_CONTEXT_CONTRACT_VERSION,
    decode: parsed.decode,
    document,
    formatId: GEMINI_CONTEXT_FORMAT_ID,
    imports,
    issues: parsed.issues,
    nodes: parsed.nodes,
    source: parsed.source,
    statements: parsed.statements,
  });
}
