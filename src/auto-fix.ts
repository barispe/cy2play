// ============================================================================
// Cy2Play — Auto-Fix Loop
// ============================================================================
//
// Runs a generated Playwright test file, captures any errors, and feeds them
// back to the LLM for self-healing. Repeats up to maxRetries times.
//
// Usage: called from the CLI when --auto-fix is passed after conversion.
// ============================================================================

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { LLMClient } from './types';
import { SYSTEM_PROMPT, extractCodeBlock } from './ai/prompts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoFixOptions {
  /** The generated Playwright test file path */
  testFile: string;
  /** LLM client for sending fix requests */
  client: LLMClient;
  /** Maximum number of fix attempts (default: 3) */
  maxRetries?: number;
  /** Enable debug logging */
  debug?: boolean;
  /** Working directory for running playwright (defaults to testFile's parent) */
  cwd?: string;
}

export interface AutoFixResult {
  /** Whether the test ultimately passed */
  success: boolean;
  /** Number of fix attempts made */
  attempts: number;
  /** The final code (fixed or last attempt) */
  finalCode: string;
  /** Error messages from each failed attempt */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Auto-Fix Prompt
// ---------------------------------------------------------------------------

const AUTO_FIX_PROMPT = `You are fixing a Playwright test that has a compilation or runtime error.

You are given:
1. The current Playwright test code
2. The error message from running the test

Your task:
- Analyze the error message carefully
- Fix the test code to resolve the error
- Return ONLY the complete fixed test file inside a single TypeScript code block
- Do NOT change the test logic or intent — only fix the error
- If the error is about a missing import, add the import
- If the error is about a wrong selector, fix the selector
- If the error is about async/await, fix the async/await usage
- Preserve all existing tests and assertions`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a generated Playwright test file and attempt to auto-fix errors via LLM.
 *
 * Flow:
 *   1. Run `npx playwright test <file>` 
 *   2. If it passes → done
 *   3. If it fails → send code + error to LLM → apply fix → retry
 *   4. Repeat up to maxRetries times
 */
export async function autoFix(options: AutoFixOptions): Promise<AutoFixResult> {
  const { testFile, client, debug = false } = options;
  const maxRetries = options.maxRetries ?? 3;
  const cwd = options.cwd ?? path.dirname(testFile);

  let currentCode = fs.readFileSync(testFile, 'utf-8');
  const errors: string[] = [];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (debug && attempt > 0) {
      console.log(`  [auto-fix] Attempt ${attempt}/${maxRetries}...`);
    }

    // --- Run the test ---
    const runResult = runPlaywrightTest(testFile, cwd);

    if (runResult.passed) {
      if (debug) console.log(`  [auto-fix] ✓ Test passed${attempt > 0 ? ` after ${attempt} fix(es)` : ''}.`);
      return {
        success: true,
        attempts: attempt,
        finalCode: currentCode,
        errors,
      };
    }

    // Test failed — if we've exhausted retries, stop
    if (attempt >= maxRetries) {
      if (debug) console.log(`  [auto-fix] ✗ Max retries (${maxRetries}) exhausted.`);
      errors.push(runResult.error);
      break;
    }

    errors.push(runResult.error);

    if (debug) {
      const truncated = runResult.error.length > 200
        ? runResult.error.slice(0, 200) + '...'
        : runResult.error;
      console.log(`  [auto-fix] Error: ${truncated}`);
      console.log(`  [auto-fix] Sending to LLM for fix...`);
    }

    // --- Send to LLM for fix ---
    try {
      const userPrompt = buildAutoFixPrompt(currentCode, runResult.error, testFile);
      const llmResponse = await client.complete(AUTO_FIX_PROMPT, userPrompt);
      const fixedCode = extractCodeBlock(llmResponse);

      if (fixedCode && fixedCode !== currentCode) {
        currentCode = fixedCode;
        fs.writeFileSync(testFile, currentCode, 'utf-8');

        if (debug) console.log(`  [auto-fix] Applied LLM fix, retrying...`);
      } else {
        if (debug) console.log(`  [auto-fix] LLM returned same or empty code — stopping.`);
        break;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (debug) console.log(`  [auto-fix] LLM error: ${msg}`);
      errors.push(`LLM fix error: ${msg}`);
      break;
    }
  }

  return {
    success: false,
    attempts: errors.length,
    finalCode: currentCode,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Playwright Test Runner
// ---------------------------------------------------------------------------

interface RunResult {
  passed: boolean;
  error: string;
  stdout: string;
}

/**
 * Run a single Playwright test file and capture the output.
 */
export function runPlaywrightTest(testFile: string, cwd: string): RunResult {
  try {
    const stdout = execSync(
      `npx playwright test "${testFile}" --reporter=line`,
      {
        cwd,
        encoding: 'utf-8',
        timeout: 60_000, // 60s timeout
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    return { passed: true, error: '', stdout };
  } catch (err: unknown) {
    // execSync throws on non-zero exit code
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const stderr = execErr.stderr ?? '';
    const stdout = execErr.stdout ?? '';
    const error = stderr || stdout || execErr.message || 'Unknown test failure';

    return { passed: false, error: truncateError(error), stdout };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the user prompt for the auto-fix LLM call.
 */
function buildAutoFixPrompt(
  code: string,
  error: string,
  filePath: string,
): string {
  return `## File: ${path.basename(filePath)}

### Current Code
\`\`\`typescript
${code}
\`\`\`

### Error Message
\`\`\`
${error}
\`\`\`

Please fix the code to resolve this error. Return the complete fixed file in a TypeScript code block.`;
}

/**
 * Truncate long error messages to keep the LLM prompt reasonable.
 */
function truncateError(error: string, maxLength: number = 2000): string {
  if (error.length <= maxLength) return error;
  return error.slice(0, maxLength) + '\n\n... [truncated]';
}
