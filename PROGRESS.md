# 🚀 Cy2Play Engineering Roadmap

> Single source of truth for engineering tasks and progress.
> For product requirements, see [PRD.md](PRD.md).

---

## Phase 0: Foundation & Setup
- [x] Initialize project structure (`package.json`, `tsconfig.json`).
- [x] Set up CLI entry point with Commander.js (`src/cli.ts`).
- [x] Define core type interfaces (`src/types.ts`) — `TransformResult`, `LLMClient`, `ConversionOptions`, `Warning`, `UnresolvedNode`, `Transformer`.
- [x] Fix dependencies: remove LangChain, add `ts-morph`, `glob`, `prettier`, `dotenv`.
- [x] Set up test infrastructure with Vitest + fixture files.
- [x] Create `.env.example` for secure API key handling.
- [x] Create `src/config.ts` — config loader for `cy2play.config.json` with defaults.
- [x] Create `src/mappings/cypress-commands.ts` — map top 50 Cypress commands to Playwright equivalents.

## Phase 1: Core Parsing & File Discovery
- [x] Implement `FileDiscoverer` (`src/discovery.ts`): use `glob` to find `.cy.ts` / `.cy.js` files.
- [x] Create `AstParser` (`src/parser.ts`):
    - [x] Parse Cypress files into AST using `ts-morph`.
    - [x] Extract test structure (`describe`, `it`, `beforeEach`).
    - [x] Identify imports and plugins.
    - [x] Detect code smells (e.g., static `cy.wait(5000)`).

## Phase 2: Rule-Based Transformation Engine (Strict Mode)
- [x] Implement `Transformer` architecture:
    - [x] `transformFile()` function in `src/transformer.ts`.
    - [x] Line-by-line chain conversion engine.
- [x] **AST Logic** — Sync-to-Async conversion:
    - [x] Identify Cypress command chains.
    - [x] Inject `async` keyword to parent `it` / `test` functions.
    - [x] Inject `await` before Playwright action calls.
- [x] **Selector Mapping**:
    - [x] `cy.get(sel)` → `page.locator(sel)`
    - [x] Handle `.find()`, `.first()`, `.last()`, `.eq(n)` → `.nth(n)`
- [x] **Action Mapping**:
    - [x] `.click()`, `.dblclick()`, `.type()` → `.fill()`, `.check()`, `.uncheck()`, `.select()` → `.selectOption()`
- [x] **Assertion Mapping**:
    - [x] `.should('be.visible')` → `await expect(loc).toBeVisible()`
    - [x] `.should('have.text', 'X')` → `await expect(loc).toHaveText('X')`
    - [x] `.should('have.length', n)` → `await expect(loc).toHaveCount(n)`
    - [x] `.should('have.css', prop, val)` → `await expect(loc).toHaveCSS(prop, val)`
    - [x] Negated assertions (`.should('not.be.visible')`)
- [x] **Navigation & Waits**:
    - [x] `cy.visit(url)` → `await page.goto(url)`
    - [x] `cy.wait(ms)` → `await page.waitForTimeout(ms)` (with warning comment)
    - [x] `cy.url()` → `expect(page).toHaveURL()`
- [x] **Hooks**:
    - [x] `beforeEach(() => {})` → `test.beforeEach(async ({ page }) => {})`
    - [x] `afterEach` / `before` / `after` equivalents
- [x] **Code Generation**: Output valid `.spec.ts` files with Playwright imports.
- [x] **CLI Integration**: Wire transformer into CLI with file writing + dry-run preview.
- [x] **Unit Tests**: 39 tests covering login/navigation fixtures + edge cases.

## Phase 3: AI-Powered Conversion (LLM Layer)
- [x] Build thin `LLMClient` adapters (no LangChain):
    - [x] `OpenAIAdapter` (`src/ai/openai-adapter.ts`) — uses `openai` SDK.
    - [x] `AnthropicAdapter` (`src/ai/anthropic-adapter.ts`) — uses `@anthropic-ai/sdk`.
    - [x] `OllamaAdapter` (`src/ai/ollama-adapter.ts`) — raw `fetch()` to OpenAI-compatible API.
- [x] `createLLMClient()` factory (`src/ai/index.ts`) — returns the right adapter by provider.
- [x] **Prompt Engineering** (`src/ai/prompts.ts`):
    - [x] Create system prompt for "Cypress Expert to Playwright Expert" role.
    - [x] Create few-shot examples for complex scenarios (`cy.intercept`, `cy.then`, `cy.within`, `cy.wrap`, `cy.fixture`, `cy.request`).
    - [x] `buildFullFilePrompt()` for pure-ai mode.
    - [x] `buildSnippetPrompt()` for hybrid placeholder resolution.
    - [x] `extractCodeBlock()` — parse LLM responses.
