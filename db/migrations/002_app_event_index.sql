-- The app's own views (patient timelines, clinician lists, care-gap detection) exclude the synthetic-history rows
-- that exist only to give analytics real volume. Without this index every such read would scan all of them.
-- Found by testing on a fork loaded with 548,396 synthetic events.
create index if not exists care_events_app_idx on care_events (recorded_at, seq) where source_system <> 'synthetic-history';
