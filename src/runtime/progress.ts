/** Diagnostic stall signal; an explicit boot deadline is handled by the session. */
export class ProgressWatch {
  private signature = '';
  private changed = 0;
  sample(
    signature: string,
    now: number,
  ): { stalled: boolean; unchangedMs: number } {
    if (signature !== this.signature) {
      this.signature = signature;
      this.changed = now;
    }
    const unchangedMs = now - this.changed;
    return { stalled: unchangedMs >= 10000, unchangedMs };
  }
}
