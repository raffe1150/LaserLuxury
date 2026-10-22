/** Supervision owns only restart scheduling, never a cursor or processing lease.
 * Call recover AFTER the failed owner and its in-flight handler have drained. */
export class TelegramPollerSupervisor {
  private failures = 0;
  private generation = 0;
  private cancelled = false;
  constructor(private readonly schedule = (work: () => void, ms: number) => {
    const timer = setTimeout(work, ms); timer.unref(); return () => clearTimeout(timer);
  }, private readonly diagnostic: (delayMs: number) => void = () => {}) {}
  private cancelTimer: (() => void) | undefined;
  activate(): void { this.cancelTimer?.(); this.cancelTimer = undefined; this.generation++; this.cancelled = false; }
  cancel(): void { this.cancelled = true; this.generation++; this.cancelTimer?.(); this.cancelTimer = undefined; }
  recover(restart: () => Promise<void>, healthyMs: number): void {
    if (this.cancelled || this.cancelTimer) return;
    if (healthyMs >= 60_000) this.failures = 0;
    // Six rapid failures open a five-minute cooldown. Continued outages remain
    // recoverable without busy looping; credential failures never get here.
    const delay = this.failures >= 6 ? 300_000 : Math.min(30_000, 1000 * 2 ** this.failures);
    this.failures = this.failures >= 6 ? 0 : this.failures + 1;
    const generation = this.generation;
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = undefined;
      if (this.cancelled || generation !== this.generation) return;
      // The attempt schedules its own recovery after retiring its fresh owner.
      void restart().catch(() => {});
    }, delay);
    this.diagnostic(delay);
  }
}

export function recoverableTelegramLeaseFailure(reason: unknown): boolean {
  return reason instanceof Error && /^telegram_poller_(?:storage_(?:timeout|unavailable)|lease_lost|cursor_unconfirmed)$/u.test(reason.message);
}
