import landingMarkup from '../components/Landing/LandingMarkup';
import useLandingInteractions from '../components/Landing/useLandingInteractions';
import '../styles/landing.css';
interface LandingProps {
  onNavigate: (path: '/' | '/login' | '/dashboard') => void;
}

export default function Landing({ onNavigate }: LandingProps) {
  useLandingInteractions(onNavigate);

  return <div dangerouslySetInnerHTML={{ __html: landingMarkup }} />;
}

