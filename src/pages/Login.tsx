import { FormEvent, useState } from 'react';

interface LoginProps {
  onNavigate: (path: '/' | '/login' | '/dashboard') => void;
}

export default function Login({ onNavigate }: LoginProps) {
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    window.setTimeout(() => onNavigate('/dashboard'), 350);
  };

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <button className="landing-logo login-logo" type="button" onClick={() => onNavigate('/')}>
          <span className="logo-dot" />
          Odinlink
        </button>
        <h1>Login</h1>
        <p>Use your existing backend authentication here.</p>
        <label>
          Email
          <input required type="email" placeholder="you@company.com" />
        </label>
        <label>
          Password
          <input required type="password" placeholder="••••••••" />
        </label>
        <button className="btn-primary" type="submit" disabled={loading}>
          {loading ? 'Opening dashboard...' : 'Continue'}
        </button>
      </form>
    </main>
  );
}

