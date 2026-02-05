// ============================================================================
// Cy2Play — Configuration Loader
// ============================================================================
import * as fs from 'fs';
import * as path from 'path';
import { Cy2PlayConfig, ConversionOptions, ConversionMode, LLMProvider } from './types';

/** Default configuration values */
const DEFAULTS: Required<Pick<ConversionOptions, 'mode' | 'outputDir' | 'dryRun' | 'debug'>> = {
  mode: 'hybrid',
  outputDir: './playwright-tests',
  dryRun: false,
  debug: false,
};

/**
 * Search for cy2play.config.json starting from `startDir` and walking up.
 * Returns the parsed config or `null` if not found.
 */
export function findConfigFile(startDir: string): Cy2PlayConfig | null {
  let dir = path.resolve(startDir);

  while (true) {
    const candidate = path.join(dir, 'cy2play.config.json');
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, 'utf-8');
        return JSON.parse(raw) as Cy2PlayConfig;
      } catch {
        return null;
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break; // reached root
    dir = parent;
  }

  return null;
}

/**
 * Resolve an API key value.
 * Supports `"env:VAR_NAME"` syntax to read from environment variables.
 */
function resolveApiKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('env:')) {
    const envVar = value.slice(4);
    return process.env[envVar];
  }
  return value;
}

export interface CLIFlags {
  mode?: string;
  dryRun?: boolean;
  debug?: boolean;
  provider?: string;
  model?: string;
  localUrl?: string;
  output?: string;
}

/**
 * Build the final `ConversionOptions` by merging (in priority order):
 *   CLI flags  >  cy2play.config.json  >  defaults
 */
export function resolveOptions(inputPath: string, cliFlags: CLIFlags, cwd?: string): ConversionOptions {
  const fileConfig = findConfigFile(cwd ?? process.cwd());

  // --- Mode ---
  const mode: ConversionMode =
    (cliFlags.mode as ConversionMode) ??
    fileConfig?.mode ??
    DEFAULTS.mode;

  // --- Output dir ---
  const outputDir: string =
    cliFlags.output ??
    fileConfig?.targetDir ??
    DEFAULTS.outputDir;

  // --- LLM config ---
  const provider: LLMProvider | undefined =
    (cliFlags.provider as LLMProvider) ??
    (fileConfig?.localLlm?.enabled ? 'local' : undefined) ??
    (fileConfig?.llm?.provider as LLMProvider) ??
    undefined;

  const llmConfig = provider
    ? {
        provider,
        model:
          cliFlags.model ??
          (provider === 'local' ? fileConfig?.localLlm?.model : undefined) ??
          fileConfig?.llm?.model ??
          'gpt-4o',
        apiKey: resolveApiKey(fileConfig?.llm?.apiKey),
        baseUrl:
          cliFlags.localUrl ??
          (provider === 'local' ? fileConfig?.localLlm?.baseUrl : undefined) ??
          undefined,
        temperature: fileConfig?.llm?.temperature ?? 0.2,
      }
    : undefined;

  return {
    mode,
    inputPath: path.resolve(inputPath),
    outputDir: path.resolve(outputDir),
    dryRun: cliFlags.dryRun ?? DEFAULTS.dryRun,
    debug: cliFlags.debug ?? DEFAULTS.debug,
    llm: llmConfig,
    customMappings: fileConfig?.customMappings,
  };
}
