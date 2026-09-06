import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { MarketTick, TICK_EVENT } from '../market-feed/market-feed.service';
import Redis from 'ioredis';
import axios from 'axios';

type Interval = '1m' | '5m' | '15m' | '1h' | '1d' | '1w';

interface LiveCandle {
  instrumentKey: string;
  interval: Interval;
  time: Date;         // candle start time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  startVolume: number; // cumulative volume at candle start (for delta)
  tickCount: number;
  isDirty: boolean;   // updated since last flush
}

const INTERVAL_MS: Record<Interval, number> = {
  '1m':  60_000,
  '5m':  300_000,
  '15m': 900_000,
  '1h':  3_600_000,
  '1d':  86_400_000,
  '1w':  604_800_000,
};

const TRACKED_INTERVALS: Interval[] = ['1m', '5m', '15m', '1h'];

@Injectable()
export class CandleService implements OnModuleInit {
  private readonly logger = new Logger(CandleService.name);
  // Map: `${instrumentKey}:${interval}` → LiveCandle
  private readonly liveCandles = new Map<string, LiveCandle>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleInit() {
    // Backfill the last 5 trading days of 1m candles on startup
    // (run in background to not block startup)
    setTimeout(() => this.backfillRecentCandles(), 10_000);

    // Flush dirty live candles to DB every 10 seconds
    setInterval(() => this.flushLiveCandles(), 10_000);
  }

  // ── Tick handling ──────────────────────────────────────────────

  @OnEvent(TICK_EVENT)
  handleTick(tick: MarketTick) {
    const now = new Date(tick.ltt || Date.now());

    for (const interval of TRACKED_INTERVALS) {
      const bucketTime = this.getBucketTime(now, interval);
      const candleKey = `${tick.instrumentKey}:${interval}`;
      const existing = this.liveCandles.get(candleKey);

      if (!existing || existing.time.getTime() !== bucketTime.getTime()) {
        // Candle completed — save it
        if (existing) {
          this.saveCompletedCandle(existing);
          // Emit completed candle event for strategy scanner
          this.redis.publish(
            `candle:completed:${interval}`,
            JSON.stringify(this.candleToDto(existing)),
          );
        }

        // Start new candle
        const newCandle: LiveCandle = {
          instrumentKey: tick.instrumentKey,
          interval,
          time: bucketTime,
          open: tick.ltp,
          high: tick.ltp,
          low: tick.ltp,
          close: tick.ltp,
          volume: 0,
          startVolume: tick.totalVolume,
          tickCount: 1,
          isDirty: true,
        };
        this.liveCandles.set(candleKey, newCandle);
      } else {
        // Update existing candle
        if (tick.ltp > existing.high) existing.high = tick.ltp;
        if (tick.ltp < existing.low) existing.low = tick.ltp;
        existing.close = tick.ltp;
        existing.volume = Math.max(0, tick.totalVolume - existing.startVolume);
        existing.tickCount++;
        existing.isDirty = true;
      }
    }
  }

  // ── Candle persistence ─────────────────────────────────────────

