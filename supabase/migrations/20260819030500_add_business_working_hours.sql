-- Per-business weekly working hours.
--
-- Format:
-- {
--   "monday":    [{"start":"09:00","end":"18:00"}],
--   "tuesday":   [{"start":"09:00","end":"18:00"}],
--   "wednesday": [{"start":"09:00","end":"18:00"}],
--   "thursday":  [{"start":"09:00","end":"18:00"}],
--   "friday":    [{"start":"09:00","end":"18:00"}],
--   "saturday":  [],
--   "sunday":    []
-- }
--
-- Empty array = business closed that day.
-- Multiple intervals are supported for split shifts / breaks.

alter table public.businesses
add column if not exists working_hours jsonb;

comment on column public.businesses.working_hours is
'Weekly business working hours. Keys are monday-sunday; values are arrays of {start,end} local-time intervals. Empty array means closed.';

