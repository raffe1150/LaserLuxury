import { useEffect, useRef, useState } from 'react';

export interface GeneratePromptFormData {
  businessName: string;
  businessType: string;
  tone: string;
  bookingRules: string;
  escalationRules: string;
}

interface GeneratePromptModalProps {
  open: boolean;
  initialBusinessName?: string;
  onClose: () => void;
  onGenerate: (
    data: GeneratePromptFormData,
    signal: AbortSignal,
  ) => Promise<void> | void;
}

const BUSINESS_TYPES = [
  'Medical Clinic',
  'Luxury Clinic',
  'Hair Salon',
  'Nail Salon',
  'Beauty Salon',
  'Dental Clinic',
  'Aesthetic Clinic',
  'Gym',
  'Restaurant',
  'Studio',
  'Office',
  'Barber',
  'Retail',
  'Other',
];

const TONE_OPTIONS = [
  'Professional',
  'Friendly',
  'Luxury',
  'Premium',
  'Medical',
  'Warm',
  'Minimal',
];

export default function GeneratePromptModal({
  open,
  initialBusinessName = '',
  onClose,
  onGenerate,
}: GeneratePromptModalProps) {
  const [businessName, setBusinessName] = useState(initialBusinessName);
  const [businessType, setBusinessType] = useState('');
  const [tone, setTone] = useState('Professional');
  const [bookingRules, setBookingRules] = useState('');
  const [escalationRules, setEscalationRules] = useState('');
  const [generating, setGenerating] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) {
      setBusinessName(initialBusinessName);
      setGenerating(false);
      abortControllerRef.current = null;
    }

    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, [open, initialBusinessName]);

  if (!open) return null;

  const handleClose = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setGenerating(false);
    onClose();
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (generating) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setGenerating(true);

    try {
      await onGenerate(
        {
          businessName: businessName.trim(),
          businessType,
          tone,
          bookingRules: bookingRules.trim(),
          escalationRules: escalationRules.trim(),
        },
        controller.signal,
      );
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setGenerating(false);
      }
    }
  };

  return (
    <div
      className="dashboard-modal-backdrop"
      role="presentation"
      onMouseDown={handleClose}
    >
      <div
        className="dashboard-modal prompt-generator-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="generate-prompt-title"
        aria-busy={generating}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dashboard-modal-header">
          <div>
            <h2 id="generate-prompt-title">Generate System Prompt</h2>
            <p>
              Give Odinlink the key business rules and generate a professional
              AI receptionist prompt.
            </p>
          </div>

          <button
            className="modal-close-btn"
            type="button"
            aria-label={generating ? 'Cancel generation and close' : 'Close'}
            onClick={handleClose}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <fieldset
            disabled={generating}
            style={{ border: 0, padding: 0, margin: 0 }}
          >
            <div className="modal-form-grid">
              <div className="form-group">
                <label className="form-label" htmlFor="prompt-business-name">
                  Business Name
                </label>
                <input
                  id="prompt-business-name"
                  className="form-input"
                  type="text"
                  value={businessName}
                  onChange={(event) => setBusinessName(event.target.value)}
                  placeholder="Laser Luxury"
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="prompt-business-type">
                  Business Type
                </label>
                <select
                  id="prompt-business-type"
                  className="form-input"
                  value={businessType}
                  onChange={(event) => setBusinessType(event.target.value)}
                  required
                >
                  <option value="">Select business type</option>

                  {BUSINESS_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group form-full">
                <label className="form-label" htmlFor="prompt-tone">
                  Personality / Tone
                </label>
                <select
                  id="prompt-tone"
                  className="form-input"
                  value={tone}
                  onChange={(event) => setTone(event.target.value)}
                >
                  {TONE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group form-full">
                <label className="form-label" htmlFor="prompt-booking-rules">
                  Booking Rules
                </label>
                <textarea
                  id="prompt-booking-rules"
                  className="form-input"
                  rows={5}
                  value={bookingRules}
                  onChange={(event) => setBookingRules(event.target.value)}
                  placeholder="Example: Always check calendar availability before confirming. Ask for the customer's name and mobile number before creating a booking."
                />
              </div>

              <div className="form-group form-full">
                <label className="form-label" htmlFor="prompt-escalation-rules">
                  Escalation Rules
                </label>
                <textarea
                  id="prompt-escalation-rules"
                  className="form-input"
                  rows={5}
                  value={escalationRules}
                  onChange={(event) => setEscalationRules(event.target.value)}
                  placeholder="Example: Escalate complaints, refunds, payment disputes and medical questions to a human."
                />
              </div>
            </div>
          </fieldset>

          <div className="dashboard-modal-actions">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={handleClose}
            >
              {generating ? 'Cancel Generation' : 'Cancel'}
            </button>

            <button
              className="btn btn-primary"
              type="submit"
              disabled={generating}
            >
              {generating ? (
                <span className="generating-label">
                  <span>Generating</span>
                  <span className="loading-dots" aria-hidden="true">
                    <span>.</span>
                    <span>.</span>
                    <span>.</span>
                  </span>
                </span>
              ) : (
                'Generate Prompt'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
