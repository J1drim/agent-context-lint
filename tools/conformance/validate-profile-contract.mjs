#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_FORMAT_VERSION = "0.1.0";
export const MAP_CONTRACT_VERSION = "0.1.0";

const NON_DETERMINISTIC_STATES = new Set([
  "conditional",
  "model-selected",
  "unknown",
  "not-listed",
  "contradiction",
  "pending-observation",
  "blocked-paid-observation",
]);

const TOP_LEVEL_KEYS = new Set([
  "recordKind",
  "fixtureFormatVersion",
  "id",
  "title",
  "profile",
  "provenance",
  "repository",
  "externalContext",
  "invocation",
  "targets",
  "eventTrace",
  "expectedGraph",
  "assertions",
  "extensions",
]);

const NODE_KINDS = new Set([
  "document",
  "external-context",
  "target",
  "event",
  "content-occurrence",
]);

const EDGE_RELATIONS = new Set([
  "discovers",
  "selects",
  "shadows",
  "excludes",
  "deduplicates",
  "activates",
  "deactivates",
  "makes-eligible",
  "imports",
  "references",
  "blocks-boundary",
  "precedes",
  "injects",
  "truncates",
  "omits",
  "observes",
]);

const EVENT_KINDS = new Set([
  "launch",
  "reference-path",
  "read-path",
  "write-path",
  "list-directory",
  "manual-rule-mention",
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
]);

const DERIVATIONS = new Set([
  "official-example",
  "synthetic-edge-case",
  "observed-reproduction",
  "regression-minimization",
]);

const EXTERNAL_CONTEXT_MODES = new Set(["unavailable", "explicit-synthetic", "not-applicable"]);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value, location, errors) {
  if (!isObject(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  return true;
}

function requireArray(value, location, errors, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${location} must be an array`);
    return false;
  }
  if (nonEmpty && value.length === 0) {
    errors.push(`${location} must not be empty`);
    return false;
  }
  return true;
}

function requireString(value, location, errors, { nullable = false } = {}) {
  if (nullable && value === null) return true;
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${location} must be a non-empty string${nullable ? " or null" : ""}`);
    return false;
  }
  return true;
}

function requireId(value, location, errors) {
  if (!requireString(value, location, errors)) return false;
  if (!/^[a-z0-9][a-z0-9._/-]*$/.test(value)) {
    errors.push(`${location} must use lowercase stable-id characters`);
    return false;
  }
  return true;
}

