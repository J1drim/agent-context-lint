import { types as nodeTypes } from "node:util";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_VERSION,
  REPORT_KIND,
  canonicalJson,
  computeCalibrationDiagnosticFingerprint,
  sha256Canonical,
  validateCalibrationReport,
} from "./contracts.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const RULE_ID = /^ACL[1-5][0-9]{2}$/;
const MAXIMUM_JSON_DEPTH = 64;
const MAXIMUM_JSON_VALUES = 250_000;
const MAXIMUM_TOTAL_STRING_CODE_UNITS = 64 * 1024 * 1024;
export const MAXIMUM_CALIBRATION_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAXIMUM_CALIBRATION_DIAGNOSTICS = 10_000;
const ROOT_KEYS = new Set([
  "diagnostics",
  "failureThreshold",
  "profileVersions",
  "recordKind",
  "schemaVersion",
  "summary",
]);
const BUNDLE_KEYS = new Set(["contractVersion", "diagnostics", "recordKind", "suppressions"]);
const SUMMARY_KEYS = new Set(["errors", "exitCode", "infos", "suppressed", "warnings"]);
const DIAGNOSTIC_KEYS = new Set([
  "fingerprintBasis",
  "fingerprints",
  "id",
  "message",
  "primary",
  "related",
  "ruleId",
  "ruleVersion",
  "severity",
  "suggestion",
]);
const SUPPRESSION_KEYS = new Set([
  "directive",
  "evidence",
  "id",
  "matchedPathFingerprints",
  "reason",
  "state",
  "targetRuleIds",
]);
const FINGERPRINT_KEYS = new Set(["path", "semantic"]);
const VERSIONED_FINGERPRINT_KEYS = new Set(["method", "value"]);
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default;
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CORE_SCHEMA_DIRECTORY = path.resolve(MODULE_DIRECTORY, "../../packages/core/schemas");

function schema(name) {
  return JSON.parse(readFileSync(path.join(CORE_SCHEMA_DIRECTORY, name), "utf8"));
}

const nativeOutputValidator = (() => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schema("diagnostic-contract.v0.schema.json"));
  return ajv.compile(schema("output-contract.v1.schema.json"));
})();

function plainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (nodeTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function snapshotJson(value) {
  const state = { strings: 0, values: 0 };
  const visit = (input, depth) => {
    state.values += 1;
    if (state.values > MAXIMUM_JSON_VALUES || depth > MAXIMUM_JSON_DEPTH)
      throw new Error("native scan JSON exceeds structure limits");
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new Error("native scan JSON contains a non-finite number");
      return input;
    }
    if (typeof input === "string") {
      state.strings += input.length;
      if (state.strings > MAXIMUM_TOTAL_STRING_CODE_UNITS || !isWellFormedUnicode(input))
        throw new Error("native scan JSON contains invalid or excessive text");
      return input;
    }
    if (typeof input === "object" && nodeTypes.isProxy(input))
      throw new Error("native scan JSON must not contain proxies");
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype)
        throw new Error("native scan JSON arrays must use Array.prototype");
      const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > 100_000
      )
        throw new Error("native scan JSON array has an invalid length");
      const length = lengthDescriptor.value;
      const keys = Reflect.ownKeys(input);
      if (keys.length !== length + 1 || keys.at(-1) !== "length")
        throw new Error("native scan JSON arrays must be dense and contain no extra keys");
      const output = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        if (keys[index] !== key)
          throw new Error("native scan JSON arrays must be dense and canonical");
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (descriptor === undefined || !("value" in descriptor))
          throw new Error("native scan JSON arrays cannot contain accessors");
        output[index] = visit(descriptor.value, depth + 1);
      }
      return Object.freeze(output);
    }
    if (!plainRecord(input)) throw new Error("native scan JSON must contain plain data only");
    const output = Object.create(null);
    const keys = Reflect.ownKeys(input);
    if (keys.length > 100_000) throw new Error("native scan JSON object exceeds its key limit");
    for (const key of keys) {
      if (typeof key !== "string") throw new Error("native scan JSON cannot contain symbols");
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !("value" in descriptor))
        throw new Error("native scan JSON cannot contain accessors");
      state.strings += key.length;
      if (state.strings > MAXIMUM_TOTAL_STRING_CODE_UNITS || !isWellFormedUnicode(key))
        throw new Error("native scan JSON contains invalid or excessive keys");
      output[key] = visit(descriptor.value, depth + 1);
    }
    return Object.freeze(output);
  };
  return visit(value, 0);
}

