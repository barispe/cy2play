# 🚀 Cy2Play Engineering Roadmap

## Phase 0: Foundation & Setup
- [x] Initialize project structure (`package.json`, `tsconfig.json`).
- [x] Set up CLI entry point and basic command parsing (Commander.js).
- [ ] **Technical Task**: Add `dotenv` and create `.env.example` for secure API key handling.
- [ ] **Technical Task**: Install and configure AST manipulation library (Recommendation: `ts-morph` or `jscodeshift`) to safely parse & rewrite code.
- [ ] **Architecture**: Create `src/types.ts` defining `ConversionOptions` (strict vs hybrid vs ai).
- [ ] **Research**: Create `src/mappings/cypress.ts` definition file to map top 50 common Cypress commands to Playwright equivalents.

## Phase 1: Core Parsing & Analysis (The "Reader")
- [ ] Implement `FileDiscoverer`: Use `glob` to find test files tailored to `cypress/e2e` or custom paths.
- [ ] Implement `FrameworkDetector`: logic to inspect `package.json` or file imports to confirm input is Cypress or WebdriverIO.
- [ ] Create `AstParser`:
    - [ ] Extract test structure (`describe`, `it`, `beforeEach`).
    - [ ] Identify imports and plugins.
    - [ ] Detect "Code Smells" (e.g., static `cy.wait(5000)`).

## Phase 2: Rule-Based Transformation Engine (The "Converter")
- [ ] Implement `Transformer` Architecture:
    - `BaseTransformer` abstract class.
    - `CypressTransformer` concrete implementation.
- [ ] **AST Logic**: Sync-to-Async conversion.
    - Identify Cypress command chains.
    - Inject `async` keyword to parent functions.
    - Inject `await` before Playwright calls.
- [ ] **Selector Mapping**:
    - `cy.get('[data-cy=submit]')` → `page.locator('[data-cy=submit]')`.
    - Handle `.find()`, `.first()`, `.last()`.
- [ ] **Action Mapping**:
    - `.click()`, `.type()`, `.check()`, `.select()`.
- [ ] **Assertion Mapping**:
    - `should('be.visible')` → `expect(locator).toBeVisible()`.
    - `should('have.text', 'X')` → `expect(locator).toHaveText('X')`.
- [ ] **Hooks**: Convert `beforeEach` / `afterEach` syntax.

## Phase 3: AI-Powered Conversion (The "Brain")
- [ ] **Infra**: Set up centralized LangChain client in `src/ai/client.ts`.
- [ ] **Local LLM Support**: Configure `OllamaAdapter` with configurable `baseUrl`.
- [ ] **Prompt Engineering**:
    - Create system prompt for "Cypress Expert to Playwright Expert".
    - Create few-shot examples for complex scenarios (intercepts, custom commands).
- [ ] **Integration**:
    - Build `AIResolver` that takes AST nodes ignored by the rule-based engine and sends them to LLM.
    - Implement caching strategy (hash code blocks) to avoid re-querying identical code.

## Phase 4: Reporting & Safety
- [ ] Implement `ConversionReporter`:
    - Track stats: Total Files, Converted Lines, AI Usage Tokens.
    - Generate `MIGRATION_SUMMARY.md`.
- [ ] **Safety**: Implement "Safe Write" mode (create `*.pw.spec.ts` files instead of overwriting).
- [ ] Add specific warning comments in generated code: `// TODO: Manual review required here`.

## Phase 5: CI/CD & Delivery
- [ ] **CI**: Create `.github/workflows/test.yml` for linting and building.
- [ ] **Testing**: Set up Jest/Vitest for unit testing transformers.
- [ ] **Packaging**:
    - Configure `.npmignore`.
    - Add `bin` configuration for global usage.
- [ ] **Release**: Create release script to bump version and publish to NPM.
