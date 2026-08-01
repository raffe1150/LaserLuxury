import { FormEvent, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { safePathAfterOAuthFailure } from '../auth/google-oauth';

interface LoginProps {
  onNavigate: (path: '/' | '/login' | '/dashboard') => void;
}

export default function Login({ onNavigate }: LoginProps) {
  const { recovery, signIn, signInWithGoogle, requestPasswordReset, updatePassword } = useAuth();
  const [busyAction, setBusyAction] = useState<'password' | 'google' | null>(null);
  const [mode, setMode] = useState<'login' | 'reset-request'>(() => 'login');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.get('mode') === 'reset') return;

    const safePath = safePathAfterOAuthFailure(currentUrl.toString());
    if (!safePath) return;

    window.history.replaceState({}, '', safePath);
    setMessage('Google sign-in was not completed. Please try again.');
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyAction) return;
    setBusyAction('password');
    setMessage(null);
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '').trim();
    const password = String(form.get('password') || '');
    const result = recovery
      ? await updatePassword(password)
      : mode === 'reset-request'
        ? await requestPasswordReset(email)
        : await signIn(email, password);
    setBusyAction(null);

    if (result.ok) {
      if (recovery) onNavigate('/dashboard');
      else if (mode === 'reset-request') {
        setMessage('If an account matches that email, password reset instructions have been sent.');
      } else onNavigate('/dashboard');
      return;
    }
    const errorCode = 'error' in result ? result.error : 'authentication_failed';
    setMessage(errorCode === 'auth_configuration_error'
      ? 'Authentication is not configured for this deployment.'
      : recovery
        ? 'The password could not be updated. Request a new reset link and try again.'
        : mode === 'login'
          ? 'Email or password is incorrect.'
          : 'We could not start password recovery right now. Please try again.');
  };

  const continueWithGoogle = async () => {
    if (busyAction) return;
    setBusyAction('google');
    setMessage(null);
    const result = await signInWithGoogle();

    if (!result.ok) {
      setBusyAction(null);
      const errorCode = 'error' in result ? result.error : 'authentication_failed';
      setMessage(errorCode === 'auth_configuration_error'
        ? 'Authentication is not configured for this deployment.'
        : 'Google sign-in could not be started. Please try again.');
    }
  };

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <button className="landing-logo login-logo" type="button" onClick={() => onNavigate('/')}>
          <span className="logo-dot" />
          Odinlink
        </button>
        <h1>{recovery ? 'Choose a new password' : mode === 'reset-request' ? 'Reset password' : 'Login'}</h1>
        <p>{recovery
          ? 'Enter a new password for your OdinLink account.'
          : mode === 'reset-request'
            ? 'We’ll send password reset instructions if the account exists.'
            : 'Sign in to your OdinLink workspace.'}</p>
        {!recovery && <label>
          Email
          <input required name="email" type="email" autoComplete="email" placeholder="you@company.com" />
        </label>}
        {mode === 'login' && <label>
          Password
          <input required name="password" type="password" autoComplete="current-password" placeholder="••••••••" />
        </label>}
        {recovery && <label>
          New password
          <input required name="password" type="password" minLength={8} autoComplete="new-password" placeholder="At least 8 characters" />
        </label>}
        {message && <p className="login-message" role="status">{message}</p>}
        <button className="btn-primary" type="submit" disabled={busyAction !== null}>
          {busyAction === 'password' ? 'Please wait…' : recovery ? 'Update password' : mode === 'reset-request' ? 'Send reset instructions' : 'Continue'}
        </button>
        {!recovery && mode === 'login' && <>
          <div className="login-divider" aria-hidden="true"><span>or</span></div>
          <button
            className="google-login-btn"
            type="button"
            disabled={busyAction !== null}
            onClick={continueWithGoogle}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.06H12v3.9h5.38a4.6 4.6 0 0 1-2 3.02v2.53h3.24c1.9-1.75 2.98-4.33 2.98-7.39Z" />
              <path fill="#34A853" d="M12 22c2.7 0 4.97-.9 6.62-2.38l-3.24-2.53c-.9.6-2.05.96-3.38.96-2.6 0-4.81-1.76-5.6-4.12H3.06v2.6A10 10 0 0 0 12 22Z" />
              <path fill="#FBBC05" d="M6.4 13.93A6 6 0 0 1 6.08 12c0-.67.12-1.32.32-1.93v-2.6H3.06A10 10 0 0 0 2 12c0 1.61.39 3.14 1.06 4.53l3.34-2.6Z" />
              <path fill="#EA4335" d="M12 5.95c1.47 0 2.79.5 3.82 1.49l2.87-2.87A9.63 9.63 0 0 0 12 2a10 10 0 0 0-8.94 5.47l3.34 2.6c.79-2.36 3-4.12 5.6-4.12Z" />
            </svg>
            {busyAction === 'google' ? 'Opening Google…' : 'Continue with Google'}
          </button>
          <p className="login-access-note">Business access is assigned separately after sign-in.</p>
        </>}
        {!recovery && <button
          className="topbar-btn ghost"
          type="button"
          disabled={busyAction !== null}
          onClick={() => { setMode((value) => value === 'login' ? 'reset-request' : 'login'); setMessage(null); }}
        >
          {mode === 'login' ? 'Forgot password?' : 'Back to login'}
        </button>}
      </form>
    </main>
  );
}
