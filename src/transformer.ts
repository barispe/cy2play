// ============================================================================
// Cy2Play — Cypress → Playwright Transformer  (The "Converter")
// ============================================================================
//
// Takes raw Cypress source code and produces valid Playwright test code.
// This is the strict / rule-based engine — no AI involved.
//
// Strategy: line-by-line chain conversion rather than AST-to-AST rewriting.
// Each Cypress expression statement (a full cy.xxx().yyy().zzz() chain) is
// parsed and converted into one or more Playwright lines.
// ============================================================================

import {
  SELECTOR_MAPPINGS,
  ACTION_MAPPINGS,
  NAVIGATION_MAPPINGS,
  ASSERTION_MAPPINGS,
  HOOK_MAPPINGS,
  STRUCTURE_MAPPINGS,
  COMPLEX_COMMANDS,
} from './mappings/cypress-commands';
import { TransformResult, TransformStats, Warning, UnresolvedNode } from './types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transform a Cypress test file into Playwright code (strict / rule-based).
 */
export function transformFile(sourceCode: string, filePath: string): TransformResult {
  const startTime = Date.now();
  const warnings: Warning[] = [];
  const unresolvedNodes: UnresolvedNode[] = [];
  let rulesApplied = 0;
  let manualReview = 0;
  let totalCommands = 0;

  const lines = sourceCode.split('\n');
  const outputLines: string[] = [];

  // Track whether we're inside a describe/it/hook and at what nesting depth
  // We process the file line-by-line, converting each expression statement.

  // First pass: collect all lines and convert them
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines — preserve them
    if (trimmed === '') {
      outputLines.push('');
      continue;
    }

    // --- Handle describe / context blocks ---
    const describeMatch = trimmed.match(/^(describe(?:\.only|\.skip)?|context(?:\.only|\.skip)?)\s*\(\s*(['"`])(.*?)\2\s*,\s*(.*)/);
    if (describeMatch) {
      const [, keyword, , title, rest] = describeMatch;
      const base = keyword.split('.')[0];
      const modifier = keyword.includes('.only') ? '.only' : keyword.includes('.skip') ? '.skip' : '';
      const pwStructure = STRUCTURE_MAPPINGS[base] || 'test.describe';
      const indent = getIndent(line);
      outputLines.push(`${indent}${pwStructure}${modifier}('${title}', ${rest}`);
      rulesApplied++;
      continue;
    }

    // --- Handle it / specify blocks ---
    const itMatch = trimmed.match(/^(it(?:\.only|\.skip)?|specify(?:\.only|\.skip)?)\s*\(\s*(['"`])(.*?)\2\s*,\s*(?:\(\s*\)\s*=>|function\s*\(\s*\))\s*\{/);
    if (itMatch) {
      const [, keyword, , title] = itMatch;
      const base = keyword.split('.')[0];
      const modifier = keyword.includes('.only') ? '.only' : keyword.includes('.skip') ? '.skip' : '';
      const pwStructure = STRUCTURE_MAPPINGS[base] || 'test';
      const indent = getIndent(line);
      outputLines.push(`${indent}${pwStructure}${modifier}('${title}', async ({ page }) => {`);
      rulesApplied++;
      continue;
    }

    // --- Handle hooks ---
    const hookMatch = trimmed.match(/^(before|beforeEach|after|afterEach)\s*\(\s*(?:\(\s*\)\s*=>|function\s*\(\s*\))\s*\{/);
    if (hookMatch) {
      const [, hookName] = hookMatch;
      const pwHook = HOOK_MAPPINGS[hookName] || `test.${hookName}`;
      const indent = getIndent(line);
      outputLines.push(`${indent}${pwHook}(async ({ page }) => {`);
      rulesApplied++;
      continue;
    }

    // --- Handle Cypress chain expression statements ---
    if (trimmed.match(/^cy\./)) {
      const result = convertCypressChain(trimmed, filePath, i + 1, warnings, unresolvedNodes);
      const indent = getIndent(line);
      for (const convertedLine of result.lines) {
        outputLines.push(`${indent}${convertedLine}`);
      }
      totalCommands += result.commandCount;
      rulesApplied += result.rulesApplied;
      manualReview += result.manualReview;
      continue;
    }

    // --- Pass through everything else (closing braces, comments, etc.) ---
    outputLines.push(line);
  }

  // Prepend Playwright import
  const finalOutput = `import { test, expect } from '@playwright/test';\n\n${outputLines.join('\n')}`;

  const stats: TransformStats = {
    rulesApplied,
    aiResolved: 0,
    manualReview,
    totalCommands,
    durationMs: Date.now() - startTime,
  };

  return {
    code: finalOutput,
    warnings,
    unresolvedNodes,
    stats,
  };
}

// ---------------------------------------------------------------------------
// Chain Converter — the core of the transformation engine
// ---------------------------------------------------------------------------

interface ChainConversionResult {
  lines: string[];
  commandCount: number;
  rulesApplied: number;
  manualReview: number;
}

/**
 * Parse a full Cypress chain like `cy.get('.btn').click()` or
 * `cy.get('.msg').should('have.text', 'Hi')` and return Playwright line(s).
 */
function convertCypressChain(
  chain: string,
  filePath: string,
  line: number,
  warnings: Warning[],
  unresolvedNodes: UnresolvedNode[],
): ChainConversionResult {
  // Remove trailing semicolon for parsing
  const cleaned = chain.replace(/;\s*$/, '');

  // Parse the chain into individual calls
  const calls = parseChainCalls(cleaned);

  if (calls.length === 0) {
    return { lines: [chain], commandCount: 0, rulesApplied: 0, manualReview: 0 };
  }

  let commandCount = calls.length;
  let rulesApplied = 0;
  let manualReview = 0;

  // Check if any call in the chain is complex / unresolvable
  const hasComplex = calls.some(c => COMPLEX_COMMANDS.has(c.method));
  if (hasComplex) {
    // Mark as unresolved for hybrid/manual
    const placeholderId = `CY2PLAY_${line}_${Date.now()}`;
    unresolvedNodes.push({
      placeholderId,
      originalCode: chain,
      context: '',
      line,
      column: 0,
    });
    manualReview++;
    return {
      lines: [`// TODO: [cy2play] Manual review required — complex command(s) detected`, `// ${chain}`],
      commandCount,
      rulesApplied: 0,
      manualReview,
    };
  }

  // Classify the chain
  const first = calls[0]; // should be cy.xxx(...)
  const rest = calls.slice(1);

  // --- cy.visit(url) ---
  if (first.method === 'visit') {
    rulesApplied++;
    return {
      lines: [`await page.goto(${first.rawArgs});`],
      commandCount,
      rulesApplied,
      manualReview,
    };
  }

  // --- cy.url().should(...) ---
  if (first.method === 'url') {
    return convertUrlChain(rest, line, filePath, warnings, commandCount);
  }

  // --- cy.title().should(...) ---
  if (first.method === 'title') {
    return convertTitleChain(rest, line, filePath, warnings, commandCount);
  }

  // --- cy.wait(n) ---
  if (first.method === 'wait') {
    rulesApplied++;
    warnings.push({
      severity: 'warning',
      message: `Static cy.wait() converted — consider replacing with explicit waitFor* in Playwright.`,
      filePath,
      line,
      originalCode: chain,
    });
    return {
      lines: [`// ⚠️ Static wait — consider using Playwright's auto-waiting instead`, `await page.waitForTimeout(${first.rawArgs});`],
      commandCount,
      rulesApplied,
      manualReview,
    };
  }

  // --- cy.reload() ---
  if (first.method === 'reload') {
    rulesApplied++;
    return {
      lines: [`await page.reload();`],
      commandCount,
      rulesApplied,
      manualReview,
    };
  }

  // --- cy.get(selector) chains --- (most common)
  if (first.method === 'get' || first.method === 'contains') {
    return convertGetChain(first, rest, line, filePath, warnings, commandCount);
  }

  // --- Fallback: unknown top-level cy.xxx ---
  manualReview++;
  return {
    lines: [`// TODO: [cy2play] Unrecognized command — cy.${first.method}()`, `// ${chain}`],
    commandCount,
    rulesApplied,
    manualReview,
  };
}

// ---------------------------------------------------------------------------
// Chain type converters
// ---------------------------------------------------------------------------

function convertGetChain(
  first: ChainCall,
  rest: ChainCall[],
  line: number,
  filePath: string,
  warnings: Warning[],
  commandCount: number,
): ChainConversionResult {
  let rulesApplied = 1; // for the cy.get itself
  let manualReview = 0;

  // Build the locator expression
  let locatorExpr: string;
  if (first.method === 'contains') {
    locatorExpr = `page.getByText(${first.rawArgs})`;
  } else {
    locatorExpr = `page.locator(${first.rawArgs})`;
  }

  // Process the rest of the chain
  const outputLines: string[] = [];
  let pendingLocator = locatorExpr;

  for (let i = 0; i < rest.length; i++) {
    const call = rest[i];
    rulesApplied++;

    // --- Selector refinement methods ---
    if (call.method === 'find') {
      pendingLocator = `${pendingLocator}.locator(${call.rawArgs})`;
      continue;
    }
    if (call.method === 'first') {
      pendingLocator = `${pendingLocator}.first()`;
      continue;
    }
    if (call.method === 'last') {
      pendingLocator = `${pendingLocator}.last()`;
      continue;
    }
    if (call.method === 'eq') {
      pendingLocator = `${pendingLocator}.nth(${call.rawArgs})`;
      continue;
    }
    if (call.method === 'filter') {
      pendingLocator = `${pendingLocator}.filter(${call.rawArgs})`;
      continue;
    }
    if (call.method === 'contains' && i > 0) {
      // .contains() as a chained filter
      pendingLocator = `${pendingLocator}.filter({ hasText: ${call.rawArgs} })`;
      continue;
    }

    // --- Action methods ---
    if (call.method === 'click') {
      outputLines.push(`await ${pendingLocator}.click();`);
      pendingLocator = locatorExpr; // reset for potential further chains (unlikely but safe)
      continue;
    }
    if (call.method === 'dblclick') {
      outputLines.push(`await ${pendingLocator}.dblclick();`);
      continue;
    }
    if (call.method === 'type') {
      outputLines.push(`await ${pendingLocator}.fill(${call.rawArgs});`);
      continue;
    }
    if (call.method === 'clear') {
      outputLines.push(`await ${pendingLocator}.clear();`);
      continue;
    }
    if (call.method === 'check') {
      outputLines.push(`await ${pendingLocator}.check();`);
      continue;
    }
    if (call.method === 'uncheck') {
      outputLines.push(`await ${pendingLocator}.uncheck();`);
      continue;
    }
    if (call.method === 'select') {
      outputLines.push(`await ${pendingLocator}.selectOption(${call.rawArgs});`);
      continue;
    }
    if (call.method === 'focus') {
      outputLines.push(`await ${pendingLocator}.focus();`);
      continue;
    }
    if (call.method === 'blur') {
      outputLines.push(`await ${pendingLocator}.blur();`);
      continue;
    }
    if (call.method === 'scrollIntoView') {
      outputLines.push(`await ${pendingLocator}.scrollIntoViewIfNeeded();`);
      continue;
    }

    // --- Assertion methods ---
    if (call.method === 'should') {
      const assertionLines = convertShouldAssertion(pendingLocator, call, line, filePath, warnings);
      outputLines.push(...assertionLines.lines);
      if (assertionLines.isManual) manualReview++;
      continue;
    }

    // --- .and() is an alias for .should() ---
    if (call.method === 'and') {
      const assertionLines = convertShouldAssertion(pendingLocator, call, line, filePath, warnings);
      outputLines.push(...assertionLines.lines);
      if (assertionLines.isManual) manualReview++;
      continue;
    }

    // --- .as() — aliasing, skip in strict mode ---
    if (call.method === 'as') {
      // Aliases are handled differently in Playwright (no direct equivalent)
      // Skip silently — the locator is already stored
      continue;
    }

    // --- Unknown chained method ---
    rulesApplied--; // undo the optimistic increment
    manualReview++;
    outputLines.push(`// TODO: [cy2play] Unknown chained method .${call.method}() — manual review needed`);
    outputLines.push(`// Original: ${pendingLocator}.${call.method}(${call.rawArgs})`);
  }

  // If no actions or assertions consumed the locator, it's a standalone locator reference (unusual)
  if (outputLines.length === 0) {
    outputLines.push(`${pendingLocator};`);
  }

  return { lines: outputLines, commandCount, rulesApplied, manualReview };
}

function convertUrlChain(
  rest: ChainCall[],
  line: number,
  filePath: string,
  warnings: Warning[],
  commandCount: number,
): ChainConversionResult {
  let rulesApplied = 1;
  const outputLines: string[] = [];

  for (const call of rest) {
    if (call.method === 'should') {
      const args = parseCallArgs(call.rawArgs);
      const chainer = stripQuotes(args[0] || '');
      const isNegated = chainer.startsWith('not.');
      const baseChainer = isNegated ? chainer.slice(4) : chainer;
      const negation = isNegated ? 'not.' : '';

      if (baseChainer === 'include' || baseChainer === 'contain') {
        const value = args[1] || "''";
        // Convert to regex for toHaveURL
        // Strip leading/trailing slashes from the value — they're implied in the URL match
        const cleanValue = stripQuotes(value).replace(/^\/+|\/+$/g, '');
        outputLines.push(`await expect(page).${negation}toHaveURL(/${escapeRegexForUrl(cleanValue)}/);`);
        rulesApplied++;
      } else if (baseChainer === 'eq' || baseChainer === 'equal') {
        const value = args[1] || "''";
        outputLines.push(`await expect(page).${negation}toHaveURL(${value});`);
        rulesApplied++;
      } else if (baseChainer === 'match') {
        const value = args[1] || '/./';
        outputLines.push(`await expect(page).${negation}toHaveURL(${value});`);
        rulesApplied++;
      } else {
        outputLines.push(`// TODO: [cy2play] Unrecognized cy.url().should('${chainer}') assertion`);
      }
    }
  }

  if (outputLines.length === 0) {
    outputLines.push(`page.url();`);
  }

  return { lines: outputLines, commandCount, rulesApplied, manualReview: 0 };
}

function convertTitleChain(
  rest: ChainCall[],
  line: number,
  filePath: string,
  warnings: Warning[],
  commandCount: number,
): ChainConversionResult {
  let rulesApplied = 1;
  const outputLines: string[] = [];

  for (const call of rest) {
    if (call.method === 'should') {
      const args = parseCallArgs(call.rawArgs);
      const chainer = stripQuotes(args[0] || '');

      if (chainer === 'eq' || chainer === 'equal') {
        outputLines.push(`await expect(page).toHaveTitle(${args[1] || "''"});`);
        rulesApplied++;
      } else if (chainer === 'include' || chainer === 'contain') {
        const value = args[1] || "''";
        const clean = stripQuotes(value);
        outputLines.push(`await expect(page).toHaveTitle(/${escapeRegex(clean)}/);`);
        rulesApplied++;
      } else {
        outputLines.push(`// TODO: [cy2play] Unrecognized cy.title().should('${chainer}') assertion`);
      }
    }
  }

  if (outputLines.length === 0) {
    outputLines.push(`await page.title();`);
  }

  return { lines: outputLines, commandCount, rulesApplied, manualReview: 0 };
}

// ---------------------------------------------------------------------------
// Assertion converter
// ---------------------------------------------------------------------------

interface AssertionResult {
  lines: string[];
  isManual: boolean;
}

function convertShouldAssertion(
  locatorExpr: string,
  call: ChainCall,
  line: number,
  filePath: string,
  warnings: Warning[],
): AssertionResult {
  const args = parseCallArgs(call.rawArgs);
  if (args.length === 0) {
    return { lines: [`// TODO: [cy2play] Empty .should() — manual review needed`], isManual: true };
  }

  const chainer = stripQuotes(args[0]);
  const isNegated = chainer.startsWith('not.');
  const baseChainer = isNegated ? chainer.slice(4) : chainer;
  const negation = isNegated ? 'not.' : '';

  // Look up in assertion mappings
  const mapping = ASSERTION_MAPPINGS[baseChainer];

  if (mapping) {
    if (mapping.hasValue && args.length >= 2) {
      // Assertions with value: .should('have.text', 'foo')
      if (baseChainer === 'have.attr' && args.length >= 3) {
        // .should('have.attr', 'href', '/about') → toHaveAttribute('href', '/about')
        return {
          lines: [`await expect(${locatorExpr}).${negation}${mapping.playwright}(${args[1]}, ${args[2]});`],
          isManual: false,
        };
      }
      if (baseChainer === 'have.css' && args.length >= 3) {
        return {
          lines: [`await expect(${locatorExpr}).${negation}${mapping.playwright}(${args[1]}, ${args[2]});`],
          isManual: false,
        };
      }
      return {
        lines: [`await expect(${locatorExpr}).${negation}${mapping.playwright}(${args[1]});`],
        isManual: false,
      };
    }

    if (!mapping.hasValue) {
      // Assertions without value: .should('be.visible')
      return {
        lines: [`await expect(${locatorExpr}).${negation}${mapping.playwright}();`],
        isManual: false,
      };
    }
  }

  // Handle .should('have.length.greaterThan', n) and similar compound assertions
  if (baseChainer === 'have.length.greaterThan' || baseChainer === 'have.length.gt') {
    // No direct Playwright equivalent — use not.toHaveCount(0) or custom logic
    const value = args[1] || '0';
    warnings.push({
      severity: 'info',
      message: `Converted .should('have.length.greaterThan', ${value}) — verify the assertion logic.`,
      filePath,
      line,
    });
    return {
      lines: [`// Assertion: original had .should('${chainer}', ${value})`, `await expect(${locatorExpr}).${negation}not.toHaveCount(0);`],
      isManual: false,
    };
  }

  if (baseChainer === 'have.length.lessThan' || baseChainer === 'have.length.lt') {
    const value = args[1] || '0';
    return {
      lines: [`// TODO: [cy2play] .should('${chainer}', ${value}) — no direct Playwright equivalent, manual review needed`],
      isManual: true,
    };
  }

  // --- Callback-style .should(($el) => { ... }) ---
  if (args[0] && !args[0].startsWith("'") && !args[0].startsWith('"')) {
    return {
      lines: [
        `// TODO: [cy2play] Callback-style .should() — needs manual conversion`,
        `// Original: .should(${call.rawArgs})`,
      ],
      isManual: true,
    };
  }

  // Unrecognized assertion
  return {
    lines: [`// TODO: [cy2play] Unrecognized assertion .should('${chainer}') — manual review needed`],
    isManual: true,
  };
}

// ---------------------------------------------------------------------------
// Chain parser — splits `cy.get('.x').click().should(...)` into calls
// ---------------------------------------------------------------------------

interface ChainCall {
  method: string;
  rawArgs: string;
}

/**
 * Parse a Cypress chain expression into individual method calls.
 *
 * Input:  `cy.get('[data-cy=email]').type('user@test.com')`
 * Output: [{ method: 'get', rawArgs: "'[data-cy=email]'" },
 *          { method: 'type', rawArgs: "'user@test.com'" }]
 */
function parseChainCalls(chain: string): ChainCall[] {
  const calls: ChainCall[] = [];

  // Remove leading `cy.`
  let remaining = chain;
  if (remaining.startsWith('cy.')) {
    remaining = remaining.slice(3);
  } else {
    return calls;
  }

  while (remaining.length > 0) {
    // Find the method name
    const methodMatch = remaining.match(/^(\w+)\s*\(/);
    if (!methodMatch) break;

    const method = methodMatch[1];
    remaining = remaining.slice(methodMatch[0].length);

    // Find matching closing paren (handling nested parens, strings, etc.)
    const argsResult = extractBalancedArgs(remaining);
    const rawArgs = argsResult.args;
    remaining = argsResult.rest;

    calls.push({ method, rawArgs });

    // Skip the `.` between chained calls
    if (remaining.startsWith('.')) {
      remaining = remaining.slice(1);
    } else {
      break;
    }
  }

  return calls;
}

/**
 * Extract arguments from a position right after the opening `(`.
 * Handles nested parens, string literals, template literals, and regex.
 */
function extractBalancedArgs(input: string): { args: string; rest: string } {
  let depth = 1;
  let i = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplate = false;
  let escaped = false;

  while (i < input.length && depth > 0) {
    const ch = input[i];

    if (escaped) {
      escaped = false;
      i++;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      i++;
      continue;
    }

    if (ch === "'" && !inDoubleQuote && !inTemplate) {
      inSingleQuote = !inSingleQuote;
    } else if (ch === '"' && !inSingleQuote && !inTemplate) {
      inDoubleQuote = !inDoubleQuote;
    } else if (ch === '`' && !inSingleQuote && !inDoubleQuote) {
      inTemplate = !inTemplate;
    } else if (!inSingleQuote && !inDoubleQuote && !inTemplate) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }

    if (depth > 0) i++;
  }

  // `i` now points at the closing `)`
  const args = input.slice(0, i);
  const rest = input.slice(i + 1); // skip the `)`
  return { args, rest };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse comma-separated arguments, respecting nested parens and strings.
 * `"'have.text', 'Hello'"` → `["'have.text'", "'Hello'"]`
 */
function parseCallArgs(rawArgs: string): string[] {
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplate = false;
  let escaped = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const ch = rawArgs[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDoubleQuote && !inTemplate) inSingleQuote = !inSingleQuote;
    else if (ch === '"' && !inSingleQuote && !inTemplate) inDoubleQuote = !inDoubleQuote;
    else if (ch === '`' && !inSingleQuote && !inDoubleQuote) inTemplate = !inTemplate;

    if (!inSingleQuote && !inDoubleQuote && !inTemplate) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) {
        args.push(current.trim());
        current = '';
        continue;
      }
    }

    current += ch;
  }

  if (current.trim()) args.push(current.trim());
  return args;
}

function getIndent(line: string): string {
  const match = line.match(/^(\s*)/);
  return match ? match[1] : '';
}

function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Like escapeRegex but keeps `/` unescaped (for URL patterns inside /regex/) */
function escapeRegexForUrl(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
