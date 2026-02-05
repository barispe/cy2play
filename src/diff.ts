// ============================================================================
// Cy2Play — Diff View
// ============================================================================
//
// Generates a side-by-side or unified diff of the original Cypress code
// vs the generated Playwright code, with colored output for the terminal.
// ============================================================================

import chalk from 'chalk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiffLine {
  type: 'unchanged' | 'added' | 'removed' | 'header';
  lineNumber?: { left?: number; right?: number };
  content: string;
}

export interface DiffResult {
  /** The structured diff lines */
  lines: DiffLine[];
  /** Number of lines added */
  additions: number;
  /** Number of lines removed */
  removals: number;
  /** Number of unchanged lines */
  unchanged: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a unified diff between the original Cypress code and the
 * generated Playwright code.
 */
export function computeDiff(
  originalCode: string,
  generatedCode: string,
  inputLabel: string = 'cypress (original)',
  outputLabel: string = 'playwright (generated)',
): DiffResult {
  const originalLines = originalCode.split('\n');
  const generatedLines = generatedCode.split('\n');

  const diffLines: DiffLine[] = [];
  let additions = 0;
  let removals = 0;
  let unchanged = 0;

  // File headers
  diffLines.push({ type: 'header', content: `--- ${inputLabel}` });
  diffLines.push({ type: 'header', content: `+++ ${outputLabel}` });

  // Simple LCS-based diff
  const lcs = computeLCS(originalLines, generatedLines);

  let oi = 0; // original index
  let gi = 0; // generated index
  let li = 0; // lcs index

  while (oi < originalLines.length || gi < generatedLines.length) {
    if (li < lcs.length && oi < originalLines.length && originalLines[oi] === lcs[li]
        && gi < generatedLines.length && generatedLines[gi] === lcs[li]) {
      // Unchanged line (in both and in LCS)
      diffLines.push({
        type: 'unchanged',
        lineNumber: { left: oi + 1, right: gi + 1 },
        content: originalLines[oi],
      });
      unchanged++;
      oi++;
      gi++;
      li++;
    } else if (oi < originalLines.length && (li >= lcs.length || originalLines[oi] !== lcs[li])) {
      // Removed line
      diffLines.push({
        type: 'removed',
        lineNumber: { left: oi + 1 },
        content: originalLines[oi],
      });
      removals++;
      oi++;
    } else if (gi < generatedLines.length && (li >= lcs.length || generatedLines[gi] !== lcs[li])) {
      // Added line
      diffLines.push({
        type: 'added',
        lineNumber: { right: gi + 1 },
        content: generatedLines[gi],
      });
      additions++;
      gi++;
    }
  }

  return { lines: diffLines, additions, removals, unchanged };
}

/**
 * Format a DiffResult as a colored terminal string (unified diff style).
 */
export function formatDiffForTerminal(diff: DiffResult): string {
  const output: string[] = [];

  // Summary line
  output.push(
    chalk.bold(`Diff: `) +
    chalk.green(`+${diff.additions} additions`) +
    chalk.gray(`, `) +
    chalk.red(`-${diff.removals} removals`) +
    chalk.gray(`, `) +
    chalk.gray(`${diff.unchanged} unchanged`),
  );
  output.push('');

  for (const line of diff.lines) {
    switch (line.type) {
      case 'header':
        output.push(chalk.bold(line.content));
        break;
      case 'unchanged':
        output.push(chalk.gray(`  ${line.content}`));
        break;
      case 'removed':
        output.push(chalk.red(`- ${line.content}`));
        break;
      case 'added':
        output.push(chalk.green(`+ ${line.content}`));
        break;
    }
  }

  return output.join('\n');
}

/**
 * Format a DiffResult as a plain-text string (no colors), useful for file output.
 */
export function formatDiffPlain(diff: DiffResult): string {
  const output: string[] = [];

  output.push(`Diff: +${diff.additions} additions, -${diff.removals} removals, ${diff.unchanged} unchanged`);
  output.push('');

  for (const line of diff.lines) {
    switch (line.type) {
      case 'header':
        output.push(line.content);
        break;
      case 'unchanged':
        output.push(`  ${line.content}`);
        break;
      case 'removed':
        output.push(`- ${line.content}`);
        break;
      case 'added':
        output.push(`+ ${line.content}`);
        break;
    }
  }

  return output.join('\n');
}

// ---------------------------------------------------------------------------
// LCS (Longest Common Subsequence) — for minimal diff
// ---------------------------------------------------------------------------

/**
 * Compute the Longest Common Subsequence of two string arrays.
 * Used to produce a minimal, readable diff.
 */
function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;

  // Build DP table
  // Use a flat array for performance with large files
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find the LCS
  const lcs: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lcs.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return lcs;
}
