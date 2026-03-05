# 🎭 Cy2Play

> Intelligently convert your Cypress tests to Playwright — using AST parsing + optional AI assistance.

---

## Why Cy2Play?

Migrating from Cypress to Playwright is tedious:
- **Syntax differences** — Cypress uses chainable sync-like APIs; Playwright uses `async/await`.
- **Scale** — Large test suites can have thousands of files. Manual rewriting is slow and error-prone.
- **Edge cases** — `cy.intercept`, custom commands, and `this` context don't map 1:1.

Cy2Play automates 80–95% of that work with a **hybrid engine**: fast deterministic AST rules for standard commands, with optional LLM assistance for complex edge cases.

---

## Features

- ⚡ **Three conversion modes**: `strict` (rules only), `hybrid` (default — AST + AI), `pure-ai` (full LLM rewrite)
- 🔒 **Local LLM support** — Use Ollama or LM Studio so your code never leaves your machine
- 🧠 **AST-powered** — Not regex find-and-replace; real syntax tree transformations
- 📊 **Migration reports** — See what changed, what needs manual review, and estimated AI cost
- 🎨 **Auto-formatted output** — Prettier integration for clean generated code

---

## Installation

```bash
npm install -g cy2play
```

Or use directly with `npx`:

```bash
npx cy2play convert ./cypress/e2e
```

---

## Quick Start

### 1. Convert a file or directory (hybrid mode — default)

```bash
npx cy2play convert ./cypress/e2e/login.cy.ts
```

### 2. Strict mode (no AI, instant, free)

```bash
npx cy2play convert ./cypress/e2e --mode strict
```

### 3. Use a local LLM (Ollama)

```bash
npx cy2play convert ./cypress/e2e \
  --mode hybrid \
  --provider local \
  --local-url http://localhost:11434 \
  --model codellama
```

### 4. Dry run (preview without writing files)

```bash
npx cy2play convert ./cypress/e2e --dry-run
```

---

## Configuration

Create a `cy2play.config.json` in your project root:

```json
{
  "mode": "hybrid",
  "targetDir": "./playwright-tests",
  "llm": {
    "provider": "openai",
    "model": "gpt-4o",
    "apiKey": "env:OPENAI_API_KEY",
    "temperature": 0.2
  },
  "localLlm": {
    "enabled": false,
    "baseUrl": "http://localhost:11434/v1",
    "model": "llama3"
  },
  "customMappings": {
    "cy.dataCy": "page.getByTestId"
  }
}
```

| Option | Type | Default | Description |
|:---|:---|:---|:---|
| `mode` | `"strict" \| "hybrid" \| "pure-ai"` | `"hybrid"` | Conversion strategy |
| `targetDir` | `string` | `"./playwright-tests"` | Output directory |
| `llm.provider` | `"openai" \| "anthropic" \| "local"` | `"openai"` | LLM backend |
| `customMappings` | `object` | `{}` | Map custom Cypress commands to Playwright equivalents |

---

## How It Works

```
Input (.cy.ts) → AST Parser → Transformation Rules → [LLM for unknowns] → Code Generator → Prettier → Output (.spec.ts)
```

1. **Strict mode** — Deterministic AST transformation for known commands (`cy.get`, `cy.visit`, `.click()`, `.should()`).
2. **Hybrid mode** — AST handles ~85% of conversions; unknown/complex blocks are sent as snippets to an LLM.
3. **Pure AI mode** — The entire file is sent to an LLM for rewriting.

See [PRD.md](PRD.md) for detailed architecture and specifications.

---

## Example Conversion

**Input** (`login.cy.ts`):
```typescript
describe('Login', () => {
  beforeEach(() => {
    cy.visit('/login');
  });

  it('should log in successfully', () => {
    cy.get('[data-cy=email]').type('user@test.com');
    cy.get('[data-cy=password]').type('password123');
    cy.get('[data-cy=submit]').click();
    cy.url().should('include', '/dashboard');
  });
});
```

**Output** (`login.spec.ts`):
```typescript
import { test, expect } from '@playwright/test';

test.describe('Login', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('should log in successfully', async ({ page }) => {
    await page.locator('[data-cy=email]').fill('user@test.com');
    await page.locator('[data-cy=password]').fill('password123');
    await page.locator('[data-cy=submit]').click();
    await expect(page).toHaveURL(/dashboard/);
  });
});
```

---

## Development

```bash
# Clone the repo (replace with your fork URL if contributing)
git clone https://github.com/barispe/cy2play.git
cd cy2play

# Install dependencies
npm install

# Run in dev mode
npm run dev -- convert ./path/to/cypress/tests

# Build
npm run build

# Run tests
npm test
```

---

## Roadmap

See [PROGRESS.md](PROGRESS.md) for the detailed engineering roadmap and task tracking.

---

## Contributing

Contributions are welcome! Please open an issue to discuss your idea before submitting a PR.

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Commit your changes
4. Push and open a PR

---

## License

[ISC](LICENSE)
