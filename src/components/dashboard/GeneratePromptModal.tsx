import { useEffect, useState } from 'react';

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
  onGenerate: (data: GeneratePromptFormData) => void;
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

  useEffect(() => {
    if (open) {
      setBusinessName(initialBusinessName);
    }
  }, [open, initialBusinessName]);

  if (!open) return null;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    onGenerate({
      businessName: businessName.trim(),
      businessType,
      tone,
      bookingRules: bookingRules.trim(),
      escalationRules: escalationRules.trim(),
    });
  };

  return (
    <div
      className="dashboard-modal-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <div
        className="dashboard-modal prompt-generator-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="generate-prompt-title"
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
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit}>
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

          <div className="dashboard-modal-actions">
            <button className="btn btn-secondary" type="button" onClick={onClose}>
              Cancel
            </button>

            <button className="btn btn-primary" type="submit">
              Generate Prompt
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
