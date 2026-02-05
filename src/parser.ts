// ============================================================================
// Cy2Play — AST Parser  (The "Reader")
// ============================================================================
//
// Parses a Cypress test file using ts-morph and extracts a structured
// representation of the test file: describes, tests, hooks, Cypress commands,
// imports, and code smells.
// ============================================================================
import { Project, SourceFile, SyntaxKind, Node, CallExpression, ts } from 'ts-morph';
import { isKnownCommand, isComplexCommand } from './mappings/cypress-commands';
import { Warning } from './types';

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/** A single Cypress command call extracted from the AST */
export interface CypressCommand {
  /** The command name, e.g. "get", "visit", "click", "should" */
  name: string;
  /** Raw text of the arguments */
  args: string[];
  /** Whether this is part of a chain (e.g. .click() after .get()) */
  isChained: boolean;
  /** Line number in the source file (1-based) */
  line: number;
  /** Column number (0-based) */
  column: number;
  /** Whether strict engine can handle this */
  isKnown: boolean;
  /** Whether this requires LLM / manual review */
  isComplex: boolean;
  /** The full text of the expression statement this belongs to */
  fullChainText: string;
}

/** A test block (it / specify) */
export interface TestBlock {
  /** Test title */
  title: string;
  /** Callback body source text */
  body: string;
  /** Line number */
  line: number;
  /** Cypress commands found inside this test */
  commands: CypressCommand[];
}

/** A hook block (before, beforeEach, after, afterEach) */
export interface HookBlock {
  type: 'before' | 'beforeEach' | 'after' | 'afterEach';
  body: string;
  line: number;
  commands: CypressCommand[];
}

/** A describe/context block */
export interface DescribeBlock {
  /** Block title */
  title: string;
  line: number;
  /** Nested describes */
  describes: DescribeBlock[];
  /** Tests in this block */
  tests: TestBlock[];
  /** Hooks in this block */
  hooks: HookBlock[];
}

/** Full analysis result for a single Cypress file */
export interface ParseResult {
  /** Original file path */
  filePath: string;
  /** Top-level describe blocks */
  describes: DescribeBlock[];
  /** Top-level hooks (outside any describe) */
  hooks: HookBlock[];
  /** Top-level tests (outside any describe — unusual but possible) */
  tests: TestBlock[];
  /** All Cypress commands found across the file (flat list) */
  allCommands: CypressCommand[];
  /** Import statements found */
  imports: string[];
  /** Code smells / warnings detected during parsing */
  warnings: Warning[];
  /** Summary statistics */
  stats: {
    totalDescribes: number;
    totalTests: number;
    totalHooks: number;
    totalCommands: number;
    knownCommands: number;
    complexCommands: number;
    unknownCommands: number;
  };
}

// ---------------------------------------------------------------------------
// Shared ts-morph project (reuse across calls for performance)
// ---------------------------------------------------------------------------

let sharedProject: Project | null = null;

function getProject(): Project {
  if (!sharedProject) {
    sharedProject = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        allowJs: true,
        jsx: ts.JsxEmit.React,
      },
    });
  }
  return sharedProject;
}

// ---------------------------------------------------------------------------
// Core Parser
// ---------------------------------------------------------------------------

/**
 * Parse a Cypress test file and extract its structure.
 *
 * @param sourceCode  - The raw source code text
 * @param filePath    - The file path (used for diagnostics)
 * @returns A structured `ParseResult`
 */
export function parseFile(sourceCode: string, filePath: string): ParseResult {
  const project = getProject();

  // Create (or overwrite) the in-memory source file
  const existing = project.getSourceFile(filePath);
  if (existing) project.removeSourceFile(existing);
  const sourceFile = project.createSourceFile(filePath, sourceCode);

  const allCommands: CypressCommand[] = [];
  const warnings: Warning[] = [];
  const imports: string[] = [];

  // --- Extract imports ---
  sourceFile.getImportDeclarations().forEach(imp => {
    imports.push(imp.getText());
  });

  // --- Walk the AST ---
  const describes: DescribeBlock[] = [];
  const topHooks: HookBlock[] = [];
  const topTests: TestBlock[] = [];

  // Find top-level expression statements
  sourceFile.getStatements().forEach(statement => {
    if (Node.isExpressionStatement(statement)) {
      const expr = statement.getExpression();
      if (Node.isCallExpression(expr)) {
        const parsed = tryParseBlock(expr, filePath, allCommands, warnings);
        if (parsed) {
          if (parsed.type === 'describe') describes.push(parsed.block as DescribeBlock);
          else if (parsed.type === 'hook') topHooks.push(parsed.block as HookBlock);
          else if (parsed.type === 'test') topTests.push(parsed.block as TestBlock);
        }
      }
    }
  });

  // --- Detect code smells ---
  detectCodeSmells(allCommands, filePath, warnings);

  // --- Compute stats ---
  const knownCommands = allCommands.filter(c => c.isKnown).length;
  const complexCommands = allCommands.filter(c => c.isComplex).length;
  const unknownCommands = allCommands.filter(c => !c.isKnown && !c.isComplex).length;

  return {
    filePath,
    describes,
    hooks: topHooks,
    tests: topTests,
    allCommands,
    imports,
    warnings,
    stats: {
      totalDescribes: countDescribes(describes),
      totalTests: topTests.length + countTestsInDescribes(describes),
      totalHooks: topHooks.length + countHooksInDescribes(describes),
      totalCommands: allCommands.length,
      knownCommands,
      complexCommands,
      unknownCommands,
    },
  };
}

