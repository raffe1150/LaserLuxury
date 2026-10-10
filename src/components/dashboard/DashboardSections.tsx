import DashboardFeedback, { useDashboardFeedback, type DashboardSaved, type DashboardFeedbackMemory } from './DashboardFeedback';
import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../../services/api';
import type {
  Business,
  IntegrationHealth,
  IntegrationKey,
  UsageInfo,
} from '../../types/dashboard';
import { ChannelIcon, StatusDot } from './Icons';
import { useDashboardI18n } from '../../i18n/dashboard';
import {
  CUSTOM_TONE_INSTRUCTIONS_MAX_LENGTH,
  EMOJI_USAGES,
  FORMALITY_LEVELS,
  RESPONSE_LENGTHS,
  TONE_PRESETS,
  normalizeBusinessToneConfig,
  type BusinessToneConfig,
} from '../../ai/tone-controls';
import {
  createToneSaveCoordinator,
  type ToneSaveCoordinator,
} from './tone-save';

interface BusinessSettingsProps {
  feedbackMemory?: DashboardFeedbackMemory;
  business: Business;
  onSaved: DashboardSaved;
}

interface BusinessToneControlsProps extends BusinessSettingsProps {
  onBusinessUpdated?: (business: Business) => void;
  businessAnswers?: ReactNode;
  customInstructions?: ReactNode;
  requestedSection?: 'ai-tone' | 'knowledge' | 'prompt-editor';
}

type WorkingDayKey =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

type WorkingHoursState = Record<
  WorkingDayKey,
  Array<{ start: string; end: string }>
>;

const WORKING_DAYS: Array<{ key: WorkingDayKey; label: string }> = [
  { key: 'monday', label: 'Monday' },
  { key: 'tuesday', label: 'Tuesday' },
  { key: 'wednesday', label: 'Wednesday' },
  { key: 'thursday', label: 'Thursday' },
  { key: 'friday', label: 'Friday' },
  { key: 'saturday', label: 'Saturday' },
  { key: 'sunday', label: 'Sunday' },
];

const LEGACY_WORKING_HOURS: WorkingHoursState = {
  monday: [{ start: '09:00', end: '20:00' }],
  tuesday: [{ start: '09:00', end: '20:00' }],
  wednesday: [{ start: '09:00', end: '20:00' }],
  thursday: [{ start: '09:00', end: '20:00' }],
  friday: [{ start: '09:00', end: '20:00' }],
  saturday: [],
  sunday: [],
};

function areWeekdayHoursIdentical(
  workingHours: WorkingHoursState
): boolean {
  const monday = JSON.stringify(workingHours.monday);

  return (
    monday === JSON.stringify(workingHours.tuesday) &&
    monday === JSON.stringify(workingHours.wednesday) &&
    monday === JSON.stringify(workingHours.thursday) &&
    monday === JSON.stringify(workingHours.friday)
  );
}

function copyMondayToWeekdays(
  workingHours: WorkingHoursState
): WorkingHoursState {
  const monday = workingHours.monday.map((item) => ({ ...item }));

  return {
    ...workingHours,
    tuesday: monday.map((item) => ({ ...item })),
    wednesday: monday.map((item) => ({ ...item })),
    thursday: monday.map((item) => ({ ...item })),
    friday: monday.map((item) => ({ ...item })),
  };
}

function normalizeDashboardWorkingHours(
  workingHours: Business['workingHours']
): WorkingHoursState {
  const result: WorkingHoursState = {
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
    sunday: [],
  };

  if (!workingHours) {
    return JSON.parse(JSON.stringify(LEGACY_WORKING_HOURS));
  }

  for (const { key } of WORKING_DAYS) {
    const intervals = workingHours[key];

    result[key] = Array.isArray(intervals)
      ? intervals.map((interval) => ({
          start: interval.start || '09:00',
          end: interval.end || '18:00',
        }))
      : [];
  }

  return result;
}

