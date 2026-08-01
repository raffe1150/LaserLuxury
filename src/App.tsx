import { useEffect, useState } from 'react';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Dashboard from './pages/dashboard';
import { useAuth } from './auth/AuthProvider';

type Route = '/' | '/login' | '/dashboard';

function getRoute(): Route {
  const path = window.location.pathname;
  if (path === '/login' || path === '/dashboard') return path;
  return '/';
}

export default function App() {
  const [route, setRoute] = useState<Route>(getRoute());
  const { user, loading, recovery } = useAuth();

  useEffect(() => {
    const onPopState = () => setRoute(getRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = (to: Route) => {
    window.history.pushState({}, '', to);
    setRoute(to);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    if (loading) return;
    if (route === '/dashboard' && !user) {
      window.history.replaceState({}, '', '/login');
      setRoute('/login');
    } else if (route === '/login' && user && !recovery) {
      window.history.replaceState({}, '', '/dashboard');
      setRoute('/dashboard');
    }
  }, [loading, recovery, route, user]);

  if (loading || (route === '/dashboard' && !user)) {
    return <main className="login-page"><div className="login-card" role="status">Loading secure session…</div></main>;
  }

  if (route === '/login') return <Login onNavigate={navigate} />;
  if (route === '/dashboard') return <Dashboard onNavigate={navigate} />;
  return <Landing onNavigate={navigate} />;
}
