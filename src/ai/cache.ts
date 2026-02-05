// ============================================================================
// Cy2Play — Snippet Cache
// ============================================================================
//
// Hash-based cache to avoid re-querying the LLM for identical code snippets.
// Uses SHA-256 hashing on the input code to create a deterministic key.
// Supports optional disk persistence for cross-run caching.
// ============================================================================

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface CacheEntry {
  /** The converted Playwright code */
  result: string;
  /** Timestamp when the entry was cached */
  cachedAt: number;
  /** The model that produced this result */
  model?: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

/**
 * Simple hash-based cache for LLM query results.
 * Avoids re-sending identical code snippets to the LLM.
 */
export class SnippetCache {
  private cache: Map<string, CacheEntry> = new Map();
  private hits = 0;
  private misses = 0;
  private persistPath: string | null;

  /**
   * @param persistPath - Optional path to a JSON file for disk persistence.
   *                      If provided, the cache is loaded on construction and
   *                      saved on each write.
   */
  constructor(persistPath?: string) {
    this.persistPath = persistPath ?? null;

    if (this.persistPath) {
      this.loadFromDisk();
    }
  }

  /**
   * Hash a code snippet into a deterministic cache key.
   * Normalizes whitespace so trivial formatting changes don't bust the cache.
   */
  static hashKey(code: string): string {
    const normalized = code.trim().replace(/\s+/g, ' ');
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  /**
   * Look up a cached result for the given code snippet.
   * @returns The cached Playwright code, or `null` if not found.
   */
  get(code: string): string | null {
    const key = SnippetCache.hashKey(code);
    const entry = this.cache.get(key);

    if (entry) {
      this.hits++;
      return entry.result;
    }

    this.misses++;
    return null;
  }

  /**
   * Store a conversion result in the cache.
   */
  set(code: string, result: string, model?: string): void {
    const key = SnippetCache.hashKey(code);
    this.cache.set(key, {
      result,
      cachedAt: Date.now(),
      model,
    });

    if (this.persistPath) {
      this.saveToDisk();
    }
  }

  /**
   * Check if a snippet is already cached.
   */
  has(code: string): boolean {
    const key = SnippetCache.hashKey(code);
    return this.cache.has(key);
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;

    if (this.persistPath && fs.existsSync(this.persistPath)) {
      fs.unlinkSync(this.persistPath);
    }
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
    };
  }

  // --- Disk persistence ---

  private loadFromDisk(): void {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;

    try {
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, CacheEntry>;
      for (const [key, entry] of Object.entries(data)) {
        this.cache.set(key, entry);
      }
    } catch {
      // Corrupted cache file — ignore and start fresh
    }
  }

  private saveToDisk(): void {
    if (!this.persistPath) return;

    try {
      const dir = path.dirname(this.persistPath);
      fs.mkdirSync(dir, { recursive: true });

      const data: Record<string, CacheEntry> = {};
      for (const [key, entry] of this.cache.entries()) {
        data[key] = entry;
      }

      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Non-critical — silently fail
    }
  }
}
