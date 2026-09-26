import { FormEvent, useEffect, useState } from 'react';
import { api, type KnowledgeSource } from '../../services/api';
import { useDashboardI18n } from '../../i18n/dashboard';

interface KnowledgePanelProps {
  businessId: string;
  onSaved: (message: string, refresh?: boolean) => void;
}

export default function KnowledgePanel({
  businessId,
  onSaved,
}: KnowledgePanelProps) {
  const { t, formatDate } = useDashboardI18n();

  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');

    try {
      const result = await api.getKnowledgeSources(businessId);
      setSources(result);
    } catch (err) {
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
      onSaved('Knowledge added');
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Could not add Knowledge';

      setError(message);
      onSaved(message);
    } finally {
      setSaving(false);
    }
  };

  const deleteKnowledge = async (source: KnowledgeSource) => {
    if (deletingId) return;

    const confirmed = window.confirm(
      `Delete "${source.title}" from Knowledge?`,
    );

    if (!confirmed) return;

    setDeletingId(source.id);
    setError('');

    try {
      await api.deleteKnowledgeSource(businessId, source.id);

      setSources((current) =>
        current.filter((item) => item.id !== source.id),
      );

      onSaved('Knowledge deleted');
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Could not delete Knowledge';

      setError(message);
      onSaved(message);
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
          <div className="mission-eyebrow">AI KNOWLEDGE</div>
          <h2>{t('Knowledge')}</h2>
          <p>
            {t(
              'Add business information the AI can use when answering customer questions.',
            )}
          </p>
        </div>

        <div className="knowledge-source-count">
          {sources.length}
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
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t('Example: Cancellation policy')}
              maxLength={200}
              disabled={saving}
            />
          </label>

          <label className="knowledge-field">
            <span>{t('Content')}</span>

            <textarea
              className="form-input"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder={t(
                'Write the information the assistant should know...',
              )}
              maxLength={100000}
              rows={8}
              disabled={saving}
            />
          </label>

          <div className="knowledge-form-footer">
            <span>
              {content.length.toLocaleString()} / 100,000
            </span>

            <button
              className="btn btn-primary"
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
              type="button"
              onClick={load}
              disabled={loading}
            >
              {loading ? t('Loading...') : t('Refresh')}
            </button>
          </div>

          {error && (
            <div className="knowledge-error">
              {error}
            </div>
          )}

          {loading && sources.length === 0 && (
            <div className="knowledge-empty">
              {t('Loading Knowledge...')}
            </div>
          )}

          {!loading && sources.length === 0 && (
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
                    <div className="knowledge-source-title">
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

      <div className="knowledge-future-note">
        <strong>{t('Coming next')}</strong>
        <span>
          {t(
            'PDF, DOCX, TXT and website URL sources will be added here without changing your existing Knowledge.',
          )}
        </span>
      </div>
    </section>
  );
}
