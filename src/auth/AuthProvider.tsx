import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getBrowserSupabaseClient } from './supabase-browser';
import { requestPasswordRecovery } from './password-recovery';
import { startGoogleOAuth } from './google-oauth';

type SafeAuthUser = Pick<User, 'id' | 'email'>;

type AuthResult = { ok: true } | { ok: false; error: 'invalid_credentials' | 'authentication_failed' | 'auth_configuration_error' };

type AuthContextValue = {
  user: SafeAuthUser | null;
  loading: boolean;
  recovery: boolean;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signInWithGoogle: () => Promise<AuthResult>;
  requestPasswordReset: (email: string) => Promise<AuthResult>;
  updatePassword: (password: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function safeUser(session: Session | null): SafeAuthUser | null {
  return session?.user ? { id: session.user.id, email: session.user.email } : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SafeAuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovery, setRecovery] = useState(false);

  useEffect(() => {
    let active = true;
    try {
      const client = getBrowserSupabaseClient();
      client.auth.getSession().then(({ data }) => {
        if (!active) return;
        setUser(safeUser(data.session));
        setRecovery(Boolean(data.session && new URLSearchParams(window.location.search).get('mode') === 'reset'));
        setLoading(false);
      }).catch(() => {
        if (active) setLoading(false);
      });

      const { data: listener } = client.auth.onAuthStateChange((event, session) => {
        if (!active) return;
        setUser(safeUser(session));
        setRecovery(event === 'PASSWORD_RECOVERY'
          || Boolean(session && new URLSearchParams(window.location.search).get('mode') === 'reset'));
        setLoading(false);
      });
      return () => {
        active = false;
        listener.subscription.unsubscribe();
      };
    } catch {
      setLoading(false);
      return () => { active = false; };
    }
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    recovery,
    async signIn(email, password) {
      try {
        const { error } = await getBrowserSupabaseClient().auth.signInWithPassword({ email, password });
        return error ? { ok: false, error: 'invalid_credentials' } : { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error && error.message === 'auth_configuration_error'
          ? 'auth_configuration_error'
          : 'authentication_failed' };
      }
    },
    async signInWithGoogle() {
      try {
        return await startGoogleOAuth(
          getBrowserSupabaseClient(),
          window.location.origin,
        );
      } catch (error) {
        return { ok: false, error: error instanceof Error && error.message === 'auth_configuration_error'
          ? 'auth_configuration_error'
          : 'authentication_failed' };
      }
    },
    async requestPasswordReset(email) {
      try {
        const redirectTo = new URL('/login?mode=reset', window.location.origin).toString();
        return await requestPasswordRecovery(getBrowserSupabaseClient(), email, redirectTo);
      } catch (error) {
        return { ok: false, error: error instanceof Error && error.message === 'auth_configuration_error'
          ? 'auth_configuration_error'
          : 'authentication_failed' };
      }
    },
    async updatePassword(password) {
      try {
        const { error } = await getBrowserSupabaseClient().auth.updateUser({ password });
        if (error) return { ok: false, error: 'authentication_failed' };
        setRecovery(false);
        window.history.replaceState({}, '', '/dashboard');
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error && error.message === 'auth_configuration_error'
          ? 'auth_configuration_error'
          : 'authentication_failed' };
      }
    },
    async signOut() {
      try {
        await getBrowserSupabaseClient().auth.signOut();
      } finally {
        setUser(null);
        setRecovery(false);
      }
    },
  }), [loading, recovery, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
