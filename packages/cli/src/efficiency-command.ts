import { Buffer } from "node:buffer";
import { types as nodeTypes } from "node:util";

import {
  compareContextEfficiencyReports,
  isIssuedContextEfficiencyReport,
  renderContextEfficiencyTerminal,
  writeContextEfficiencyJson,
} from "@agent-context/efficiency/report";
import type { ContextEfficiencyReport } from "@agent-context/efficiency/report";

import type { CliAgentProfile, CliCommandHandler, CliCommandHandlers } from "./command-router.js";

export interface EfficiencyCommandRequest {
  readonly agent: CliAgentProfile | null;
  readonly comparePath: string | null;
  readonly repository: string | null;
  readonly signal: AbortSignal;
}

export interface EfficiencyCommandComparisonSource {
  readonly baseline: ContextEfficiencyReport;
  readonly candidate: ContextEfficiencyReport;
}

export type EfficiencyCommandSourceResult =
  ContextEfficiencyReport | EfficiencyCommandComparisonSource;

export interface EfficiencyCommandSource {
  /**
   * I02/F15 supplies this trusted internal capability after producing genuine G05/G07/G08
   * records. G09 deliberately does not read repositories, report files, or scan on its own.
   */
  readonly load: (
    request: EfficiencyCommandRequest,
  ) => EfficiencyCommandSourceResult | Promise<EfficiencyCommandSourceResult>;
}

export interface EfficiencyCommandOptions {
  readonly source: EfficiencyCommandSource;
}

const OPTION_KEYS = new Set(["source"]);
const SOURCE_KEYS = new Set(["load"]);
const COMPARISON_KEYS = new Set(["baseline", "candidate"]);
const OUTPUT_CHUNK_BYTES = 64 * 1_024;

function ownDataRecord(
  value: unknown,
  keys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new Error("invalid efficiency command capability");
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.size ||
    actual.some((key) => typeof key !== "string" || !keys.has(key))
  )
    throw new Error("invalid efficiency command capability");
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      throw new Error("invalid efficiency command capability");
  }
  return value as Readonly<Record<string, unknown>>;
}

function field(record: Readonly<Record<string, unknown>>, key: string): unknown {
  return Reflect.getOwnPropertyDescriptor(record, key)?.value;
}

function sourceFromOptions(optionsValue: unknown): EfficiencyCommandSource["load"] {
  const options = ownDataRecord(optionsValue, OPTION_KEYS);
  const source = ownDataRecord(field(options, "source"), SOURCE_KEYS);
  const load = field(source, "load");
  if (typeof load !== "function" || nodeTypes.isProxy(load))
    throw new Error("invalid efficiency command capability");
  return load as EfficiencyCommandSource["load"];
}

function comparison(value: unknown): EfficiencyCommandComparisonSource | null {
  try {
    const record = ownDataRecord(value, COMPARISON_KEYS);
    const baseline = field(record, "baseline");
    const candidate = field(record, "candidate");
    return isIssuedContextEfficiencyReport(baseline) && isIssuedContextEfficiencyReport(candidate)
      ? Object.freeze({ baseline, candidate })
      : null;
  } catch {
    return null;
  }
}

async function writeTerminal(text: string, write: (text: string) => Promise<void>): Promise<void> {
  let chunk = "";
  let bytes = 0;
  for (const scalar of text) {
    const scalarBytes = Buffer.byteLength(scalar, "utf8");
    if (bytes + scalarBytes > OUTPUT_CHUNK_BYTES && chunk.length > 0) {
      await write(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += scalar;
    bytes += scalarBytes;
  }
  if (chunk.length > 0) await write(chunk);
}

/** Install the exit-neutral G09 command around an injected, genuine analysis source. */
export function createEfficiencyCommandHandlers(optionsValue: unknown): CliCommandHandlers {
  const load = sourceFromOptions(optionsValue);
  const efficiency: CliCommandHandler = async (context) => {
    const loaded = await Reflect.apply(load, undefined, [
      Object.freeze({
        agent: context.agent,
        comparePath: context.comparePath,
        repository: context.operands[0] ?? null,
        signal: context.signal,
      }),
    ]);
    const comparisonSource = context.comparePath === null ? null : comparison(loaded);
    const output =
      context.comparePath === null
        ? isIssuedContextEfficiencyReport(loaded)
          ? loaded
          : null
        : comparisonSource === null
          ? null
          : compareContextEfficiencyReports(comparisonSource);
    if (output === null) throw new Error("efficiency source returned an invalid result");
    if (context.format === "json") {
      await writeContextEfficiencyJson(
        output,
        { write: (text: string): Promise<void> => context.writeStdout(text) },
        { signal: context.signal },
      );
    } else {
      await writeTerminal(
        renderContextEfficiencyTerminal(output, {
          colorMode: context.noColor ? "never" : "ansi",
          width: context.width ?? 80,
        }),
        context.writeStdout,
      );
    }
    // Efficiency is informational. Scores, grades, and recommendations never change the exit code.
    return { status: "success" };
  };
  return Object.freeze({ efficiency });
}
