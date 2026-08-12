import { Buffer } from "node:buffer";

import {
  BUILTIN_ESTIMATE_IDENTITY,
  MAX_TOKENIZER_INPUT_BYTES,
  TOKENIZER_PLUGIN_CONTRACT_VERSION,
} from "./tokenizer-contract.js";

import type {
  TokenCount,
  TokenizerContractIssue,
  TokenizerContractIssueCode,
} from "./tokenizer-contract.js";

/** The versioned estimate is the ceiling of UTF-8 bytes divided by this fixed denominator. */
export const ESTIMATE_UTF8_BYTES_PER_TOKEN = 4 as const;

export type EstimateTokenCountResult =
  | { readonly ok: true; readonly value: TokenCount }
  | { readonly issues: readonly TokenizerContractIssue[]; readonly ok: false };

function failure(
  code: Extract<TokenizerContractIssueCode, "input-limit" | "invalid-input">,
  message: string,
): EstimateTokenCountResult {
  return Object.freeze({
    issues: Object.freeze([
      Object.freeze({
        code,
        message,
        path: "$input",
      }),
    ]),
    ok: false,
  });
}

/**
 * Return a deterministic, explicitly approximate token count for a bounded string.
 *
 * This is not a model tokenizer. The formula intentionally depends only on Node's specified UTF-8
 * string encoding length and integer arithmetic, so it has no locale, ICU, regex, or platform
 * vocabulary dependency.
 */
export function countEstimatedTokens(input: unknown): EstimateTokenCountResult {
  if (typeof input !== "string") {
    return failure("invalid-input", "tokenizer input must be a string");
  }

  // UTF-8 never uses fewer bytes than JavaScript UTF-16 code units. This cheap preflight avoids
  // scanning an already-over-limit hostile string a second time.
  if (input.length > MAX_TOKENIZER_INPUT_BYTES) {
    return failure("input-limit", "tokenizer input exceeds the contract byte ceiling");
  }

  const inputUtf8Bytes = Buffer.byteLength(input, "utf8");
  if (inputUtf8Bytes > MAX_TOKENIZER_INPUT_BYTES) {
    return failure("input-limit", "tokenizer input exceeds the contract byte ceiling");
  }

  return Object.freeze({
    ok: true,
    value: Object.freeze({
      contractVersion: TOKENIZER_PLUGIN_CONTRACT_VERSION,
      identity: BUILTIN_ESTIMATE_IDENTITY,
      inputCodeUnits: input.length,
      inputUtf8Bytes,
      tokens: Math.ceil(inputUtf8Bytes / ESTIMATE_UTF8_BYTES_PER_TOKEN),
    }),
  });
}
