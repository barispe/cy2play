// ============================================================================
// Cy2Play — Pure-AI Conversion Strategy
// ============================================================================
//
// Sends the entire Cypress file to the LLM and asks it to produce the
// full Playwright equivalent. Used in `pure-ai` mode.
// ============================================================================

import { LLMClient, TransformResult, TransformStats, Warning } from '../types';
import { SYSTEM_PROMPT, buildFullFilePrompt, extractCodeBlock } from './prompts';
import { SnippetCache } from './cache';

export interface PureAIOptions {
  /** LLM client to use */
  client: LLMClient;
  /** Optional snippet cache */
  cache?: SnippetCache;
  /** Model name (for cache tagging) */
  model?: string;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Convert a full Cypress file using pure AI — no rule-based transformation.
 * Sends the entire file to the LLM and parses the code block from the response.
 */
export async function pureAITransform(
  sourceCode: string,
  filePath: string,
  options: PureAIOptions,
): Promise<TransformResult> {
  const startTime = Date.now();
  const warnings: Warning[] = [];

  // --- Check cache first ---
  if (options.cache) {
    const cached = options.cache.get(sourceCode);
    if (cached) {
      if (options.debug) {
        console.log(`  [ai] Cache hit for ${filePath}`);
      }

      return {
        code: cached,
        warnings: [],
        unresolvedNodes: [],
        stats: {
          rulesApplied: 0,
          aiResolved: 1,
          manualReview: 0,
          totalCommands: 0,
          durationMs: Date.now() - startTime,
        },
      };
    }
  }

  // --- Build prompt and call LLM ---
  const userPrompt = buildFullFilePrompt(sourceCode, filePath);

  if (options.debug) {
    console.log(`  [ai] Sending ${filePath} to LLM (${sourceCode.length} chars)...`);
  }

  let llmResponse: string;
  try {
    llmResponse = await options.client.complete(SYSTEM_PROMPT, userPrompt);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push({
      severity: 'error',
      message: `LLM request failed: ${msg}`,
      filePath,
      line: 0,
    });

    return {
      code: `// cy2play: AI conversion failed for this file.\n// Error: ${msg}\n// Falling back to original code:\n\n${sourceCode}`,
      warnings,
      unresolvedNodes: [],
      stats: {
        rulesApplied: 0,
        aiResolved: 0,
        manualReview: 1,
        totalCommands: 0,
        durationMs: Date.now() - startTime,
      },
    };
  }

  // --- Extract code from response ---
  const code = extractCodeBlock(llmResponse);

  if (!code) {
    warnings.push({
      severity: 'error',
      message: 'LLM response did not contain a valid code block. Returning raw response.',
      filePath,
      line: 0,
    });

    return {
      code: `// cy2play: Could not parse AI response. Raw output below:\n// ${llmResponse.replace(/\n/g, '\n// ')}`,
      warnings,
      unresolvedNodes: [],
      stats: {
        rulesApplied: 0,
        aiResolved: 0,
        manualReview: 1,
        totalCommands: 0,
        durationMs: Date.now() - startTime,
      },
    };
  }

  // --- Validate basic structure ---
  if (!code.includes("from '@playwright/test'") && !code.includes('from "@playwright/test"')) {
    warnings.push({
      severity: 'warning',
      message: 'AI output is missing the Playwright import statement. It was auto-added.',
      filePath,
      line: 0,
    });
  }

  // Ensure Playwright import is present
  const finalCode = code.includes("from '@playwright/test'") || code.includes('from "@playwright/test"')
    ? code
    : `import { test, expect } from '@playwright/test';\n\n${code}`;

  // --- Cache the result ---
  if (options.cache) {
    options.cache.set(sourceCode, finalCode, options.model);
  }

  const stats: TransformStats = {
    rulesApplied: 0,
    aiResolved: 1,
    manualReview: 0,
    totalCommands: 0,
    durationMs: Date.now() - startTime,
  };

  return {
    code: finalCode,
    warnings,
    unresolvedNodes: [],
    stats,
  };
}
