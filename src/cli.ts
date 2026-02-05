#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { resolveOptions } from './config';
import { discoverFiles, computeOutputPath } from './discovery';
import { parseFile } from './parser';
import { transformFile } from './transformer';
import { orchestrate } from './hybrid';
import { SnippetCache } from './ai/cache';
import { createLLMClient } from './ai/index';
import { MigrationReporter, FileRecord, validateSafeWrite, validateOutputFile } from './reporter';
import { computeDiff, formatDiffForTerminal } from './diff';
import { ProgressBar } from './progress';
import { autoFix } from './auto-fix';
import { TransformResult, TransformStats, ConversionMode, LLMProvider } from './types';

const program = new Command();

program
  .name('cy2play')
  .description('CLI to convert Cypress tests to Playwright')
  .version('0.1.0');

program
  .command('convert')
  .description('Convert test files')
  .argument('<path>', 'Path to file or directory to convert')
  .option('-m, --mode <mode>', 'Conversion mode: strict | hybrid | pure-ai')
  .option('-o, --output <dir>', 'Output directory')
  .option('-d, --dry-run', 'Run without writing files')
  .option('--debug', 'Enable debug logging')
  .option('--provider <provider>', 'LLM provider: openai | anthropic | local')
  .option('--model <model>', 'LLM model name')
  .option('--local-url <url>', 'Local LLM base URL')
  .option('--diff', 'Show side-by-side diff of input vs output')
  .option('--auto-fix', 'Run generated tests and auto-fix errors via LLM (requires --provider)')
  .action(async (inputPath: string, flags: Record<string, unknown>) => {
    try {
      const options = resolveOptions(inputPath, {
        mode: flags.mode as string | undefined,
        dryRun: flags.dryRun as boolean | undefined,
        debug: flags.debug as boolean | undefined,
        provider: flags.provider as string | undefined,
        model: flags.model as string | undefined,
        localUrl: flags.localUrl as string | undefined,
        output: flags.output as string | undefined,
      });

      // --- Safe-write validation ---
      if (!options.dryRun) {
        validateSafeWrite(options.inputPath, options.outputDir);
      }

      console.log(chalk.blue(`\n🚀 Cy2Play v0.1.0`));
      console.log(chalk.gray(`   Mode: ${options.mode} | Output: ${options.outputDir}`));

      if (options.dryRun) {
        console.log(chalk.yellow('   ℹ️  Dry run mode — no files will be written.\n'));
      } else {
        console.log();
      }

      // --- Discover files ---
      const discovery = await discoverFiles(inputPath);
      console.log(chalk.white(`📂 Found ${chalk.bold(String(discovery.count))} Cypress test file(s) in: ${discovery.rootDir}\n`));

      if (discovery.count === 0) {
        console.log(chalk.yellow('   No .cy.ts / .cy.js files found. Nothing to do.'));
        return;
      }

      // --- Parse & Transform each file ---
      let totalTests = 0;
      let totalKnown = 0;
      let totalComplex = 0;
      let filesWritten = 0;

      // Shared snippet cache across all files in this run
      const cache = new SnippetCache();

      // Migration reporter tracks per-file results and generates the summary
      const reporter = new MigrationReporter();

      // Progress bar for batch conversions
      const showProgress = discovery.count > 1 && !options.debug && process.stderr.isTTY;
      const progress = showProgress
        ? new ProgressBar({ total: discovery.count, label: '  Converting' })
        : null;

      // Diff + auto-fix flags
      const showDiff = flags.diff as boolean | undefined;
      const runAutoFix = flags.autoFix as boolean | undefined;

      for (const file of discovery.files) {
        const source = fs.readFileSync(file, 'utf-8');
        const parseResult = parseFile(source, file);

        const relPath = file.replace(discovery.rootDir, '').replace(/^[/\\]/, '');
        const outputPath = computeOutputPath(file, discovery.rootDir, options.outputDir);
        const relOutput = outputPath.replace(process.cwd(), '').replace(/^[/\\]/, '');

        const pct = parseResult.stats.totalCommands > 0
          ? Math.round((parseResult.stats.knownCommands / parseResult.stats.totalCommands) * 100)
          : 100;

        const pctColor = pct >= 80 ? chalk.green : pct >= 50 ? chalk.yellow : chalk.red;

        // Run the transformer (mode-aware: strict / hybrid / pure-ai)
        const transformResult = await orchestrate(source, file, { options, cache });

        console.log(
          chalk.white(`   ${relPath}`) +
          chalk.gray(` → ${relOutput}`) +
          chalk.gray(` | `) +
          chalk.cyan(`${parseResult.stats.totalTests} tests`) +
          chalk.gray(`, `) +
          chalk.cyan(`${transformResult.stats.totalCommands} cmds`) +
          chalk.gray(` (`) +
          pctColor(`${pct}% strict`) +
          chalk.gray(`)`) +
          (transformResult.stats.manualReview > 0
            ? chalk.yellow(` ⚠ ${transformResult.stats.manualReview} need review`)
            : '')
        );

        // Show warnings
        if (options.debug && transformResult.warnings.length > 0) {
          for (const w of transformResult.warnings) {
            const icon = w.severity === 'warning' ? '⚠️ ' : 'ℹ️ ';
            console.log(chalk.gray(`      ${icon} L${w.line}: ${w.message}`));
          }
        }

        // Validate output won't overwrite source
        if (!options.dryRun) {
          validateOutputFile(file, outputPath);
        }

        // Record into reporter
        reporter.addFile({
          inputPath: file,
          outputPath,
          relativeInput: relPath,
          relativeOutput: relOutput,
          result: transformResult,
        });

        totalTests += parseResult.stats.totalTests;
        totalKnown += parseResult.stats.knownCommands;
        totalComplex += parseResult.stats.complexCommands;

        // Update progress bar
        if (progress) {
          progress.tick(relPath);
        }

        // Show diff if requested
        if (showDiff) {
          const diff = computeDiff(source, transformResult.code, relPath, relOutput);
          console.log();
          console.log(formatDiffForTerminal(diff));
          console.log();
        }
      }

      // Complete the progress bar
      if (progress) {
        progress.complete();
      }

      // --- Summary ---
      const aggStats = reporter.aggregateStats();
      const allWarnings = reporter.collectAllWarnings();
      const totalCommands = aggStats.totalCommands;

      const totalPct = totalCommands > 0
        ? Math.round((totalKnown / totalCommands) * 100)
        : 100;

      console.log(chalk.white(`\n📊 Summary:`));
      console.log(chalk.gray(`   Files:         ${discovery.count}`));
      console.log(chalk.gray(`   Tests:         ${totalTests}`));
      console.log(chalk.gray(`   Commands:      ${totalCommands}`));
      console.log(chalk.green(`   Rules applied: ${aggStats.rulesApplied}`));
      if (aggStats.aiResolved > 0) {
        console.log(chalk.blue(`   AI resolved:   ${aggStats.aiResolved}`));
      }
      if (totalComplex > 0) {
        console.log(chalk.yellow(`   Complex:       ${totalComplex} (need AI / manual)`));
      }
      if (aggStats.manualReview > 0) {
        console.log(chalk.yellow(`   Manual review: ${aggStats.manualReview}`));
      }
      if (allWarnings.length > 0) {
        console.log(chalk.yellow(`   Warnings:      ${allWarnings.length} (use --debug to see details)`));
      }

      // --- TODO/FIXME inventory ---
      const todoInventory = reporter.collectTodoInventory();
      const todoCount = todoInventory.reduce((sum, f) => sum + f.items.length, 0);
      if (todoCount > 0) {
        console.log(chalk.yellow(`   TODOs/FIXMEs:  ${todoCount} (see MIGRATION_SUMMARY.md)`));
      }

      if (options.dryRun) {
        console.log(chalk.yellow(`\n   Dry run complete — no files were written.`));
        // In debug+dryRun, show the generated code for the first file
        const files = reporter.getFiles();
        if (options.debug && files.length > 0) {
          console.log(chalk.gray(`\n--- Preview of ${files[0].relativeInput} ---\n`));
          console.log(files[0].result.code);
          console.log(chalk.gray(`\n--- End Preview ---`));
        }
      } else {
        // Write the converted files
        for (const record of reporter.getFiles()) {
          const dir = path.dirname(record.outputPath);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(record.outputPath, record.result.code, 'utf-8');
          filesWritten++;
        }
        console.log(chalk.green(`\n   ✅ ${filesWritten} file(s) written to ${options.outputDir}`));

        // Write MIGRATION_SUMMARY.md
        const summaryPath = reporter.writeSummary(options.outputDir, options.mode);
        const relSummary = path.relative(process.cwd(), summaryPath);
        console.log(chalk.blue(`   📊 Migration summary: ${relSummary}`));

        // --- Auto-fix loop ---
        if (runAutoFix) {
          if (!options.llm) {
            console.log(chalk.yellow(`\n   ⚠️  --auto-fix requires --provider to be set. Skipping.`));
          } else {
            console.log(chalk.blue(`\n   🔧 Running auto-fix loop...`));
            const client = createLLMClient(options.llm);
            let fixedCount = 0;
            let failedCount = 0;

            for (const record of reporter.getFiles()) {
              if (!fs.existsSync(record.outputPath)) continue;

              const result = await autoFix({
                testFile: record.outputPath,
                client,
                maxRetries: 3,
                debug: options.debug,
                cwd: options.outputDir,
              });

              if (result.success) {
                fixedCount++;
                if (result.attempts > 0) {
                  console.log(chalk.green(`      ✓ ${record.relativeOutput} — fixed after ${result.attempts} attempt(s)`));
                }
              } else {
                failedCount++;
                console.log(chalk.yellow(`      ⚠ ${record.relativeOutput} — could not auto-fix (${result.attempts} attempt(s))`));
              }
            }

            if (fixedCount > 0 || failedCount > 0) {
              console.log(chalk.gray(`      Auto-fix: ${fixedCount} passed, ${failedCount} need manual fix`));
            }
          }
        }
      }

      console.log();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n❌ Error: ${msg}\n`));
      process.exit(1);
    }
  });

program
  .command('report')
  .description('View migration report')
  .argument('[dir]', 'Output directory to look for MIGRATION_SUMMARY.md', './playwright-tests')
  .action((dir: string) => {
    const summaryPath = path.join(path.resolve(dir), 'MIGRATION_SUMMARY.md');

    if (!fs.existsSync(summaryPath)) {
      console.error(
        chalk.red(`\n❌ No migration summary found at ${summaryPath}`),
      );
      console.log(
        chalk.gray('   Run `cy2play convert <path>` first to generate a report.\n'),
      );
      process.exit(1);
    }

    const content = fs.readFileSync(summaryPath, 'utf-8');
    console.log(content);
  });

program
  .command('init')
  .description('Scaffold a cy2play.config.json configuration file')
  .option('-m, --mode <mode>', 'Conversion mode', 'hybrid')
  .option('-o, --output <dir>', 'Output directory', './playwright-tests')
  .option('--provider <provider>', 'LLM provider: openai | anthropic | local')
  .option('--model <model>', 'LLM model name')
  .option('--force', 'Overwrite existing config file')
  .action((flags: Record<string, unknown>) => {
    const configPath = path.join(process.cwd(), 'cy2play.config.json');

    if (fs.existsSync(configPath) && !flags.force) {
      console.log(chalk.yellow(`\n   ⚠️  Config file already exists: ${configPath}`));
      console.log(chalk.gray('   Use --force to overwrite.\n'));
      return;
    }

    const mode = (flags.mode as string) || 'hybrid';
    const outputDir = (flags.output as string) || './playwright-tests';
    const provider = flags.provider as string | undefined;
    const model = flags.model as string | undefined;

    const config: Record<string, unknown> = {
      mode,
      targetDir: outputDir,
    };

    if (provider) {
      config.llm = {
        provider,
        model: model || (provider === 'openai' ? 'gpt-4o' : provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'codellama'),
        apiKey: `env:${provider === 'openai' ? 'OPENAI_API_KEY' : provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'LLM_API_KEY'}`,
        temperature: 0.2,
      };
    }

    if (provider === 'local') {
      config.localLlm = {
        enabled: true,
        baseUrl: 'http://localhost:11434/v1',
        model: model || 'codellama',
      };
    }

    config.customMappings = {
      '// Add custom Cypress → Playwright command mappings here': '',
      '// Example: "cy.dataCy": "page.getByTestId"': '',
    };

    const json = JSON.stringify(config, null, 2);
    fs.writeFileSync(configPath, json + '\n', 'utf-8');

    console.log(chalk.green(`\n   ✅ Created ${configPath}`));
    console.log(chalk.gray(`   Mode: ${mode}`));
    console.log(chalk.gray(`   Output: ${outputDir}`));
    if (provider) {
      console.log(chalk.gray(`   Provider: ${provider}`));
      console.log(chalk.gray(`   Model: ${model || 'default'}`));
    }
    console.log(chalk.gray(`\n   Edit the file to customize your settings.`));
    console.log(chalk.gray(`   Then run: cy2play convert <path>\n`));
  });

program.parse();
