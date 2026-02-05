import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { discoverFiles, computeOutputPath } from '../src/discovery';

const FIXTURES_INPUT = path.join(__dirname, 'fixtures', 'input');

describe('FileDiscoverer', () => {
  describe('discoverFiles', () => {
    it('should discover all .cy.ts files in a directory', async () => {
      const result = await discoverFiles(FIXTURES_INPUT);
      expect(result.count).toBeGreaterThanOrEqual(2);
      expect(result.files.some(f => f.endsWith('login.cy.ts'))).toBe(true);
      expect(result.files.some(f => f.endsWith('navigation.cy.ts'))).toBe(true);
    });

    it('should return a single file when given a file path', async () => {
      const filePath = path.join(FIXTURES_INPUT, 'login.cy.ts');
      const result = await discoverFiles(filePath);
      expect(result.count).toBe(1);
      expect(result.files[0]).toBe(filePath);
    });

    it('should throw for a non-existent path', async () => {
      await expect(discoverFiles('/does/not/exist')).rejects.toThrow('Path does not exist');
    });

    it('should return sorted, unique file list', async () => {
      const result = await discoverFiles(FIXTURES_INPUT);
      const sorted = [...result.files].sort();
      expect(result.files).toEqual(sorted);
    });
  });

  describe('computeOutputPath', () => {
    it('should convert .cy.ts to .spec.ts', () => {
      const result = computeOutputPath(
        '/project/cypress/e2e/login.cy.ts',
        '/project/cypress/e2e',
        '/project/playwright-tests',
      );
      expect(result).toBe(path.join('/project/playwright-tests', 'login.spec.ts'));
    });

    it('should preserve subdirectory structure', () => {
      const result = computeOutputPath(
        '/project/cypress/e2e/auth/login.cy.ts',
        '/project/cypress/e2e',
        '/project/output',
      );
      expect(result).toBe(path.join('/project/output', 'auth', 'login.spec.ts'));
    });

    it('should handle .cy.js files', () => {
      const result = computeOutputPath(
        '/project/tests/app.cy.js',
        '/project/tests',
        '/project/output',
      );
      expect(result).toBe(path.join('/project/output', 'app.spec.ts'));
    });
  });
});