function validateNativeOutputRelations(output) {
  if (!nativeOutputValidator(output)) {
    const details = (nativeOutputValidator.errors ?? [])
      .slice(0, 8)
      .map((error) => `${error.instancePath || "$"} ${error.message ?? "is invalid"}`)
      .join("; ");
    throw new Error(`native scan output failed published B05/B04 schemas: ${details}`);
  }
  const bundle = own(output, "diagnostics");
  const diagnostics = own(bundle, "diagnostics");
  const suppressions = own(bundle, "suppressions");
  const suppressed = new Set(
    suppressions
      .filter((suppression) => own(suppression, "state") === "suppressed")
      .flatMap((suppression) => own(suppression, "matchedPathFingerprints")),
  );
  const active = diagnostics.filter(
    (diagnostic) => !suppressed.has(own(own(own(diagnostic, "fingerprints"), "path"), "value")),
  );
  const expected = {
    errors: active.filter((diagnostic) => own(diagnostic, "severity") === "error").length,
    infos: active.filter((diagnostic) => own(diagnostic, "severity") === "info").length,
    suppressed: suppressed.size,
    warnings: active.filter((diagnostic) => own(diagnostic, "severity") === "warning").length,
  };
  const summary = own(output, "summary");
  for (const key of Object.keys(expected))
    if (own(summary, key) !== expected[key])
      throw new Error("native scan output summary violates the published B05 relationship");
  const threshold = own(output, "failureThreshold");
  const expectedExit =
    threshold === "never"
      ? 0
      : threshold === "warning"
        ? expected.errors + expected.warnings > 0
          ? 1
          : 0
        : expected.errors > 0
          ? 1
          : 0;
  if (own(summary, "exitCode") !== expectedExit)
    throw new Error("native scan output exit code violates the published B05 relationship");
  const declaredProfiles = Object.keys(own(output, "profileVersions")).sort(compareUtf8);
  const usedProfiles = [
    ...new Set(
      diagnostics.flatMap((diagnostic) => {
        const basis = own(diagnostic, "fingerprintBasis");
        return [
          ...own(own(basis, "path"), "profileIds"),
          ...own(own(basis, "semantic"), "profileIds"),
        ];
      }),
    ),
  ].sort(compareUtf8);
  if (
    usedProfiles.length > 0 &&
    (usedProfiles.length !== declaredProfiles.length ||
      usedProfiles.some((profile, index) => profile !== declaredProfiles[index]))
  )
    throw new Error("native scan output profile identities violate the published B05 relationship");
}

function exactKeys(value, expected, label) {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.size ||
    keys.some((key) => typeof key !== "string" || !expected.has(key))
  )
    throw new Error(`${label} has an invalid field set`);
}

function deepFreeze(value) {
  const pending = [value];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined && "value" in descriptor) pending.push(descriptor.value);
    }
    Object.freeze(current);
  }
  return value;
}

function visiblePathFingerprints(bundle) {
  const suppressed = new Set();
  const suppressions = own(bundle, "suppressions");
  if (!Array.isArray(suppressions) || suppressions.length > 100_000)
    throw new Error("scan suppressions are invalid");
  for (const entry of suppressions) {
    if (!plainRecord(entry)) throw new Error("scan suppression is invalid");
    exactKeys(entry, SUPPRESSION_KEYS, "scan suppression");
    if (own(entry, "state") !== "suppressed") continue;
    const matched = own(entry, "matchedPathFingerprints");
    if (!Array.isArray(matched) || matched.length > 100_000)
      throw new Error("scan suppression fingerprints are invalid");
    for (const fingerprint of matched) {
      if (typeof fingerprint !== "string" || !SHA256.test(fingerprint))
        throw new Error("scan suppression fingerprint is invalid");
      suppressed.add(fingerprint);
    }
  }
  return suppressed;
}

