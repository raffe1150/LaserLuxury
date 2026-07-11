import landingMarkup from '../components/landing/LandingMarkup';
import useLandingInteractions from '../components/landing/useLandingInteractions';

interface LandingProps {
  onNavigate: (path: '/' | '/login' | '/dashboard') => void;
}

export default function Landing({ onNavigate }: LandingProps) {
  useLandingInteractions(onNavigate);

  return <div dangerouslySetInnerHTML={{ __html: landingMarkup }} />;
}

