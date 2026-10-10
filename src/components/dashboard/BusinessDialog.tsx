import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useDashboardI18n } from '../../i18n/dashboard';

// Bounded to Add/Delete Business. Native modality makes the background inert;
// React remains responsible for open/close state and the existing form handlers.
export default function BusinessDialog({ titleId, descriptionId, busy, onClose, children }: {
  titleId: string;
  descriptionId: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useDashboardI18n();

  useLayoutEffect(() => {
    const dialog = ref.current!;
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]')?.focus();
    return () => {
      if (dialog.open) dialog.close();
      // A successful deletion can remove its invoking row. Keep focus in the shell.
      const target = invoker?.isConnected && invoker.getClientRects().length
        ? invoker : document.querySelector<HTMLElement>('.dashboard-account summary');
      target?.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (busy && dialog && !dialog.querySelector('button:enabled, input:enabled, select:enabled')) dialog.focus();
  }, [busy]);

  return <dialog ref={ref} className="dashboard-business-dialog" tabIndex={-1} translate="no" aria-labelledby={titleId}
    aria-describedby={descriptionId} aria-busy={busy} onCancel={(event) => {
      event.preventDefault();
      if (!busy) onClose();
    }} onKeyDown={(event) => {
      if (event.key === 'Escape') event.stopPropagation();
      if (event.key !== 'Tab') return;
      const dialog = event.currentTarget as HTMLDialogElement;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]'))
        .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); event.currentTarget.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <button className="ai-modal-close" type="button" aria-label={t('Close')} disabled={busy} onClick={onClose}>×</button>
    {children}
  </dialog>;
}
