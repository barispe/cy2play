// ============================================================================
// Cy2Play — Cypress → Playwright Command Mappings
// ============================================================================

// ---------------------------------------------------------------------------
// Selector Mappings (cy.xxx → page.xxx)
// ---------------------------------------------------------------------------

export interface SelectorMapping {
  /** The Playwright replacement method */
  playwright: string;
  /** Whether the result is a locator (not an action — no await needed on its own) */
  isLocator: boolean;
  /** Optional notes for documentation / warnings */
  note?: string;
}

/**
 * Maps Cypress selector/query commands to their Playwright equivalents.
 * Key = Cypress method name (without `cy.` prefix).
 */
export const SELECTOR_MAPPINGS: Record<string, SelectorMapping> = {
  get:       { playwright: 'page.locator',          isLocator: true },
  contains:  { playwright: 'page.getByText',        isLocator: true, note: 'Partial text match by default in Playwright' },
  find:      { playwright: '.locator',              isLocator: true, note: 'Scoped locator' },
  first:     { playwright: '.first()',              isLocator: true },
  last:      { playwright: '.last()',               isLocator: true },
  eq:        { playwright: '.nth',                  isLocator: true },
  closest:   { playwright: '.locator',              isLocator: true, note: 'Manual review — closest() has no direct equivalent' },
  parent:    { playwright: '.locator(\"..\")',       isLocator: true },
  children:  { playwright: '.locator(\"> *\")',     isLocator: true },
  siblings:  { playwright: '.locator(\"~ *\")',     isLocator: true, note: 'Approximation — review manually' },
  filter:    { playwright: '.filter',               isLocator: true },
};

// ---------------------------------------------------------------------------
// Action Mappings (chainable actions → awaited Playwright calls)
// ---------------------------------------------------------------------------

export interface ActionMapping {
  /** The Playwright replacement method */
  playwright: string;
  /** Whether this action returns a Promise (needs await) */
  needsAwait: boolean;
  /** Optional argument transformation hint */
  argTransform?: 'passthrough' | 'none' | 'special';
  note?: string;
}

/**
 * Maps Cypress action commands to their Playwright equivalents.
 * Key = Cypress method name.
 */
export const ACTION_MAPPINGS: Record<string, ActionMapping> = {
  click:        { playwright: '.click()',             needsAwait: true },
  dblclick:     { playwright: '.dblclick()',           needsAwait: true },
  rightclick:   { playwright: '.click({ button: \"right\" })', needsAwait: true },
  type:         { playwright: '.fill',                needsAwait: true, note: 'cy.type → .fill() (fill replaces; use .pressSequentially for keystroke sim)' },
  clear:        { playwright: '.clear()',              needsAwait: true },
  check:        { playwright: '.check()',              needsAwait: true },
  uncheck:      { playwright: '.uncheck()',            needsAwait: true },
  select:       { playwright: '.selectOption',         needsAwait: true },
  focus:        { playwright: '.focus()',               needsAwait: true },
  blur:         { playwright: '.blur()',                needsAwait: true },
  submit:       { playwright: '.press(\"Enter\")',     needsAwait: true, note: 'No direct submit — press Enter on form' },
  trigger:      { playwright: '.dispatchEvent',        needsAwait: true, note: 'Argument mapping may need manual review' },
  scrollIntoView: { playwright: '.scrollIntoViewIfNeeded()', needsAwait: true },
  scrollTo:     { playwright: '.evaluate(el => el.scrollTo(...))', needsAwait: true, note: 'Manual review likely needed' },
};

// ---------------------------------------------------------------------------
// Navigation / Utility Mappings (cy.xxx → page.xxx)
// ---------------------------------------------------------------------------

export interface NavigationMapping {
  /** The Playwright replacement */
  playwright: string;
  needsAwait: boolean;
  argTransform?: 'passthrough' | 'none' | 'special';
  note?: string;
}

export const NAVIGATION_MAPPINGS: Record<string, NavigationMapping> = {
  visit:    { playwright: 'await page.goto',              needsAwait: true },
  go:       { playwright: 'await page.goBack',            needsAwait: true, note: 'cy.go("back") / cy.go("forward")' },
  reload:   { playwright: 'await page.reload()',           needsAwait: true },
  url:      { playwright: 'page.url()',                    needsAwait: false },
  title:    { playwright: 'await page.title()',            needsAwait: true },
  location: { playwright: 'page.url()',                    needsAwait: false, note: 'Returns string, not Location object' },
};

// ---------------------------------------------------------------------------
// Wait Mappings
// ---------------------------------------------------------------------------

export const WAIT_MAPPINGS: Record<string, NavigationMapping> = {
  wait_number:  { playwright: 'await page.waitForTimeout',  needsAwait: true, note: '⚠️ Static waits are a code smell — prefer waitFor* assertions' },
  wait_alias:   { playwright: 'await page.waitForResponse',  needsAwait: true, note: 'Complex: requires refactoring cy.intercept + cy.wait pattern' },
};

// ---------------------------------------------------------------------------
// Assertion Mappings (.should('xxx') → expect(loc).toXxx())
// ---------------------------------------------------------------------------

