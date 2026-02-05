# Product Requirements Document: Cy2Play - The AI Test Converter

**Version:** 1.0.0  
**Status:** DRAFT  
**Date:** February 5, 2026

---

## 1. Product Overview

### 1.1 The Problem
Cypress and Playwright are the two dominant testing frameworks. Many organizations are migrating from Cypress to Playwright for better performance, stability, and parallelization. However, this migration is painful:
-   **Syntax Differences:** Cypress uses a chainable, synchronous-like API (`cy.get('.btn').click()`), while Playwright uses standard JavaScript Promises/Async-Await (`await page.locator('.btn').click()`).
-   **Architecture Mismatch:** Cypress runs inside the browser; Playwright uses the DevTools Protocol (CDP).
-   **Scale:** Large codebases can have thousands of tests. Manual translation is slow, expensive, and error-prone.

### 1.2 The Solution
`Cy2Play` is an intelligent CLI tool that automates the conversion of Cypress tests to Playwright. Unlike simple regex-based find-and-replace tools, Cy2Play understands the Abstract Syntax Tree (AST) of the code.

It introduces a **Hybrid Engine** that balances speed and accuracy:
1.  **Strict Mode:** Deterministic, fast, rule-based conversion for standard commands.
2.  **Pure AI Mode:** Leveraging LLMs for reasoning through complex logic.
3.  **Hybrid Mode:** The default powerhouse—handling 90% of the work locally via AST and outsourcing only complex/unknown blocks to an LLM.

### 1.3 Value Proposition
-   **Efficiency:** Automate 80-95% of the migration effort.
-   **Privacy & Cost Control:** Support for Local LLMs (Ollama) means code doesn't have to leave the machine, and zero token costs.
-   **Accuracy:** Solves the specific problem of "Chaining vs. Await" which simple regex parsers fail at.

---

## 2. Detailed Architecture

The system follows a linear pipeline architecture:

```mermaid
graph TD
    A[Input File .spec.ts] --> B[CLI / Config Loader]
    B --> C[Parser (AST Generator)]
    C --> D{Strategy Selector}
    
    D -- "Strict Mode" --> E[AST Transformer]
    D -- "Hybrid Mode" --> F[Hybrid Orchestrator]
    D -- "Pure AI Mode" --> G[LLM Client]

    E --> H[Code Generator]
    F --> H
    G --> H
    
    H --> I[Formatter (Prettier)]
    I --> J[Output File .spec.ts]
```

### 2.1 Core Components
1.  **Parser:** Uses `babel` or `ts-morph` to generate an AST from the input Cypress file.
2.  **Strategy Selector:** Determines the execution path based on the user's `--mode` flag.
3.  **AST Transformer (The "Strict" Engine):**
    -   Walking the tree to identify CallExpressions (`cy.get`, `cy.click`).
    -   **Sync-to-Async Transformation:** This is the critical logic. It must detect chains and wrap the statement in an `await` expression.
    -   *Example:* `cy.get(sel).click()` AST node needs to become `await page.locator(sel).click()`.
4.  **LLM Layer:** An adapter interface defining how to talk to AI providers.
    -   `IOpenAIAdapter`
    -   `IAnthropicAdapter`
    -   `ILocalLLMAdapter` (Ollama/LM Studio compatible)

---

## 3. Detailed Feature Specifications

### 3.1 Mode 1: `strict` (Deterministic)
*   **Description:** 100% Rule-based. No AI calls.
*   **Logic:**
    -   Iterate over AST nodes.
    -   Match known Cypress patterns (e.g., `cy.get`, `cy.visit`, `cy.contains`).
    -   Throw warnings or leave comments (`// TODO: Convert manual`) for unknown expressions.
*   **Mappings:**
    -   `cy.visit(url)` -> `await page.goto(url)`
    -   `cy.get(selector)` -> `page.locator(selector)`
    -   `.click()` -> `.click()`
    -   `.type(text)` -> `.fill(text)` (Note: Type vs Fill nuance)
    -   `.should('be.visible')` -> `await expect(...).toBeVisible()`
*   **Pros:** Instant, zero cost, deterministic.
*   **Cons:** Fails on `cy.origin`, complex aliases, custom commands.

### 3.2 Mode 2: `pure-ai` (Full Context)
*   **Description:** Reads the entire file content and prompts the LLM to rewrite it.
*   **Logic:**
    -   Construct a prompt with system instructions: "You are an expert SDET. Convert this Cypress code to Playwright...".
    -   Send full file content.
    -   Parse response to extract code block.