// ---------------------------------------------------------------------------
// Block parsers
// ---------------------------------------------------------------------------

type ParsedBlock =
  | { type: 'describe'; block: DescribeBlock }
  | { type: 'test'; block: TestBlock }
  | { type: 'hook'; block: HookBlock }
  | null;

const DESCRIBE_NAMES = new Set(['describe', 'context']);
const TEST_NAMES = new Set(['it', 'specify']);
const HOOK_NAMES = new Set(['before', 'beforeEach', 'after', 'afterEach']);

function tryParseBlock(
  callExpr: CallExpression,
  filePath: string,
  allCommands: CypressCommand[],
  warnings: Warning[],
): ParsedBlock {
  const callee = callExpr.getExpression();
  const calleeName = callee.getText();

  // Handle describe.only / describe.skip / it.only / it.skip
  const baseName = calleeName.split('.')[0];

  if (DESCRIBE_NAMES.has(baseName)) {
    return { type: 'describe', block: parseDescribe(callExpr, filePath, allCommands, warnings) };
  }

  if (TEST_NAMES.has(baseName)) {
    return { type: 'test', block: parseTest(callExpr, filePath, allCommands, warnings) };
  }

  if (HOOK_NAMES.has(baseName)) {
    return { type: 'hook', block: parseHook(callExpr, baseName as HookBlock['type'], filePath, allCommands, warnings) };
  }

  return null;
}

function parseDescribe(
  callExpr: CallExpression,
  filePath: string,
  allCommands: CypressCommand[],
  warnings: Warning[],
): DescribeBlock {
  const args = callExpr.getArguments();
  const title = args[0] ? stripQuotes(args[0].getText()) : '<untitled>';
  const line = callExpr.getStartLineNumber();

  const nested: DescribeBlock[] = [];
  const tests: TestBlock[] = [];
  const hooks: HookBlock[] = [];

  // The second argument should be the callback
  const callback = args[1];
  if (callback) {
    const body = getCallbackBody(callback);
    if (body) {
      for (const stmt of body) {
        if (Node.isExpressionStatement(stmt)) {
          const expr = stmt.getExpression();
          if (Node.isCallExpression(expr)) {
            const parsed = tryParseBlock(expr, filePath, allCommands, warnings);
            if (parsed) {
              if (parsed.type === 'describe') nested.push(parsed.block as DescribeBlock);
              else if (parsed.type === 'test') tests.push(parsed.block as TestBlock);
              else if (parsed.type === 'hook') hooks.push(parsed.block as HookBlock);
            }
          }
        }
      }
    }
  }

  return { title, line, describes: nested, tests, hooks };
}

function parseTest(
  callExpr: CallExpression,
  filePath: string,
  allCommands: CypressCommand[],
  warnings: Warning[],
): TestBlock {
  const args = callExpr.getArguments();
  const title = args[0] ? stripQuotes(args[0].getText()) : '<untitled>';
  const line = callExpr.getStartLineNumber();

  const callback = args[1];
  const bodyText = callback ? callback.getText() : '';

  const commands = extractCypressCommands(callback, filePath, allCommands);

  return { title, body: bodyText, line, commands };
}

function parseHook(
  callExpr: CallExpression,
  type: HookBlock['type'],
  filePath: string,
  allCommands: CypressCommand[],
  _warnings: Warning[],
): HookBlock {
  const args = callExpr.getArguments();
  const callback = args[0];
  const bodyText = callback ? callback.getText() : '';
  const line = callExpr.getStartLineNumber();

  const commands = extractCypressCommands(callback, filePath, allCommands);

  return { type, body: bodyText, line, commands };
}

// ---------------------------------------------------------------------------
// Cypress command extraction
// ---------------------------------------------------------------------------

/**
 * Walk all call expressions inside a callback and extract Cypress commands.
 */
function extractCypressCommands(
  node: Node | undefined,
  filePath: string,
  allCommands: CypressCommand[],
): CypressCommand[] {
  if (!node) return [];

  const commands: CypressCommand[] = [];

  node.getDescendantsOfKind(SyntaxKind.CallExpression).forEach(call => {
    const cmd = tryExtractCyCommand(call, filePath);
    if (cmd) {
      commands.push(cmd);
      allCommands.push(cmd);
    }
  });

  return commands;
}

