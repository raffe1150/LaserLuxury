type WaitingRequest = {
  start: () => void;
  signal?: AbortSignal;
  abort: () => void;
};

// A waiting request owns no slot. Once admitted, it keeps its slot until its
// provider promise settles, including rejection after transport cancellation.
export class AiRequestQueue {
  private active = 0;
  private waiting: WaitingRequest[] = [];

  constructor(private readonly concurrency: number) {}

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry: WaitingRequest = {
        signal,
        start: () => {
          signal?.removeEventListener('abort', entry.abort);
          this.active++;
          resolve();
        },
        abort: () => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          signal?.removeEventListener('abort', entry.abort);
          reject(signal?.reason);
        },
      };
      this.waiting.push(entry);
      signal?.addEventListener('abort', entry.abort, { once: true });
    });
  }

  private release(): void {
    this.active--;
    const next = this.waiting.shift();
    next?.start();
  }

  async run<T>(job: () => Promise<T>, onExecutionStart?: () => void, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      onExecutionStart?.();
      return await job();
    } finally {
      this.release();
    }
  }
}