  private async saveCompletedCandle(candle: LiveCandle) {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO candles (instrument_key, interval, time, open, high, low, close, volume, is_complete)
        VALUES (
          ${candle.instrumentKey}, ${candle.interval}, ${candle.time},
          ${candle.open}, ${candle.high}, ${candle.low}, ${candle.close},
          ${candle.volume}, TRUE
        )
        ON CONFLICT (instrument_key, interval, time) DO UPDATE SET
          high       = GREATEST(candles.high, EXCLUDED.high),
          low        = LEAST(candles.low, EXCLUDED.low),
          close      = EXCLUDED.close,
          volume     = EXCLUDED.volume,
          is_complete = TRUE
      `;
    } catch (err) {
      this.logger.error(`Failed to save candle ${candle.instrumentKey} ${candle.interval}:`, err);
    }
  }

  private async flushLiveCandles() {
    const dirty = [...this.liveCandles.values()].filter((c) => c.isDirty);
    if (dirty.length === 0) return;

    for (const candle of dirty) {
      try {
        await this.prisma.$executeRaw`
          INSERT INTO candles (instrument_key, interval, time, open, high, low, close, volume, is_complete)
          VALUES (
            ${candle.instrumentKey}, ${candle.interval}, ${candle.time},
            ${candle.open}, ${candle.high}, ${candle.low}, ${candle.close},
            ${candle.volume}, FALSE
          )
          ON CONFLICT (instrument_key, interval, time) DO UPDATE SET
            high       = GREATEST(candles.high, EXCLUDED.high),
            low        = LEAST(candles.low, EXCLUDED.low),
            close      = EXCLUDED.close,
            volume     = EXCLUDED.volume
        `;
        candle.isDirty = false;

        // Push live candle to WebSocket subscribers via Redis
        this.redis.publish(
          `candle:live:${candle.instrumentKey}`,
          JSON.stringify(this.candleToDto(candle)),
        );
      } catch (err) {
        this.logger.error('Flush candle error:', err);
      }
    }
  }

  // ── Historical candle fetching ─────────────────────────────────

  /**
   * Fetch candles from Upstox V3 Historical API and store in TimescaleDB.
   * Called on startup and in daily backfill job.
   */
  async fetchAndStoreHistorical(
    instrumentKey: string,
    interval: string,
    fromDate: string,  // YYYY-MM-DD
    toDate: string,
  ) {
    const token = await this.redis.get('feed:access_token');
    if (!token) {
      this.logger.warn('No access token — skipping historical fetch');
      return;
    }

    try {
      const encodedKey = encodeURIComponent(instrumentKey);
      const url = `${this.config.get('UPSTOX_API_V3_BASE')}/historical-candle/${encodedKey}/${interval}/${toDate}/${fromDate}`;
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        timeout: 30_000,
      });

      const candles: number[][] = response.data?.data?.candles ?? [];
      if (candles.length === 0) return;

      // Batch insert
      for (let i = 0; i < candles.length; i += 1000) {
        const batch = candles.slice(i, i + 1000);
        await this.prisma.$executeRaw`
          INSERT INTO candles (instrument_key, interval, time, open, high, low, close, volume, is_complete)
          SELECT
            ${instrumentKey},
            ${interval},
            to_timestamp(c->>0, 'YYYY-MM-DD"T"HH24:MI:SS+05:30')::timestamptz,
            (c->>1)::numeric,
            (c->>2)::numeric,
            (c->>3)::numeric,
            (c->>4)::numeric,
            (c->>5)::bigint,
            TRUE
          FROM jsonb_array_elements(${JSON.stringify(batch.map(String))}::jsonb) AS c
          ON CONFLICT DO NOTHING
        `;
      }

      this.logger.debug(`Stored ${candles.length} ${interval} candles for ${instrumentKey}`);
    } catch (err: any) {
      if (err.response?.status === 429) {
        this.logger.warn(`Rate limited fetching ${instrumentKey} ${interval}`);
      } else {
        this.logger.error(`Historical fetch error for ${instrumentKey}:`, err.message);
      }
    }
  }

  private async backfillRecentCandles() {
    this.logger.log('Starting startup candle backfill');
    const today = new Date();
    const fromDate = new Date(today.getTime() - 7 * 86400_000);

    const token = await this.redis.get('feed:access_token');
    if (!token) {
      this.logger.warn('No broker access token in Redis — skipping startup historical candle backfill');
      return;
    }

    const instruments = await this.prisma.instrument.findMany({
      where: { active: true, suspended: false, scannerEnabled: true },
      select: { instrumentKey: true },
      take: 500,
    });

    // Rate-limit: 10 requests per second
    const RATE = 10;
    for (let i = 0; i < instruments.length; i++) {
      const { instrumentKey } = instruments[i];
      await this.fetchAndStoreHistorical(
        instrumentKey,
        '5m',
        this.formatDate(fromDate),
        this.formatDate(today),
      );
      if ((i + 1) % RATE === 0) {
        await this.sleep(1100); // 1.1s delay after every 10 requests
      }
    }
    this.logger.log('Startup backfill complete');
  }

  // ── REST: get candles for chart ────────────────────────────────

  // ── REST: get candles for chart ────────────────────────────────

  async getCandles(
    instrumentKey: string,
    interval: string,
    from: Date,
    to: Date,
    limit = 500,
  ) {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT time, open, high, low, close, volume
      FROM candles
      WHERE instrument_key = ${instrumentKey}
        AND interval = ${interval}
        AND time BETWEEN ${from} AND ${to}
      ORDER BY time ASC
      LIMIT ${limit}
    `;

    if (rows && rows.length >= 10) {
      return rows.map((r) => ({
        time: r.time.getTime() / 1000, // Unix seconds for TradingView
        open: parseFloat(r.open),
        high: parseFloat(r.high),
        low: parseFloat(r.low),
        close: parseFloat(r.close),
        volume: Number(r.volume),
      }));
    }

    // Fallback: fetch live historical candles from Yahoo Finance
    const yahooCandles = await this.fetchYahooCandles(instrumentKey, interval);
    if (yahooCandles && yahooCandles.length > 0) {
      return yahooCandles;
    }

    if (rows && rows.length > 0) {
      return rows.map((r) => ({
        time: r.time.getTime() / 1000,
        open: parseFloat(r.open),
        high: parseFloat(r.high),
        low: parseFloat(r.low),
        close: parseFloat(r.close),
        volume: Number(r.volume),
      }));
    }

    return [];
  }