export interface AssertionMapping {
  /** The Playwright expect method */
  playwright: string;
  /** Whether the assertion takes a value argument */
  hasValue: boolean;
  /** Whether the assertion is negatable (should('not.xxx')) */
  negatable: boolean;
  note?: string;
}

/**
 * Maps Cypress `.should()` assertion strings to Playwright `expect()` assertions.
 * Key = the Cypress chainer string (e.g., 'be.visible', 'have.text').
 */
export const ASSERTION_MAPPINGS: Record<string, AssertionMapping> = {
  // Visibility
  'be.visible':       { playwright: 'toBeVisible',      hasValue: false, negatable: true },
  'be.hidden':        { playwright: 'toBeHidden',        hasValue: false, negatable: true },
  'exist':            { playwright: 'toBeAttached',      hasValue: false, negatable: true },
  'not.exist':        { playwright: 'not.toBeAttached',  hasValue: false, negatable: false },

  // Text
  'have.text':        { playwright: 'toHaveText',        hasValue: true,  negatable: true },
  'contain':          { playwright: 'toContainText',     hasValue: true,  negatable: true },
  'contain.text':     { playwright: 'toContainText',     hasValue: true,  negatable: true },
  'include.text':     { playwright: 'toContainText',     hasValue: true,  negatable: true },

  // Value
  'have.value':       { playwright: 'toHaveValue',       hasValue: true,  negatable: true },

  // Attributes & CSS
  'have.attr':        { playwright: 'toHaveAttribute',   hasValue: true,  negatable: true },
  'have.css':         { playwright: 'toHaveCSS',         hasValue: true,  negatable: true },
  'have.class':       { playwright: 'toHaveClass',       hasValue: true,  negatable: true },
  'have.id':          { playwright: 'toHaveId',          hasValue: true,  negatable: true },

  // Count / Length
  'have.length':      { playwright: 'toHaveCount',       hasValue: true,  negatable: true },

  // State
  'be.checked':       { playwright: 'toBeChecked',       hasValue: false, negatable: true },
  'be.disabled':      { playwright: 'toBeDisabled',      hasValue: false, negatable: true },
  'be.enabled':       { playwright: 'toBeEnabled',       hasValue: false, negatable: true },
  'be.empty':         { playwright: 'toBeEmpty',         hasValue: false, negatable: true },
  'be.focused':       { playwright: 'toBeFocused',       hasValue: false, negatable: true },
  'be.selected':      { playwright: 'toBeChecked',       hasValue: false, negatable: true, note: 'Approximation — review for <option> elements' },

  // URL (used with cy.url().should(...))
  'include':          { playwright: 'toContainText',     hasValue: true,  negatable: true, note: 'Context-dependent: may be toHaveURL when chained from cy.url()' },
  'eq':               { playwright: 'toHaveText',        hasValue: true,  negatable: true, note: 'Context-dependent: exact match' },
  'match':            { playwright: 'toHaveText',        hasValue: true,  negatable: true, note: 'Regex match — may need toHaveURL with regex' },
};

// ---------------------------------------------------------------------------
// Hook Mappings
// ---------------------------------------------------------------------------

export const HOOK_MAPPINGS: Record<string, string> = {
  before:       'test.beforeAll',
  beforeEach:   'test.beforeEach',
  after:        'test.afterAll',
  afterEach:    'test.afterEach',
};

// ---------------------------------------------------------------------------
// Structure Mappings (describe / it / context)
// ---------------------------------------------------------------------------

export const STRUCTURE_MAPPINGS: Record<string, string> = {
  describe:  'test.describe',
  context:   'test.describe',
  it:        'test',
  specify:   'test',
};

// ---------------------------------------------------------------------------
// Commands that always need LLM / manual review
// ---------------------------------------------------------------------------

export const COMPLEX_COMMANDS: Set<string> = new Set([
  'intercept',
  'route',
  'server',
  'origin',
  'session',
  'task',
  'exec',
  'readFile',
  'writeFile',
  'fixture',
  'wrap',
  'request',
  'getCookie',
  'getCookies',
  'setCookie',
  'clearCookie',
  'clearCookies',
  'screenshot',
  'viewport',
  'window',
  'document',
  'then',  // callback unwrapping is complex
  'each',  // iteration pattern differs
  'within', // scoped context
  'shadow', // shadow DOM access
  'its',   // property access pattern
  'invoke', // method invocation pattern
]);

/**
 * Quick lookup: Is this a known Cypress command we can handle in strict mode?
 */
export function isKnownCommand(command: string): boolean {
  return (
    command in SELECTOR_MAPPINGS ||
    command in ACTION_MAPPINGS ||
    command in NAVIGATION_MAPPINGS ||
    command in HOOK_MAPPINGS ||
    command in STRUCTURE_MAPPINGS ||
    command === 'wait'
  );
}

/**
 * Quick lookup: Does this command require LLM / manual review?
 */
export function isComplexCommand(command: string): boolean {
  return COMPLEX_COMMANDS.has(command);
}
