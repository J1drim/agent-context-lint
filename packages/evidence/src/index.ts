/** Internal workspace marker; this package is not a public consumer API. */
export const packageId = "@agent-context/evidence" as const;

export * from "./atomic-writer.js";
export * from "./read-only-filesystem.js";
export * from "./safe-fix-pipeline.js";
export * from "./repository-root.js";
export * from "./tracked-file-enumeration.js";
export * from "./ignore-engine.js";
export * from "./discovery-index.js";
export * from "./import-graph-loader.js";
export * from "./workspace-boundary-discovery.js";
export * from "./evidence-index.js";
export * from "./command-lexer.js";
export * from "./statement-classifier.js";
export * from "./duplication-index.js";
export * from "./changed-file-metadata.js";
