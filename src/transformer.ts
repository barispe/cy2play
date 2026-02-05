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

import * as fs from 'fs';
import * as path from 'path';
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
// Custom Command Support
// ---------------------------------------------------------------------------

export interface CustomCommandDef {
  /** The command name, e.g. 'removeAds' */
  name: string;
  /** Playwright code lines to emit when this command is encountered */
  playwrightLines: string[];
}

/**
 * Scan a Cypress project for custom command definitions in support/commands.ts.
 * Parses `Cypress.Commands.add('name', ...)` entries and converts known patterns
 * into Playwright equivalents.
 *
 * Currently handles:
 *   - DOM removal patterns: cy.get('body').then(($body) => { $body.find(selectors).remove() })
 *     → page.evaluate(() => document.querySelectorAll(selectors).forEach(el => el.remove()))
 */
export function parseCustomCommands(projectRoot: string): CustomCommandDef[] {
  const defs: CustomCommandDef[] = [];

  // Look for cypress/support/commands.ts or commands.js
  const candidates = [
    path.join(projectRoot, 'cypress', 'support', 'commands.ts'),
    path.join(projectRoot, 'cypress', 'support', 'commands.js'),
  ];

  let commandsSource = '';
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      commandsSource = fs.readFileSync(candidate, 'utf-8');
      break;
    }
  }

  if (!commandsSource) return defs;

  // Match Cypress.Commands.add('name', ...) blocks
  const addRegex = /Cypress\.Commands\.add\(\s*['"]([\w]+)['"]\s*,/g;
  let match;
  while ((match = addRegex.exec(commandsSource)) !== null) {
    const cmdName = match[1];
    // Extract the body between this match and the next Cypress.Commands.add or end of file
    const startIdx = match.index;
    const nextMatch = commandsSource.indexOf('Cypress.Commands.add', startIdx + match[0].length);
    const endIdx = nextMatch > -1 ? nextMatch : commandsSource.length;
    const cmdBody = commandsSource.slice(startIdx, endIdx);

    // Detect DOM removal pattern:
    //   Pattern A: $body.find('selectors').remove()  — literal string in find()
    //   Pattern B: const selectors = '...'; $body.find(selectors).remove() — variable reference
    const removePatternA = cmdBody.match(/\.find\(\s*['"](.+?)['"]\s*\)\.remove\(\)/);
    if (removePatternA) {
      const selectors = removePatternA[1];
      defs.push({
        name: cmdName,
        playwrightLines: [
          `await page.evaluate(() => {`,
          `  document.querySelectorAll('${selectors}').forEach(el => el.remove());`,
          `});`,
        ],
      });
      continue;
    }

    // Pattern B: variable holds selectors, used in .find(variable).remove()
    const removePatternB = cmdBody.match(/\.find\(\s*(\w+)\s*\)\.remove\(\)/);
    if (removePatternB) {
      const varName = removePatternB[1];
      // Look for the variable declaration: const varName = '...' or "..." or `...`
      // Use the opening quote to determine the delimiter
      const varDeclMatch = cmdBody.match(new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*('|"|${'`'})`, ''));
      if (varDeclMatch) {
        const quote = varDeclMatch[1];
        const afterQuote = cmdBody.slice(cmdBody.indexOf(varDeclMatch[0]) + varDeclMatch[0].length);
        const endQuoteIdx = afterQuote.indexOf(quote);
        if (endQuoteIdx > -1) {
          const selectors = afterQuote.slice(0, endQuoteIdx);
          defs.push({
            name: cmdName,
            playwrightLines: [
              `await page.evaluate(() => {`,
              `  document.querySelectorAll('${selectors.replace(/'/g, "\\'")}').forEach(el => el.remove());`,
              `});`,
            ],
          });
          continue;
        }
      }
    }

    // Detect simple evaluate/DOM manipulation patterns
    const evalPattern = cmdBody.match(/cy\.document\(\).*?\$doc[\s\S]*?\$doc\.find\(\s*['"](.+?)['"]\s*\)\.(\w+)/);
    if (evalPattern) {
      defs.push({
        name: cmdName,
        playwrightLines: [
          `await page.evaluate(() => {`,
          `  document.querySelectorAll('${evalPattern[1]}').forEach(el => el.${evalPattern[2]}());`,
          `});`,
        ],
      });
      continue;
    }

    // Unknown custom command — leave as TODO but with name info
    // (will still fall through to unrecognized in the transformer)
  }

  return defs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transform a Cypress test file into Playwright code (strict / rule-based).
 *
 * @param customCommands  Optional list of detected custom Cypress commands with
 *                        their Playwright equivalents (from parseCustomCommands).
 */
export function transformFile(
  sourceCode: string,
  filePath: string,
  customCommands?: CustomCommandDef[],
): TransformResult {
  const startTime = Date.now();
  const warnings: Warning[] = [];
  const unresolvedNodes: UnresolvedNode[] = [];
  const customCommandMap = new Map<string, CustomCommandDef>();
  if (customCommands) {
    for (const cmd of customCommands) {
      customCommandMap.set(cmd.name, cmd);
    }
  }
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

    // Special: multi-line cy.window().then((win) => { ... }) blocks
    // The inner body typically contains cy.stub() calls — convert inner lines, skip the wrapper
    if (trimmed.match(/^cy\.window\s*\(\s*\)\s*\.then\s*\(/)) {
      const indent = getIndent(line);
      const { blockLines, endIndex } = accumulateBlock(lines, i);
      const result = convertWindowThenBlock(blockLines, filePath, i + 1, warnings, unresolvedNodes, customCommandMap);
      for (const convertedLine of result.lines) {
        outputLines.push(`${indent}${convertedLine}`);
      }
      totalCommands += result.commandCount;
      rulesApplied += result.rulesApplied;
      manualReview += result.manualReview;
      i = endIndex;
      continue;
    }

    // Special: multi-line cy.on('event', (arg) => { ... }) blocks
    if (trimmed.match(/^cy\.on\s*\(/) && !trimmed.match(/\)\s*;?\s*$/)) {
      // Multi-line — the closing ); isn't on the same line
      const indent = getIndent(line);
      const { blockLines, endIndex } = accumulateBlock(lines, i);
      // Re-join and convert as single chain
      const joined = blockLines.map(l => l.trim()).join(' ');
      const result = convertCypressChain(joined, filePath, i + 1, warnings, unresolvedNodes, customCommandMap);
      for (const convertedLine of result.lines) {
        outputLines.push(`${indent}${convertedLine}`);
      }
      totalCommands += result.commandCount;
      rulesApplied += result.rulesApplied;
      manualReview += result.manualReview;
      i = endIndex;
      continue;
    }

    // Special: multi-line cy.request({...}).then() blocks
    if (trimmed.match(/^cy\.request\s*\(\s*\{/)) {
      const indent = getIndent(line);
      const { blockLines, endIndex } = accumulateBlock(lines, i);
      const result = convertCyRequest(blockLines, filePath, i + 1, warnings, unresolvedNodes);
      for (const convertedLine of result.lines) {
        outputLines.push(`${indent}${convertedLine}`);
      }
      totalCommands += result.commandCount;
      rulesApplied += result.rulesApplied;
      manualReview += result.manualReview;
      i = endIndex; // skip past the accumulated block
      continue;
    }

    // Special: multi-line cy.fixture('...').then((data) => { ... }) blocks
    if (trimmed.match(/^cy\.fixture\s*\(/)) {
      const indent = getIndent(line);
      // Check if this is a multi-line block with .then()
      if (trimmed.includes('.then(') || (i + 1 < lines.length && lines[i + 1].trim().startsWith('}).then('))) {
        const { blockLines, endIndex } = accumulateBlock(lines, i);
        const result = convertCyFixtureBlock(blockLines, filePath, i + 1, warnings, unresolvedNodes);
        for (const convertedLine of result.lines) {
          outputLines.push(`${indent}${convertedLine}`);
        }
        totalCommands += result.commandCount;
        rulesApplied += result.rulesApplied;
        manualReview += result.manualReview;
        i = endIndex;
        continue;
      }
    }

    // Special: multi-line cy.get(selector).should(($el) => { ... }) callback blocks
    if (trimmed.match(/^cy\.(get|contains)\s*\(/) && trimmed.match(/\.should\s*\(\s*\(\s*\$/)) {
      const indent = getIndent(line);
      const { blockLines, endIndex } = accumulateBlock(lines, i);
      const result = convertCallbackShould(blockLines, filePath, i + 1, warnings);
      for (const convertedLine of result.lines) {
        outputLines.push(`${indent}${convertedLine}`);
      }
      totalCommands += result.commandCount;
      rulesApplied += result.rulesApplied;
      manualReview += result.manualReview;
      i = endIndex;
      continue;
    }

    // Special: multi-line cy.get(selector).within(() => { ... }) scoped blocks
    if (trimmed.match(/^cy\.(get|contains)\s*\(/) && trimmed.match(/\.within\s*\(/)) {
      const indent = getIndent(line);
      const { blockLines, endIndex } = accumulateBlock(lines, i);
      const result = convertWithinBlock(blockLines, filePath, i + 1, warnings, unresolvedNodes, customCommandMap);
      for (const convertedLine of result.lines) {
        outputLines.push(`${indent}${convertedLine}`);
      }
      totalCommands += result.commandCount;
      rulesApplied += result.rulesApplied;
      manualReview += result.manualReview;
      i = endIndex;
      continue;
    }

    // Special: multi-line cy.get(selector).then(($el) => { ... }) callback blocks (DOM manipulation)
    if (trimmed.match(/^cy\.get\s*\(/) && trimmed.match(/\.then\s*\(\s*\(\s*\$/)) {
      const indent = getIndent(line);
      const { blockLines, endIndex } = accumulateBlock(lines, i);
      const result = convertCallbackThen(blockLines, filePath, i + 1, warnings);
      for (const convertedLine of result.lines) {
        outputLines.push(`${indent}${convertedLine}`);
      }
      totalCommands += result.commandCount;
      rulesApplied += result.rulesApplied;
      manualReview += result.manualReview;
      i = endIndex;
      continue;
    }

    if (trimmed.match(/^cy\./)) {
      const result = convertCypressChain(trimmed, filePath, i + 1, warnings, unresolvedNodes, customCommandMap);
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

  // Post-process: fix test signatures for API tests
  // If a test block contains `request.get/post/put/delete/patch`, replace `{ page }` with `{ request }`
  const hasApiCalls = outputLines.some(l => l.match(/await request\.(get|post|put|delete|patch|head)\(/));
  let processedLines = outputLines;
  if (hasApiCalls) {
    processedLines = outputLines.map(l => {
      if (l.match(/async \(\{ page \}\) =>/)) {
        return l.replace('{ page }', '{ request }');
      }
      return l;
    });
  }

  // Prepend Playwright import
  const finalOutput = `import { test, expect } from '@playwright/test';\n\n${processedLines.join('\n')}`;

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
  customCommandMap?: Map<string, CustomCommandDef>,
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
  // Exception: cy.window().then() and cy.fixture().then() are handled by our converters
  const isWindowThen = calls[0]?.method === 'window' && calls.some(c => c.method === 'then');
  const isFixtureThen = calls[0]?.method === 'fixture' && calls.some(c => c.method === 'then');
  const hasComplex = !isWindowThen && !isFixtureThen && calls.some(c => COMPLEX_COMMANDS.has(c.method));
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

  // --- cy.fixture('name').then((data) => { ... }) → import fixture as JSON ---
  if (first.method === 'fixture') {
    const fixtureName = stripQuotes(first.rawArgs);
    // The .then() callback body follows on subsequent lines — just emit the import
    warnings.push({
      severity: 'info',
      message: `cy.fixture('${fixtureName}') — add \`import ${fixtureName} from '../fixtures/${fixtureName}.json';\` at the top of the file.`,
      filePath,
      line,
    });
    return {
      lines: [`// cy.fixture('${fixtureName}') — replace with: import ${fixtureName} from '../fixtures/${fixtureName}.json';`],
      commandCount,
      rulesApplied: 1,
      manualReview: 0,
    };
  }

  // --- cy.window().then((win) => { ... }) → skip wrapper (inner cy.stub handled separately) ---
  if (first.method === 'window') {
    // cy.window().then((win) => {  is a wrapper for stub/dialog patterns
    // The inner cy.stub() lines are handled by convertCyStub on their own lines
    // So we just skip the wrapper silently
    const hasThen = rest.some(c => c.method === 'then');
    if (hasThen) {
      return {
        lines: [`// cy.window().then() wrapper — inner stub/dialog handled below`],
        commandCount,
        rulesApplied: 1,
        manualReview: 0,
      };
    }
    // Standalone cy.window() without .then() — might be cy.window().its(...)
    rulesApplied++;
    return {
      lines: [`// TODO: [cy2play] cy.window() chain — manual review needed`, `// ${chain}`],
      commandCount,
      rulesApplied: 0,
      manualReview: 1,
    };
  }

  // --- cy.on('window:alert/confirm', callback) → page.on('dialog', ...) ---
  if (first.method === 'on') {
    return convertCyOn(first, chain, line, filePath, warnings, commandCount);
  }

  // --- cy.stub(win, 'method').returns(val) → dialog/popup handler ---
  if (first.method === 'stub') {
    return convertCyStub(first, rest, chain, line, filePath, warnings, commandCount);
  }

  // --- Custom command lookup ---
  if (customCommandMap?.has(first.method)) {
    const customCmd = customCommandMap.get(first.method)!;
    return {
      lines: customCmd.playwrightLines,
      commandCount,
      rulesApplied: 1,
      manualReview: 0,
    };
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

/**
 * Convert cy.on('window:alert/confirm', callback) → page.on('dialog', ...)
 */
function convertCyOn(
  first: ChainCall,
  chain: string,
  line: number,
  filePath: string,
  warnings: Warning[],
  commandCount: number,
): ChainConversionResult {
  const args = parseCallArgs(first.rawArgs);
  const eventName = stripQuotes(args[0] || '');

  // --- cy.on('window:confirm', () => true) → accept dialog ---
  if (eventName === 'window:confirm') {
    const callback = (args[1] || '').trim();
    // () => true  or  () => { return true; }
    if (callback.includes('true')) {
      return {
        lines: [`page.on('dialog', async (dialog) => { await dialog.accept(); });`],
        commandCount,
        rulesApplied: 1,
        manualReview: 0,
      };
    }
    // () => false  or  () => { return false; }
    if (callback.includes('false')) {
      return {
        lines: [`page.on('dialog', async (dialog) => { await dialog.dismiss(); });`],
        commandCount,
        rulesApplied: 1,
        manualReview: 0,
      };
    }
  }

  // --- cy.on('window:alert', (text) => { ... }) → dialog handler with message check ---
  if (eventName === 'window:alert') {
    // The callback body may be multi-line (rest comes on following lines).
    // Generate a dialog accept handler — the assertion from the callback body
    // is left on subsequent lines for manual cleanup.
    return {
      lines: [`page.on('dialog', async (dialog) => { await dialog.accept(); });`],
      commandCount,
      rulesApplied: 1,
      manualReview: 0,
    };
  }

  // --- cy.on('uncaught:exception', ...) → common pattern to suppress errors ---
  if (eventName === 'uncaught:exception') {
    return {
      lines: [`// cy.on('uncaught:exception') — Playwright doesn't need this; errors are not auto-fatal`],
      commandCount,
      rulesApplied: 1,
      manualReview: 0,
    };
  }

  // Unknown cy.on event — leave a more informative TODO
  return {
    lines: [`// TODO: [cy2play] Unsupported cy.on('${eventName}') — manual review needed`, `// ${chain}`],
    commandCount,
    rulesApplied: 0,
    manualReview: 1,
  };
}

/**
 * Convert cy.stub(win, 'method') patterns → Playwright equivalents
 *
 * Known patterns:
 *   cy.stub(win, 'prompt').returns('value') → page.on('dialog', d => d.accept('value'))
 *   cy.stub(win, 'open').as('alias')        → // popup handled via waitForEvent('page')
 *   cy.stub(win, 'confirm').returns(true)    → page.on('dialog', d => d.accept())
 */
function convertCyStub(
  first: ChainCall,
  rest: ChainCall[],
  chain: string,
  line: number,
  filePath: string,
  warnings: Warning[],
  commandCount: number,
): ChainConversionResult {
  const args = parseCallArgs(first.rawArgs);
  // args[0] = 'win', args[1] = "'prompt'" or "'open'"
  const stubbedMethod = stripQuotes(args[1] || '');

  // Check for .returns(val) in the rest of the chain
  const returnsCall = rest.find(c => c.method === 'returns');
  const returnsValue = returnsCall ? returnsCall.rawArgs.trim() : '';

  // --- cy.stub(win, 'prompt').returns('value') → dialog handler ---
  if (stubbedMethod === 'prompt') {
    const promptValue = returnsValue || "''";
    return {
      lines: [`page.on('dialog', async (dialog) => { await dialog.accept(${promptValue}); });`],
      commandCount,
      rulesApplied: 1,
      manualReview: 0,
    };
  }

  // --- cy.stub(win, 'confirm').returns(true/false) → dialog handler ---
  if (stubbedMethod === 'confirm') {
    if (returnsValue.includes('false')) {
      return {
        lines: [`page.on('dialog', async (dialog) => { await dialog.dismiss(); });`],
        commandCount,
        rulesApplied: 1,
        manualReview: 0,
      };
    }
    return {
      lines: [`page.on('dialog', async (dialog) => { await dialog.accept(); });`],
      commandCount,
      rulesApplied: 1,
      manualReview: 0,
    };
  }

  // --- cy.stub(win, 'alert') → dialog handler ---
  if (stubbedMethod === 'alert') {
    return {
      lines: [`page.on('dialog', async (dialog) => { await dialog.accept(); });`],
      commandCount,
      rulesApplied: 1,
      manualReview: 0,
    };
  }

  // --- cy.stub(win, 'open') → popup handling ---
  if (stubbedMethod === 'open') {
    return {
      lines: [
        `// Playwright handles new tabs/windows natively:`,
        `// const [newPage] = await Promise.all([`,
        `//   context.waitForEvent('page'),`,
        `//   page.locator('#triggerButton').click(),`,
        `// ]);`,
      ],
      commandCount,
      rulesApplied: 1,
      manualReview: 0,
    };
  }

  // Unknown stub target — leave TODO
  return {
    lines: [`// TODO: [cy2play] cy.stub() for '${stubbedMethod}' — manual review needed`, `// ${chain}`],
    commandCount,
    rulesApplied: 0,
    manualReview: 1,
  };
}

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
    // cy.contains('text') → page.getByText('text')
    // cy.contains('selector', 'text') → page.locator('selector').filter({ hasText: 'text' })
    const containsArgs = parseContainsArgs(first.rawArgs);
    if (containsArgs.selector) {
      locatorExpr = `page.locator('${containsArgs.selector}').filter({ hasText: ${containsArgs.text} })`;
    } else {
      locatorExpr = `page.getByText(${first.rawArgs})`;
    }
  } else {
    // Check if this is an alias reference like cy.get('@windowOpen')
    const selectorValue = stripQuotes(first.rawArgs);
    if (selectorValue.startsWith('@')) {
      // Alias reference — likely a stub/spy alias. Check if the rest has stub assertions.
      const hasStubAssertion = rest.some(c =>
        c.method === 'should' && (
          c.rawArgs.includes('be.called') ||
          c.rawArgs.includes('have.been.called')
        )
      );
      if (hasStubAssertion) {
        // This is a stub verification like cy.get('@windowOpen').should('be.called')
        // Already handled by popup/dialog pattern in cy.stub() conversion
        return {
          lines: [`// Stub alias '${selectorValue}' assertion — handled by Playwright's popup/dialog pattern above`],
          commandCount,
          rulesApplied: 1,
          manualReview: 0,
        };
      }
      // Generic alias — no direct Playwright equivalent
      return {
        lines: [`// TODO: [cy2play] Alias reference cy.get('${selectorValue}') — aliases need manual conversion`],
        commandCount,
        rulesApplied: 0,
        manualReview: 1,
      };
    }
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
    if (call.method === 'next') {
      if (call.rawArgs.trim()) {
        // .next('selector') → locator('+ selector')
        pendingLocator = `${pendingLocator}.locator('+ ${stripQuotes(call.rawArgs)}')`;
      } else {
        // .next() → locator('+ *') — next sibling
        pendingLocator = `${pendingLocator}.locator('+ *')`;
      }
      continue;
    }
    if (call.method === 'prev') {
      // .prev() — no simple CSS, use xpath
      pendingLocator = `${pendingLocator}.locator('xpath=preceding-sibling::*[1]')`;
      continue;
    }
    if (call.method === 'parent') {
      if (call.rawArgs.trim()) {
        pendingLocator = `${pendingLocator}.locator('xpath=ancestor::${stripQuotes(call.rawArgs)}[1]')`;
      } else {
        pendingLocator = `${pendingLocator}.locator('..')`;
      }
      continue;
    }
    if (call.method === 'children') {
      if (call.rawArgs.trim()) {
        pendingLocator = `${pendingLocator}.locator('> ${stripQuotes(call.rawArgs)}')`;
      } else {
        pendingLocator = `${pendingLocator}.locator('> *')`;
      }
      continue;
    }
    if (call.method === 'siblings') {
      pendingLocator = `${pendingLocator}.locator('xpath=preceding-sibling::* | following-sibling::*')`;
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
    if (call.method === 'rightclick') {
      outputLines.push(`await ${pendingLocator}.click({ button: 'right' });`);
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
    if (call.method === 'selectFile') {
      outputLines.push(`await ${pendingLocator}.setInputFiles(${call.rawArgs});`);
      continue;
    }
    if (call.method === 'invoke') {
      const invokeArgs = parseCallArgs(call.rawArgs);
      const methodName = stripQuotes(invokeArgs[0] || '');
      // Check if next in chain is .should() — we may need to capture the value
      const nextCall = (i + 1 < rest.length) ? rest[i + 1] : null;
      if (methodName === 'val') {
        if (nextCall && (nextCall.method === 'should' || nextCall.method === 'and')) {
          // .invoke('val').should('deep.equal', [...]) → evaluate + expect
          const shouldArgs = parseCallArgs(nextCall.rawArgs);
          const chainer = stripQuotes(shouldArgs[0] || '');
          if (chainer === 'deep.equal' || chainer === 'deep.eq' || chainer === 'eql') {
            outputLines.push(`const _val = await ${pendingLocator}.evaluate(el => (el as HTMLSelectElement).value);`);
            outputLines.push(`expect(_val).toEqual(${shouldArgs[1] || '""'});`);
          } else {
            outputLines.push(`const _val = await ${pendingLocator}.inputValue();`);
            outputLines.push(`expect(_val).toBe(${shouldArgs[1] || '""'});`);
          }
          i++; // skip the .should() — we handled it
          continue;
        }
        outputLines.push(`const _val = await ${pendingLocator}.inputValue();`);
        continue;
      }
      if (methodName === 'text') {
        outputLines.push(`const _text = await ${pendingLocator}.textContent();`);
        continue;
      }
      if (methodName === 'html') {
        outputLines.push(`const _html = await ${pendingLocator}.innerHTML();`);
        continue;
      }
      if (methodName === 'attr') {
        const attrName = invokeArgs[1] || "''";
        outputLines.push(`const _attr = await ${pendingLocator}.getAttribute(${attrName});`);
        continue;
      }
      if (methodName === 'show') {
        outputLines.push(`await ${pendingLocator}.evaluate(el => el.style.display = '');`);
        continue;
      }
      if (methodName === 'hide') {
        outputLines.push(`await ${pendingLocator}.evaluate(el => el.style.display = 'none');`);
        continue;
      }
      if (methodName === 'removeAttr') {
        const attrName = invokeArgs[1] || "''";
        outputLines.push(`await ${pendingLocator}.evaluate((el, attr) => el.removeAttribute(attr), ${attrName});`);
        continue;
      }
      if (methodName === 'css') {
        if (invokeArgs.length >= 3) {
          // .invoke('css', 'prop', 'value') — set CSS
          outputLines.push(`await ${pendingLocator}.evaluate((el, [p, v]) => el.style[p] = v, [${invokeArgs[1]}, ${invokeArgs[2]}]);`);
        } else {
          // .invoke('css', 'prop') — get CSS
          outputLines.push(`const _css = await ${pendingLocator}.evaluate((el, p) => getComputedStyle(el)[p], ${invokeArgs[1] || "''"});`);
        }
        continue;
      }
      if (methodName === 'prop') {
        const propName = invokeArgs[1] || "''";
        outputLines.push(`const _prop = await ${pendingLocator}.evaluate((el, p) => el[p], ${propName});`);
        continue;
      }
      // Generic invoke — use evaluate
      const extraArgs = invokeArgs.slice(1).join(', ');
      outputLines.push(`await ${pendingLocator}.evaluate((el) => el.${methodName}(${extraArgs}));`);
      continue;
    }
    if (call.method === 'trigger') {
      const triggerArgs = parseCallArgs(call.rawArgs);
      const eventName = stripQuotes(triggerArgs[0] || '');
      if (eventName === 'mouseover' || eventName === 'mouseenter') {
        outputLines.push(`await ${pendingLocator}.hover();`);
      } else if (eventName === 'mouseout' || eventName === 'mouseleave') {
        outputLines.push(`await ${pendingLocator}.dispatchEvent('${eventName}');`);
      } else if (eventName === 'change' || eventName === 'input' || eventName === 'scroll' || eventName === 'submit' || eventName === 'reset' || eventName === 'focus' || eventName === 'blur') {
        outputLines.push(`await ${pendingLocator}.dispatchEvent('${eventName}');`);
      } else {
        outputLines.push(`await ${pendingLocator}.dispatchEvent('${eventName}');`);
      }
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

    // --- .within() — scoped locator context ---
    if (call.method === 'within') {
      // Output: const _scope = page.locator(selector);
      // The inner cy.get() calls on subsequent lines will need manual scoping.
      // We emit a helpful comment + variable for the developer.
      outputLines.push(`// Scoped within: ${pendingLocator}`);
      outputLines.push(`// Inner cy.get()/cy.contains() calls below should use this locator as parent`);
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

  // --- Stub/spy assertions: .should('be.called'), .should('have.been.calledWith', ...) ---
  if (baseChainer === 'be.called' || baseChainer === 'have.been.called' || baseChainer === 'be.calledOnce' || baseChainer === 'have.been.calledWith') {
    return {
      lines: [`// Stub assertion (.should('${chainer}')) — handled by Playwright's popup/dialog pattern above`],
      isManual: false,
    };
  }

  // Unrecognized assertion
  return {
    lines: [`// TODO: [cy2play] Unrecognized assertion .should('${chainer}') — manual review needed`],
    isManual: true,
  };
}

// ---------------------------------------------------------------------------
// Multi-line block handlers
// ---------------------------------------------------------------------------

/**
 * Accumulate a multi-line block starting from a given line index.
 * Uses indent-based detection: the block ends when we see a line at or below
 * the starting indent that ends with `});` — the final closing of the full statement.
 */
function accumulateBlock(allLines: string[], startIndex: number): { blockLines: string[]; endIndex: number } {
  const blockLines: string[] = [];
  const startIndentLen = getIndent(allLines[startIndex]).length;
  let i = startIndex;

  // First line is always included
  blockLines.push(allLines[i]);
  i++;

  // Accumulate until we find `});` at the start indent level (closing the whole chain)
  for (; i < allLines.length; i++) {
    const line = allLines[i];
    blockLines.push(line);
    const trimmed = line.trim();
    const indentLen = getIndent(line).length;

    // The block ends when we hit `});` at the same or lesser indent as the starting line
    if ((trimmed === '});' || trimmed === '});') && indentLen <= startIndentLen) {
      break;
    }
  }

  return { blockLines, endIndex: i };
}

/**
 * Convert a multi-line cy.request({...}).then((response) => {...}) block
 * into Playwright APIRequestContext calls.
 *
 * Pattern:
 *   cy.request({
 *     method: 'GET',
 *     url: `${baseUrl}/path`,
 *     body: { ... },
 *     headers: { ... },
 *     qs: { ... },
 *     failOnStatusCode: false,
 *   }).then((response) => {
 *     expect(response.status).to.eq(200);
 *     expect(response.body.key).to.eq('value');
 *   });
 *
 * Output:
 *   const response = await request.get(`${baseUrl}/path`, { data: {...}, headers: {...} });
 *   expect(response.status()).toBe(200);
 *   const body = await response.json();
 *   expect(body.key).toBe('value');
 */
function convertCyRequest(
  blockLines: string[],
  filePath: string,
  line: number,
  warnings: Warning[],
  _unresolvedNodes: UnresolvedNode[],
): ChainConversionResult {
  const fullBlock = blockLines.map(l => l.trim()).join(' ');
  const outputLines: string[] = [];
  let rulesApplied = 0;

  // --- Parse the request options ---
  const methodMatch = fullBlock.match(/method\s*:\s*['"](\w+)['"]/);
  const urlMatch = fullBlock.match(/url\s*:\s*(`[^`]+`|'[^']+'|"[^"]+")/);
  const hasBody = fullBlock.match(/body\s*:\s*(\{[\s\S]*?\})\s*,?\s*(headers|qs|failOnStatusCode|\})/);
  const hasHeaders = fullBlock.match(/headers\s*:\s*\{/);
  const hasQs = fullBlock.match(/qs\s*:\s*\{/);
  const failOnStatusCode = fullBlock.match(/failOnStatusCode\s*:\s*false/);

  const httpMethod = methodMatch ? methodMatch[1].toLowerCase() : 'get';
  const urlExpr = urlMatch ? urlMatch[1] : "'/'";

  // Build the Playwright request options
  const opts: string[] = [];

  // Extract body block if present
  if (hasBody) {
    // Find the body object — extract from the original lines for proper formatting
    const bodyLines = extractObjectProp(blockLines, 'body');
    if (bodyLines) {
      opts.push(`data: ${bodyLines}`);
    }
  }

  // Extract headers block
  if (hasHeaders) {
    const headersLines = extractObjectProp(blockLines, 'headers');
    if (headersLines) {
      opts.push(`headers: ${headersLines}`);
    }
  }

  // Extract query string
  if (hasQs) {
    const qsLines = extractObjectProp(blockLines, 'qs');
    if (qsLines) {
      opts.push(`params: ${qsLines}`);
    }
  }

  // Build the request call
  const optsStr = opts.length > 0 ? `, { ${opts.join(', ')} }` : '';
  outputLines.push(`const response = await request.${httpMethod}(${urlExpr}${optsStr});`);
  rulesApplied++;

  // --- Parse the .then() callback body ---
  // Find lines between .then((response) => { and the closing });
  let inThenBody = false;
  let needsBodyVar = false;
  let thenBodyDepth = 0;

  for (const rawLine of blockLines) {
    const t = rawLine.trim();

    // Detect the .then() opener
    if (!inThenBody && (t.match(/\}\s*\)\s*\.then\s*\(\s*\(\s*\w+\s*\)\s*=>\s*\{/) || t.match(/\.then\s*\(\s*\(\s*\w+\s*\)\s*=>\s*\{/))) {
      inThenBody = true;
      thenBodyDepth = 1; // we're inside the { of the .then() callback
      continue;
    }

    if (!inThenBody) continue;

    // Track brace depth within the .then() body to handle nested closures like forEach
    for (const ch of t) {
      if (ch === '{') thenBodyDepth++;
      if (ch === '}') thenBodyDepth--;
    }

    // Closing of the .then() callback — depth returned to 0
    if (thenBodyDepth <= 0) {
      break;
    }

    // Convert Chai-style assertions on response
    if (t.match(/expect\(response\.status\)/)) {
      const valMatch = t.match(/\.to\.(eq|equal|equals)\((\d+)\)/);
      if (valMatch) {
        outputLines.push(`expect(response.status()).toBe(${valMatch[2]});`);
        rulesApplied++;
      } else {
        outputLines.push(`// ${t}`);
      }
      continue;
    }

    if (t.match(/expect\(response\.body\)/)) {
      needsBodyVar = true;
      // response.body direct assertion: expect(response.body).to.eq(true)
      const eqMatch = t.match(/\.to\.(eq|equal)\((.+)\)/);
      const beMatch = t.match(/\.to\.be\.an?\((.+)\)/);
      const propMatch = t.match(/\.to\.have\.property\((.+)\)/);
      if (eqMatch) {
        outputLines.push(`expect(body).toBe(${eqMatch[2]});`);
        rulesApplied++;
      } else if (beMatch) {
        const typeStr = stripQuotes(beMatch[1]);
        if (typeStr === 'array') {
          outputLines.push(`expect(Array.isArray(body)).toBe(true);`);
        } else if (typeStr === 'object') {
          outputLines.push(`expect(typeof body).toBe('object');`);
        } else if (typeStr === 'string') {
          outputLines.push(`expect(typeof body).toBe('string');`);
        } else {
          outputLines.push(`// ${t}`);
        }
        rulesApplied++;
      } else if (propMatch) {
        outputLines.push(`expect(body).toHaveProperty(${propMatch[1]});`);
        rulesApplied++;
      } else {
        outputLines.push(`// ${t}`);
      }
      continue;
    }

    if (t.match(/expect\(response\.body\./)) {
      needsBodyVar = true;
      // response.body.xxx assertions
      const bodyPropExpr = t.match(/expect\(response\.body\.(.+?)\)/);
      if (bodyPropExpr) {
        const propExpr = bodyPropExpr[1];
        // Replace response.body.xxx with body.xxx
        const eqMatch = t.match(/\.to\.(eq|equal|equals)\((.+)\)/);
        const beAMatch = t.match(/\.to\.be\.an?\((.+)\)/);
        const haveLength = t.match(/\.to\.have\.length\((\d+)\)/);
        const haveLengthGt = t.match(/\.to\.have\.length\.greaterThan\((\d+)\)|\.length\)\.to\.be\.greaterThan\((\d+)\)/);
        const propMatch = t.match(/\.to\.have\.property\((.+)\)/);
        const beGt = t.match(/\.to\.be\.greaterThan\((\d+)\)/);

        if (eqMatch) {
          outputLines.push(`expect(body.${propExpr}).toBe(${eqMatch[2]});`);
          rulesApplied++;
        } else if (beAMatch) {
          const typeStr = stripQuotes(beAMatch[1]);
          if (typeStr === 'array') {
            outputLines.push(`expect(Array.isArray(body.${propExpr})).toBe(true);`);
          } else if (typeStr === 'string') {
            outputLines.push(`expect(typeof body.${propExpr}).toBe('string');`);
          } else {
            outputLines.push(`// ${t}`);
          }
          rulesApplied++;
        } else if (haveLength) {
          outputLines.push(`expect(body.${propExpr}).toHaveLength(${haveLength[1]});`);
          rulesApplied++;
        } else if (haveLengthGt) {
          const val = haveLengthGt[1] || haveLengthGt[2] || '0';
          // If propExpr is or ends with 'length', don't append .length again
          const lengthExpr = (propExpr === 'length' || propExpr.endsWith('.length'))
            ? `body.${propExpr}` : `body.${propExpr}.length`;
          outputLines.push(`expect(${lengthExpr}).toBeGreaterThan(${val});`);
          rulesApplied++;
        } else if (propMatch) {
          outputLines.push(`expect(body.${propExpr}).toHaveProperty(${propMatch[1]});`);
          rulesApplied++;
        } else if (beGt) {
          outputLines.push(`expect(body.${propExpr}).toBeGreaterThan(${beGt[1]});`);
          rulesApplied++;
        } else {
          outputLines.push(`// ${t}`);
        }
      } else {
        outputLines.push(`// ${t}`);
      }
      continue;
    }

    // forEach on response body (e.g., response.body.forEach((pet: any) => { ... }))
    if (t.match(/response\.body\.forEach/)) {
      needsBodyVar = true;
      outputLines.push(t.replace('response.body', 'body'));
      rulesApplied++;
      continue;
    }

    // Variable assignments from response.body
    if (t.match(/=\s*response\.body\./)) {
      needsBodyVar = true;
      outputLines.push(t.replace(/response\.body/g, 'body'));
      rulesApplied++;
      continue;
    }

    // Lines within forEach callbacks
    if (t.match(/expect\(\w+\.status\)\.to\.(eq|equal)\(/)) {
      // expect(pet.status).to.eq('available') — inside forEach
      const m = t.match(/expect\((\w+)\.(\w+)\)\.to\.(eq|equal)\((.+)\)/);
      if (m) {
        outputLines.push(`expect(${m[1]}.${m[2]}).toBe(${m[4]});`);
        rulesApplied++;
        continue;
      }
    }

    // Comments — pass through
    if (t.startsWith('//')) {
      outputLines.push(t);
      continue;
    }

    // Other variable declarations (const book = ...) — pass through with body replacement
    if (t.match(/^(const|let|var)\s+/)) {
      needsBodyVar = true;
      outputLines.push(t.replace(/response\.body/g, 'body'));
      rulesApplied++;
      continue;
    }

    // Expect on a local variable (e.g., expect(book).to.have.property('isbn'))
    if (t.match(/^expect\(\w+\)\.to\./)) {
      const localPropMatch = t.match(/expect\((\w+)\)\.to\.have\.property\((.+)\)/);
      const localEqMatch = t.match(/expect\((\w+)\)\.to\.(eq|equal)\((.+)\)/);
      if (localPropMatch) {
        outputLines.push(`expect(${localPropMatch[1]}).toHaveProperty(${localPropMatch[2]});`);
        rulesApplied++;
      } else if (localEqMatch) {
        outputLines.push(`expect(${localEqMatch[1]}).toBe(${localEqMatch[3]});`);
        rulesApplied++;
      } else {
        outputLines.push(`// ${t}`);
      }
      continue;
    }

    // Pass through closing braces
    if (t === '}' || t === '});' || t === '},') {
      outputLines.push(t);
      continue;
    }

    // Anything else — pass through
    outputLines.push(t);
  }

  // Insert `const body = await response.json();` if we need it
  if (needsBodyVar) {
    // Insert after the request line
    outputLines.splice(1, 0, `const body = await response.json();`);
    rulesApplied++;
  }

  if (failOnStatusCode) {
    warnings.push({
      severity: 'info',
      message: `cy.request() with failOnStatusCode: false — Playwright's request API does not fail on non-2xx by default.`,
      filePath,
      line,
    });
  }

  return {
    lines: outputLines,
    commandCount: 1,
    rulesApplied,
    manualReview: 0,
  };
}

/**
 * Extract an object property value from a block of lines.
 * E.g., extract the object assigned to `body:` from the request config.
 */
function extractObjectProp(blockLines: string[], propName: string): string | null {
  const joined = blockLines.map(l => l.trim()).join('\n');
  // Find propName: { ... } or propName: value,
  const propRegex = new RegExp(`${propName}\\s*:\\s*`);
  const startIdx = joined.search(propRegex);
  if (startIdx === -1) return null;

  const afterProp = joined.slice(startIdx).replace(propRegex, '');
  if (afterProp.startsWith('{')) {
    // Extract balanced braces
    let depth = 0;
    let i = 0;
    for (; i < afterProp.length; i++) {
      if (afterProp[i] === '{') depth++;
      if (afterProp[i] === '}') depth--;
      if (depth === 0) break;
    }
    return afterProp.slice(0, i + 1).replace(/\n/g, ' ');
  }
  // Simple value
  const simpleMatch = afterProp.match(/^([^,\n}]+)/);
  return simpleMatch ? simpleMatch[1].trim() : null;
}

/**
 * Parse cy.contains() arguments to detect one-arg vs two-arg forms.
 *   cy.contains('text')             → { selector: null, text: "'text'" }
 *   cy.contains('td', 'Student')    → { selector: 'td', text: "'Student'" }
 */
function parseContainsArgs(rawArgs: string): { selector: string | null; text: string } {
  // Two-arg form: 'selector', 'text'
  const twoArgMatch = rawArgs.match(/^(['"])(.+?)\1\s*,\s*(['"])(.+?)\3/);
  if (twoArgMatch) {
    return { selector: twoArgMatch[2], text: `${twoArgMatch[3]}${twoArgMatch[4]}${twoArgMatch[3]}` };
  }
  // Single arg form
  return { selector: null, text: rawArgs };
}

/**
 * Convert a multi-line cy.window().then((win) => { ... }) block.
 * The inner body typically contains cy.stub(win, 'method') calls.
 * We skip the wrapper and convert each inner cy.* line normally.
 */
function convertWindowThenBlock(
  blockLines: string[],
  filePath: string,
  line: number,
  warnings: Warning[],
  unresolvedNodes: UnresolvedNode[],
  customCommandMap?: Map<string, CustomCommandDef>,
): ChainConversionResult {
  const outputLines: string[] = [];
  let rulesApplied = 1; // count the wrapper as handled
  let manualReview = 0;
  let totalCommands = 0;

  // Process inner lines (the callback body)
  let inBody = false;
  for (const rawLine of blockLines) {
    const t = rawLine.trim();

    // Detect the .then() opener
    if (!inBody && t.match(/\.then\s*\(\s*\(\s*\w+\s*\)\s*=>\s*\{/)) {
      inBody = true;
      continue;
    }
    // Closing of the .then() callback
    if (inBody && (t === '});' || t === '})')) {
      break;
    }

    if (!inBody) continue;
    if (t === '') continue;

    // Convert inner cy.* chains
    if (t.match(/^cy\./)) {
      const result = convertCypressChain(t, filePath, line, warnings, unresolvedNodes, customCommandMap);
      outputLines.push(...result.lines);
      totalCommands += result.commandCount;
      rulesApplied += result.rulesApplied;
      manualReview += result.manualReview;
    } else {
      // Pass through other lines (comments, etc.)
      outputLines.push(t);
    }
  }

  return {
    lines: outputLines,
    commandCount: totalCommands || 1,
    rulesApplied,
    manualReview,
  };
}

/**
 * Convert a multi-line cy.get(selector).within(() => { ... }) block.
 * The .within() callback body contains cy.* chains scoped to the parent element.
 *
 * Strategy: extract the scope selector, then convert each inner cy.* line
 * replacing `page.locator(...)` with scoped `scope.locator(...)` references.
 */
function convertWithinBlock(
  blockLines: string[],
  filePath: string,
  line: number,
  warnings: Warning[],
  unresolvedNodes: UnresolvedNode[],
  customCommandMap?: Map<string, CustomCommandDef>,
): ChainConversionResult {
  const outputLines: string[] = [];
  let rulesApplied = 0;
  let manualReview = 0;
  let totalCommands = 0;

  const firstLine = blockLines[0].trim();

  // Extract the scope selector from cy.get('selector').within(...)
  const selectorMatch = firstLine.match(/^cy\.get\s*\(\s*(['"`])(.+?)\1/);
  const scopeSelector = selectorMatch ? selectorMatch[2] : '.unknown';

  // Emit scope variable
  const scopeVar = '_scope';
  outputLines.push(`const ${scopeVar} = page.locator('${scopeSelector}');`);
  rulesApplied++;

  // Process inner lines (the callback body)
  let inBody = false;
  for (const rawLine of blockLines) {
    const t = rawLine.trim();

    // Detect the .within() opener
    if (t.match(/\.within\s*\(\s*(\(\s*\)\s*=>|function)\s*\{/)) {
      inBody = true;
      continue;
    }
    // Closing of the .within() callback
    if (inBody && (t === '});' || t === '})')) {
      break;
    }

    if (!inBody) continue;

    // Skip empty lines
    if (t === '') {
      outputLines.push('');
      continue;
    }

    // Convert inner cy.* chains
    if (t.match(/^cy\./)) {
      const result = convertCypressChain(t, filePath, line, warnings, unresolvedNodes, customCommandMap);
      for (const convertedLine of result.lines) {
        // Replace page.locator/page.getByText with scope-relative versions
        const scoped = convertedLine
          .replace(/page\.locator\(/g, `${scopeVar}.locator(`)
          .replace(/page\.getByText\(/g, `${scopeVar}.getByText(`)
          .replace(/page\.getByRole\(/g, `${scopeVar}.getByRole(`)
          .replace(/page\.getByLabel\(/g, `${scopeVar}.getByLabel(`)
          .replace(/page\.getByPlaceholder\(/g, `${scopeVar}.getByPlaceholder(`);
        outputLines.push(scoped);
      }
      totalCommands += result.commandCount;
      rulesApplied += result.rulesApplied;
      manualReview += result.manualReview;
    } else {
      // Pass through other lines (comments, etc.)
      outputLines.push(t);
    }
  }

  return {
    lines: outputLines,
    commandCount: totalCommands || 1,
    rulesApplied,
    manualReview,
  };
}

/**
 * Convert a multi-line cy.get(selector).should(($el) => { ... }) callback block
 * into Playwright's `expect(async () => { ... }).toPass({ timeout })` pattern.
 *
 * Handles:
 *   1. $el.attr('name') → locator.getAttribute('name')
 *   2. $el.filter((_, el) => ...) → page.evaluate() with querySelectorAll
 *   3. Chai assertions → Playwright assertions
 *   4. timeout option from cy.get(selector, { timeout: N })
 */
function convertCallbackShould(
  blockLines: string[],
  filePath: string,
  line: number,
  warnings: Warning[],
): ChainConversionResult {
  const outputLines: string[] = [];
  let rulesApplied = 0;
  let manualReview = 0;

  const joined = blockLines.join('\n');
  const firstLine = blockLines[0].trim();

  // --- Extract selector ---
  const selectorMatch = firstLine.match(/^cy\.(get|contains)\s*\(\s*(['"`])(.+?)\2/);
  const selector = selectorMatch ? selectorMatch[3] : '.unknown';
  const locatorMethod = selectorMatch?.[1] === 'contains' ? 'getByText' : 'locator';
  const locatorExpr = locatorMethod === 'getByText'
    ? `page.getByText(${selectorMatch?.[2]}${selector}${selectorMatch?.[2]})`
    : `page.locator('${selector}')`;

  // --- Extract timeout option ---
  const timeoutMatch = firstLine.match(/\{\s*timeout\s*:\s*(\d+)\s*\}/);
  const timeout = timeoutMatch ? parseInt(timeoutMatch[1], 10) : null;

  // --- Extract callback variable name: .should(($el) => { ---
  const callbackMatch = joined.match(/\.should\s*\(\s*\(\s*(\$?\w+)\s*\)\s*=>\s*\{/);
  const callbackVar = callbackMatch ? callbackMatch[1] : '$el';

  // --- Extract callback body lines ---
  const bodyLines: string[] = [];
  let inBody = false;
  for (const rawLine of blockLines) {
    const t = rawLine.trim();
    if (!inBody) {
      if (t.match(/\.should\s*\(\s*\(\s*\$?\w+\s*\)\s*=>\s*\{/)) {
        // If there's code after the opening brace on the same line, grab it
        const afterBrace = t.replace(/^.*\.should\s*\(\s*\(\s*\$?\w+\s*\)\s*=>\s*\{\s*/, '');
        if (afterBrace && afterBrace !== '}' && afterBrace !== '});') {
          bodyLines.push(afterBrace);
        }
        inBody = true;
      }
      continue;
    }
    if (t === '});' || t === '})') break;
    if (t !== '') bodyLines.push(t);
  }

  // --- Detect which pattern this is and convert ---
  const bodyJoined = bodyLines.join('\n');

  // Pattern A: $el.attr('attrName') usage → getAttribute
  if (bodyJoined.includes(`${callbackVar}.attr(`)) {
    // e.g.: const value = parseInt($bar.attr('aria-valuenow') || '0');
    //       expect(value).to.be.greaterThan(0);
    const innerLines: string[] = [];
    for (const bLine of bodyLines) {
      let converted = bLine;
      // Replace $el.attr('x') → await <locator>.getAttribute('x')
      converted = converted.replace(
        new RegExp(`${escapeRegex(callbackVar)}\\.attr\\(\\s*(['"])(.+?)\\1\\s*\\)`, 'g'),
        `await ${locatorExpr}.getAttribute('$2')`,
      );
      // Convert Chai assertions to Playwright
      converted = convertChaiToPlaywright(converted);
      innerLines.push(converted);
    }
    outputLines.push(`await expect(async () => {`);
    for (const il of innerLines) {
      outputLines.push(`  ${il}`);
    }
    const toPassOpts = timeout ? `{ timeout: ${timeout} }` : '';
    outputLines.push(`}).toPass(${toPassOpts});`);
    rulesApplied++;
  }
  // Pattern B: $el.filter(...) with textContent → page.evaluate + querySelectorAll
  else if (bodyJoined.includes(`${callbackVar}.filter(`)) {
    // e.g.: const withContent = $groups.filter((_, el) => el.textContent.trim() !== '');
    //       expect(withContent.length).to.eq(1);
    outputLines.push(`await expect(async () => {`);
    outputLines.push(`  const allElements = await ${locatorExpr}.all();`);

    // Parse the filter callback to extract the condition
    const filterMatch = bodyJoined.match(
      new RegExp(`${escapeRegex(callbackVar)}\\.filter\\s*\\(\\s*\\(\\s*_?\\s*,?\\s*(\\w+)\\s*\\)\\s*=>\\s*(.+?)\\)\\s*;`)
    );

    if (filterMatch) {
      const elVar = filterMatch[1];
      const condition = filterMatch[2].trim();
      // Convert textContent access for Playwright
      let pwCondition = condition;
      if (condition.includes(`${elVar}.textContent`)) {
        // Convert to async Playwright check
        const resultVar = bodyJoined.match(/const\s+(\w+)\s*=\s*/)?.[1] || 'filtered';
        outputLines.push(`  const ${resultVar} = [];`);
        outputLines.push(`  for (const el of allElements) {`);

        // Rewrite condition: el.textContent.trim() !== '' → (await el.textContent())?.trim() !== ''
        let asyncCondition = pwCondition.replace(
          new RegExp(`${escapeRegex(elVar)}\\.textContent`, 'g'),
          `(await el.textContent())`,
        );
        outputLines.push(`    if (${asyncCondition}) ${resultVar}.push(el);`);
        outputLines.push(`  }`);

        // Find the assertion line
        const assertLine = bodyLines.find(bl => bl.includes('expect('));
        if (assertLine) {
          const convertedAssert = convertChaiToPlaywright(assertLine);
          outputLines.push(`  ${convertedAssert}`);
        }
      }
    } else {
      // Fallback: emit a TODO for unrecognized filter patterns
      outputLines.push(`  // TODO: [cy2play] Unrecognized .filter() pattern — manual review needed`);
      manualReview++;
    }

    const toPassOpts = timeout ? `{ timeout: ${timeout} }` : '';
    outputLines.push(`}).toPass(${toPassOpts});`);
    rulesApplied++;
  }
  // Pattern C: general callback — emit best-effort conversion
  else {
    outputLines.push(`await expect(async () => {`);
    for (const bLine of bodyLines) {
      let converted = bLine;
      // Replace $el[0] → await <locator>.elementHandle() etc.
      converted = converted.replace(
        new RegExp(`${escapeRegex(callbackVar)}\\[0\\]`, 'g'),
        `(await ${locatorExpr}.elementHandle())`,
      );
      converted = convertChaiToPlaywright(converted);
      outputLines.push(`  ${converted}`);
    }
    const toPassOpts = timeout ? `{ timeout: ${timeout} }` : '';
    outputLines.push(`}).toPass(${toPassOpts});`);
    rulesApplied++;
    warnings.push({
      severity: 'info',
      message: `Converted callback .should() — verify the inner logic is correct.`,
      filePath,
      line,
    });
  }

  return {
    lines: outputLines,
    commandCount: 1,
    rulesApplied,
    manualReview,
  };
}

/** Convert common Chai assertion expressions to Playwright/Jest equivalents */
function convertChaiToPlaywright(line: string): string {
  let converted = line;
  // expect(x).to.be.greaterThan(n) → expect(x).toBeGreaterThan(n)
  converted = converted.replace(/\.to\.be\.greaterThan\(/g, '.toBeGreaterThan(');
  // expect(x).to.be.lessThan(n) → expect(x).toBeLessThan(n)
  converted = converted.replace(/\.to\.be\.lessThan\(/g, '.toBeLessThan(');
  // expect(x).to.be.at\.least(n) → expect(x).toBeGreaterThanOrEqual(n)
  converted = converted.replace(/\.to\.be\.at\.least\(/g, '.toBeGreaterThanOrEqual(');
  // expect(x).to.eq(n) or .to.equal(n) → .toBe(n)
  converted = converted.replace(/\.to\.eq\(/g, '.toBe(');
  converted = converted.replace(/\.to\.equal\(/g, '.toBe(');
  converted = converted.replace(/\.to\.eql\(/g, '.toEqual(');
  converted = converted.replace(/\.to\.deep\.equal\(/g, '.toEqual(');
  // expect(x).to.be.true → expect(x).toBe(true)
  converted = converted.replace(/\.to\.be\.true\b/g, '.toBe(true)');
  // expect(x).to.be.false → expect(x).toBe(false)
  converted = converted.replace(/\.to\.be\.false\b/g, '.toBe(false)');
  // expect(x).to.be.null → expect(x).toBeNull()
  converted = converted.replace(/\.to\.be\.null\b/g, '.toBeNull()');
  // expect(x).to.be.undefined → expect(x).toBeUndefined()
  converted = converted.replace(/\.to\.be\.undefined\b/g, '.toBeUndefined()');
  // expect(x).to.include(y) / .to.contain(y) → .toContain(y)
  converted = converted.replace(/\.to\.include\(/g, '.toContain(');
  converted = converted.replace(/\.to\.contain\(/g, '.toContain(');
  // expect(x).to.have.length(n) → .toHaveLength(n)
  converted = converted.replace(/\.to\.have\.length\(/g, '.toHaveLength(');
  // expect(x).to.exist → expect(x).toBeTruthy()
  converted = converted.replace(/\.to\.exist\b/g, '.toBeTruthy()');
  // expect(x).to.not. → .not.
  converted = converted.replace(/\.to\.not\./g, '.not.');
  // expect(x).to.be.above → .toBeGreaterThan
  converted = converted.replace(/\.to\.be\.above\(/g, '.toBeGreaterThan(');
  // expect(x).to.be.below → .toBeLessThan
  converted = converted.replace(/\.to\.be\.below\(/g, '.toBeLessThan(');
  return converted;
}

/**
 * Convert a multi-line cy.get(selector).then(($el) => { ... }) block
 * where the body performs native DOM manipulation (e.g. slider value setting).
 * Converts to page.evaluate() or appropriate Playwright API calls.
 */
function convertCallbackThen(
  blockLines: string[],
  filePath: string,
  line: number,
  warnings: Warning[],
): ChainConversionResult {
  const outputLines: string[] = [];
  let rulesApplied = 0;
  let manualReview = 0;

  const firstLine = blockLines[0].trim();

  // --- Extract selector ---
  const selectorMatch = firstLine.match(/^cy\.get\s*\(\s*(['"`])(.+?)\1/);
  const selector = selectorMatch ? selectorMatch[2] : '.unknown';

  // --- Extract callback variable name: .then(($el) => { ---
  const joined = blockLines.join('\n');
  const callbackMatch = joined.match(/\.then\s*\(\s*\(\s*(\$?\w+)\s*\)\s*=>\s*\{/);
  const callbackVar = callbackMatch ? callbackMatch[1] : '$el';

  // --- Extract body lines ---
  const bodyLines: string[] = [];
  let inBody = false;
  for (const rawLine of blockLines) {
    const t = rawLine.trim();
    if (!inBody) {
      if (t.match(/\.then\s*\(\s*\(\s*\$?\w+\s*\)\s*=>\s*\{/)) {
        inBody = true;
      }
      continue;
    }
    if (t === '});' || t === '})') break;
    if (t !== '') bodyLines.push(t);
  }

  const bodyJoined = bodyLines.join('\n');

  // Pattern: nativeInputValueSetter.call($slider[0], 'value') + dispatchEvent
  // This is a native slider value setter pattern → page.fill() or page.evaluate()
  if (bodyJoined.includes('nativeInputValueSetter') || bodyJoined.includes('dispatchEvent')) {
    // Try to extract the value being set
    const valueMatch = bodyJoined.match(/nativeInputValueSetter\.call\s*\(\s*\$?\w+\[0\]\s*,\s*['"](.+?)['"]\s*\)/);
    const setValue = valueMatch ? valueMatch[1] : null;

    if (setValue) {
      // Use page.fill() for input range sliders
      outputLines.push(`await page.locator('${selector}').fill('${setValue}');`);
      rulesApplied++;
    } else {
      // Fallback: wrap the whole thing in page.evaluate
      outputLines.push(`await page.evaluate(() => {`);
      outputLines.push(`  const el = document.querySelector('${selector}') as HTMLInputElement;`);
      for (const bLine of bodyLines) {
        let converted = bLine;
        converted = converted.replace(new RegExp(`${escapeRegex(callbackVar)}\\[0\\]`, 'g'), 'el');
        outputLines.push(`  ${converted}`);
      }
      outputLines.push(`});`);
      rulesApplied++;
      warnings.push({
        severity: 'info',
        message: `Converted .then() native DOM block to page.evaluate() — verify correctness.`,
        filePath,
        line,
      });
    }
  }
  // Generic fallback: wrap in page.evaluate
  else {
    outputLines.push(`await page.evaluate(() => {`);
    outputLines.push(`  const el = document.querySelector('${selector}');`);
    for (const bLine of bodyLines) {
      let converted = bLine;
      converted = converted.replace(new RegExp(`${escapeRegex(callbackVar)}\\[0\\]`, 'g'), 'el');
      converted = converted.replace(new RegExp(escapeRegex(callbackVar), 'g'), 'el');
      outputLines.push(`  ${converted}`);
    }
    outputLines.push(`});`);
    rulesApplied++;
    warnings.push({
      severity: 'info',
      message: `Converted .then() callback to page.evaluate() — verify correctness.`,
      filePath,
      line,
    });
  }

  return {
    lines: outputLines,
    commandCount: 1,
    rulesApplied,
    manualReview,
  };
}

/**
 * Convert a multi-line cy.fixture('name').then((data) => { ... }) block.
 * The .then() callback body contains cy.* chains using the fixture data.
 *
 * We convert by:
 * 1. Emitting an import statement for the fixture JSON
 * 2. Processing each cy.* line inside the .then() callback body normally
 *    (replacing the data variable references with the imported fixture name)
 */
function convertCyFixtureBlock(
  blockLines: string[],
  filePath: string,
  line: number,
  warnings: Warning[],
  unresolvedNodes: UnresolvedNode[],
): ChainConversionResult {
  const outputLines: string[] = [];
  let rulesApplied = 0;
  let manualReview = 0;
  let totalCommands = 0;

  // Extract fixture name
  const firstLine = blockLines[0].trim();
  const fixtureMatch = firstLine.match(/cy\.fixture\s*\(\s*['"](\w+)['"]\s*\)/);
  const fixtureName = fixtureMatch ? fixtureMatch[1] : 'fixture';

  // Extract the variable name from .then((varName) => {)
  const thenMatch = blockLines.join(' ').match(/\.then\s*\(\s*\(\s*(\w+)\s*\)\s*=>\s*\{/);
  const dataVar = thenMatch ? thenMatch[1] : 'data';

  // Emit import comment
  outputLines.push(`// Load fixture: import ${fixtureName} from '../fixtures/${fixtureName}.json';`);
  rulesApplied++;

  // Process inner lines (the callback body)
  let inBody = false;
  for (const rawLine of blockLines) {
    const t = rawLine.trim();

    // Detect the .then() opener
    if (t.match(/\.then\s*\(\s*\(\s*\w+\s*\)\s*=>\s*\{/)) {
      inBody = true;
      continue;
    }
    // Closing of the .then() callback
    if (inBody && (t === '});' || t === '})')) {
      break;
    }

    if (!inBody) continue;

    // Skip empty lines
    if (t === '') {
      outputLines.push('');
      continue;
    }

    // Replace data variable references with fixture name
    let converted = t.replace(new RegExp(`\\b${dataVar}\\.`, 'g'), `${fixtureName}.`);

    // If it's a cy.* chain, convert it
    if (converted.match(/^cy\./)) {
      const result = convertCypressChain(converted, filePath, line, warnings, unresolvedNodes);
      outputLines.push(...result.lines);
      totalCommands += result.commandCount;
      rulesApplied += result.rulesApplied;
      manualReview += result.manualReview;
    } else {
      // Pass through other lines (comments, expect, etc.)
      outputLines.push(converted);
    }
  }

  return {
    lines: outputLines,
    commandCount: totalCommands || 1,
    rulesApplied,
    manualReview,
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