export function BusinessSettings({ business, onSaved, feedbackMemory }: BusinessSettingsProps) {
  const { t } = useDashboardI18n();
  const [name, setName] = useState(business.name || '');
  const [industry, setIndustry] = useState(business.industry || '');
  const [timezone, setTimezone] = useState(business.timezone || '');
  const [language, setLanguage] = useState(business.language || 'en');
  const [services, setServices] = useState<NonNullable<Business['services']>>(
    () => (business.services || []).map((service) => ({ ...service }))
  );
  const [workingHours, setWorkingHours] = useState<WorkingHoursState>(
    () => normalizeDashboardWorkingHours(business.workingHours)
  );
  const [applySameWeekdayHours, setApplySameWeekdayHours] = useState(() =>
    areWeekdayHoursIdentical(
      normalizeDashboardWorkingHours(business.workingHours)
    )
  );
  const [saving, setSaving] = useState(false);
  const { feedback, reportFeedback, clearFeedback } = useDashboardFeedback(onSaved, feedbackMemory, business.id);

  useEffect(() => {
    setName(business.name || '');
    setIndustry(business.industry || '');
    setTimezone(business.timezone || '');
    setLanguage(business.language || 'en');
    setServices(
      (business.services || []).map((service) => ({ ...service }))
    );

    const nextWorkingHours =
      normalizeDashboardWorkingHours(business.workingHours);

    setWorkingHours(nextWorkingHours);
    setApplySameWeekdayHours(
      areWeekdayHoursIdentical(nextWorkingHours)
    );
  }, [
    business.id,
    business.name,
    business.industry,
    business.timezone,
    business.language,
    business.services,
    business.workingHours,
  ]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    clearFeedback();
    setSaving(true);
    try {
      await api.updateBusiness(business.id, {
        name,
        industry,
        timezone,
        language,
        services,
        workingHours,
      });
      reportFeedback('Business settings saved', true);
    } catch (error) {
      reportFeedback(error instanceof Error ? error.message : 'Could not save business settings', false, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      id="business-settings"
      className="dashboard-section business-settings-target"
    >
      <form id="business-settings-form" onSubmit={save} onChangeCapture={() => { if (feedback?.kind === 'success') clearFeedback(); }} className="business-settings-target-form">

        <div className="business-settings-target-heading">
          <div>
            <h2 id="settings-business-title" tabIndex={-1}>Business Settings</h2>
            <p>
              Manage your business information, language, timezone,
              and working hours.
            </p>
          </div>

          <button
            className="btn btn-primary business-settings-save-top"
            type="submit"
            disabled={saving}
          >
            <svg
              className="business-settings-save-icon"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M5 4h12l2 2v14H5z" />
              <path d="M8 4v6h8V4" />
              <path d="M8 15h8v5H8z" />
            </svg>
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>

        <div className="business-settings-info-card">
          <div className="business-settings-info-grid">

            <div className="business-settings-field">
              <label htmlFor="business-name">Business Name</label>
              <div className="business-settings-input-shell">
                <span
                  className="business-settings-field-icon"
                  aria-hidden="true"
                >
                  <svg viewBox="0 0 24 24">
                    <path d="M4 10h16v10H4z" />
                    <path d="M3 10l2-5h14l2 5" />
                    <path d="M8 14v6M16 14v6" />
                    <path d="M3 10c0 2 3 2 3 0 0 2 3 2 3 0 0 2 3 2 3 0 0 2 3 2 3 0 0 2 3 2 3 0" />
                  </svg>
                </span>

                <input id="business-name" dir="auto"
                  className="form-input"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            </div>

            <div className="business-settings-field">
              <label htmlFor="business-industry">Business Type</label>

              <input id="business-industry" dir="auto"
                className="form-input"
                value={industry}
                onChange={(event) => setIndustry(event.target.value)}
                placeholder="Service business"
              />
            </div>

            <div className="business-settings-field">
              <label htmlFor="business-language">{t('Default assistant language')}</label>

              <div className="business-settings-input-shell">
                <span
                  className="business-settings-field-icon"
                  aria-hidden="true"
                >
                  <svg viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M3 12h18" />
                    <path d="M12 3c3 3 4 6 4 9s-1 6-4 9" />
                    <path d="M12 3c-3 3-4 6-4 9s1 6 4 9" />
                  </svg>
                </span>

                <select id="business-language"
                  className="form-input"
                  value={language}
                  onChange={(event) =>
                    setLanguage(
                      event.target.value as Business['language']
                    )
                  }
                >
                  <option value="en">English</option>
                  <option value="sv">Svenska</option>
                  <option value="de">Deutsch</option>
                  <option value="es">Español</option>
                  <option value="fa">فارسی</option>
                  <option value="ar">العربية</option>
                </select>
              </div>
              <small className="form-hint">{t("Used only as a fallback when the customer's language cannot be determined. OdinLink automatically responds in the customer's detected language.")}</small>
            </div>

            <div className="business-settings-field">
              <label htmlFor="business-timezone">Timezone</label>

              <div className="business-settings-input-shell">
                <span
                  className="business-settings-field-icon"
                  aria-hidden="true"
                >
                  <svg viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="8" />
                    <path d="M12 7v5l3 2" />
                  </svg>
                </span>

                <input id="business-timezone" dir="ltr"
                  className="form-input mono"
                  value={timezone}
                  onChange={(event) =>
                    setTimezone(event.target.value)
                  }
                  placeholder="Europe/Stockholm"
                />
              </div>
            </div>

          </div>

          <div className="business-settings-info-hint">
            <span aria-hidden="true">ⓘ</span>
            These settings help Odinlink provide accurate responses
            to your customers.
          </div>
        </div>

        <div className="business-services-card">
          <div className="business-services-header">
            <div>
              <h3>Services &amp; Pricing</h3>
              <p>
                Add the services customers can book and define their duration
                and price.
              </p>
            </div>

            <button
              type="button"
              className="business-services-add"
              onClick={() =>
                setServices((current) => [
                  ...current,
                  {
                    name: '',
                    durationMinutes: 60,
                    price: null,
                    currency: 'SEK',
                    active: true,
                  },
                ])
              }
            >
              ＋ Add Service
            </button>
          </div>

          {services.length === 0 ? (
            <div className="business-services-empty">
              <span>No services added yet.</span>
              <span>
                Add your first service so Odinlink can use the correct booking
                duration and price.
              </span>
            </div>
          ) : (
            <div className="business-services-list">
              <div className="business-services-labels" aria-hidden="true">
                <span>Service Name</span>
                <span>Duration</span>
                <span>Price</span>
                <span>Currency</span>
                <span>Active</span>
                <span />
              </div>

              {services.map((service, index) => (
                <div
                  className="business-service-row"
                  key={index}
                >
                  <div className="business-service-field service-name">
                    <label htmlFor={`service-${index}-name`}>Service Name</label>
                    <input id={`service-${index}-name`} dir="auto"
                      className="form-input"
                      value={service.name}
                      placeholder="e.g. Consultation"
                      onChange={(event) => {
                        const value = event.target.value;

                        setServices((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, name: value }
                              : item
                          )
                        );
                      }}
                    />
                  </div>

                  <div className="business-service-field service-duration">
                    <label htmlFor={`service-${index}-duration`}>Duration</label>
                    <div className="business-service-number-shell">
                      <input id={`service-${index}-duration`} dir="ltr"
                        className="form-input"
                        type="number"
                        min="1"
                        max="1440"
                        step="1"
                        value={service.durationMinutes}
                        onChange={(event) => {
                          const value = Number(event.target.value);

                          setServices((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index
                                ? {
                                    ...item,
                                    durationMinutes: value,
                                  }
                                : item
                            )
                          );
                        }}
                      />
                      <span>min</span>
                    </div>
                  </div>

                  <div className="business-service-field service-price">
                    <label htmlFor={`service-${index}-price`}>Price</label>
                    <input id={`service-${index}-price`} dir="ltr"
                      className="form-input"
                      type="number"
                      min="0"
                      step="0.01"
                      value={service.price ?? ''}
                      placeholder="Optional"
                      onChange={(event) => {
                        const raw = event.target.value;
                        const value = raw === '' ? null : Number(raw);

                        setServices((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, price: value }
                              : item
                          )
                        );
                      }}
                    />
                  </div>

                  <div className="business-service-field service-currency">
                    <label htmlFor={`service-${index}-currency`}>Currency</label>
                    <input id={`service-${index}-currency`} dir="ltr"
                      className="form-input"
                      value={service.currency}
                      maxLength={3}
                      placeholder="SEK"
                      onChange={(event) => {
                        const value = event.target.value.toUpperCase();

                        setServices((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, currency: value }
                              : item
                          )
                        );
                      }}
                    />
                  </div>

                  <div className="business-service-field service-active">
                    <label htmlFor={`service-${index}-active`}>Active</label>
                    <button
                      type="button"
                      className={`business-service-toggle ${
                        service.active ? 'is-enabled' : ''
                      }`}
                      id={`service-${index}-active`}
                      aria-pressed={service.active}
                      aria-label={t('Active') + ': ' + service.name}
                      title={
                        service.active
                          ? 'Service is active'
                          : 'Service is inactive'
                      }
                      onClick={() =>
                        setServices((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, active: !item.active }
                              : item
                          )
                        )
                      }
                    >
                      <span aria-hidden="true" />
                    </button>
                  </div>

                  <div className="business-service-field service-delete">
                    <label>Delete</label>
                    <button
                      type="button"
                      className="business-service-delete"
                      title="Delete service"
                      aria-label={t('Delete') + ': ' + (service.name || t('Service'))}
                      onClick={() =>
                        setServices((current) =>
                          current.filter(
                            (_, itemIndex) => itemIndex !== index
                          )
                        )
                      }
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M3 6h18" />
                        <path d="M8 6V4h8v2" />
                        <path d="M19 6l-1 14H6L5 6" />
                        <path d="M10 10v6M14 10v6" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="working-hours-target-card">

          <div className="working-hours-target-header">

            <div className="working-hours-target-title">
              <span
                className="working-hours-clock"
                aria-hidden="true"
              >
                <svg viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="8" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </span>

              <div>
                <h3>Working Hours</h3>
                <p>Set when your business is open for bookings.</p>
              </div>
            </div>

            <div className="working-hours-weekday-switch-wrap">
              <button
                type="button"
                className={`working-hours-weekday-switch-button ${
                  applySameWeekdayHours ? 'is-enabled' : ''
                }`}
                aria-pressed={applySameWeekdayHours}
                onClick={() => {
                  const enabled = !applySameWeekdayHours;

                  setApplySameWeekdayHours(enabled);

                  if (!enabled) return;

                  setWorkingHours((current) =>
                    copyMondayToWeekdays(current)
                  );
                }}
              >
                <span
                  className="working-hours-switch-ui"
                  aria-hidden="true"
                />
                <span>
                  Apply same hours to all weekdays
                </span>
              </button>

              <span
                className="working-hours-info-icon"
                title="When enabled, Monday hours are copied to Tuesday through Friday."
              >
                ⓘ
              </span>
            </div>

          </div>

          <div className="working-hours-target-list">

            {WORKING_DAYS.map(({ key, label }) => {
              const intervals = workingHours[key];
              const isOpen = intervals.length > 0;

              return (
                <div
                  key={key}
                  className={`working-hours-target-day ${
                    isOpen ? 'is-open' : 'is-closed'
                  }`}
                >

                  <div className="working-hours-target-day-name">
                    {label}
                  </div>

                  <label className="working-hours-open-control">
                    <input aria-label={t(label) + ': ' + t(isOpen ? 'Open' : 'Closed')}
                      type="checkbox"
                      checked={isOpen}
                      onChange={(event) => {
                        const checked = event.target.checked;

                        setWorkingHours((current) => {
                          const next: WorkingHoursState = {
                            ...current,
                            [key]: checked
                              ? current[key].length
                                ? current[key].map((item) => ({ ...item }))
                                : [
                                    {
                                      start: '09:00',
                                      end: '18:00',
                                    },
                                  ]
                              : [],
                          };

                          return (
                            key === 'monday' &&
                            applySameWeekdayHours
                          )
                            ? copyMondayToWeekdays(next)
                            : next;
                        });
                      }}
                    />

                    <span>
                      {isOpen ? 'Open' : 'Closed'}
                    </span>
                  </label>

                  <div className="working-hours-target-schedule">

                    {isOpen ? (
                      <>

                        {intervals.map((interval, index) => (
                          <div
                            key={`${key}-${index}`}
                            className="working-hours-target-interval"
                          >

                            <input id={`hours-${key}-${index}-start`} aria-label={t(label) + ' · ' + t('Start') + ' ' + (index + 1)} dir="ltr"
                              type="time"
                              className="form-input working-hours-time-input"
                              value={interval.start}
                              onChange={(event) => {
                                const value = event.target.value;

                                setWorkingHours((current) => {
                                  const next: WorkingHoursState = {
                                    ...current,
                                    [key]: current[key].map(
                                      (item, itemIndex) =>
                                        itemIndex === index
                                          ? {
                                              ...item,
                                              start: value,
                                            }
                                          : { ...item }
                                    ),
                                  };

                                  return (
                                    key === 'monday' &&
                                    applySameWeekdayHours
                                  )
                                    ? copyMondayToWeekdays(next)
                                    : next;
                                });
                              }}
                            />

                            <span className="working-hours-to">
                              to
                            </span>

                            <input id={`hours-${key}-${index}-end`} aria-label={t(label) + ' · ' + t('End') + ' ' + (index + 1)} dir="ltr"
                              type="time"
                              className="form-input working-hours-time-input"
                              value={interval.end}
                              onChange={(event) => {
                                const value = event.target.value;

                                setWorkingHours((current) => {
                                  const next: WorkingHoursState = {
                                    ...current,
                                    [key]: current[key].map(
                                      (item, itemIndex) =>
                                        itemIndex === index
                                          ? {
                                              ...item,
                                              end: value,
                                            }
                                          : { ...item }
                                    ),
                                  };

                                  return (
                                    key === 'monday' &&
                                    applySameWeekdayHours
                                  )
                                    ? copyMondayToWeekdays(next)
                                    : next;
                                });
                              }}
                            />

                            {index === 0 &&
                              intervals.length === 1 && (
                                <button
                                  type="button"
                                  className="working-hours-add-break"
                                  aria-label={t('＋ Add break') + ' · ' + t(label)}
                                  onClick={() => {
                                    setWorkingHours((current) => {
                                      const first =
                                        current[key][0];

                                      if (!first) return current;

                                      const next: WorkingHoursState = {
                                        ...current,
                                        [key]: [
                                          {
                                            start: first.start,
                                            end: '12:00',
                                          },
                                          {
                                            start: '13:00',
                                            end:
                                              first.end ||
                                              '18:00',
                                          },
                                        ],
                                      };

                                      return (
                                        key === 'monday' &&
                                        applySameWeekdayHours
                                      )
                                        ? copyMondayToWeekdays(next)
                                        : next;
                                    });
                                  }}
                                >
                                  ＋ Add break
                                </button>
                              )}

                            {intervals.length > 1 && (
                              <button
                                type="button"
                                className="working-hours-remove-slot"
                                title="Remove time slot"
                                aria-label={t('Remove time slot') + ' · ' + t(label) + ' ' + (index + 1)}
                                onClick={() => {
                                  setWorkingHours((current) => {
                                    const next: WorkingHoursState = {
                                      ...current,
                                      [key]: current[key]
                                        .filter(
                                          (_, itemIndex) =>
                                            itemIndex !== index
                                        )
                                        .map((item) => ({ ...item })),
                                    };

                                    return (
                                      key === 'monday' &&
                                      applySameWeekdayHours
                                    )
                                      ? copyMondayToWeekdays(next)
                                      : next;
                                  });
                                }}
                              >
                                ×
                              </button>
                            )}

                          </div>
                        ))}

                        {intervals.length > 1 && (
                          <button
                            type="button"
                            className="working-hours-add-slot"
                            onClick={() => {
                              setWorkingHours((current) => {
                                const next: WorkingHoursState = {
                                  ...current,
                                  [key]: [
                                    ...current[key].map((item) => ({
                                      ...item,
                                    })),
                                    {
                                      start: '13:00',
                                      end: '18:00',
                                    },
                                  ],
                                };

                                return (
                                  key === 'monday' &&
                                  applySameWeekdayHours
                                )
                                  ? copyMondayToWeekdays(next)
                                  : next;
                              });
                            }}
                          >
                            ＋ Add time slot
                          </button>
                        )}

                      </>
                    ) : null}

                  </div>

                  <div className="working-hours-target-actions">

                    <button
                      type="button"
                      className="working-hours-copy-action"
                      title="Apply this day's hours to weekdays"
                      aria-label={t("Apply this day's hours to weekdays") + ' · ' + t(label)}
                      onClick={() => {
                        setWorkingHours((current) => {
                          const copied =
                            current[key].map((item) => ({
                              ...item,
                            }));

                          return {
                            ...current,
                            monday: copied.map((item) => ({
                              ...item,
                            })),
                            tuesday: copied.map((item) => ({
                              ...item,
                            })),
                            wednesday: copied.map((item) => ({
                              ...item,
                            })),
                            thursday: copied.map((item) => ({
                              ...item,
                            })),
                            friday: copied.map((item) => ({
                              ...item,
                            })),
                          };
                        });
                      }}
                    >
                      <svg viewBox="0 0 24 24">
                        <rect
                          x="8"
                          y="8"
                          width="10"
                          height="10"
                          rx="2"
                        />
                        <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
                      </svg>
                    </button>

                    <button
                      type="button"
                      className="working-hours-delete-action"
                      title="Mark day as closed"
                      aria-label={t('Mark day as closed') + ' · ' + t(label)}
                      onClick={() => {
                        setWorkingHours((current) => {
                          const next: WorkingHoursState = {
                            ...current,
                            [key]: [],
                          };

                          return (
                            key === 'monday' &&
                            applySameWeekdayHours
                          )
                            ? copyMondayToWeekdays(next)
                            : next;
                        });
                      }}
                    >
                      <svg viewBox="0 0 24 24">
                        <path d="M3 6h18" />
                        <path d="M8 6V4h8v2" />
                        <path d="M19 6l-1 14H6L5 6" />
                        <path d="M10 10v6M14 10v6" />
                      </svg>
                    </button>

                  </div>

                </div>
              );
            })}

          </div>

          <div className="business-save-footer"><p>{t('Business information, services and working hours are saved together.')}</p><button className="btn btn-primary" type="submit" disabled={saving}>{saving ? t('Saving...') : t('Save Changes')}</button></div>
          <div className="working-hours-target-footer">
            <span>ⓘ</span>
            All times are in{' '}
            {timezone || 'Europe/Stockholm'} timezone
          </div>

        </div>

        <DashboardFeedback feedback={feedback} saving={saving} />
      </form>
    </section>
  );
}

const tonePresetDescriptions: Record<BusinessToneConfig['tonePreset'], string> = {
  professional: 'Clear, polished, and dependable.',
  friendly: 'Approachable, positive, and conversational.',
  warm: 'Calm, empathetic, and welcoming.',
  casual: 'Relaxed and natural, while staying respectful.',
  concise: 'Direct and focused on the next useful step.',
  custom: 'Use your own style guidance.',
};

const titleCaseOption = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export function BusinessToneControls({
  business,
  onSaved,
  onBusinessUpdated,
  businessAnswers,
  customInstructions,
  requestedSection,
}: BusinessToneControlsProps) {
  const { t } = useDashboardI18n();
  const [tone, setTone] = useState<BusinessToneConfig>(() => normalizeBusinessToneConfig(business.toneConfig));
  const [saving, setSaving] = useState(false);
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const [saveError, setSaveError] = useState('');
  const { feedback, reportFeedback, clearFeedback } = useDashboardFeedback(onSaved);
  const callbacksRef = useRef({ t, onSaved: reportFeedback, onBusinessUpdated });
  const coordinatorRef = useRef<ToneSaveCoordinator | null>(null);
  callbacksRef.current = { t, onSaved: reportFeedback, onBusinessUpdated };

  if (!coordinatorRef.current) {
    coordinatorRef.current = createToneSaveCoordinator({
      persist: (businessId, nextTone) => api.updateBusiness(businessId, { toneConfig: nextTone }),
      onSavingChange: setSaving,
      onPersisted: (updatedBusiness) => {
        setTone(normalizeBusinessToneConfig(updatedBusiness.toneConfig));
        callbacksRef.current.onBusinessUpdated?.(updatedBusiness);
      },
      onSuccess: () => {
        setSaveError('');
        callbacksRef.current.onSaved(callbacksRef.current.t('AI tone saved.'));
      },
      onFailure: () => {
        const message = callbacksRef.current.t("Couldn't save AI tone. Please try again.");
        setSaveError(message);
        callbacksRef.current.onSaved(message, false, 'error');
      },
      onDiagnostic: (error) => console.error('AI tone save failed:', error),
    });
  }

  useEffect(() => {
    coordinatorRef.current?.selectBusiness(business.id);
    setSaveError('');
    setTone(normalizeBusinessToneConfig(business.toneConfig));
  }, [business.id, business.toneConfig]);

  useEffect(() => { clearFeedback(); }, [business.id]);

  useEffect(() => () => coordinatorRef.current?.dispose(), []);

  // Legacy prompt targets open the native disclosure before the shell focuses it.
  useLayoutEffect(() => {
    if (requestedSection === 'prompt-editor' && advancedRef.current) advancedRef.current.open = true;
  }, [requestedSection]);

  const editCustomStyle = () => {
    if (advancedRef.current) advancedRef.current.open = true;
    document.getElementById('custom-tone-instructions')?.focus();
  };

  const update = <Key extends keyof BusinessToneConfig>(key: Key, value: BusinessToneConfig[Key]) => {
    if (feedback?.kind === 'success') clearFeedback();
    setTone((current) => ({ ...current, [key]: value }));
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    clearFeedback();
    setSaveError('');
    await coordinatorRef.current?.save(business.id, tone);
  };

  return (
    <div className="ai-assistant-setup">
      <header className="assistant-page-heading"><h1>{t('AI Assistant')}</h1></header>
      <section id="ai-tone" className="card dashboard-section tone-controls" aria-labelledby="assistant-style-title">
        <form id="ai-style-form" onSubmit={save} aria-describedby={saveError ? 'ai-style-error' : undefined}>
          <div className="card-header">
            <div>
              <h2 id="assistant-style-title" className="card-title">{t('How should OdinLink speak?')}</h2>
              <div className="card-desc">{t('Style changes how OdinLink communicates. Your business information and booking rules still apply.')}</div>
            </div>
          </div>
          <fieldset disabled={saving} aria-describedby={saveError ? 'ai-style-error' : undefined}>
            <legend>{t('Tone preset')}</legend>
            <div className="tone-preset-grid">
              {TONE_PRESETS.map((preset) => (
                <button key={preset} type="button" className={tone.tonePreset === preset ? 'tone-option selected' : 'tone-option'} aria-pressed={tone.tonePreset === preset} onClick={() => update('tonePreset', preset)}>
                  <strong>{t(titleCaseOption(preset))}{tone.tonePreset === preset && <span className="tone-selected-mark" aria-hidden="true">✓</span>}</strong>
                  <span>{t(tonePresetDescriptions[preset])}</span>
                </button>
              ))}
            </div>
          </fieldset>
          {tone.tonePreset === 'custom' && (
            <div className="tone-custom-summary">
              <p>{t(tone.customToneInstructions ? 'Your custom style is selected.' : 'Add your custom style guidance in Advanced.')}</p>
              <button className="btn btn-ghost" type="button" onClick={editCustomStyle}>{t('Edit custom style')}</button>
            </div>
          )}
          {saveError && <p id="ai-style-error" className="dashboard-inline-error" role="alert">{saveError}</p>}
          {!saveError && <DashboardFeedback feedback={feedback} saving={saving} />}
          <div className="save-row">
            <button ref={saveRef} className="btn btn-primary" type="submit" disabled={saving}>{saving ? t('Saving...') : t('Save style')}</button>
          </div>
        </form>
      </section>
      {businessAnswers}
      <details id="ai-advanced" className="ai-advanced" ref={advancedRef}>
        <summary>{t('Advanced')}<span className="advanced-summary-help">{t('Optional style adjustments and custom instructions.')}</span></summary>
        <div className="ai-advanced-content">
          <section id="tone-adjustments" className="card tone-controls" aria-labelledby="tone-adjustments-title">
            <h3 id="tone-adjustments-title" className="card-title">{t('Tone adjustments')}</h3>
            <div className="tone-control-grid">
              <ToneChoice
                label={t('Response length')}
                value={tone.responseLength}
                options={RESPONSE_LENGTHS}
                onChange={(value) => update('responseLength', value)}
                t={t}
                disabled={saving}
              />
              <ToneChoice
                label={t('Formality')}
                value={tone.formality}
                options={FORMALITY_LEVELS}
                onChange={(value) => update('formality', value)}
                t={t}
                disabled={saving}
              />
              <ToneChoice
                label={t('Emoji usage')}
                value={tone.emojiUsage}
                options={EMOJI_USAGES}
                onChange={(value) => update('emojiUsage', value)}
                t={t}
                disabled={saving}
              />
            </div>

            <div className="form-group tone-custom-guidance">
              <label className="form-label" htmlFor="custom-tone-instructions">{t('Custom tone guidance')}</label>
              <textarea
                id="custom-tone-instructions"
                className="form-input"
                dir="auto"
                translate="no"
                rows={4}
                form="ai-style-form"
                aria-describedby={`custom-tone-help${saveError ? ' ai-style-error' : ''}`}
                maxLength={CUSTOM_TONE_INSTRUCTIONS_MAX_LENGTH}
                disabled={saving}
                value={tone.customToneInstructions}
                onChange={(event) => update('customToneInstructions', event.target.value)}
                placeholder={t('Sound calm, confident and welcoming. Avoid salesy language.')}
              />
              <div id="custom-tone-help" className="tone-custom-meta">
                <span>{t('Used when Custom is selected. Add business facts in Business answers.')}</span>
                <bdi dir="ltr">{tone.customToneInstructions.length} / {CUSTOM_TONE_INSTRUCTIONS_MAX_LENGTH}</bdi>
              </div>
            </div>

            <p className="card-desc">{t('Save style also saves these adjustments.')}</p>
            <button className="btn btn-primary" type="submit" form="ai-style-form" disabled={saving}>{saving ? t('Saving...') : t('Save style')}</button>
            <button className="btn btn-ghost" type="button" onClick={() => saveRef.current?.focus()}>{t('Back to assistant style')}</button>
          </section>
          {customInstructions}
        </div>
      </details>
    </div>
  );
}

function ToneChoice<Option extends string>({
  label,
  value,
  options,
  onChange,
  t,
  disabled,
}: {
  label: string;
  value: Option;
  options: readonly Option[];
  onChange: (value: Option) => void;
  t: (source: string) => string;
  disabled: boolean;
}) {
  return (
    <fieldset className="tone-choice" disabled={disabled}>
      <legend>{label}</legend>
      <div>
        {options.map((option) => (
          <button key={option} type="button" className={value === option ? 'selected' : ''} aria-pressed={value === option} onClick={() => onChange(option)}>
            {t(titleCaseOption(option))}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function SystemPromptEditor({ business, onSaved, feedbackMemory }: BusinessSettingsProps) {
  const { t } = useDashboardI18n();
  const [prompt, setPrompt] = useState(business.systemPrompt || '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const { feedback, reportFeedback, clearFeedback } = useDashboardFeedback(onSaved, feedbackMemory, business.id);

  useEffect(() => {
    setPrompt(business.systemPrompt || '');
    setSaveError('');
  }, [business.id, business.systemPrompt]);

  const save = async () => {
    clearFeedback();
    setSaveError('');
    setSaving(true);
    try {
      await api.updateBusiness(business.id, { systemPrompt: prompt });
      setSaveError('');
      reportFeedback('Prompt saved', true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save prompt';
      setSaveError(message);
      reportFeedback(message, false, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="prompt-editor" className="card dashboard-section">
      <div className="card-header">
        <div>
          <h3 className="card-title">{t('Custom instructions')}</h3>
          <div className="card-desc">{t('Optional instructions for this business. Save them separately from style changes.')}</div>
        </div>
      </div>
      <div className="form-group form-full">
        <label className="form-label" htmlFor="custom-assistant-instructions">{t('Instructions')}</label>
        <div className="prompt-toolbar">
          <span id="custom-instructions-count" dir="ltr" className="prompt-char-count">{prompt.length} / 10000</span>
        </div>
        <textarea
          id="custom-assistant-instructions"
          aria-describedby={`custom-instructions-count custom-instructions-help${saveError ? ' custom-instructions-error' : ''}`}
          className="form-input"
          dir="auto"
          translate="no"
          maxLength={10000}
          rows={6}
          value={prompt}
          onChange={(event) => { if (feedback?.kind === 'success') clearFeedback(); setPrompt(event.target.value); }}
          placeholder={t('Describe this business, booking rules, tone and escalation policy.')}
        />
        <div id="custom-instructions-help" className="form-hint">{t('These instructions are saved for the selected business only.')}</div>
        {saveError && <p id="custom-instructions-error" className="dashboard-inline-error" role="alert">{saveError}</p>}
      </div>
      {!saveError && <DashboardFeedback feedback={feedback} saving={saving} />}
      <div className="save-row">
        <button className="btn btn-primary" type="button" onClick={save} disabled={saving}>
          {saving ? t('Saving...') : t('Save instructions')}
        </button>
      </div>
    </section>
  );
}


export function ChannelSettings({
  business,
  health,
  onTest,
  onSaved,
}: {
  business: Business;
  health: IntegrationHealth[];
  onTest: (integration: string) => void;
  onSaved: DashboardSaved;
}) {
  const { t } = useDashboardI18n();
  const [values, setValues] = useState(() => getChannelValues(business));
  const [saving, setSaving] = useState(false);
  const byKey = new Map(health.map((item) => [item.key, item]));
  const channels: Array<{ key: IntegrationKey; title: string; copy: string; fields: Array<{ key: keyof Business; label: string; secret?: boolean }> }> = [
    { key: 'google_calendar', title: 'Google Calendar', copy: 'Sync availability and create bookings directly in the business calendar.', fields: [{ key: 'calendarId', label: 'Calendar ID' }, { key: 'timezone', label: 'Timezone' }] },
    { key: 'instagram', title: 'Instagram', copy: 'Connect Instagram DMs and comment replies through Meta Graph API.', fields: [{ key: 'instagramPageId', label: 'Instagram Page ID' }, { key: 'instagramAccountId', label: 'Instagram Account ID' }, { key: 'instagramAccessToken', label: 'Access Token', secret: true }, { key: 'instagramWebhookVerifyToken', label: 'Webhook Verify Token', secret: true }] },
    { key: 'messenger', title: 'Facebook Messenger', copy: 'Connect Messenger inbox, page comments and post reply automation.', fields: [{ key: 'messengerPageId', label: 'Facebook Page ID' }, { key: 'messengerAccessToken', label: 'Page Access Token', secret: true }, { key: 'messengerAppSecret', label: 'App Secret', secret: true }, { key: 'messengerWebhookVerifyToken', label: 'Webhook Verify Token', secret: true }] },
    { key: 'telegram', title: 'Telegram', copy: 'Connect Telegram bot for DMs, voice messages and booking notifications.', fields: [{ key: 'telegramToken', label: 'Bot Token', secret: true }, { key: 'telegramAdminChatId', label: 'Admin Chat ID' }] },
    { key: 'whatsapp', title: 'WhatsApp Business', copy: 'Connect WhatsApp via Meta Cloud API for customer messages.', fields: [{ key: 'whatsappPhoneNumberId', label: 'Phone Number ID' }, { key: 'whatsappBusinessAccountId', label: 'WABA ID' }, { key: 'whatsappAccessToken', label: 'Access Token', secret: true }, { key: 'whatsappWebhookVerifyToken', label: 'Webhook Verify Token', secret: true }] },
  ];

  useEffect(() => {
    setValues(getChannelValues(business));
  }, [business]);

  const updateValue = (key: keyof Business, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.updateBusiness(business.id, values);
      onSaved('Channel settings saved', true);
    } catch (error) {
      onSaved(error instanceof Error ? error.message : 'Could not save channel settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="channel-settings" className="card dashboard-section">
      <div className="card-header">
        <div>
          <div className="card-title">Channel Settings</div>
          <div className="card-desc">{t('Credentials are masked and updates should be sent to the backend for {business}.', { business: business.name })}</div>
        </div>
      </div>
      {channels.map((channel) => {
        const status = byKey.get(channel.key);
        const connected = status?.status === 'connected' || status?.status === 'synced';
        return (
          <div className="integration-shell" key={channel.key}>
            <div className="channel-header">
              <div className="channel-icon"><ChannelIcon channel={channel.key} /></div>
              <div className="channel-info">
                <h3>{channel.title}</h3>
                <p>{t(channel.copy)}</p>
              </div>
              <div className="card-header-right" style={{ marginLeft: 'auto' }}>
                <span className={connected ? 'status-chip connected' : 'status-chip disconnected'}>
                  <StatusDot status={status?.status || 'setup_required'} />
                  {t(status?.detail || 'Setup required')}
                </span>
                <button className="btn btn-ghost" type="button" onClick={() => onTest(channel.key)}>Test</button>
              </div>
            </div>
            <div className="api-guide">
              <div>
                <div className="api-guide-title">Setup notes</div>
                <div className="api-steps">
                  <div className="api-step"><span>Use credentials generated for the selected business only.</span></div>
                  <div className="api-step"><span>Store and rotate secrets through backend endpoints.</span></div>
                  <div className="api-step"><span>Run a test connection before enabling automation.</span></div>
                </div>
              </div>
              <div className="api-guide-list">
                <div className="api-guide-item"><b>Tenant</b><span>{business.name}</span></div>
                <div className="api-guide-item"><b>Security</b><span>Tokens stay masked in the browser.</span></div>
              </div>
            </div>
            <div className="form-grid-2">
              {channel.fields.map((field) => (
                <div className="form-group" key={field.key}>
                  <label className="form-label">{field.label}</label>
                  <input
                    className="form-input mono"
                    type={field.secret ? 'password' : 'text'}
                    value={(values[field.key] as string | undefined) || ''}
                    placeholder={field.secret ? '••••••••••••••••' : ''}
                    onChange={(event) => updateValue(field.key, event.target.value)}
                  />
                  <div className="form-hint secret-note">
                    {field.secret ? 'Leave blank to keep the existing credential.' : 'Update is sent server-side for the selected business.'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <div className="save-row">
        <button className="btn btn-primary" type="button" onClick={save} disabled={saving}>
          {saving ? 'Saving...' : 'Save Channel Settings'}
        </button>
      </div>
    </section>
  );
}

function getChannelValues(business: Business): Partial<Business> {
  return {
    calendarId: business.calendarId || '',
    timezone: business.timezone || '',
    telegramToken: '',
    telegramAdminChatId: business.telegramAdminChatId || '',
    instagramPageId: business.instagramPageId || '',
    instagramAccountId: business.instagramAccountId || '',
    instagramAccessToken: '',
    instagramWebhookVerifyToken: '',
    messengerPageId: business.messengerPageId || '',
    messengerAccessToken: '',
    messengerAppSecret: '',
    messengerWebhookVerifyToken: '',
    whatsappPhoneNumberId: business.whatsappPhoneNumberId || '',
    whatsappBusinessAccountId: business.whatsappBusinessAccountId || '',
    whatsappAccessToken: '',
    whatsappWebhookVerifyToken: '',
  };
}

export function UsageStatistics({ usage }: { usage: UsageInfo }) {
  const used = usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
  return (
    <section id="usage-statistics" className="insight-card dashboard-section">
      <div className="chart-header">
        <div>
          <div className="chart-title">Usage Statistics</div>
          <div className="chart-sub">{usage.plan}</div>
        </div>
      </div>
      <div className="usage-meta"><span>{usage.used} used</span><span>{usage.limit} limit</span></div>
      <div className="usage-bar"><div className="usage-fill" style={{ width: `${used}%` }} /></div>
      <div className="usage-meta"><span>{used}%</span><span>{Math.max(0, usage.limit - usage.used)} remaining</span></div>
    </section>
  );
}
