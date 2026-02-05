// ============================================================================
// Cy2Play — File Discovery
// ============================================================================
import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';

/** Default glob patterns to match Cypress test files */
const DEFAULT_PATTERNS = [
  '**/*.cy.ts',
  '**/*.cy.js',
  '**/*.cy.tsx',
  '**/*.cy.jsx',
];

/** Directories to always ignore */
const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/playwright-tests/**',
];

export interface DiscoveryResult {
  /** Absolute paths to all discovered test files */
  files: string[];
  /** The root directory that was scanned */
  rootDir: string;
  /** Total count */
  count: number;
}

/**
 * Discover Cypress test files in the given path.
 *
 * - If `inputPath` is a file, returns just that file (if it matches).
 * - If `inputPath` is a directory, globs recursively for Cypress test files.
 *
 * @param inputPath - Absolute or relative path to a file or directory
 * @param extraPatterns - Additional glob patterns to include
 */
export async function discoverFiles(
  inputPath: string,
  extraPatterns: string[] = [],
): Promise<DiscoveryResult> {
  const resolved = path.resolve(inputPath);

  // --- Single file ---
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return {
      files: [resolved],
      rootDir: path.dirname(resolved),
      count: 1,
    };
  }

  // --- Directory ---
  if (!fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }

  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Path is not a file or directory: ${resolved}`);
  }

  const patterns = [...DEFAULT_PATTERNS, ...extraPatterns];

  const allFiles: string[] = [];

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: resolved,
      absolute: true,
      ignore: IGNORE_PATTERNS,
      nodir: true,
    });
    allFiles.push(...matches);
  }

  // De-duplicate and sort
  const unique = [...new Set(allFiles)].sort();

  return {
    files: unique,
    rootDir: resolved,
    count: unique.length,
  };
}

/**
 * Compute the output file path for a given input file.
 *
 * Example:
 *   inputFile:  /project/cypress/e2e/login.cy.ts
 *   inputRoot:  /project/cypress/e2e
 *   outputDir:  /project/playwright-tests
 *   → result:   /project/playwright-tests/login.spec.ts
 */
export function computeOutputPath(
  inputFile: string,
  inputRoot: string,
  outputDir: string,
): string {
  const relative = path.relative(inputRoot, inputFile);

  // Replace .cy.ts/.cy.js extensions with .spec.ts
  const outputName = relative
    .replace(/\.cy\.(tsx?|jsx?)$/, '.spec.ts');

  return path.join(outputDir, outputName);
}