function publicDiagnostic(repositoryId, diagnostic, defaultSeverityByRule) {
  if (!plainRecord(diagnostic)) throw new Error("scan diagnostic is invalid");
  const fingerprints = own(diagnostic, "fingerprints");
  if (!plainRecord(fingerprints)) throw new Error("scan diagnostic fingerprints are invalid");
  const pathIdentity = own(fingerprints, "path");
  const semanticIdentity = own(fingerprints, "semantic");
  if (!plainRecord(pathIdentity) || !plainRecord(semanticIdentity))
    throw new Error("scan diagnostic fingerprint identities are invalid");
  exactKeys(fingerprints, FINGERPRINT_KEYS, "scan diagnostic fingerprints");
  exactKeys(pathIdentity, VERSIONED_FINGERPRINT_KEYS, "scan path fingerprint");
  exactKeys(semanticIdentity, VERSIONED_FINGERPRINT_KEYS, "scan semantic fingerprint");
  const identity = {
    effectiveSeverity: own(diagnostic, "severity"),
    pathFingerprint: own(pathIdentity, "value"),
    repositoryId,
    ruleId: own(diagnostic, "ruleId"),
    semanticFingerprint: own(semanticIdentity, "value"),
    severity: defaultSeverityByRule.get(own(diagnostic, "ruleId")),
  };
  if (
    !SHA256.test(identity.pathFingerprint) ||
    !SHA256.test(identity.semanticFingerprint) ||
    !RULE_ID.test(identity.ruleId) ||
    !new Set(["error", "warning", "info"]).has(identity.effectiveSeverity) ||
    !new Set(["error", "warning", "info"]).has(identity.severity)
  )
    throw new Error("scan diagnostic public identity is invalid");
  return Object.freeze({
    diagnosticFingerprint: computeCalibrationDiagnosticFingerprint(identity),
    ...identity,
  });
}

/**
 * Project one already validated native I05 output into a commit-safe identity list and a separate
 * private review payload. The private payload intentionally retains diagnostic explanations but no
 * source bytes; callers must keep it and its disposable checkout outside the repository.
 */
export function projectCalibrationScan(repositoryId, output, defaultSeverityByRule) {
  if (!/^[1-9][0-9]{0,19}$/.test(repositoryId)) throw new Error("repository ID is invalid");
  if (!(defaultSeverityByRule instanceof Map) || defaultSeverityByRule.size !== 69)
    throw new Error("capture requires the exact 69-rule packaged default-severity registry");
  const snapshot = snapshotJson(output);
  validateNativeOutputRelations(snapshot);
  if (!plainRecord(snapshot) || own(snapshot, "recordKind") !== "agent-context-scan-output")
    throw new Error("capture requires native scan JSON output");
  exactKeys(snapshot, ROOT_KEYS, "native scan output");
  if (
    typeof own(snapshot, "schemaVersion") !== "string" ||
    !new Set(["error", "never", "warning"]).has(own(snapshot, "failureThreshold")) ||
    !plainRecord(own(snapshot, "profileVersions"))
  )
    throw new Error("native scan output metadata is invalid");
  const bundle = own(snapshot, "diagnostics");
  const summary = own(snapshot, "summary");
  if (
    !plainRecord(bundle) ||
    own(bundle, "recordKind") !== "agent-context-diagnostics" ||
    !plainRecord(summary)
  )
    throw new Error("native scan output has an invalid diagnostic bundle or summary");
  exactKeys(bundle, BUNDLE_KEYS, "native diagnostic bundle");
  exactKeys(summary, SUMMARY_KEYS, "native scan summary");
  for (const key of SUMMARY_KEYS)
    if (!Number.isSafeInteger(own(summary, key)) || own(summary, key) < 0)
      throw new Error("native scan summary counts are invalid");
  const diagnostics = own(bundle, "diagnostics");
  if (!Array.isArray(diagnostics) || diagnostics.length > 100_000)
    throw new Error("scan diagnostic list is invalid");
  const suppressed = visiblePathFingerprints(bundle);
  const publicDiagnostics = [];
  const privateDiagnostics = [];
  for (const diagnostic of diagnostics) {
    if (!plainRecord(diagnostic)) throw new Error("scan diagnostic is invalid");
    exactKeys(diagnostic, DIAGNOSTIC_KEYS, "scan diagnostic");
    const projected = publicDiagnostic(repositoryId, diagnostic, defaultSeverityByRule);
    if (projected.severity === "info") continue;
    if (suppressed.has(projected.pathFingerprint)) continue;
    publicDiagnostics.push(projected);
    privateDiagnostics.push(
      Object.freeze({
        ...projected,
        diagnostic,
      }),
    );
  }
  return Object.freeze({
    privateDiagnostics: Object.freeze(privateDiagnostics),
    publicDiagnostics: Object.freeze(publicDiagnostics),
  });
}

