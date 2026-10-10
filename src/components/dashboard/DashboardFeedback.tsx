import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useDashboardI18n } from '../../i18n/dashboard';

export type FeedbackKind = 'success' | 'error' | 'info';
export interface DashboardFeedbackValue { message: string; kind: FeedbackKind }
export type DashboardFeedbackMemory = MutableRefObject<{ businessId: string; feedback: DashboardFeedbackValue | null } | null>;
export type DashboardSaved = (message: string, refresh?: boolean, feedback?: { kind: FeedbackKind; local?: boolean }) => void;

// Presentation only: the caller retains its existing save, validation and refresh boundaries.
export function useDashboardFeedback(onSaved: DashboardSaved, memory?: DashboardFeedbackMemory, businessId = '') {
  // Independent form message only. Existing dashboard refreshes can remount forms;
  // keep their last result without retaining fields, changing requests or persisting globally.
  const [feedback, setFeedback] = useState<DashboardFeedbackValue | null>(() => memory?.current?.businessId === businessId ? memory.current.feedback : null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const reportFeedback = (message: string, refresh = false, kind: FeedbackKind = 'success') => {
    if (mounted.current) {
      setFeedback({ message, kind });
      if (memory) memory.current = { businessId, feedback: { message, kind } };
    }
    onSaved(message, refresh, { kind, local: true });
  };
  return { feedback, reportFeedback, clearFeedback: () => { setFeedback(null); if (memory) memory.current = { businessId, feedback: null }; } };
}

export default function DashboardFeedback({ feedback, saving = false, busyLabel = 'Saving...' }: { feedback: DashboardFeedbackValue | null; saving?: boolean; busyLabel?: string }) {
  const { t } = useDashboardI18n();
  if (!saving && !feedback) return null;
  const kind = saving ? 'info' : feedback!.kind;
  return <div className={`dashboard-feedback ${kind}`} role={kind === 'error' ? 'alert' : 'status'} aria-atomic="true" translate="no">
    <span className="dashboard-feedback-symbol" aria-hidden="true">{saving ? '…' : kind === 'success' ? '✓' : kind === 'error' ? '!' : 'i'}</span>
    <div><strong>{t(saving ? busyLabel : kind === 'success' ? 'Done' : kind === 'error' ? 'Needs attention' : 'Status')}</strong>
      {!saving && <p>{t(feedback!.message)}</p>}
    </div>
  </div>;
}
