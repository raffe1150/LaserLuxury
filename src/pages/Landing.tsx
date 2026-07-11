import { useEffect } from 'react';
import landingMarkup from '../components/Landing/LandingMarkup';
import useLandingInteractions from '../components/Landing/useLandingInteractions';
import landingCss from '../styles/landing.css?raw';

interface LandingProps {
  onNavigate: (path: '/' | '/login' | '/dashboard') => void;
}

export default function Landing({ onNavigate }: LandingProps) {
  useLandingInteractions(onNavigate);

  useEffect(() => {
    const style = document.createElement('style');
    style.dataset.pageStyle = 'landing';
    style.textContent = landingCss;
    document.head.appendChild(style);

    return () => {
      style.remove();
    };
  }, []);

  return <div dangerouslySetInnerHTML={{ __html: landingMarkup }} />;
}