/**
 * Check if a CallExpression is a Cypress command (starts with `cy.` or is chained).
 */
function tryExtractCyCommand(call: CallExpression, filePath: string): CypressCommand | null {
  const expr = call.getExpression();
  const fullText = getFullExpressionStatementText(call);

  // Direct cy.xxx() call
  if (Node.isPropertyAccessExpression(expr)) {
    const obj = expr.getExpression();
    const methodName = expr.getName();

    // cy.get(...), cy.visit(...)
    if (obj.getText() === 'cy') {
      return {
        name: methodName,
        args: call.getArguments().map(a => a.getText()),
        isChained: false,
        line: call.getStartLineNumber(),
        column: call.getStartLinePos() != null ? call.getStart() - call.getStartLinePos() : 0,
        isKnown: isKnownCommand(methodName),
        isComplex: isComplexCommand(methodName),
        fullChainText: fullText,
      };
    }

    // Chained call: .click(), .type(), .should(), etc.
    // Check if the chain ultimately starts with cy
    if (isPartOfCyChain(obj)) {
      return {
        name: methodName,
        args: call.getArguments().map(a => a.getText()),
        isChained: true,
        line: call.getStartLineNumber(),
        column: call.getStartLinePos() != null ? call.getStart() - call.getStartLinePos() : 0,
        isKnown: isKnownCommand(methodName),
        isComplex: isComplexCommand(methodName),
        fullChainText: fullText,
      };
    }
  }

  return null;
}

/**
 * Walk up the property-access / call chain to see if it starts with `cy`.
 */
function isPartOfCyChain(node: Node): boolean {
  if (node.getText() === 'cy') return true;

  if (Node.isCallExpression(node)) {
    const callee = node.getExpression();
    return isPartOfCyChain(callee);
  }

  if (Node.isPropertyAccessExpression(node)) {
    const obj = node.getExpression();
    return isPartOfCyChain(obj);
  }

  return false;
}

/**
 * Get the full text of the enclosing ExpressionStatement (the whole chain line).
 */
function getFullExpressionStatementText(node: Node): string {
  let current: Node | undefined = node;
  while (current) {
    if (Node.isExpressionStatement(current)) {
      return current.getText();
    }
    current = current.getParent();
  }
  return node.getText();
}

// ---------------------------------------------------------------------------
// Code smell detection
// ---------------------------------------------------------------------------

function detectCodeSmells(
  commands: CypressCommand[],
  filePath: string,
  warnings: Warning[],
): void {
  for (const cmd of commands) {
    // Static cy.wait(number) — code smell
    if (cmd.name === 'wait' && cmd.args.length > 0) {
      const arg = cmd.args[0];
      if (/^\d+$/.test(arg)) {
        warnings.push({
          severity: 'warning',
          message: `Static cy.wait(${arg}) detected — consider using Playwright's auto-waiting or explicit waitFor* methods instead.`,
          filePath,
          line: cmd.line,
          originalCode: cmd.fullChainText,
        });
      }
    }

    // cy.wait with alias — complex pattern
    if (cmd.name === 'wait' && cmd.args.length > 0 && cmd.args[0].startsWith("'@")) {
      warnings.push({
        severity: 'info',
        message: `cy.wait('${cmd.args[0]}') with alias detected — requires refactoring cy.intercept + cy.wait pattern to page.waitForResponse.`,
        filePath,
        line: cmd.line,
        originalCode: cmd.fullChainText,
      });
    }

    // Complex commands
    if (cmd.isComplex) {
      warnings.push({
        severity: 'info',
        message: `Complex command '${cmd.name}' detected — will require AI assistance or manual conversion.`,
        filePath,
        line: cmd.line,
        originalCode: cmd.fullChainText,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCallbackBody(node: Node) {
  // Arrow function: () => { ... }
  if (Node.isArrowFunction(node)) {
    const body = node.getBody();
    if (Node.isBlock(body)) {
      return body.getStatements();
    }
  }
  // Function expression: function() { ... }
  if (Node.isFunctionExpression(node)) {
    const body = node.getBody();
    if (Node.isBlock(body)) {
      return body.getStatements();
    }
  }
  return null;
}

function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '');
}

function countDescribes(blocks: DescribeBlock[]): number {
  return blocks.reduce((sum, b) => sum + 1 + countDescribes(b.describes), 0);
}

function countTestsInDescribes(blocks: DescribeBlock[]): number {
  return blocks.reduce(
    (sum, b) => sum + b.tests.length + countTestsInDescribes(b.describes),
    0,
  );
}

function countHooksInDescribes(blocks: DescribeBlock[]): number {
  return blocks.reduce(
    (sum, b) => sum + b.hooks.length + countHooksInDescribes(b.describes),
    0,
  );
}
