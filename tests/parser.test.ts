import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseFile } from '../src/parser';

const FIXTURES_INPUT = path.join(__dirname, 'fixtures', 'input');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_INPUT, name), 'utf-8');
}

describe('AstParser', () => {
  describe('parseFile — login.cy.ts', () => {
    const source = readFixture('login.cy.ts');
    const result = parseFile(source, 'login.cy.ts');

    it('should find one top-level describe block', () => {
      expect(result.describes).toHaveLength(1);
      expect(result.describes[0].title).toBe('Login');
    });

    it('should find two test blocks', () => {
      expect(result.stats.totalTests).toBe(2);
      expect(result.describes[0].tests).toHaveLength(2);
      expect(result.describes[0].tests[0].title).toBe('should log in successfully');
      expect(result.describes[0].tests[1].title).toBe('should show error for invalid credentials');
    });

    it('should find one beforeEach hook', () => {
      expect(result.describes[0].hooks).toHaveLength(1);
      expect(result.describes[0].hooks[0].type).toBe('beforeEach');
    });

    it('should extract cy.visit command from beforeEach', () => {
      const hookCmds = result.describes[0].hooks[0].commands;
      const visitCmd = hookCmds.find(c => c.name === 'visit');
      expect(visitCmd).toBeDefined();
      expect(visitCmd!.isChained).toBe(false);
      expect(visitCmd!.isKnown).toBe(true);
    });

    it('should extract cy.get, .type, .click commands from tests', () => {
      const test1Cmds = result.describes[0].tests[0].commands;
      const names = test1Cmds.map(c => c.name);
      expect(names).toContain('get');
      expect(names).toContain('type');
      expect(names).toContain('click');
    });

    it('should extract .should assertions', () => {
      const test1Cmds = result.describes[0].tests[0].commands;
      const shouldCmds = test1Cmds.filter(c => c.name === 'should');
      expect(shouldCmds.length).toBeGreaterThanOrEqual(1);
    });

    it('should mark chained commands correctly', () => {
      const test1Cmds = result.describes[0].tests[0].commands;
      const typeCmds = test1Cmds.filter(c => c.name === 'type');
      typeCmds.forEach(cmd => {
        expect(cmd.isChained).toBe(true);
      });
    });

    it('should report correct total command count', () => {
      // login.cy.ts has: visit, 3x get+type/click, url+should in test1
      //                   3x get+type/click, get+should, get+should in test2
      expect(result.stats.totalCommands).toBeGreaterThan(5);
    });

    it('should have no warnings for standard commands', () => {
      // No cy.wait or complex commands in login fixture
      const complexWarnings = result.warnings.filter(w => w.severity === 'warning');
      expect(complexWarnings).toHaveLength(0);
    });
  });

  describe('parseFile — navigation.cy.ts', () => {
    const source = readFixture('navigation.cy.ts');
    const result = parseFile(source, 'navigation.cy.ts');

    it('should find one describe with three tests', () => {
      expect(result.describes).toHaveLength(1);
      expect(result.describes[0].title).toBe('Navigation');
      expect(result.describes[0].tests).toHaveLength(3);
    });

    it('should detect cy.intercept as complex', () => {
      const interceptCmd = result.allCommands.find(c => c.name === 'intercept');
      expect(interceptCmd).toBeDefined();
      expect(interceptCmd!.isComplex).toBe(true);
    });

    it('should detect cy.wait with alias and emit a warning', () => {
      const waitCmd = result.allCommands.find(c => c.name === 'wait');
      expect(waitCmd).toBeDefined();
      // Should generate an info warning about alias wait pattern
      const aliasWarning = result.warnings.find(
        w => w.message.includes('wait') && w.message.includes('alias'),
      );
      expect(aliasWarning).toBeDefined();
    });

    it('should detect cy.check and cy.select', () => {
      const names = result.allCommands.map(c => c.name);
      expect(names).toContain('check');
      expect(names).toContain('select');
    });

    it('should report complex commands in stats', () => {
      expect(result.stats.complexCommands).toBeGreaterThan(0);
    });
  });

  describe('parseFile — edge cases', () => {
    it('should handle an empty file gracefully', () => {
      const result = parseFile('', 'empty.cy.ts');
      expect(result.describes).toHaveLength(0);
      expect(result.tests).toHaveLength(0);
      expect(result.allCommands).toHaveLength(0);
    });

    it('should handle a file with only comments', () => {
      const source = '// This is a comment\n/* Block comment */\n';
      const result = parseFile(source, 'comments.cy.ts');
      expect(result.describes).toHaveLength(0);
      expect(result.allCommands).toHaveLength(0);
    });

    it('should handle describe.only and it.skip', () => {
      const source = `
        describe.only('Focused', () => {
          it.skip('skipped test', () => {
            cy.visit('/');
          });
        });
      `;
      const result = parseFile(source, 'skip.cy.ts');
      // describe.only starts with 'describe' so it should be parsed
      expect(result.describes).toHaveLength(1);
    });
  });
});
