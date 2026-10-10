import DashboardFeedback, { useDashboardFeedback, type DashboardSaved, type DashboardFeedbackMemory } from './DashboardFeedback';
import { FormEvent, useEffect, useState } from 'react';
import { api, type KnowledgeSource } from '../../services/api';
import { useDashboardI18n } from '../../i18n/dashboard';

interface KnowledgePanelProps {
  businessId: string;
  onSaved: DashboardSaved;
  feedbackMemory?: DashboardFeedbackMemory;
}

export default function KnowledgePanel({
  businessId,
  onSaved,
  feedbackMemory,
}: KnowledgePanelProps) {
  const { t, formatDate } = useDashboardI18n();

  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { feedback, reportFeedback, clearFeedback } = useDashboardFeedback(onSaved, feedbackMemory, businessId);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [localError, setLocalError] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');

    try {
      const result = await api.getKnowledgeSources(businessId);
      setSources(result);
    } catch (err) {
      setLocalError(!(err instanceof Error));
      setError(
        err instanceof Error
          ? err.message
          : 'Could not load Knowledge sources',
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;

    setLoading(true);
    setError('');

    api.getKnowledgeSources(businessId)
      .then((result) => {
        if (active) setSources(result);
      })
      .catch((err) => {
        if (!active) return;

        setLocalError(!(err instanceof Error));
        setError(
          err instanceof Error
            ? err.message
            : 'Could not load Knowledge sources',
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [businessId]);

  const addKnowledge = async (event: FormEvent) => {
    event.preventDefault();

    const normalizedTitle = title.trim();
    const normalizedContent = content.trim();

    if (!normalizedTitle || !normalizedContent || saving) return;

    clearFeedback();
    setSaving(true);
    setError('');

    try {
      const created = await api.createKnowledgeSource(
        businessId,
        {
          title: normalizedTitle,
          content: normalizedContent,
        },
      );

      setSources((current) => [created, ...current]);
      setTitle('');
      setContent('');
      reportFeedback('Knowledge added');
    } catch (err) {
      setLocalError(!(err instanceof Error));
      const message =
        err instanceof Error
          ? err.message
          : 'Could not add Knowledge';

      setError(message);
      reportFeedback(message, false, 'error');
    } finally {
      setSaving(false);
    }
  };

  const deleteKnowledge = async (source: KnowledgeSource) => {
    if (deletingId) return;

    const confirmed = window.confirm(
      // Insert source text verbatim; generic interpolation formats numeric values.
      t('Delete "{title}" from Knowledge?').replace('{title}', () => source.title),
    );

    if (!confirmed) return;

    clearFeedback();
    setDeletingId(source.id);
    setError('');

    try {
      await api.deleteKnowledgeSource(businessId, source.id);

      setSources((current) =>
        current.filter((item) => item.id !== source.id),
      );

      reportFeedback('Knowledge deleted');
    } catch (err) {
      setLocalError(!(err instanceof Error));
      const message =
        err instanceof Error
          ? err.message
          : 'Could not delete Knowledge';

      setError(message);
      reportFeedback(message, false, 'error');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section
      id="knowledge"
      className="card dashboard-section knowledge-panel"
    >
      <div className="knowledge-panel-heading">
        <div>
          <h2>{t('Business answers')}</h2>
          <p>
            {t(
              'Add information OdinLink can use when answering customer questions.',
            )}
          </p>
        </div>

        <div className="knowledge-source-count">
          {loading || error ? '—' : sources.length}
          <span>{t('sources')}</span>
        </div>
      </div>

      <div className="knowledge-layout">
        <form
          className="knowledge-create-card"
          onSubmit={addKnowledge}
        >
          <div className="knowledge-card-heading">
            <div>
              <h3>{t('Add knowledge')}</h3>
              <p>
                {t(
                  'Use manual text for policies, FAQs, procedures and other business information.',
                )}
              </p>
            </div>

            <span className="knowledge-type-badge">
              {t('Manual text')}
            </span>
          </div>

          <label className="knowledge-field">
            <span>{t('Title')}</span>

            <input
              className="form-input"
              dir="auto" translate="no"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t('Example: Cancellation policy')}
              aria-describedby={error ? 'knowledge-error' : undefined}
              maxLength={200}
              disabled={saving}
            />
          </label>

          <label className="knowledge-field">
            <span>{t('Content')}</span>

            <textarea
              className="form-input"
              dir="auto" translate="no"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder={t(
                'Write the information the assistant should know...',
              )}
              aria-describedby={error ? 'knowledge-error' : undefined}
              maxLength={100000}
              rows={8}
              disabled={saving}
            />
          </label>

          <div className="knowledge-form-footer">
            <span dir="ltr">
              {content.length.toLocaleString()} / 100,000
            </span>

            <button
              className="btn btn-primary"
              translate="no"
              type="submit"
              disabled={
                saving ||
                !title.trim() ||
                !content.trim()
              }
            >
              {saving ? t('Adding...') : t('Add knowledge')}
            </button>
          </div>
        </form>

        <div className="knowledge-library-card">
          <div className="knowledge-card-heading">
            <div>
              <h3>{t('Knowledge library')}</h3>
              <p>
                {t(
                  'Information currently available to this business AI.',
                )}
              </p>
            </div>

            <button
              className="btn knowledge-refresh-button"
              translate="no"
              type="button"
              onClick={load}
              disabled={loading}
            >
              {loading ? t('Loading...') : t('Refresh')}
            </button>
          </div>

          {!error && <DashboardFeedback feedback={feedback} saving={saving || Boolean(deletingId)} busyLabel={deletingId ? 'Deleting...' : 'Adding...'} />}
          {error && (
            <div id="knowledge-error" className="knowledge-error" role="alert">
              <strong>{t('Needs attention')}</strong><p translate="no">{localError ? t(error) : error}</p>
            </div>
          )}

          {loading && sources.length === 0 && (
            <div className="knowledge-empty" role="status">
              {t('Loading Knowledge...')}
            </div>
          )}

          {!loading && !error && sources.length === 0 && (
            <div className="knowledge-empty">
              <strong>{t('No Knowledge added yet')}</strong>
              <span>
                {t(
                  'Add your first business policy, FAQ or procedure using the form.',
                )}
              </span>
            </div>
          )}

          {sources.length > 0 && (
            <div className="knowledge-source-list">
              {sources.map((source) => (
                <article
                  className="knowledge-source-row"
                  key={source.id}
                >
                  <div className="knowledge-source-icon">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path d="M6 3h9l3 3v15H6z" />
                      <path d="M14 3v4h4" />
                      <path d="M9 11h6M9 15h6" />
                    </svg>
                  </div>

                  <div className="knowledge-source-main">
                    <div className="knowledge-source-title" dir="auto" translate="no">
                      {source.title}
                    </div>

                    <div className="knowledge-source-meta">
                      <span>{t('Manual text')}</span>

                      <span
                        className={`knowledge-status knowledge-status-${source.status}`}
                      >
                        {source.status}
                      </span>

                      {source.updatedAt && (
                        <span>
                          {formatDate(new Date(source.updatedAt))}
                        </span>
                      )}
                    </div>
                  </div>

                  <button
                    className="btn btn-danger knowledge-delete-button"
                    translate="no"
                    aria-label={t('Delete') + ': ' + source.title}
                    type="button"
                    disabled={Boolean(deletingId)}
                    onClick={() => deleteKnowledge(source)}
                  >
                    {deletingId === source.id
                      ? t('Deleting...')
                      : t('Delete')}
                  </button>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>

    </section>
  );
}
