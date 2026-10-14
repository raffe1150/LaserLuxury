import { AsyncLocalStorage } from 'node:async_hooks';

export function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: any) => {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) {
      Object.values(item).forEach(freeze); Object.freeze(item);
    }
  };
  freeze(copy); return copy;
}

export type CapturedEvidence<T> = Readonly<{ support: T | null; required: boolean; documents: any | null }>;
type RequestState<T> = { session?: string; token?: symbol; expires?: number; evidence?: CapturedEvidence<T>; invocation?: readonly string[] };

/** Lifetime is independent of conversation-cache expiry; entries exist only while work runs. */
export class RequestSecurity<T> {
  private scope = new AsyncLocalStorage<RequestState<T>>();
  private sessions = new Map<string, { latest: symbol; active: number }>();
  async run<R>(work: () => Promise<R>): Promise<R> {
    const state: RequestState<T> = {};
    return this.scope.run(state, async () => {
      try { return await work(); }
      finally {
        const session = state.session && this.sessions.get(state.session);
        if (session && --session.active === 0) this.sessions.delete(state.session!);
      }
    });
  }
  bind(session: string) {
    const state = this.scope.getStore();
    if (!state || state.session) return;
    const token = Symbol(session); const previous = this.sessions.get(session);
    this.sessions.set(session, { latest: token, active: (previous?.active || 0) + 1 });
    Object.assign(state, { session, token, expires: Date.now() + 5 * 60_000 });
  }
  capture(support: T | null, required: boolean, documents: any | null) {
    const state = this.scope.getStore();
    if (state && !state.evidence) state.evidence = immutable({ support, required, documents });
  }
  get evidence() { return this.scope.getStore()?.evidence; }
  get bound() { return Boolean(this.scope.getStore()?.session); }
  current() {
    const state = this.scope.getStore();
    return Boolean(state?.session && state.expires > Date.now() && this.sessions.get(state.session)?.latest === state.token);
  }
  active(session: string) { return Boolean(this.sessions.get(session)?.active); }
  offer(names: string[]) {
    const state = this.scope.getStore();
    if (!state) return;
    state.invocation = Object.freeze(this.evidence?.required ? [] : [...new Set(names)]);
  }
  authorize(names: string[], currentlyAllowed: string[]): string[] {
    if (!this.current() || !this.scope.getStore()?.invocation) return [];
    const offered = new Set(this.scope.getStore()!.invocation);
    const remaining = new Set(currentlyAllowed);
    return names.filter(name => offered.has(name) && remaining.has(name));
  }
}
