// ============================================================================
// Cy2Play — Hybrid Orchestrator
// ============================================================================
//
// Combines the strict rule-based transformer with AI-powered resolution for
// complex/unresolved code patterns. This is the "best of both worlds" mode.
//
// Pipeline:
//   Pass 1 — Run strict transformer → get TransformResult with placeholders
//   Pass 2 — Collect UnresolvedNode[] from result
//   Pass 3 — Batch-send snippets to LLM for resolution
//   Pass 4 — String-replace placeholders with LLM responses
//   Final  — Run Prettier to normalize formatting
// ============================================================================

import { transformFile } from './transformer';
import { createLLMClient } from './ai/index';
import { pureAITransform } from './ai/pure-ai-strategy';
import { SnippetCache } from './ai/cache';
import { SYSTEM_PROMPT, buildSnippetPrompt, extractCodeBlock } from './ai/prompts';
import {
  ConversionOptions,
  LLMClient,
  TransformResult,
  TransformStats,
  Warning,
  UnresolvedNode,
} from './types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OrchestratorOptions {
  /** Resolved conversion options from CLI + config */
  options: ConversionOptions;
  /** Pre-created LLM client (optional — will be created from options.llm if missing) */
  client?: LLMClient;
  /** Shared snippet cache (optional) */
  cache?: SnippetCache;
}

/**
 * Run the appropriate conversion strategy based on the mode.
 *
 * - `strict`:  Rule-based only — no AI.
 * - `hybrid`:  Rule-based first, then AI for unresolved nodes.
 * - `pure-ai`: Entire file sent to AI.
 */
export async function orchestrate(
  sourceCode: string,
  filePath: string,
  orchOptions: OrchestratorOptions,
): Promise<TransformResult> {
  const { options } = orchOptions;

  switch (options.mode) {
    case 'strict':
      return transformFile(sourceCode, filePath);

    case 'pure-ai':
      return runPureAI(sourceCode, filePath, orchOptions);

    case 'hybrid':
      return runHybrid(sourceCode, filePath, orchOptions);

    default:
      throw new Error(`Unknown conversion mode: "${options.mode}"`);
  }
}

// ---------------------------------------------------------------------------
// Pure-AI Mode
// ---------------------------------------------------------------------------

async function runPureAI(
  sourceCode: string,
  filePath: string,
  orchOptions: OrchestratorOptions,
): Promise<TransformResult> {
  const client = getOrCreateClient(orchOptions);

  return pureAITransform(sourceCode, filePath, {
    client,
    cache: orchOptions.cache,
    model: orchOptions.options.llm?.model,
    debug: orchOptions.options.debug,
  });
}

// ---------------------------------------------------------------------------
// Hybrid Mode — the core 4-pass pipeline
// ---------------------------------------------------------------------------

