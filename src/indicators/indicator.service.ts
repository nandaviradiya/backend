import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { CandleService } from '../candles/candle.service';
import Redis from 'ioredis';
import { MarketFeedService } from '../market-feed/market-feed.service';

interface DayLevel {
  instrumentKey: string;
  tradingDate: Date;
  resistance20d: number;
  support20d: number;
  atr14: number;
  avgVolByBucket: Record<string, number>;
  vwap: number;
  vwapNumerator: number;
  vwapDenominator: number;
  prevDayClose: number;
}

@Injectable()
export class IndicatorService implements OnModuleInit {
  private readonly logger = new Logger(IndicatorService.name);
  // In-memory cache of today's levels (refreshed pre-market)
  private readonly levels = new Map<string, DayLevel>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly candles: CandleService,
    private readonly feed: MarketFeedService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleInit() {
    // Load today's levels from DB on startup
    await this.loadLevelsFromDb();
  }

  // ── Pre-market calculation ─────────────────────────────────────

  /**
   * Runs Mon–Fri at 8:30 AM IST (3:00 UTC).
   * Calculates 20-day resistance/support, ATR, and RVOL baselines for all instruments.
   */
  @Cron('0 3 * * 1-5', { name: 'pre-market-levels', timeZone: 'UTC' })
  async calculatePreMarketLevels() {
    this.logger.log('Calculating pre-market technical levels');
    const today = this.getTodayIST();

    const instruments = await this.prisma.instrument.findMany({
      where: { active: true, suspended: false, scannerEnabled: true },
      select: { instrumentKey: true, tickSize: true },
    });

    let successCount = 0;
    const BATCH = 50;

    for (let i = 0; i < instruments.length; i += BATCH) {
      const batch = instruments.slice(i, i + BATCH);
      await Promise.allSettled(
        batch.map(async (inst) => {
          try {
            await this.calculateForInstrument(inst.instrumentKey, today);
            successCount++;
          } catch (err) {
            this.logger.error(`Level calc failed for ${inst.instrumentKey}:`, err);
          }
        }),
      );
    }

    this.logger.log(`Pre-market levels calculated for ${successCount}/${instruments.length} instruments`);
    await this.loadLevelsFromDb();
  }

  private async calculateForInstrument(instrumentKey: string, tradingDate: Date) {
    // Get last 21 daily candles (we exclude current day, use prev 20)
    const candles = await this.prisma.$queryRaw<any[]>`
      SELECT time, open, high, low, close, volume
      FROM candles
      WHERE instrument_key = ${instrumentKey}
        AND interval = '1d'
        AND time < ${tradingDate}
      ORDER BY time DESC
      LIMIT 21
    `;

    if (candles.length < 10) return; // not enough data

    const recent20 = candles.slice(0, 20);

    // 20-day resistance = highest high of previous 20 sessions
    const resistance20d = Math.max(...recent20.map((c) => parseFloat(c.high)));

    // 20-day support = lowest low of previous 20 sessions
    const support20d = Math.min(...recent20.map((c) => parseFloat(c.low)));

    // ATR-14 = average of true ranges
    const trueRanges: number[] = [];
    for (let i = 0; i < Math.min(14, recent20.length - 1); i++) {
      const curr = recent20[i];
      const prev = recent20[i + 1];
      const tr = Math.max(
        parseFloat(curr.high) - parseFloat(curr.low),
        Math.abs(parseFloat(curr.high) - parseFloat(prev.close)),
        Math.abs(parseFloat(curr.low) - parseFloat(prev.close)),
      );
      trueRanges.push(tr);
    }
    const atr14 = trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;

    // RVOL baselines: median volume at each 5-min bucket over last 20 sessions
    // Query 5-minute candles for last 20 trading days, group by time-of-day bucket
    const bucketData = await this.prisma.$queryRaw<any[]>`
      SELECT
        to_char(time AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS bucket,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY volume) AS median_vol
      FROM candles
      WHERE instrument_key = ${instrumentKey}
        AND interval = '5m'
        AND time >= ${new Date(tradingDate.getTime() - 25 * 86400_000)}
        AND time < ${tradingDate}
      GROUP BY bucket
      ORDER BY bucket
    `;

    const avgVolByBucket: Record<string, number> = {};
    for (const row of bucketData) {
      avgVolByBucket[row.bucket] = parseFloat(row.median_vol ?? 0);
    }

    const prevDayClose = parseFloat(recent20[0]?.close ?? 0);

    // Upsert into DB
    await this.prisma.technicalLevel.upsert({
      where: { instrumentKey_tradingDate: { instrumentKey, tradingDate } },
      create: {
        instrumentKey,
        tradingDate,
        resistance20d,
        support20d,
        atr14,
        avgVolByBucket,
        prevDayClose,
        prevDayVolume: BigInt(Math.round(parseFloat(recent20[0]?.volume ?? 0))),
      },
      update: {
        resistance20d,
        support20d,
        atr14,
        avgVolByBucket,
        prevDayClose,
        prevDayVolume: BigInt(Math.round(parseFloat(recent20[0]?.volume ?? 0))),
        calculatedAt: new Date(),
      },
    });
  }

