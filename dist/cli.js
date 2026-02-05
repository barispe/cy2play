#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const chalk_1 = __importDefault(require("chalk"));
const program = new commander_1.Command();
program
    .name('cy2play')
    .description('CLI to convert Cypress/WebdriverIO tests to Playwright')
    .version('0.1.0');
program
    .command('convert')
    .description('Convert test files')
    .argument('<path>', 'Path to file or directory to convert')
    .option('-d, --dry-run', 'Run without writing files')
    .option('--debug', 'Enable debug logging')
    .action((path, options) => {
    console.log(chalk_1.default.blue(`🚀 Starting Cy2Play conversion for: ${path}`));
    if (options.dryRun) {
        console.log(chalk_1.default.yellow('ℹ️  Dry run mode: No files will be modified.'));
    }
    // TODO: Implement AST parsing and conversion logic
    console.log(chalk_1.default.gray('Analyzing files...'));
});
program
    .command('report')
    .description('Generate migration report')
    .action(() => {
    console.log(chalk_1.default.green('Generating migration report...'));
    // TODO: Implement reporting logic
});
program.parse();
