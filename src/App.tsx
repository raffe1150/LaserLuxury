import { useEffect, useState } from 'react';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Dashboard from './pages/dashboard';

type Route = '/' | '/login' | '/dashboard';

function getRoute(): Route {
  const path = window.location.pathname;
  if (path === '/login' || path === '/dashboard') return path;
  return '/';
}

export default function App() {
  const [route, setRoute] = useState<Route>(getRoute());

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

  if (route === '/login') return <Login onNavigate={navigate} />;
  if (route === '/dashboard') return <Dashboard onNavigate={navigate} />;
  return <Landing onNavigate={navigate} />;
}
