// ============================================================================
// Cy2Play — Batch Progress Bar
// ============================================================================
//
// Renders a real-time progress bar in the terminal during directory conversions.
// Shows: file N/M, percentage, elapsed time, ETA, and current file name.
// ============================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProgressBarOptions {
  /** Total number of items to process */
  total: number;
  /** Width of the progress bar in characters (default: 30) */
  barWidth?: number;
  /** Label prefix (default: 'Converting') */
  label?: string;
  /** Stream to write to (default: process.stderr) */
  stream?: NodeJS.WriteStream;
}

// ---------------------------------------------------------------------------
// ProgressBar
// ---------------------------------------------------------------------------

export class ProgressBar {
  private total: number;
  private current: number = 0;
  private barWidth: number;
  private label: string;
  private stream: NodeJS.WriteStream;
  private startTime: number;
  private currentFile: string = '';
  private isTTY: boolean;

  constructor(options: ProgressBarOptions) {
    this.total = options.total;
    this.barWidth = options.barWidth ?? 30;
    this.label = options.label ?? 'Converting';
    this.stream = options.stream ?? process.stderr;
    this.startTime = Date.now();
    this.isTTY = this.stream.isTTY ?? false;
  }

  /**
   * Update progress — increment by one and optionally set the current file name.
   */
  tick(fileName?: string): void {
    this.current++;
    if (fileName) this.currentFile = fileName;
    this.render();
  }

  /**
   * Set progress to a specific value.
   */
  update(current: number, fileName?: string): void {
    this.current = current;
    if (fileName) this.currentFile = fileName;
    this.render();
  }

  /**
   * Mark the progress bar as complete — clears the line and prints a final message.
   */
  complete(message?: string): void {
    if (this.isTTY) {
      this.clearLine();
    }
    if (message) {
      this.stream.write(message + '\n');
    }
  }

  /**
   * Get the formatted progress string (without clearing the line).
   * Useful for testing or non-TTY environments.
   */
  format(): string {
    const pct = this.total > 0 ? Math.round((this.current / this.total) * 100) : 100;
    const filled = this.total > 0
      ? Math.round((this.current / this.total) * this.barWidth)
      : this.barWidth;
    const empty = this.barWidth - filled;

    const bar = `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
    const counter = `${this.current}/${this.total}`;
    const elapsed = this.formatTime(Date.now() - this.startTime);
    const eta = this.estimateETA();

    let line = `${this.label} ${bar} ${pct}% (${counter}) ${elapsed}`;
    if (eta) line += ` ETA: ${eta}`;
    if (this.currentFile) line += ` | ${this.truncateFile(this.currentFile)}`;

    return line;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private render(): void {
    const line = this.format();

    if (this.isTTY) {
      this.clearLine();
      this.stream.write(line);
    }
    // Non-TTY: don't write progress to avoid polluting piped output
  }

  private clearLine(): void {
    this.stream.write('\r\x1b[K'); // carriage return + clear line
  }

  private estimateETA(): string {
    if (this.current === 0) return '';
    const elapsed = Date.now() - this.startTime;
    const msPerItem = elapsed / this.current;
    const remaining = (this.total - this.current) * msPerItem;
    if (remaining <= 0) return '';
    return this.formatTime(remaining);
  }

  private formatTime(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    return `${m}m${rs}s`;
  }

  private truncateFile(name: string, maxLen: number = 30): string {
    if (name.length <= maxLen) return name;
    return '...' + name.slice(name.length - maxLen + 3);
  }
}
