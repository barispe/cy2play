// ============================================================================
// Cy2Play — Core Type Definitions
// ============================================================================

// ---------------------------------------------------------------------------
// Conversion Options (CLI + Config)
// ---------------------------------------------------------------------------

/** The three conversion strategies */
export type ConversionMode = 'strict' | 'hybrid' | 'pure-ai';

/** LLM provider backends */
export type LLMProvider = 'openai' | 'anthropic' | 'local';

/** Severity level for warnings emitted during conversion */
export type WarningSeverity = 'info' | 'warning' | 'error';

/** Options resolved from CLI flags + cy2play.config.json */
export interface ConversionOptions {
  /** Conversion strategy to use */
  mode: ConversionMode;

  /** Input path — file or directory of Cypress tests */
  inputPath: string;

  /** Output directory for generated Playwright tests */
  outputDir: string;

  /** If true, don't write files — just report what would change */
  dryRun: boolean;

  /** Enable verbose/debug logging */
  debug: boolean;

  /** LLM configuration (only used in hybrid / pure-ai modes) */
  llm?: LLMConfig;

  /** User-defined custom command mappings, e.g. { "cy.dataCy": "page.getByTestId" } */
  customMappings?: Record<string, string>;
}

/** LLM connection configuration */
export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// LLM Client Interface (thin adapter — replaces LangChain)
// ---------------------------------------------------------------------------

/** Options passed to a single LLM completion call */
export interface LLMCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  /** Stop sequences */
  stop?: string[];
}

/**
 * Minimal interface that all LLM adapters must implement.
 * Adapters: OpenAIAdapter, AnthropicAdapter, OllamaAdapter
 */
export interface LLMClient {
  /**
   * Send a prompt and get a text completion back.
   * @param systemPrompt - System-level instructions for the LLM
   * @param userPrompt   - The user/code prompt to complete
   * @param options      - Optional generation parameters
   * @returns The raw text response from the LLM
   */
  complete(
    systemPrompt: string,
    userPrompt: string,
    options?: LLMCompletionOptions,
  ): Promise<string>;
}

// ---------------------------------------------------------------------------
// AST Transformation Results
// ---------------------------------------------------------------------------

/** A warning emitted during conversion (goes into the report) */
export interface Warning {
  /** The severity of this warning */
  severity: WarningSeverity;
  /** Human-readable message */
  message: string;
  /** Original source file path */
  filePath: string;
  /** Line number in the original file (1-based) */
  line: number;
  /** The original code snippet that triggered the warning */
  originalCode?: string;
}

/**
 * An AST node that the strict engine could not transform.
 * In hybrid mode these get sent to the LLM for resolution.
 */
export interface UnresolvedNode {
  /** Unique identifier for placeholder replacement */
  placeholderId: string;
  /** The original Cypress code block */
  originalCode: string;
  /** Surrounding context (e.g. preceding 5 lines) for LLM prompt */
  context: string;
  /** Line number in the original file (1-based) */
  line: number;
  /** Column in the original file (0-based) */
  column: number;
}

/**
 * The result of transforming a single file.
 * This is the core contract that flows between the AST engine and the LLM layer.
 */
export interface TransformResult {
  /** The generated Playwright code (may contain placeholders if unresolved) */
  code: string;

  /** Warnings emitted during conversion */
  warnings: Warning[];

  /** Nodes the strict engine couldn't handle — for hybrid LLM handoff */
  unresolvedNodes: UnresolvedNode[];

  /** Conversion statistics */
  stats: TransformStats;
}

/** Per-file conversion statistics */
export interface TransformStats {
  /** Number of AST nodes converted by strict rules */
  rulesApplied: number;
  /** Number of nodes resolved by AI */
  aiResolved: number;
  /** Number of nodes left for manual review */
  manualReview: number;
  /** Total Cypress commands found */
  totalCommands: number;
  /** Time taken in milliseconds */
  durationMs: number;
  /** Approximate token usage (if AI was used) */
  tokensUsed?: number;
}

// ---------------------------------------------------------------------------
// Transformer Interface
// ---------------------------------------------------------------------------

/**
 * Base interface for all transformers.
 * Concrete implementations: CypressTransformer (and potentially others in the future).
 */
export interface Transformer {
  /** Transform a single Cypress file into Playwright code */
  transform(sourceCode: string, filePath: string): Promise<TransformResult>;
}

// ---------------------------------------------------------------------------
// Configuration File Schema (cy2play.config.json)
// ---------------------------------------------------------------------------

/** Shape of the cy2play.config.json file */
export interface Cy2PlayConfig {
  mode?: ConversionMode;
  targetDir?: string;
  llm?: {
    provider?: LLMProvider;
    model?: string;
    apiKey?: string;
    temperature?: number;
  };
  localLlm?: {
    enabled?: boolean;
    baseUrl?: string;
    model?: string;
  };
  customMappings?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Summary report for an entire conversion run */
export interface MigrationReport {
  /** Timestamp of the conversion run */
  timestamp: string;
  /** Total files scanned */
  totalFiles: number;
  /** Files successfully converted */
  convertedFiles: number;
  /** Files that failed to parse or convert */
  failedFiles: number;
  /** Aggregated stats across all files */
  totalStats: TransformStats;
  /** All warnings across all files */
  warnings: Warning[];
  /** Per-file results */
  files: Array<{
    inputPath: string;
    outputPath: string;
    stats: TransformStats;
    warnings: Warning[];
  }>;
}