function normalizeCheckout(checkout) {
  if (checkout === null || typeof checkout !== "object")
    return { budget: null, inventorySha256: null, quota: null, root: checkout ?? null };
  return {
    budget: checkout.budget,
    inventorySha256: checkout.inventorySha256,
    quota: checkout.quota ?? null,
    root: checkout.root,
  };
}

function finishCapturedCalibrationReport({
  corpus,
  diagnostics,
  engine,
  generatedAt,
  repositories,
}) {
  diagnostics.sort((left, right) =>
    compareUtf8(
      `${left.repositoryId}\u0000${left.ruleId}\u0000${left.diagnosticFingerprint}`,
      `${right.repositoryId}\u0000${right.ruleId}\u0000${right.diagnosticFingerprint}`,
    ),
  );
  const privatePayload = {
    recordKind: "agent-context-private-metadata-calibration-review-payload",
    repositories: repositories.map((repository) => ({
      checkout: {
        budget: repository.checkout.budget,
        inventorySha256: repository.checkout.inventorySha256,
        quota: repository.checkout.quota ?? null,
        root: repository.checkout.root,
      },
      diagnostics: repository.diagnostics,
      fullName: repository.fullName,
      repositoryId: repository.repositoryId,
    })),
  };
  const privatePayloadSha256 = sha256Canonical(privatePayload);
  const report = {
    contractVersion: CONTRACT_VERSION,
    corpusSha256: sha256Canonical(corpus),
    diagnostics,
    engine,
    engineVersion: engine.version,
    generatedAt,
    knowledgeVersion: engine.knowledgeVersion,
    privatePayloadSha256,
    recordKind: REPORT_KIND,
    sourcePolicy: { fingerprintOnly: true, repositoryContent: false, repositoryPaths: false },
  };
  const checked = validateCalibrationReport(report, corpus);
  if (!checked.valid) throw new Error(checked.errors.join("\n"));
  const privateReviewBundle = {
    mustNotCommit: true,
    privatePayloadSha256,
    recordKind: "agent-context-private-metadata-calibration-review-bundle",
    reportSha256: sha256Canonical(report),
    repositories,
  };
  if (
    Buffer.byteLength(JSON.stringify(report), "utf8") > MAXIMUM_CALIBRATION_ARTIFACT_BYTES ||
    Buffer.byteLength(JSON.stringify(privateReviewBundle), "utf8") >
      MAXIMUM_CALIBRATION_ARTIFACT_BYTES
  )
    throw new Error("captured calibration artifacts exceed the aligned 8 MiB review limit");
  return deepFreeze({ privateReviewBundle, report });
}

export function validatePrivateReviewBundle(report, bundle) {
  try {
    const exactKeys = (value, expected) =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      canonicalJson(Object.keys(value).sort(compareUtf8)) ===
        canonicalJson([...expected].sort(compareUtf8));
    if (
      !exactKeys(bundle, [
        "mustNotCommit",
        "privatePayloadSha256",
        "recordKind",
        "reportSha256",
        "repositories",
      ]) ||
      bundle?.recordKind !== "agent-context-private-metadata-calibration-review-bundle" ||
      bundle.mustNotCommit !== true ||
      bundle.reportSha256 !== sha256Canonical(report) ||
      !Array.isArray(bundle.repositories)
    )
      return Object.freeze({
        errors: Object.freeze(["private review bundle identity is invalid"]),
        valid: false,
      });
    for (const repository of bundle.repositories) {
      if (
        !exactKeys(repository, ["checkout", "diagnostics", "fullName", "repositoryId"]) ||
        !exactKeys(repository.checkout, ["budget", "inventorySha256", "quota", "root"])
      )
        return Object.freeze({
          errors: Object.freeze(["private review bundle contains unbound wrapper fields"]),
          valid: false,
        });
    }
    const privatePayload = {
      recordKind: "agent-context-private-metadata-calibration-review-payload",
      repositories: bundle.repositories.map((repository) => ({
        checkout: {
          budget: repository.checkout?.budget,
          inventorySha256: repository.checkout?.inventorySha256,
          quota: repository.checkout?.quota ?? null,
          root: repository.checkout?.root,
        },
        diagnostics: repository.diagnostics,
        fullName: repository.fullName,
        repositoryId: repository.repositoryId,
      })),
    };
    const digest = sha256Canonical(privatePayload);
    const privateDiagnostics = bundle.repositories
      .flatMap((repository) => repository.diagnostics)
      .map((entry) => {
        const publicDiagnostic = { ...entry };
        delete publicDiagnostic.diagnostic;
        return publicDiagnostic;
      })
      .sort((left, right) =>
        compareUtf8(
          `${left.repositoryId}\u0000${left.ruleId}\u0000${left.diagnosticFingerprint}`,
          `${right.repositoryId}\u0000${right.ruleId}\u0000${right.diagnosticFingerprint}`,
        ),
      );
    const valid =
      digest === report.privatePayloadSha256 &&
      digest === bundle.privatePayloadSha256 &&
      canonicalJson(privateDiagnostics) === canonicalJson(report.diagnostics);
    return Object.freeze({
      errors: Object.freeze(valid ? [] : ["private review payload differs from its public digest"]),
      valid,
    });
  } catch (error) {
    return Object.freeze({
      errors: Object.freeze([
        `private review bundle is malformed: ${error instanceof Error ? error.message : "unknown error"}`,
      ]),
      valid: false,
    });
  }
}

