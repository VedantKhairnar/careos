-- CareOS schema for Tiger Cloud (PostgreSQL + TimescaleDB).
--
-- Statements are separated by lines containing only "--#" and run one at a time, because continuous
-- aggregates and policies cannot share a transaction. Written to be schema-agnostic (uses search_path)
-- so the same file can be applied to a scratch schema in tests.
--
-- Design notes
--  * Hypertables must include the time column in every unique constraint, so event uniqueness is
--    (event_id, occurred_at). Global idempotency lives in a small relational table instead.
--  * care_events is the audit record and is never deleted. Only agent_executions has a retention policy.
--  * Everything the app shows (status, timeline, gaps, analytics) is derived from these tables.

create table if not exists care_events (
  seq                 bigint generated always as identity,
  event_id            text        not null,
  occurred_at         timestamptz not null,
  recorded_at         timestamptz not null,
  patient_id          text        not null,
  workflow_id         text        not null,
  event_type          text        not null,
  actor_type          text        not null,
  actor_id            text        not null,
  source_system       text        not null,
  payload             jsonb       not null default '{}'::jsonb,
  verification_status text        not null check (verification_status in ('confirmed','patient_reported','estimated','unverified')),
  is_simulated        boolean     not null,
  correlation_id      text        not null,
  idempotency_key     text        not null,
  primary key (event_id, occurred_at)
);
--#
select create_hypertable('care_events', 'occurred_at', chunk_time_interval => interval '7 days', if_not_exists => true);
--#
create index if not exists care_events_workflow_idx on care_events (workflow_id, recorded_at, seq);
--#
create index if not exists care_events_patient_idx on care_events (patient_id, occurred_at desc);
--#
create index if not exists care_events_type_idx on care_events (event_type, occurred_at desc);
--#
create table if not exists event_idempotency (
  idempotency_key text primary key,
  event_id        text        not null,
  first_seen      timestamptz not null default now()
);
--#
create table if not exists workflow_metrics (
  occurred_at   timestamptz      not null,
  workflow_id   text             not null,
  patient_id    text             not null,
  metric        text             not null check (metric in ('ack_latency','fulfilment_time','clarification_resolution')),
  value_seconds double precision not null,
  simulated     boolean          not null
);
--#
select create_hypertable('workflow_metrics', 'occurred_at', chunk_time_interval => interval '7 days', if_not_exists => true);
--#
create index if not exists workflow_metrics_metric_idx on workflow_metrics (metric, occurred_at desc);
--#
create table if not exists agent_executions (
  seq           bigint generated always as identity,
  started_at    timestamptz not null,
  agent         text        not null,
  patient_id    text        not null,
  tool          text,
  model         text,
  ok            boolean     not null,
  error         text,
  duration_ms   integer     not null,
  input_tokens  integer,
  output_tokens integer
);
--#
select create_hypertable('agent_executions', 'started_at', chunk_time_interval => interval '7 days', if_not_exists => true);
--#
create table if not exists care_gaps_open (
  gap_key      text primary key,
  rule         text        not null,
  patient_id   text        not null,
  workflow_id  text        not null,
  responsible  text        not null,
  detected_at  timestamptz not null
);
--#
create table if not exists care_gap_events (
  seq         bigint generated always as identity,
  occurred_at timestamptz not null,
  gap_key     text        not null,
  rule        text        not null,
  patient_id  text        not null,
  workflow_id text        not null,
  responsible text        not null,
  transition  text        not null check (transition in ('detected','resolved'))
);
--#
select create_hypertable('care_gap_events', 'occurred_at', chunk_time_interval => interval '7 days', if_not_exists => true);
--#
-- Continuous aggregates (real-time: they also include data newer than the last refresh)
create materialized view if not exists care_events_hourly
with (timescaledb.continuous, timescaledb.materialized_only = false) as
select time_bucket(interval '1 hour', occurred_at) as bucket,
       event_type,
       count(*)                                    as events,
       count(*) filter (where is_simulated)        as simulated_events
from care_events
where event_type like 'prescription.%'
group by 1, 2
with no data;
--#
create materialized view if not exists workflow_metrics_daily
with (timescaledb.continuous, timescaledb.materialized_only = false) as
select time_bucket(interval '1 day', occurred_at) as bucket,
       metric,
       count(*)           as samples,
       avg(value_seconds) as avg_seconds,
       min(value_seconds) as min_seconds,
       max(value_seconds) as max_seconds
from workflow_metrics
group by 1, 2
with no data;
--#
create materialized view if not exists care_gaps_daily
with (timescaledb.continuous, timescaledb.materialized_only = false) as
select time_bucket(interval '1 day', occurred_at) as bucket,
       rule,
       count(*) filter (where transition = 'detected') as detected,
       count(*) filter (where transition = 'resolved') as resolved
from care_gap_events
group by 1, 2
with no data;
--#
create materialized view if not exists agent_latency_hourly
with (timescaledb.continuous, timescaledb.materialized_only = false) as
select time_bucket(interval '1 hour', started_at) as bucket,
       agent,
       count(*)                                  as calls,
       count(*) filter (where not ok)            as failures,
       avg(duration_ms)                          as avg_ms,
       max(duration_ms)                          as max_ms,
       sum(coalesce(input_tokens, 0))            as input_tokens,
       sum(coalesce(output_tokens, 0))           as output_tokens
from agent_executions
group by 1, 2
with no data;
--#
create materialized view if not exists notifications_daily
with (timescaledb.continuous, timescaledb.materialized_only = false) as
select time_bucket(interval '1 day', occurred_at) as bucket,
       event_type,
       count(*) as events
from care_events
where event_type in ('notification.sent', 'notification.acknowledged')
group by 1, 2
with no data;
--#
select add_continuous_aggregate_policy('care_events_hourly',   start_offset => interval '7 days',  end_offset => interval '1 minute', schedule_interval => interval '5 minutes', if_not_exists => true);
--#
select add_continuous_aggregate_policy('workflow_metrics_daily', start_offset => interval '60 days', end_offset => interval '1 minute', schedule_interval => interval '15 minutes', if_not_exists => true);
--#
select add_continuous_aggregate_policy('care_gaps_daily',      start_offset => interval '60 days', end_offset => interval '1 minute', schedule_interval => interval '15 minutes', if_not_exists => true);
--#
select add_continuous_aggregate_policy('agent_latency_hourly', start_offset => interval '7 days',  end_offset => interval '1 minute', schedule_interval => interval '5 minutes', if_not_exists => true);
--#
select add_continuous_aggregate_policy('notifications_daily',  start_offset => interval '60 days', end_offset => interval '1 minute', schedule_interval => interval '15 minutes', if_not_exists => true);
--#
-- Compression for old audit data, retention only for agent logs.
alter table care_events set (timescaledb.compress, timescaledb.compress_segmentby = 'patient_id', timescaledb.compress_orderby = 'occurred_at desc');
--#
select add_compression_policy('care_events', interval '30 days', if_not_exists => true);
--#
select add_retention_policy('agent_executions', interval '90 days', if_not_exists => true);