- [x] **`PureAIStrategy`** (`src/ai/pure-ai-strategy.ts`): Send full file to LLM, extract code block, return `TransformResult`. Handles errors gracefully, auto-adds missing imports.
- [x] **Caching** (`src/ai/cache.ts`): SHA-256 hash-based cache with optional disk persistence. Normalizes whitespace for cache key stability.
- [x] **Unit Tests** (`tests/ai.test.ts`): 41 tests covering prompts, code extraction, cache hits/misses, factory validation, pure-AI strategy with mocked LLM.

## Phase 4: Hybrid Orchestration
- [x] Implement `HybridOrchestrator` (`src/hybrid.ts`):
    - [x] `orchestrate()` — mode-aware entry point (strict / hybrid / pure-ai).
    - [x] Pass 1: Run strict AST transformer.
    - [x] Pass 2: Collect `UnresolvedNode[]` from `TransformResult`.
    - [x] Insert `// __CY2PLAY_PLACEHOLDER_ID__` markers in output for unresolved blocks.
    - [x] Pass 3: Batch-send unresolved snippets + context to LLM (with cache).
    - [x] Pass 4: String-replace placeholders with LLM responses.
- [x] Run `Prettier` on final output to normalize formatting.
- [x] Wire all 3 modes into CLI (`src/cli.ts`) with shared `SnippetCache`.
- [x] **Unit Tests** (`tests/hybrid.test.ts`): 14 tests — strict passthrough, pure-ai delegation, hybrid 4-pass pipeline, LLM error handling, cache reuse, Prettier formatting, edge cases.

## Phase 5: Reporting & Safety
- [x] Implement `MigrationReporter` (`src/reporter.ts`):
    - [x] Track stats: total files, converted lines, AI token usage.
    - [x] Aggregate `TransformStats` across all files.
    - [x] Collect TODO/FIXME inventory from generated code.
    - [x] Generate `MIGRATION_SUMMARY.md` with overview, per-file table, coverage bar, TODO list, warnings, next steps.
    - [x] `writeSummary()` writes report to output directory.
- [x] **Safe Write**: `validateSafeWrite()` and `validateOutputFile()` — never overwrite source files.
- [x] Add `// TODO: [cy2play] Manual review required` comments for unresolved/uncertain conversions.
- [x] Wire reporter into CLI (`src/cli.ts`): replaces manual stat tracking, writes `MIGRATION_SUMMARY.md` after conversion, implements `report` command.
- [x] **Unit Tests** (`tests/reporter.test.ts`): 27 tests — stats aggregation, warning collection, TODO/FIXME inventory, markdown generation, safe-write validation, summary file writing.

## Phase 6: CI/CD & Delivery
- [x] Create `.github/workflows/ci.yml` — type check, test, build on push/PR to main (Node 18/20/22 matrix).
- [x] Create `.npmignore` — excludes src/, tests/, fixtures, docs, .env, .github from published package.
- [x] Verify `bin` configuration works for `npx cy2play` — shebang in cli.ts, `node dist/cli.js --help` works, `npm pack --dry-run` shows only dist/ + README.md (18 files, 30 KB).
- [x] Add `files` field and `engines` to `package.json` — belt-and-suspenders with .npmignore.
- [x] Add release scripts: `prepublishOnly` (typecheck + test + build), `release:patch/minor/major`, `clean`, `typecheck`.

## Phase 7: Post-MVP Enhancements
- [x] **Auto-Fix Loop**: Run generated Playwright test → if it fails → feed error + code back to LLM → self-heal (`src/auto-fix.ts`). Wired into CLI via `--auto-fix` flag.
- [x] **Diff View**: LCS-based unified diff with colored terminal output (`src/diff.ts`). Wired into CLI via `--diff` flag.
- [x] **Batch progress bar**: Real-time progress bar with ETA and file counter (`src/progress.ts`). Auto-enabled for multi-file conversions on TTY.
- [x] **Config generator**: `npx cy2play init` scaffolds `cy2play.config.json` with `--mode`, `--provider`, `--model`, `--force` options.
- [x] **Unit Tests** (`tests/phase7.test.ts`): 22 tests — diff computation (identical/added/removed/changed/headers/empty), formatDiffPlain, ProgressBar (format/ticks/label/truncate), autoFix structure, runPlaywrightTest, init config shape.
