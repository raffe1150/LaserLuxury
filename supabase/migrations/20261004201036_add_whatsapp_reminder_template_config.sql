-- Optional, tenant-owned configuration only. No template is enabled or approved
-- by this migration; send-time Meta verification is required by the application.
alter table public.businesses
  add column if not exists whatsapp_reminder_templates jsonb;

comment on column public.businesses.whatsapp_reminder_templates is
  'Optional appointment reminder template mappings per language and reminder type. Null disables outside-window WhatsApp reminders. Meta approval is verified at send time.';
