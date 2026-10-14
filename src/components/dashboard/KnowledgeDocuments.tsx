import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, type KnowledgeSource } from '../../services/api';
import { useDashboardI18n } from '../../i18n/dashboard';
import { documentErrorMessage } from '../../i18n/knowledge-documents';

export default function KnowledgeDocuments({ businessId, onCount }: { businessId: string; onCount?: (count: number) => void }) {
  const { t, formatDate } = useDashboardI18n();
  const [documents, setDocuments] = useState<KnowledgeSource[]>([]);
  const [owner, setOwner] = useState(businessId);
  const visibleDocuments = owner === businessId ? documents : [];
  const [file, setFile] = useState<File | null>(null);
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const current = ++generation.current;
    let active = true; let running = false;
    setDocuments([]); onCount?.(0); setFile(null); setAttested(false); setError(''); setBusy(false); setLoading(true);
    if (input.current) input.current.value = '';
    const load = async () => {
      if (running) return; running = true;
      try {
        const result = await api.getKnowledgeDocuments(businessId);
        if (active && current === generation.current) { setOwner(businessId); setDocuments(result); onCount?.(result.length); setError(''); }
      } catch (err) {
        if (active && current === generation.current) setError(documentErrorMessage(err));
      } finally { running = false; if (active) setLoading(false); }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => { active = false; ++generation.current; clearInterval(timer); };
  }, [businessId, onCount]);
  const perform = async (action: () => Promise<unknown>) => {
    const current = generation.current;
    if (busy) return; setBusy(true); setError('');
    try {
      await action();
      const next = await api.getKnowledgeDocuments(businessId);
      if (current === generation.current) { setOwner(businessId); setDocuments(next); onCount?.(next.length); }
    } catch (err) { if (current === generation.current) setError(documentErrorMessage(err)); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const upload = (event: FormEvent) => {
    event.preventDefault(); if (!file || !attested || busy) return;
    if (file.size === 0 || file.size > 5 * 1024 * 1024) { setError('Choose a file between 1 byte and 5 MiB.'); return; }
    const current = generation.current;
    void perform(async () => {
      await api.uploadKnowledgeDocument(businessId, file);
      if (current === generation.current) { setFile(null); setAttested(false); if (input.current) input.current.value = ''; }
    });
  };
  return <div className="knowledge-documents">
    <div className="knowledge-card-heading"><div><h3>{t('Business documents')}</h3>
      <p>{t('PDF, DOCX, TXT, CSV and XLSX · up to 5 MiB each')}</p></div></div>
    <p className="knowledge-document-help">{t('Text PDFs only, up to 100 pages. Spreadsheets must contain simple values without formulas. No images or macros.')}</p>
    <form onSubmit={upload} className="knowledge-document-upload">
      <div className="knowledge-field"><label htmlFor="knowledge-document-file">{t('Choose document')}</label>
        <input ref={input} id="knowledge-document-file" type="file" hidden accept=".pdf,.docx,.txt,.csv,.xlsx" disabled={busy}
          onChange={(event) => setFile(event.target.files?.[0] || null)} />
        <div className="knowledge-document-file-choice"><button className="btn" type="button" disabled={busy} onClick={() => input.current?.click()}>{t('Choose document')}</button>
          {file && <span dir="auto" translate="no">{file.name}</span>}</div></div>
      <label className="knowledge-document-attestation"><input type="checkbox" checked={attested} disabled={busy}
        onChange={(event) => setAttested(event.target.checked)} />
        <span>{t('This is business information and contains no patient records or sensitive medical information.')}</span></label>
      <button className="btn btn-primary" type="submit" disabled={busy || !file || !attested}>{t(busy ? 'Working...' : 'Upload document')}</button>
    </form>
    <p className="knowledge-document-help">{t('Documents inform business answers. Manage services, prices and booking rules in business settings.')}</p>
    {error && <div className="knowledge-error" role="alert">{t(error)}</div>}
    {loading && <p role="status">{t('Loading documents...')}</p>}
    {!loading && !visibleDocuments.length && !error && <p className="knowledge-document-help">{t('No documents uploaded yet.')}</p>}
    <div className="knowledge-source-list" aria-live="polite">
      {visibleDocuments.map((document) => <article className="knowledge-source-row" key={document.id}>
        <div className="knowledge-source-main"><div className="knowledge-source-title" dir="auto" translate="no">{document.title}</div>
          <div className="knowledge-source-meta"><span dir="ltr">{String(document.metadata?.format || '').toUpperCase()}</span>
            <span className={`knowledge-status knowledge-status-${document.status}`}>{t(document.status === 'processing' ? 'Processing' : document.status === 'ready' ? 'Ready' : document.status === 'failed' ? 'Failed' : 'Pending')}</span>
            {document.updatedAt && <span>{formatDate(new Date(document.updatedAt))}</span>}</div>
          {document.status === 'failed' && <p className="knowledge-document-help">{t(documentErrorMessage({ code: document.metadata?.errorCode }))}</p>}
        </div>
        <div className="knowledge-document-actions">
          {(document.status === 'failed' || document.status === 'processing' || document.status === 'pending') && document.metadata?.retryable !== false && <button type="button" className="btn" disabled={busy || Number(document.metadata?.attempts) >= 3} onClick={() => void perform(() => api.retryKnowledgeDocument(businessId, document.id))}>{t('Retry')}</button>}
          <button type="button" className="btn btn-danger knowledge-delete-button" disabled={busy} aria-label={t('Delete') + ': ' + document.title}
            onClick={() => { if (window.confirm(t('Delete "{title}" from Knowledge?').replace('{title}', () => document.title))) void perform(() => api.deleteKnowledgeDocument(businessId, document.id)); }}>{t('Delete')}</button>
        </div>
      </article>)}
    </div>
  </div>;
}
