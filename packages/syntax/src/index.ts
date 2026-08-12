/** Internal workspace marker; this package is not a public consumer API. */
export const packageId = "@agent-context/syntax" as const;

/** Parse one explicit repository configuration source. */
export { parseAgentContextConfiguration } from "./configuration-parser.js";
export type { ParseAgentContextConfigurationOptions } from "./configuration-parser.js";

export {
  doesIssuedConfigurationResolutionMatchRepository,
  isIssuedConfigurationResolutionSuccess,
  resolveAgentContextConfiguration,
} from "./configuration-resolution.js";
export type {
  ConfigurationLayerKind,
  ConfigurationResolutionIssue,
  ConfigurationResolutionIssueCode,
  ConfigurationResolutionResult,
  ConfigurationResolutionSource,
  ConfigurationResolutionSuccess,
  ResolveAgentContextConfigurationOptions,
} from "./configuration-resolution.js";

export {
  DEFAULT_FRONTMATTER_LIMITS,
  FRONTMATTER_DIALECTS,
  FRONTMATTER_PARSER_CONTRACT_VERSION,
  FrontmatterParserError,
  parseFrontmatter,
} from "./frontmatter-parser.js";
export type {
  FrontmatterDialect,
  FrontmatterIssue,
  FrontmatterIssueCode,
  FrontmatterLocation,
  FrontmatterParseResult,
  FrontmatterParseState,
  FrontmatterParserErrorCode,
  FrontmatterParserInput,
  FrontmatterParserOptions,
  FrontmatterScopeAuthority,
} from "./frontmatter-parser.js";

export {
  COPILOT_INSTRUCTION_FORMATS,
  COPILOT_INSTRUCTION_SYNTAX_CONTRACT_VERSION,
  CopilotInstructionSyntaxError,
  CopilotInstructionSyntaxErrorCode,
  parseCopilotInstructionSyntax,
} from "./copilot-instructions.js";

export {
  CLAUDE_INSTRUCTION_FORMATS,
  CLAUDE_INSTRUCTION_MAX_BYTES,
  CLAUDE_INSTRUCTION_SYNTAX_CONTRACT_VERSION,
  ClaudeInstructionSyntaxError,
  ClaudeInstructionSyntaxErrorCode,
  parseClaudeInstructionSyntax,
} from "./claude-instructions.js";
export type {
  ClaudeInstructionFormat,
  ClaudeInstructionSyntaxErrorCode as ClaudeInstructionSyntaxErrorCodeType,
  ClaudeInstructionSyntaxInput,
  ClaudeInstructionSyntaxIssue,
  ClaudeInstructionSyntaxIssueCode,
  ClaudeInstructionSyntaxResult,
  ClaudePathsField,
} from "./claude-instructions.js";

export {
  CURSOR_RULE_FORMATS,
  CURSOR_RULE_SYNTAX_CONTRACT_VERSION,
  CURSOR_RULE_SYNTAX_LIMITS,
  CursorRuleSyntaxError,
  CursorRuleSyntaxErrorCode,
  parseCursorRuleSyntax,
} from "./cursor-rules.js";
export type {
  CursorGlobPattern,
  CursorGlobValue,
  CursorRuleField,
  CursorRuleFieldState,
  CursorRuleFormat,
  CursorRuleModeClassification,
  CursorRuleModeState,
  CursorRuleModeSyntax,
  CursorRuleSourceLocation,
  CursorRuleSyntaxErrorCode as CursorRuleSyntaxErrorCodeType,
  CursorRuleSyntaxInput,
  CursorRuleSyntaxIssue,
  CursorRuleSyntaxIssueCode,
  CursorRuleSyntaxResult,
} from "./cursor-rules.js";
export type {
  CopilotExcludedAgent,
  CopilotInstructionField,
  CopilotInstructionFormat,
  CopilotInstructionSyntaxErrorCode as CopilotInstructionSyntaxErrorCodeType,
  CopilotInstructionSyntaxInput,
  CopilotInstructionSyntaxIssue,
  CopilotInstructionSyntaxIssueCode,
  CopilotInstructionSyntaxResult,
} from "./copilot-instructions.js";

export {
  DEFAULT_IMPORT_LEXER_LIMITS,
  IMPORT_DIALECTS,
  IMPORT_LEXER_CONTRACT_VERSION,
  ImportLexerError,
  lexImportReferences,
} from "./import-lexer.js";
export type {
  ImportDialect,
  ImportLexerErrorCode,
  ImportLexerInput,
  ImportLexerOptions,
  ImportLexerResult,
} from "./import-lexer.js";

export {
  DEFAULT_SUPPRESSION_LIMITS,
  SUPPRESSION_DIRECTIVE_SYNTAX,
  SUPPRESSION_PROCESSOR_RESOURCE_LIMITS,
  SuppressionProcessorError,
  matchSuppressionDirectives,
  parseSuppressionDirectives,
} from "./suppression.js";

export {
  AGENTS_MARKDOWN_CONTRACT_VERSION,
  AGENTS_MARKDOWN_FORMAT_ID,
  AGENTS_MARKDOWN_MAX_BYTES,
  AGENTS_MARKDOWN_MAX_PATH_BYTES,
  AgentsMarkdownError,
  AgentsMarkdownErrorCode,
  parseAgentsMarkdown,
} from "./agents-markdown.js";

export {
  GEMINI_CONTEXT_CONTRACT_VERSION,
  GEMINI_CONTEXT_FORMAT_ID,
  GEMINI_CONTEXT_MAX_BYTES,
  GEMINI_CONTEXT_MAX_PATH_BYTES,
  parseGeminiContext,
} from "./gemini-context.js";
export type { GeminiContextParseResult, ParseGeminiContextInput } from "./gemini-context.js";

export {
  GEMINI_SETTINGS_CONTRACT_VERSION,
  GEMINI_SETTINGS_DEFAULTS,
  GEMINI_SETTINGS_LIMITS,
  GeminiSettingsError,
  mergeGeminiSettingsLayers,
  parseGeminiSettings,
} from "./gemini-settings.js";
export type {
  GeminiImportFormat,
  GeminiSettingsIssue,
  GeminiSettingsIssueCode,
  GeminiSettingsLayerInput,
  GeminiSettingsLayerKind,
  GeminiSettingsMergeResult,
  GeminiSettingsParseResult,
  GeminiSettingsValues,
  ParseGeminiSettingsInput,
} from "./gemini-settings.js";
export type {
  AgentsMarkdownContentStatus,
  AgentsMarkdownErrorCode as AgentsMarkdownErrorCodeType,
  AgentsMarkdownIssue,
  AgentsMarkdownIssueCode,
  AgentsMarkdownParseResult,
  ParseAgentsMarkdownInput,
} from "./agents-markdown.js";
export type {
  ParsedSuppressionDirective,
  SuppressedDiagnostic,
  SuppressionDirectiveIssue,
  SuppressionDirectiveIssueCode,
  SuppressionMatchResult,
  SuppressionOptions,
  SuppressionParseResult,
  SuppressionProcessorErrorCode,
} from "./suppression.js";