  // ── Live VWAP update ───────────────────────────────────────────

  /**
   * Update VWAP numerator and denominator in-memory for each tick.
   * VWAP = sum(price × volume) / sum(volume)
   */
  updateVwap(instrumentKey: string, price: number, volumeDelta: number) {
    const level = this.levels.get(instrumentKey);
    if (!level || volumeDelta <= 0) return;

    level.vwapNumerator += price * volumeDelta;
    level.vwapDenominator += volumeDelta;
    level.vwap = level.vwapDenominator > 0
      ? level.vwapNumerator / level.vwapDenominator
      : price;
  }

  getLevel(instrumentKey: string): DayLevel | undefined {
    return this.levels.get(instrumentKey);
  }

  getVwap(instrumentKey: string): number {
    return this.levels.get(instrumentKey)?.vwap ?? 0;
  }

  /**
   * Calculate RVOL for a given instrument at the current time.
   * Compares current cumulative volume to median historical volume at same time-of-day.
   */
  calculateRvol(instrumentKey: string, currentVolume: number): number {
    const level = this.levels.get(instrumentKey);
    if (!level) return 0;

    const nowIST = new Date(Date.now() + 5.5 * 3600_000);
    const bucketKey = nowIST.toISOString().substring(11, 16).replace('T', '');
    const historicalMedian = level.avgVolByBucket[bucketKey] ?? 0;

    if (historicalMedian === 0) return 0;
    return parseFloat((currentVolume / historicalMedian).toFixed(2));
  }

  // ── EMA calculation ────────────────────────────────────────────

  /**
   * Calculate EMA from an array of closes.
   * Used for slope-based ML features.
   */
  calculateEMA(closes: number[], period: number): number[] {
    if (closes.length < period) return [];
    const k = 2 / (period + 1);
    const result: number[] = [];
    let ema = closes.slice(0, period).reduce((a, b) => a + b) / period;

    for (let i = period; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
      result.push(ema);
    }
    return result;
  }

  calculateATR(highs: number[], lows: number[], closes: number[], period = 14): number {
    const trs: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      trs.push(
        Math.max(
          highs[i] - lows[i],
          Math.abs(highs[i] - closes[i - 1]),
          Math.abs(lows[i] - closes[i - 1]),
        ),
      );
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  }

  // ── Load from DB ───────────────────────────────────────────────

  private async loadLevelsFromDb() {
    const today = this.getTodayIST();
    const rows = await this.prisma.technicalLevel.findMany({
      where: { tradingDate: today },
    });

    for (const row of rows) {
      this.levels.set(row.instrumentKey, {
        instrumentKey: row.instrumentKey,
        tradingDate: row.tradingDate,
        resistance20d: row.resistance20d,
        support20d: row.support20d,
        atr14: row.atr14,
        avgVolByBucket: row.avgVolByBucket as Record<string, number>,
        vwap: row.vwap,
        vwapNumerator: row.vwapNumerator,
        vwapDenominator: row.vwapDenominator,
        prevDayClose: row.prevDayClose ?? 0,
      });
    }
    this.logger.log(`Loaded ${this.levels.size} technical levels into memory`);
  }

  private getTodayIST(): Date {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    return new Date(`${istNow.toISOString().split('T')[0]}T00:00:00.000Z`);
  }
}
