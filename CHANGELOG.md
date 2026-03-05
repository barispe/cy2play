# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- GitHub Actions CI workflow (typecheck, test, build on Node 18/20/22)
- ISC LICENSE file
- CHANGELOG.md

### Changed
- README: replaced placeholder clone URL with actual repository URL
- README: replaced external doc links (PRD.md, PROGRESS.md) with inline roadmap

## [0.1.0] - 2024-12-01

### Added
- **Three conversion modes**: `strict` (AST rules only), `hybrid` (AST + AI), `pure-ai` (full LLM rewrite)
- AST-powered Cypress → Playwright transformer using `ts-morph`
- LLM adapters for OpenAI, Anthropic, and local models (Ollama/LM Studio)
- Hybrid orchestrator with 4-pass pipeline (parse → transform → AI resolve → format)
- Auto-fix loop: run generated tests and self-heal errors via LLM (`--auto-fix`)
- Migration summary report (`MIGRATION_SUMMARY.md`) with per-file stats
- Side-by-side diff view (`--diff` flag)
- Batch progress bar for directory conversions
- Configuration file support (`cy2play.config.json`) with CLI flag overrides
- Custom Cypress command mapping support
- File discovery for `.cy.ts`, `.cy.js`, `.cy.tsx`, `.cy.jsx` files
- Dry run mode (`--dry-run`)
- Prettier integration for auto-formatted output
- Snippet caching to avoid duplicate LLM calls
- Comprehensive test suite (parser, transformer, hybrid, AI, reporter, discovery)