function requireUniqueIds(items, location, errors) {
  const ids = new Set();
  for (const [index, item] of items.entries()) {
    if (!isObject(item)) continue;
    if (!requireId(item.id, `${location}[${index}].id`, errors)) continue;
    if (ids.has(item.id)) errors.push(`${location} contains duplicate id ${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

function requireEvidence(value, location, errors, evidenceStates) {
  if (!requireArray(value, location, errors, { nonEmpty: true })) return;
  for (const [index, state] of value.entries()) {
    if (!evidenceStates.has(state)) {
      errors.push(`${location}[${index}] is not a canonical evidence state: ${String(state)}`);
    }
  }
}

function isSafeRepoPath(value, { allowRoot = false, directory = false } = {}) {
  if (typeof value !== "string" || value === "") return false;
  if (allowRoot && value === ".") return true;
  if (value === "." || value.startsWith("/") || value.includes("\\") || value.includes("\0"))
    return false;
  const body = directory && value.endsWith("/") ? value.slice(0, -1) : value;
  if (directory && !value.endsWith("/")) return false;
  if (!directory && value.endsWith("/")) return false;
  const segments = body.split("/");
  return (
    segments.length > 0 &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function requireRepoPath(value, location, errors, options) {
  if (!isSafeRepoPath(value, options)) {
    errors.push(`${location} must be a canonical repository-relative POSIX path`);
  }
}

export function validateProfileMap(map) {
  const errors = [];
  if (!requireObject(map, "map", errors)) return errors;
  if (map.recordKind !== "profile-surface-map")
    errors.push("map.recordKind must be profile-surface-map");
  if (map.contractVersion !== MAP_CONTRACT_VERSION) {
    errors.push(`map.contractVersion must be ${MAP_CONTRACT_VERSION}`);
  }

  for (const key of [
    "evidenceStates",
    "supportStates",
    "researchRecords",
    "documentFormats",
    "profiles",
    "surfaces",
    "formatSupport",
  ]) {
    requireArray(map[key], `map.${key}`, errors, { nonEmpty: true });
  }
  if (errors.length > 0) return errors;

  const evidenceStates = new Set(map.evidenceStates);
  const supportStates = new Set(map.supportStates);
  const researchIds = requireUniqueIds(map.researchRecords, "map.researchRecords", errors);
  const formatIds = requireUniqueIds(map.documentFormats, "map.documentFormats", errors);
  const profileIds = requireUniqueIds(map.profiles, "map.profiles", errors);
  const surfaceIds = requireUniqueIds(map.surfaces, "map.surfaces", errors);

  for (const [index, record] of map.researchRecords.entries()) {
    if (!requireObject(record, `map.researchRecords[${index}]`, errors)) continue;
    requireRepoPath(record.path, `map.researchRecords[${index}].path`, errors);
    if (record.upstreamRevision === null) {
      requireString(
        record.mutableSourceReason,
        `map.researchRecords[${index}].mutableSourceReason`,
        errors,
      );
    } else {
      requireString(
        record.upstreamRevision,
        `map.researchRecords[${index}].upstreamRevision`,
        errors,
      );
    }
    if (
      requireArray(record.primarySources, `map.researchRecords[${index}].primarySources`, errors, {
        nonEmpty: true,
      })
    ) {
      for (const [sourceIndex, url] of record.primarySources.entries()) {
        if (typeof url !== "string" || !url.startsWith("https://")) {
          errors.push(
            `map.researchRecords[${index}].primarySources[${sourceIndex}] must be an absolute HTTPS URL`,
          );
        }
      }
    }
  }

  for (const [index, format] of map.documentFormats.entries()) {
    const at = `map.documentFormats[${index}]`;
    if (!requireObject(format, at, errors)) continue;
    requireString(format.syntaxFamily, `${at}.syntaxFamily`, errors);
    if (
      requireArray(format.canonicalLocationPatterns, `${at}.canonicalLocationPatterns`, errors, {
        nonEmpty: true,
      })
    ) {
      format.canonicalLocationPatterns.forEach((value, valueIndex) =>
        requireString(value, `${at}.canonicalLocationPatterns[${valueIndex}]`, errors),
      );
    }
    if (requireArray(format.defaultNames, `${at}.defaultNames`, errors)) {
      format.defaultNames.forEach((value, valueIndex) =>
        requireString(value, `${at}.defaultNames[${valueIndex}]`, errors),
      );
    }
    if (
      requireArray(format.parserResponsibilities, `${at}.parserResponsibilities`, errors, {
        nonEmpty: true,
      })
    ) {
      format.parserResponsibilities.forEach((value, valueIndex) =>
        requireString(value, `${at}.parserResponsibilities[${valueIndex}]`, errors),
      );
    }
    if (requireArray(format.researchRecords, `${at}.researchRecords`, errors, { nonEmpty: true })) {
      for (const id of format.researchRecords)
        if (!researchIds.has(id))
          errors.push(`${at}.researchRecords references unknown record ${id}`);
    }
  }

  for (const [index, profile] of map.profiles.entries()) {
    const at = `map.profiles[${index}]`;
    if (!requireObject(profile, at, errors)) continue;
    requireString(profile.product, `${at}.product`, errors);
    if (!["ga-required", "recognized-evidence-only"].includes(profile.releaseClass)) {
      errors.push(`${at}.releaseClass is invalid: ${String(profile.releaseClass)}`);
    }
    if (requireArray(profile.surfaceIds, `${at}.surfaceIds`, errors, { nonEmpty: true })) {
      for (const id of profile.surfaceIds)
        if (!surfaceIds.has(id)) errors.push(`${at}.surfaceIds references unknown surface ${id}`);
    }
  }

  for (const [index, surface] of map.surfaces.entries()) {
    const at = `map.surfaces[${index}]`;
    if (!requireObject(surface, at, errors)) continue;
    if (!profileIds.has(surface.profileId))
      errors.push(`${at}.profileId references unknown profile ${String(surface.profileId)}`);
    requireString(surface.kind, `${at}.kind`, errors);
    requireString(surface.version, `${at}.version`, errors, { nullable: true });
    requireString(surface.versionStatus, `${at}.versionStatus`, errors);
    if (
      requireArray(surface.defaultInstructionNames, `${at}.defaultInstructionNames`, errors, {
        nonEmpty: true,
      })
    ) {
      surface.defaultInstructionNames.forEach((value, valueIndex) =>
        requireString(value, `${at}.defaultInstructionNames[${valueIndex}]`, errors),
      );
    }
    if (
      requireArray(
        surface.configurableInstructionNames,
        `${at}.configurableInstructionNames`,
        errors,
      )
    ) {
      surface.configurableInstructionNames.forEach((value, valueIndex) =>
        requireString(value, `${at}.configurableInstructionNames[${valueIndex}]`, errors),
      );
    }
    requireString(surface.repositoryRootModel, `${at}.repositoryRootModel`, errors);
    if (requireObject(surface.rootMarkers, `${at}.rootMarkers`, errors)) {
      if (surface.rootMarkers.default !== null) {
        requireArray(surface.rootMarkers.default, `${at}.rootMarkers.default`, errors);
      }
      if (surface.rootMarkers.conditional !== undefined) {
        requireArray(surface.rootMarkers.conditional, `${at}.rootMarkers.conditional`, errors);
      }
      if (![true, false, null].includes(surface.rootMarkers.configurable)) {
        errors.push(`${at}.rootMarkers.configurable must be boolean or null`);
      }
      if (!evidenceStates.has(surface.rootMarkers.evidenceStatus)) {
        errors.push(
          `${at}.rootMarkers.evidenceStatus is not canonical: ${String(surface.rootMarkers.evidenceStatus)}`,
        );
      }
    }
    if (requireArray(surface.externalScopes, `${at}.externalScopes`, errors)) {
      surface.externalScopes.forEach((value, valueIndex) =>
        requireString(value, `${at}.externalScopes[${valueIndex}]`, errors),
      );
    }
    if (!evidenceStates.has(surface.externalScopeStatus)) {
      errors.push(
        `${at}.externalScopeStatus is not canonical: ${String(surface.externalScopeStatus)}`,
      );
    }
    if (
      requireArray(surface.researchRecords, `${at}.researchRecords`, errors, { nonEmpty: true })
    ) {
      for (const id of surface.researchRecords)
        if (!researchIds.has(id))
          errors.push(`${at}.researchRecords references unknown record ${id}`);
    }
  }

  const mappingKeys = new Set();
  for (const [index, support] of map.formatSupport.entries()) {
    const at = `map.formatSupport[${index}]`;
    if (!requireObject(support, at, errors)) continue;
    if (!surfaceIds.has(support.surfaceId))
      errors.push(`${at}.surfaceId references unknown surface ${String(support.surfaceId)}`);
    if (!formatIds.has(support.formatId))
      errors.push(`${at}.formatId references unknown format ${String(support.formatId)}`);
    const key = `${support.surfaceId}\0${support.formatId}`;
    if (mappingKeys.has(key))
      errors.push(
        `${at} duplicates surface/format mapping ${support.surfaceId} + ${support.formatId}`,
      );
    mappingKeys.add(key);
    if (!supportStates.has(support.supportStatus))
      errors.push(`${at}.supportStatus is not canonical: ${String(support.supportStatus)}`);
    if (
      requireArray(support.repositoryScopes, `${at}.repositoryScopes`, errors, { nonEmpty: true })
    ) {
      support.repositoryScopes.forEach((value, valueIndex) =>
        requireString(value, `${at}.repositoryScopes[${valueIndex}]`, errors),
      );
    }
    if (requireArray(support.userScopes, `${at}.userScopes`, errors)) {
      support.userScopes.forEach((value, valueIndex) =>
        requireString(value, `${at}.userScopes[${valueIndex}]`, errors),
      );
    }
    requireString(support.activation, `${at}.activation`, errors);
    requireEvidence(support.evidenceStatus, `${at}.evidenceStatus`, errors, evidenceStates);
  }

  for (const surfaceId of surfaceIds) {
    if (![...mappingKeys].some((key) => key.startsWith(`${surfaceId}\0`))) {
      errors.push(`map surface ${surfaceId} has no formatSupport entry`);
    }
  }

  return errors;
}

export function validateFixture(fixture, map) {
  const errors = [];
  const mapErrors = validateProfileMap(map);
  if (mapErrors.length > 0) return mapErrors.map((error) => `canonical map invalid: ${error}`);
  if (!requireObject(fixture, "fixture", errors)) return errors;

  for (const key of Object.keys(fixture)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`fixture contains unknown top-level field ${key}`);
  }
  if (fixture.recordKind !== "profile-conformance-fixture")
    errors.push("fixture.recordKind must be profile-conformance-fixture");
  if (fixture.fixtureFormatVersion !== FIXTURE_FORMAT_VERSION) {
    errors.push(`fixture.fixtureFormatVersion must be ${FIXTURE_FORMAT_VERSION}`);
  }
  requireId(fixture.id, "fixture.id", errors);
  requireString(fixture.title, "fixture.title", errors);

  const surfaces = new Map(map.surfaces.map((surface) => [surface.id, surface]));
  const profiles = new Set(map.profiles.map((profile) => profile.id));
  const formats = new Set(map.documentFormats.map((format) => format.id));
  const researchRecords = new Set(map.researchRecords.map((record) => record.id));
  const evidenceStates = new Set(map.evidenceStates);
  const supportPairs = new Set(
    map.formatSupport.map((entry) => `${entry.surfaceId}\0${entry.formatId}`),
  );

  let selectedSurface;
  if (requireObject(fixture.profile, "fixture.profile", errors)) {
    const profile = fixture.profile;
    if (!profiles.has(profile.profileId))
      errors.push(`fixture.profile.profileId is unknown: ${String(profile.profileId)}`);
    const surface = surfaces.get(profile.surfaceId);
    selectedSurface = surface;
    if (!surface) errors.push(`fixture.profile.surfaceId is unknown: ${String(profile.surfaceId)}`);
    else {
      if (surface.profileId !== profile.profileId)
        errors.push(
          `fixture profile/surface pair is invalid: ${profile.profileId} + ${profile.surfaceId}`,
        );
      if (!surface.researchRecords.includes(profile.specSnapshotId))
        errors.push(`fixture.profile.specSnapshotId is not mapped to surface ${surface.id}`);
      if (surface.version !== null && profile.clientVersion !== surface.version)
        errors.push(
          `fixture.profile.clientVersion must equal mapped surface version ${surface.version}`,
        );
    }
    requireString(profile.specSnapshotId, "fixture.profile.specSnapshotId", errors);
    requireString(profile.clientVersion, "fixture.profile.clientVersion", errors, {
      nullable: true,
    });
    requireString(profile.versionStatus, "fixture.profile.versionStatus", errors);
    if (profile.clientVersion === null && /hosted/.test(profile.versionStatus)) {
      requireString(profile.serviceObservedAt, "fixture.profile.serviceObservedAt", errors);
    }
  }

  if (requireObject(fixture.provenance, "fixture.provenance", errors)) {
    const provenance = fixture.provenance;
    if (
      requireArray(provenance.researchRecordIds, "fixture.provenance.researchRecordIds", errors, {
        nonEmpty: true,
      })
    ) {
      for (const id of provenance.researchRecordIds)
        if (!researchRecords.has(id))
          errors.push(`fixture.provenance references unknown research record ${id}`);
      if (
        selectedSurface &&
        !provenance.researchRecordIds.includes(fixture.profile.specSnapshotId)
      ) {
        errors.push(
          "fixture.provenance.researchRecordIds must include fixture.profile.specSnapshotId",
        );
      }
    }
    if (!DERIVATIONS.has(provenance.derivation))
      errors.push(`fixture.provenance.derivation is invalid: ${String(provenance.derivation)}`);
    requireArray(provenance.assumptions, "fixture.provenance.assumptions", errors);
    requireArray(provenance.observationIds, "fixture.provenance.observationIds", errors);
    if (
      requireArray(provenance.sources, "fixture.provenance.sources", errors, { nonEmpty: true })
    ) {
      requireUniqueIds(provenance.sources, "fixture.provenance.sources", errors);
      for (const [index, source] of provenance.sources.entries()) {
        const at = `fixture.provenance.sources[${index}]`;
        if (!isObject(source)) continue;
        if (typeof source.url !== "string" || !source.url.startsWith("https://"))
          errors.push(`${at}.url must be an absolute HTTPS URL`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(source.retrievedAt ?? ""))
          errors.push(`${at}.retrievedAt must be YYYY-MM-DD`);
        if (
          !["immutable-revision", "retrieved-living-doc", "observation-artifact"].includes(
            source.immutability,
          )
        ) {
          errors.push(`${at}.immutability is invalid`);
        } else if (source.immutability === "immutable-revision") {
          requireString(source.revision, `${at}.revision`, errors);
        } else if (source.immutability === "retrieved-living-doc") {
          requireString(source.mutableSourceReason, `${at}.mutableSourceReason`, errors);
        } else {
          requireRepoPath(source.artifactPath, `${at}.artifactPath`, errors);
        }
      }
    }
  }

  if (requireObject(fixture.repository, "fixture.repository", errors)) {
    const repository = fixture.repository;
    requireRepoPath(repository.root, "fixture.repository.root", errors, { allowRoot: true });
    if (requireArray(repository.directories, "fixture.repository.directories", errors)) {
      for (const [index, directory] of repository.directories.entries())
        requireRepoPath(directory, `fixture.repository.directories[${index}]`, errors, {
          directory: true,
        });
    }
    if (requireArray(repository.files, "fixture.repository.files", errors)) {
      for (const [index, file] of repository.files.entries()) {
        const at = `fixture.repository.files[${index}]`;
        if (!requireObject(file, at, errors)) continue;
        requireRepoPath(file.path, `${at}.path`, errors);
        if (file.formatId !== null && !formats.has(file.formatId))
          errors.push(
            `${at}.formatId must be null or a canonical format: ${String(file.formatId)}`,
          );
        if (
          file.formatId !== null &&
          fixture.profile?.surfaceId &&
          !supportPairs.has(`${fixture.profile.surfaceId}\0${file.formatId}`)
        ) {
          errors.push(`${at}.formatId is not mapped to surface ${fixture.profile.surfaceId}`);
        }
        if (typeof file.content !== "string")
          errors.push(`${at}.content must be a UTF-8 string; empty content is valid`);
      }
    }
    if (requireArray(repository.symlinks, "fixture.repository.symlinks", errors)) {
      for (const [index, link] of repository.symlinks.entries()) {
        const at = `fixture.repository.symlinks[${index}]`;
        if (!requireObject(link, at, errors)) continue;
        requireRepoPath(link.path, `${at}.path`, errors);
        requireString(link.target, `${at}.target`, errors);
      }
    }
  }

  if (requireObject(fixture.externalContext, "fixture.externalContext", errors)) {
    if (!EXTERNAL_CONTEXT_MODES.has(fixture.externalContext.mode))
      errors.push(
        `fixture.externalContext.mode is invalid: ${String(fixture.externalContext.mode)}`,
      );
    requireArray(fixture.externalContext.entries, "fixture.externalContext.entries", errors);
    if (
      fixture.externalContext.mode !== "explicit-synthetic" &&
      fixture.externalContext.entries?.length > 0
    ) {
      errors.push(
        "fixture.externalContext.entries must be empty unless mode is explicit-synthetic",
      );
    }
  }

  if (requireObject(fixture.invocation, "fixture.invocation", errors)) {
    requireRepoPath(fixture.invocation.launchCwd, "fixture.invocation.launchCwd", errors, {
      allowRoot: true,
    });
    if (
      requireArray(fixture.invocation.workspaceRoots, "fixture.invocation.workspaceRoots", errors, {
        nonEmpty: true,
      })
    ) {
      for (const [index, root] of fixture.invocation.workspaceRoots.entries())
        requireRepoPath(root, `fixture.invocation.workspaceRoots[${index}]`, errors, {
          allowRoot: true,
        });
    }
    requireObject(fixture.invocation.settings, "fixture.invocation.settings", errors);
    requireString(fixture.invocation.trustState, "fixture.invocation.trustState", errors);
    requireObject(fixture.invocation.branchState, "fixture.invocation.branchState", errors);
    requireString(fixture.invocation.runtimeMode, "fixture.invocation.runtimeMode", errors);
  }

  let targetIds = new Set();
  if (requireArray(fixture.targets, "fixture.targets", errors, { nonEmpty: true })) {
    targetIds = requireUniqueIds(fixture.targets, "fixture.targets", errors);
    for (const [index, target] of fixture.targets.entries()) {
      if (!isObject(target)) continue;
      requireRepoPath(target.path, `fixture.targets[${index}].path`, errors);
      requireString(target.purpose, `fixture.targets[${index}].purpose`, errors);
    }
  }

  let eventIds = new Set();
  if (requireArray(fixture.eventTrace, "fixture.eventTrace", errors, { nonEmpty: true })) {
    eventIds = requireUniqueIds(fixture.eventTrace, "fixture.eventTrace", errors);
    for (const [index, event] of fixture.eventTrace.entries()) {
      const at = `fixture.eventTrace[${index}]`;
      if (!isObject(event)) continue;
      if (event.sequence !== index)
        errors.push(`${at}.sequence must equal its zero-based array position`);
      if (!EVENT_KINDS.has(event.kind)) errors.push(`${at}.kind is invalid: ${String(event.kind)}`);
      if (event.path !== undefined)
        requireRepoPath(event.path, `${at}.path`, errors, { allowRoot: true });
      if (event.targetId !== undefined && !targetIds.has(event.targetId))
        errors.push(`${at}.targetId references unknown target ${event.targetId}`);
    }
  }

  const ambiguityIds = new Set();
  const nodeIds = new Set();
  if (requireObject(fixture.expectedGraph, "fixture.expectedGraph", errors)) {
    const graph = fixture.expectedGraph;
    if (!["complete", "partial", "unknown"].includes(graph.analysisStatus)) {
      errors.push(
        `fixture.expectedGraph.analysisStatus is invalid: ${String(graph.analysisStatus)}`,
      );
    }
    if (requireArray(graph.ambiguities, "fixture.expectedGraph.ambiguities", errors)) {
      for (const [index, ambiguity] of graph.ambiguities.entries()) {
        const at = `fixture.expectedGraph.ambiguities[${index}]`;
        if (!requireObject(ambiguity, at, errors)) continue;
        if (requireId(ambiguity.id, `${at}.id`, errors)) {
          if (ambiguityIds.has(ambiguity.id))
            errors.push(`fixture.expectedGraph.ambiguities contains duplicate id ${ambiguity.id}`);
          ambiguityIds.add(ambiguity.id);
        }
        requireString(ambiguity.kind, `${at}.kind`, errors);
        requireString(ambiguity.reason, `${at}.reason`, errors);
        requireArray(ambiguity.evidenceRefs, `${at}.evidenceRefs`, errors, { nonEmpty: true });
        if (
          requireArray(ambiguity.alternatives, `${at}.alternatives`, errors, { nonEmpty: true })
        ) {
          if (ambiguity.alternatives.length < 2)
            errors.push(`${at}.alternatives must contain at least two alternatives`);
          requireUniqueIds(ambiguity.alternatives, `${at}.alternatives`, errors);
          for (const [altIndex, alternative] of ambiguity.alternatives.entries()) {
            if (isObject(alternative))
              requireString(
                alternative.description,
                `${at}.alternatives[${altIndex}].description`,
                errors,
              );
          }
        }
      }
    }
    if (graph.analysisStatus === "complete" && graph.ambiguities?.length > 0) {
      errors.push(
        "fixture.expectedGraph.analysisStatus cannot be complete when ambiguities are present",
      );
    }

    if (requireArray(graph.nodes, "fixture.expectedGraph.nodes", errors, { nonEmpty: true })) {
      nodeIds.clear();
      for (const [index, node] of graph.nodes.entries()) {
        const at = `fixture.expectedGraph.nodes[${index}]`;
        if (!requireObject(node, at, errors)) continue;
        if (requireId(node.id, `${at}.id`, errors)) {
          if (nodeIds.has(node.id))
            errors.push(`fixture.expectedGraph.nodes contains duplicate id ${node.id}`);
          nodeIds.add(node.id);
        }
        if (!NODE_KINDS.has(node.kind)) errors.push(`${at}.kind is invalid: ${String(node.kind)}`);
        if (!evidenceStates.has(node.resolutionStatus))
          errors.push(`${at}.resolutionStatus is invalid: ${String(node.resolutionStatus)}`);
        requireArray(node.evidenceRefs, `${at}.evidenceRefs`, errors, { nonEmpty: true });
        if (node.path !== undefined) requireRepoPath(node.path, `${at}.path`, errors);
        if (node.formatId !== undefined) {
          if (!formats.has(node.formatId))
            errors.push(`${at}.formatId is unknown: ${String(node.formatId)}`);
          if (
            fixture.profile?.surfaceId &&
            !supportPairs.has(`${fixture.profile.surfaceId}\0${node.formatId}`)
          )
            errors.push(`${at}.formatId is not mapped to surface ${fixture.profile.surfaceId}`);
        }
        if (node.eventId !== undefined && !eventIds.has(node.eventId))
          errors.push(`${at}.eventId references unknown event ${node.eventId}`);
      }
    }

    if (requireArray(graph.edges, "fixture.expectedGraph.edges", errors)) {
      requireUniqueIds(graph.edges, "fixture.expectedGraph.edges", errors);
      for (const [index, edge] of graph.edges.entries()) {
        const at = `fixture.expectedGraph.edges[${index}]`;
        if (!isObject(edge)) continue;
        if (!nodeIds.has(edge.from))
          errors.push(`${at}.from references unknown node ${String(edge.from)}`);
        if (!nodeIds.has(edge.to))
          errors.push(`${at}.to references unknown node ${String(edge.to)}`);
        if (!EDGE_RELATIONS.has(edge.relation))
          errors.push(`${at}.relation is invalid: ${String(edge.relation)}`);
        if (!evidenceStates.has(edge.resolutionStatus))
          errors.push(`${at}.resolutionStatus is invalid: ${String(edge.resolutionStatus)}`);
        requireArray(edge.evidenceRefs, `${at}.evidenceRefs`, errors, { nonEmpty: true });
      }
    }
  }

  const ambiguityReferences = new Set();
  function validateAmbiguityReference(item, at) {
    if (!isObject(item)) return;
    if (NON_DETERMINISTIC_STATES.has(item.resolutionStatus ?? item.evidenceStatus)) {
      if (!requireString(item.ambiguityId, `${at}.ambiguityId`, errors)) return;
      if (!ambiguityIds.has(item.ambiguityId))
        errors.push(`${at}.ambiguityId references unknown ambiguity ${item.ambiguityId}`);
      else ambiguityReferences.add(item.ambiguityId);
    } else if (item.ambiguityId !== undefined) {
      if (!ambiguityIds.has(item.ambiguityId))
        errors.push(`${at}.ambiguityId references unknown ambiguity ${item.ambiguityId}`);
      else ambiguityReferences.add(item.ambiguityId);
    }
  }

  fixture.expectedGraph?.nodes?.forEach((node, index) =>
    validateAmbiguityReference(node, `fixture.expectedGraph.nodes[${index}]`),
  );
  fixture.expectedGraph?.edges?.forEach((edge, index) =>
    validateAmbiguityReference(edge, `fixture.expectedGraph.edges[${index}]`),
  );

  if (requireArray(fixture.assertions, "fixture.assertions", errors, { nonEmpty: true })) {
    requireUniqueIds(fixture.assertions, "fixture.assertions", errors);
    for (const [index, assertion] of fixture.assertions.entries()) {
      const at = `fixture.assertions[${index}]`;
      if (!requireObject(assertion, at, errors)) continue;
      requireString(assertion.predicate, `${at}.predicate`, errors);
      if (!evidenceStates.has(assertion.evidenceStatus))
        errors.push(`${at}.evidenceStatus is invalid: ${String(assertion.evidenceStatus)}`);
      requireArray(assertion.evidenceRefs, `${at}.evidenceRefs`, errors, { nonEmpty: true });
      if (!Object.hasOwn(assertion, "expected")) errors.push(`${at}.expected is required`);
      validateAmbiguityReference(assertion, at);
    }
  }

  for (const ambiguityId of ambiguityIds) {
    if (!ambiguityReferences.has(ambiguityId))
      errors.push(
        `fixture ambiguity ${ambiguityId} is not referenced by any non-deterministic result`,
      );
  }

  return errors;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${filePath}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const [, , mapPath, ...fixturePaths] = process.argv;
  if (!mapPath || fixturePaths.length === 0) {
    console.error("usage: validate-profile-contract.mjs MAP.json FIXTURE.json [FIXTURE.json ...]");
    process.exitCode = 2;
  } else {
    try {
      const map = readJson(mapPath);
      const mapErrors = validateProfileMap(map);
      if (mapErrors.length > 0) {
        for (const error of mapErrors) console.error(`${mapPath}: ${error}`);
        process.exitCode = 1;
      } else {
        let failed = false;
        for (const fixturePath of fixturePaths) {
          const errors = validateFixture(readJson(fixturePath), map);
          if (errors.length > 0) {
            failed = true;
            for (const error of errors) console.error(`${fixturePath}: ${error}`);
          } else {
            console.log(`valid ${fixturePath}`);
          }
        }
        if (failed) process.exitCode = 1;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