*   **Pros:** Handles complex logic, variable scoping, and "intent" best.
*   **Cons:** Expensive (tokens), slow, prone to hallucinating APIs that don't exist.

### 3.3 Mode 3: `hybrid` (The Default)
*   **Description:** A smart mix. It tries to convert everything via AST rules first.
*   **Workflow:**
    1.  Parse AST.
    2.  Traverse nodes. If a node is in the `KNOWN_COMMANDS` list (visit, get, click, type, should), apply AST transformation.
    3.  If a node is **Unknown** (e.g., `cy.dragAndDrop`, `cy.myCustomCmd`) or **Complex** (nested callbacks inside `cy.then`):
        -   Extract that specific code block and its immediate context (previous 5 lines).
        -   Send *snippet* to LLM: "Translate this specific Cypress block to Playwright equivalents. Assume `page` object exists."
        -   Inject the LLM response back into the AST or string buffer.
*   **Pros:** Cost-effective, high accuracy on basics, capability to handle edge cases.

### 3.4 Local LLM Support
*   **Requirement:** The tool must not enforce usage of OpenAI.
*   **Implementation:**
    -   Generic HTTP Adapter compatible with OpenAI API spec (which Ollama and LM Studio imitate).
    -   Configurable `baseUrl` (e.g., `http://localhost:11434/v1`).
    -   Configurable `modelName` (e.g., `mistral`, `codellama`).

---

## 4. Configuration Schema

The tool looks for `cy2play.config.json` in the root.

```json
{
  "$schema": "./node_modules/cy2play/schema.json",
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

**Field Details:**
-   `mode`: `"strict" | "hybrid" | "pure-ai"`
-   `llm.provider`: `"openai" | "anthropic" | "local"`

---

## 5. Technical Constraints & Edge Cases

### 5.1 Handling `cy.wait()`
-   **Static Wait:** `cy.wait(1000)` -> `await page.waitForTimeout(1000)` (Simple).
-   **Alias Wait:** `cy.wait('@apiCall')` -> `await page.waitForResponse(resp => ...)` (Complex).
    -   *Strategy:* In `strict` mode, this might require a `// FIXME` comment because Playwright requires defining the route handler *before* the action, whereas Cypress often defines interceptors globally or in `beforeEach`.
    -   *Hybrid Solution:* Send the `cy.intercept` + `cy.wait` pattern to LLM to refactor into `await Promise.all([ page.waitForResponse(...), page.click(...) ])`.

### 5.2 Global Hooks (`before`, `beforeEach`)
-   Cypress converts `beforeEach` closely to Playwright `test.beforeEach`.
-   **Constraint:** Cypress often uses `this.foo = 'bar'` in `beforeEach` and accesses `this.foo` in tests. Playwright does not share `this` context the same way.
-   *Mitigation:* Convert `this.foo` usage to local variables or Playwright fixtures. This is a high-complexity task ideal for the LLM.

### 5.3 Sync vs Async Chaining
-   Cypress: `cy.get('li').eq(0).click()`
-   Playwright: `await page.locator('li').nth(0).click()`
-   The parser must identify the *end* of the chain to apply the `await`.
    -   *Incorrect:* `await page.locator('li').nth(0)` (returns locator) --> then `.click()`?
    -   *Correct:* `await page.locator('li').nth(0).click()` (returns Promise).

---

## 6. User Experience (CLI)

The CLI should be built using `commander` or `yargs`.

### Commands

**1. Transform a single file**
```bash
npx cy2play src/e2e/login.cy.ts
```

**2. Transform with specific flags**
```bash
npx cy2play src/e2e/folder/ --mode pure-ai --provider openai --model gpt-4
```

**3. Use Local LLM**
```bash
npx cy2play src/e2e/ --mode hybrid --provider local --local-url http://localhost:1234 --model mistral
```

**Output:**
```text
> cy2play v0.1.0
> Loaded config from cy2play.config.json
> Mode: Hybrid | Processor: Local (Mistral)

[Converted] src/e2e/login.cy.ts -> play/login.spec.ts (1.2s)
[Converted] src/e2e/checkout.cy.ts -> play/checkout.spec.ts (4.5s)
...
Done! Converted 12 files. 
Stats: 
- 85% Rules Base
- 15% AI Resolved
```

---

## 7. Engineering Roadmap

> For the detailed, tracked engineering roadmap with task status, see [PROGRESS.md](PROGRESS.md).