  private async fetchYahooCandles(instrumentKey: string, interval: string): Promise<any[]> {
    try {
      let yahooSymbol = instrumentKey;
      if (instrumentKey.startsWith('NSE_INDEX|') || instrumentKey.includes('Nifty 50')) {
        yahooSymbol = '^NSEI';
      } else if (instrumentKey.includes('Bank') || instrumentKey.includes('BANK NIFTY')) {
        yahooSymbol = '^NSEBANK';
      } else if (instrumentKey.includes('IT') || instrumentKey.includes('CNXIT')) {
        yahooSymbol = '^CNXIT';
      } else if (instrumentKey.includes('VIX') || instrumentKey.includes('INDIAVIX')) {
        yahooSymbol = '^INDIAVIX';
      } else {
        let sym = instrumentKey;
        if (sym.includes('|')) {
          const inst = await this.prisma.instrument.findUnique({
            where: { instrumentKey },
            select: { tradingSymbol: true },
          });
          sym = inst?.tradingSymbol || sym.split('|')[1];
        }
        if (sym === 'ZOMATO') {
          yahooSymbol = 'ETERNAL.NS';
        } else if (!sym.endsWith('.NS') && !sym.startsWith('^')) {
          yahooSymbol = `${sym}.NS`;
        }
      }

      let yInterval = '5m';
      let range = '5d';
      let aggregateSeconds = 0;

      // Handle timeframes: minutes (1m, 2m, 3m, 4m, 5m, 10m, 15m, 30m, 75m, 125m),
      // hours (1h, 2h, 3h, 4h), days (1D), weeks (1W), months (1M)
      if (interval === '1M' || interval.toLowerCase() === '1mo' || interval.toLowerCase() === '1mth') {
        yInterval = '1mo';
        range = '5y';
      } else {
        switch (interval.toLowerCase()) {
          case '1m':
            yInterval = '1m'; range = '2d'; break;
          case '2m':
            yInterval = '2m'; range = '5d'; break;
          case '3m':
            yInterval = '1m'; range = '5d'; aggregateSeconds = 180; break;
          case '4m':
            yInterval = '1m'; range = '5d'; aggregateSeconds = 240; break;
          case '5m':
            yInterval = '5m'; range = '5d'; break;
          case '10m':
            yInterval = '5m'; range = '1mo'; aggregateSeconds = 600; break;
          case '15m':
            yInterval = '15m'; range = '1mo'; break;
          case '30m':
            yInterval = '30m'; range = '1mo'; break;
          case '75m':
            yInterval = '15m'; range = '1mo'; aggregateSeconds = 4500; break;
          case '125m':
            yInterval = '5m'; range = '1mo'; aggregateSeconds = 7500; break;
          case '1h':
            yInterval = '60m'; range = '3mo'; break;
          case '2h':
            yInterval = '60m'; range = '6mo'; aggregateSeconds = 7200; break;
          case '3h':
            yInterval = '60m'; range = '6mo'; aggregateSeconds = 10800; break;
          case '4h':
            yInterval = '60m'; range = '6mo'; aggregateSeconds = 14400; break;
          case '1d':
            yInterval = '1d'; range = '1y'; break;
          case '1w':
            yInterval = '1wk'; range = '2y'; break;
          default:
            yInterval = '5m'; range = '5d'; break;
        }
      }

      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${yInterval}&range=${range}`;
      const res = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
        timeout: 8_000,
      });

      const result = res.data?.chart?.result?.[0];
      if (!result) return [];

      const timestamps: number[] = result.timestamp || [];
      const quotes = result.indicators?.quote?.[0];
      if (!quotes) return [];

      const candles: any[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (quotes.open?.[i] != null && quotes.close?.[i] != null) {
          candles.push({
            time: timestamps[i],
            open: Number(quotes.open[i].toFixed(2)),
            high: Number(quotes.high[i].toFixed(2)),
            low: Number(quotes.low[i].toFixed(2)),
            close: Number(quotes.close[i].toFixed(2)),
            volume: Number(quotes.volume?.[i] || 0),
          });
        }
      }

      if (aggregateSeconds > 0 && candles.length > 0) {
        return this.aggregateCandles(candles, aggregateSeconds);
      }

      return candles;
    } catch (err: any) {
      this.logger.debug(`Yahoo candles fallback failed for ${instrumentKey}: ${err.message}`);
      return [];
    }
  }

  private aggregateCandles(candles: any[], bucketSeconds: number): any[] {
    if (!candles || candles.length === 0) return [];
    const buckets = new Map<number, any>();
    for (const c of candles) {
      const bucketTime = Math.floor(c.time / bucketSeconds) * bucketSeconds;
      const existing = buckets.get(bucketTime);
      if (!existing) {
        buckets.set(bucketTime, {
          time: bucketTime,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume || 0,
        });
      } else {
        existing.high = Math.max(existing.high, c.high);
        existing.low = Math.min(existing.low, c.low);
        existing.close = c.close;
        existing.volume += (c.volume || 0);
      }
    }
    return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
  }

  getLiveCandle(instrumentKey: string, interval: Interval): LiveCandle | undefined {
    return this.liveCandles.get(`${instrumentKey}:${interval}`);
  }

  // ── Utilities ──────────────────────────────────────────────────

  private getBucketTime(now: Date, interval: Interval): Date {
    const ms = now.getTime();
    const bucket = Math.floor(ms / INTERVAL_MS[interval]) * INTERVAL_MS[interval];
    return new Date(bucket);
  }

  private candleToDto(candle: LiveCandle) {
    return {
      instrumentKey: candle.instrumentKey,
      interval: candle.interval,
      time: candle.time.getTime() / 1000,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    };
  }

  private formatDate(d: Date): string {
    return d.toISOString().split('T')[0];
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