export function createCalibrationCaptureAccumulator({
  corpus,
  defaultSeverityByRule,
  engine,
  generatedAt,
  limits = {},
}) {
  const maximumDiagnostics = limits.maximumDiagnostics ?? MAXIMUM_CALIBRATION_DIAGNOSTICS;
  const maximumPrivateBytes = limits.maximumPrivateBytes ?? MAXIMUM_CALIBRATION_ARTIFACT_BYTES;
  const maximumPublicBytes = limits.maximumPublicBytes ?? MAXIMUM_CALIBRATION_ARTIFACT_BYTES;
  const diagnostics = [];
  const repositories = [];
  const expected = new Map(
    corpus.repositories.map((repository) => [repository.repositoryId, repository]),
  );
  const seen = new Set();
  let privateBytes = 0;
  let publicBytes = 0;
  return Object.freeze({
    add(repositoryId, output, checkout = null) {
      const repository = expected.get(repositoryId);
      if (repository === undefined || seen.has(repositoryId))
        throw new Error("capture repository is unknown or duplicated");
      const projected = projectCalibrationScan(repositoryId, output, defaultSeverityByRule);
      const nextPublicBytes = Buffer.byteLength(
        JSON.stringify(projected.publicDiagnostics),
        "utf8",
      );
      const nextPrivateRepository = {
        checkout: normalizeCheckout(checkout),
        diagnostics: projected.privateDiagnostics,
        fullName: repository.fullName,
        repositoryId,
      };
      const nextPrivateBytes = Buffer.byteLength(JSON.stringify(nextPrivateRepository), "utf8");
      if (
        diagnostics.length + projected.publicDiagnostics.length > maximumDiagnostics ||
        publicBytes + nextPublicBytes > maximumPublicBytes ||
        privateBytes + nextPrivateBytes > maximumPrivateBytes
      )
        throw new Error("aggregate calibration capture exceeds its diagnostic or byte budget");
      diagnostics.push(...projected.publicDiagnostics);
      repositories.push(nextPrivateRepository);
      publicBytes += nextPublicBytes;
      privateBytes += nextPrivateBytes;
      seen.add(repositoryId);
    },
    finish(completedAt = generatedAt) {
      if (seen.size !== expected.size)
        throw new Error(
          "capture must contain exactly one scan output for every selected repository",
        );
      return finishCapturedCalibrationReport({
        corpus,
        diagnostics,
        engine,
        generatedAt: completedAt,
        repositories,
      });
    },
    state() {
      return Object.freeze({
        diagnosticCount: diagnostics.length,
        privateBytes,
        publicBytes,
        repositoryCount: seen.size,
      });
    },
  });
}

export function createCapturedCalibrationReport({
  corpus,
  defaultSeverityByRule,
  engine,
  generatedAt,
  repositoryCheckouts = null,
  repositoryOutputs,
}) {
  if (!(repositoryOutputs instanceof Map) || repositoryOutputs.size !== corpus.repositories.length)
    throw new Error("capture must contain exactly one scan output for every selected repository");
  const capture = createCalibrationCaptureAccumulator({
    corpus,
    defaultSeverityByRule,
    engine,
    generatedAt,
  });
  for (const repository of corpus.repositories) {
    const output = repositoryOutputs.get(repository.repositoryId);
    if (output === undefined)
      throw new Error(`capture is missing selected repository ${repository.repositoryId}`);
    capture.add(
      repository.repositoryId,
      output,
      repositoryCheckouts?.get(repository.repositoryId) ?? null,
    );
  }
  return capture.finish();
}
