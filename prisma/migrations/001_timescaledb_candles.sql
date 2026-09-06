-- ─────────────────────────────────────────────────────────────
-- TimescaleDB hypertable for candles
-- Run this AFTER Prisma migrate (which creates other tables)
-- ─────────────────────────────────────────────────────────────

-- Enable extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Create the main candles table
CREATE TABLE IF NOT EXISTS candles (
  instrument_key  TEXT           NOT NULL,
  interval        TEXT           NOT NULL,  -- '1m','5m','15m','1h','1d','1w'
  time            TIMESTAMPTZ    NOT NULL,
  open            NUMERIC(14, 4) NOT NULL,
  high            NUMERIC(14, 4) NOT NULL,
  low             NUMERIC(14, 4) NOT NULL,
  close           NUMERIC(14, 4) NOT NULL,
  volume          BIGINT         NOT NULL DEFAULT 0,
  is_complete     BOOLEAN        NOT NULL DEFAULT TRUE,
  PRIMARY KEY (instrument_key, interval, time)
);

-- Convert to TimescaleDB hypertable (partition by time, 1-day chunks)
SELECT create_hypertable(
  'candles',
  'time',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists       => TRUE
);

-- Add compression policy (compress chunks older than 7 days)
ALTER TABLE candles SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'instrument_key, interval'
);
SELECT add_compression_policy('candles', INTERVAL '7 days', if_not_exists => TRUE);

-- Useful indexes
CREATE INDEX IF NOT EXISTS idx_candles_instrument_interval
  ON candles (instrument_key, interval, time DESC);

CREATE INDEX IF NOT EXISTS idx_candles_time_desc
  ON candles (time DESC);

-- ─────────────────────────────────────────────────────────────
-- Continuous aggregate: daily OHLCV from 1-minute candles
-- ─────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS candles_daily_agg
WITH (timescaledb.continuous) AS
SELECT
  instrument_key,
  time_bucket('1 day', time) AS bucket,
  FIRST(open, time)          AS open,
  MAX(high)                  AS high,
  MIN(low)                   AS low,
  LAST(close, time)          AS close,
  SUM(volume)                AS volume
FROM candles
WHERE interval = '1m'
GROUP BY instrument_key, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'candles_daily_agg',
  start_offset  => INTERVAL '3 days',
  end_offset    => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

-- ─────────────────────────────────────────────────────────────
-- Indicator snapshots (lightweight, not hypertable)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS indicator_snapshots (
  instrument_key TEXT        NOT NULL,
  time           TIMESTAMPTZ NOT NULL,
  interval       TEXT        NOT NULL,
  ema20          NUMERIC(14,4),
  ema50          NUMERIC(14,4),
  ema200         NUMERIC(14,4),
  sma20          NUMERIC(14,4),
  rsi14          NUMERIC(6,2),
  macd_line      NUMERIC(14,4),
  macd_signal    NUMERIC(14,4),
  macd_hist      NUMERIC(14,4),
  bb_upper       NUMERIC(14,4),
  bb_lower       NUMERIC(14,4),
  bb_mid         NUMERIC(14,4),
  atr14          NUMERIC(14,4),
  vwap           NUMERIC(14,4),
  PRIMARY KEY (instrument_key, interval, time)
);