async function runHybrid(
  sourceCode: string,
  filePath: string,
  orchOptions: OrchestratorOptions,
): Promise<TransformResult> {
  const startTime = Date.now();
  const debug = orchOptions.options.debug;

  // ── Pass 1: Strict transformation ──────────────────────────────────────
  if (debug) console.log(`  [hybrid] Pass 1: Running strict transformer on ${filePath}...`);

  const strictResult = transformFile(sourceCode, filePath);
  const allWarnings: Warning[] = [...strictResult.warnings];

  // If there are no unresolved nodes, we're done — no AI needed
  if (strictResult.unresolvedNodes.length === 0) {
    if (debug) console.log(`  [hybrid] No unresolved nodes — skipping AI pass.`);

    const formatted = await formatWithPrettier(strictResult.code, filePath, allWarnings);

    return {
      code: formatted,
      warnings: allWarnings,
      unresolvedNodes: [],
      stats: {
        ...strictResult.stats,
        durationMs: Date.now() - startTime,
      },
    };
  }

  // ── Pass 2: Collect unresolved nodes & insert placeholders ─────────────
  if (debug) {
    console.log(
      `  [hybrid] Pass 2: Found ${strictResult.unresolvedNodes.length} unresolved node(s). Inserting placeholders...`,
    );
  }

  // The strict transformer already outputs `// TODO: [cy2play] ...` comments
  // for complex commands. We need to replace those with unique placeholders
  // so we can swap in the AI-generated code later.
  let codeWithPlaceholders = strictResult.code;
  const placeholderMap = new Map<string, UnresolvedNode>();

  for (const node of strictResult.unresolvedNodes) {
    const placeholder = `// __CY2PLAY_PLACEHOLDER_${node.placeholderId}__`;

    // Replace the TODO comment + original code comment block with placeholder
    // The transformer emits two lines:
    //   // TODO: [cy2play] Manual review required — complex command(s) detected
    //   // <original code>
    const todoPattern = `// TODO: [cy2play] Manual review required — complex command(s) detected\n`;
    const originalCommentLine = `// ${node.originalCode}`;

    // Try to find and replace the TODO block
    const todoBlock = todoPattern + findIndentedLine(codeWithPlaceholders, originalCommentLine);

    if (codeWithPlaceholders.includes(originalCommentLine)) {
      // Replace the entire TODO + comment block with the placeholder
      codeWithPlaceholders = codeWithPlaceholders.replace(
        todoBlock,
        placeholder,
      );

      // If the block replacement didn't work (indentation mismatch), try just the comment
      if (!codeWithPlaceholders.includes(placeholder)) {
        codeWithPlaceholders = codeWithPlaceholders.replace(
          originalCommentLine,
          placeholder,
        );
      }
    } else {
      // Fallback: just append placeholder (shouldn't normally happen)
      codeWithPlaceholders += `\n${placeholder}`;
    }

    placeholderMap.set(node.placeholderId, node);
  }

  // ── Pass 3: Batch-resolve via LLM ─────────────────────────────────────
  if (debug) {
    console.log(
      `  [hybrid] Pass 3: Sending ${placeholderMap.size} snippet(s) to LLM for resolution...`,
    );
  }

  const client = getOrCreateClient(orchOptions);
  const cache = orchOptions.cache;
  let aiResolved = 0;

  const resolutions = new Map<string, string>();

  for (const [placeholderId, node] of placeholderMap) {
    // Check cache first
    if (cache) {
      const cached = cache.get(node.originalCode);
      if (cached) {
        if (debug) console.log(`  [hybrid]   Cache hit for placeholder ${placeholderId}`);
        resolutions.set(placeholderId, cached);
        aiResolved++;
        continue;
      }
    }

    // Build context: surrounding lines from the generated code
    const context = extractSurroundingContext(codeWithPlaceholders, placeholderId, 5);

    try {
      const userPrompt = buildSnippetPrompt(node.originalCode, context);
      const llmResponse = await client.complete(SYSTEM_PROMPT, userPrompt);
      const resolved = extractCodeBlock(llmResponse);

      if (resolved) {
        resolutions.set(placeholderId, resolved);
        aiResolved++;

        // Cache the result
        if (cache) {
          cache.set(node.originalCode, resolved, orchOptions.options.llm?.model);
        }

        if (debug) console.log(`  [hybrid]   ✓ Resolved placeholder ${placeholderId}`);
      } else {
        // LLM didn't return a code block — keep the TODO comment
        allWarnings.push({
          severity: 'warning',
          message: `AI could not resolve snippet at line ${node.line}. Keeping TODO comment.`,
          filePath,
          line: node.line,
          originalCode: node.originalCode,
        });

        resolutions.set(
          placeholderId,
          `// TODO: [cy2play] AI could not resolve this — manual review needed\n// ${node.originalCode}`,
        );

        if (debug) console.log(`  [hybrid]   ✗ Failed to resolve placeholder ${placeholderId}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      allWarnings.push({
        severity: 'error',
        message: `LLM error for snippet at line ${node.line}: ${msg}`,
        filePath,
        line: node.line,
        originalCode: node.originalCode,
      });

      resolutions.set(
        placeholderId,
        `// TODO: [cy2play] AI error — manual review needed\n// Error: ${msg}\n// ${node.originalCode}`,
      );
    }
  }

  // ── Pass 4: Replace placeholders with resolved code ───────────────────
  if (debug) console.log(`  [hybrid] Pass 4: Replacing placeholders with resolved code...`);

  let finalCode = codeWithPlaceholders;
  for (const [placeholderId, resolved] of resolutions) {
    const placeholder = `// __CY2PLAY_PLACEHOLDER_${placeholderId}__`;
    finalCode = finalCode.replace(placeholder, resolved);
  }

  // ── Final: Prettier formatting ────────────────────────────────────────
  const formatted = await formatWithPrettier(finalCode, filePath, allWarnings);

  const manualReviewRemaining = strictResult.stats.manualReview - aiResolved;

  const stats: TransformStats = {
    rulesApplied: strictResult.stats.rulesApplied,
    aiResolved,
    manualReview: manualReviewRemaining > 0 ? manualReviewRemaining : 0,
    totalCommands: strictResult.stats.totalCommands,
    durationMs: Date.now() - startTime,
  };

  return {
    code: formatted,
    warnings: allWarnings,
    unresolvedNodes: [], // all resolved (or have TODO comments)
    stats,
  };
}

// ---------------------------------------------------------------------------
// Prettier Formatting
// ---------------------------------------------------------------------------

/**
 * Format code with Prettier. Falls back to unformatted code on failure.
 */
async function formatWithPrettier(
  code: string,
  filePath: string,
  warnings: Warning[],
): Promise<string> {
  try {
    const prettier = await import('prettier');
    const formatted = await prettier.format(code, {
      parser: 'typescript',
      singleQuote: true,
      trailingComma: 'all',
      semi: true,
      printWidth: 100,
      tabWidth: 2,
    });
    return formatted;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push({
      severity: 'info',
      message: `Prettier formatting skipped: ${msg}`,
      filePath,
      line: 0,
    });
    return code;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get or create the LLM client from orchestrator options.
 */
function getOrCreateClient(orchOptions: OrchestratorOptions): LLMClient {
  if (orchOptions.client) return orchOptions.client;

  if (!orchOptions.options.llm) {
    throw new Error(
      'LLM configuration is required for hybrid/pure-ai modes.\n' +
      'Set --provider and configure your API key in .env or cy2play.config.json.',
    );
  }

  return createLLMClient(orchOptions.options.llm);
}

/**
 * Extract surrounding lines of context around a placeholder for the LLM prompt.
 */
function extractSurroundingContext(
  code: string,
  placeholderId: string,
  contextLines: number,
): string {
  const placeholder = `// __CY2PLAY_PLACEHOLDER_${placeholderId}__`;
  const lines = code.split('\n');
  const idx = lines.findIndex(l => l.includes(placeholder));

  if (idx === -1) return '';

  const start = Math.max(0, idx - contextLines);
  const end = Math.min(lines.length, idx + contextLines + 1);

  return lines.slice(start, end).join('\n');
}

/**
 * Find a line in the code, including its indentation.
 */
function findIndentedLine(code: string, line: string): string {
  const lines = code.split('\n');
  const found = lines.find(l => l.trim() === line.trim());
  return found ?? line;
}
