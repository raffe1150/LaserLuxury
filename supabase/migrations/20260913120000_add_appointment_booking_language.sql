alter table public.appointments
  add column if not exists language text;

alter table public.appointments
  drop constraint if exists appointments_language_check;

alter table public.appointments
  add constraint appointments_language_check
  check (language is null or language in ('sv', 'en', 'de', 'es', 'fa', 'ar'));

comment on column public.appointments.language is
  'Authoritative customer language captured when the booking is confirmed; null preserves legacy reminder fallback behavior.';
