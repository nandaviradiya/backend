import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import WebSocket from 'ws';
import axios from 'axios';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { PrismaService } from '../prisma/prisma.service';

export interface MarketTick {
  instrumentKey: string;
  symbol?: string;
  name?: string;
  ltp: number;
  ltq: number;
  ltt: number;
  prevClose: number;
  totalVolume: number;
  bidPrice: number;
  bidQty: number;
  askPrice: number;
  askQty: number;
  marketStatus: string;
  openInterest?: number;
  isIndex?: boolean;
  source?: 'upstox' | 'yahoo' | 'yahoo_quote' | 'yahoo_chart' | 'yahoo_cached' | 'nse_pub';
}

export interface LiveQuote {
  instrumentKey: string;
  symbol: string;
  name: string;
  ltp: number;
  change: number;
  changePct: number;
  volume: number;
  bidPrice: number;
  askPrice: number;
  isIndex: boolean;
  source: string;
  updatedAt: number;
}

export interface LiveInstrument {
  instrumentKey: string;
  symbol: string;
  name: string;
  yahoo: string;
  isIndex?: boolean;
}

export const TICK_EVENT = 'market.tick';
export const FEED_STATUS_EVENT = 'market.feed.status';

export const DEFAULT_LIVE_INSTRUMENTS: LiveInstrument[] = [
  { instrumentKey: 'NSE_INDEX|Nifty 50', symbol: 'NIFTY 50', name: 'Nifty 50', yahoo: '^NSEI', isIndex: true },
  { instrumentKey: 'NSE_INDEX|Nifty Bank', symbol: 'BANK NIFTY', name: 'Nifty Bank', yahoo: '^NSEBANK', isIndex: true },
  { instrumentKey: 'NSE_INDEX|Nifty IT', symbol: 'NIFTY IT', name: 'Nifty IT', yahoo: '^CNXIT', isIndex: true },
  { instrumentKey: 'NSE_INDEX|India VIX', symbol: 'INDIA VIX', name: 'India VIX', yahoo: '^INDIAVIX', isIndex: true },
  { instrumentKey: 'NSE_EQ|INE002A01018', symbol: 'RELIANCE', name: 'Reliance Industries Ltd', yahoo: 'RELIANCE.NS' },
  { instrumentKey: 'NSE_EQ|INE040A01034', symbol: 'HDFCBANK', name: 'HDFC Bank Ltd', yahoo: 'HDFCBANK.NS' },
  { instrumentKey: 'NSE_EQ|INE081A01020', symbol: 'TATASTEEL', name: 'Tata Steel Ltd', yahoo: 'TATASTEEL.NS' },
  { instrumentKey: 'NSE_EQ|INE009A01021', symbol: 'INFY', name: 'Infosys Ltd', yahoo: 'INFY.NS' },
  { instrumentKey: 'NSE_EQ|INE090A01021', symbol: 'ICICIBANK', name: 'ICICI Bank Ltd', yahoo: 'ICICIBANK.NS' },
  { instrumentKey: 'NSE_EQ|INE467B01029', symbol: 'TCS', name: 'Tata Consultancy Services', yahoo: 'TCS.NS' },
  { instrumentKey: 'NSE_EQ|INE062A01020', symbol: 'SBIN', name: 'State Bank of India', yahoo: 'SBIN.NS' },
  { instrumentKey: 'NSE_EQ|INE758T01015', symbol: 'ZOMATO', name: 'Zomato Ltd (Eternal)', yahoo: 'ETERNAL.NS' },
];

@Injectable()
export class MarketFeedService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketFeedService.name);
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private isDestroyed = false;
  private isDegraded = false;
  private feedMode: 'upstox' | 'yahoo' | 'yahoo_quote' | 'yahoo_chart' | 'yahoo_cached' | 'nse_pub' | 'disconnected' = 'disconnected';
  private subscribedKeys = new Set<string>();
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_DELAY = 30_000;
  private readonly metaByKey = new Map<string, LiveInstrument>();
  private readonly metaByYahoo = new Map<string, LiveInstrument>();
  private readonly latestQuotes = new Map<string, LiveQuote>();

  // Cache for Yahoo Finance quotes to reduce API calls
  private readonly quoteCache = new Map<string, { quote: LiveQuote; timestamp: number }>();
  private readonly CACHE_TTL_MS = 2_000; // 2 seconds cache

  // Retry configuration — keep low to avoid log spam on timeout
  private readonly MAX_RETRIES = 1;
  private readonly BASE_RETRY_DELAY = 1_000; // ms

  constructor(
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    for (const item of DEFAULT_LIVE_INSTRUMENTS) {
      this.metaByKey.set(item.instrumentKey, item);
      this.metaByYahoo.set(item.yahoo, item);
    }
  }

  async onModuleInit() {
    DEFAULT_LIVE_INSTRUMENTS.forEach((item) => this.subscribedKeys.add(item.instrumentKey));
    setTimeout(() => this.connect(), 1_000);
  }

  async onModuleDestroy() {
    this.isDestroyed = true;
    this.clearTimers();
    if (this.ws) this.ws.close(1000, 'Server shutting down');
  }

  private async connect() {
    if (this.isDestroyed) return;

    try {
      const accessToken = await this.getAccessToken();
      if (accessToken) {
        this.logger.log('Upstox access token detected — connecting to live Upstox V3 feed');
        const wsUrl = `wss://api.upstox.com/v3/feed/market-data-feed?access_token=${accessToken}`;
        this.ws = new WebSocket(wsUrl);
        this.ws.on('open', () => this.onOpen());
        this.ws.on('message', (data: Buffer) => this.onMessage(data));
        this.ws.on('error', (err) => this.onError(err));
        this.ws.on('close', (code, reason) => this.onClose(code, reason.toString()));
        this.startQuotePoller();
        return;
      }

      this.logger.log('No Upstox broker token — attempting Yahoo Finance quote API');
      this.feedMode = 'yahoo_quote';
      this.events.emit(FEED_STATUS_EVENT, { status: 'connecting', source: 'yahoo_quote' });
      this.startQuotePoller();
    } catch (err: any) {
      this.logger.error(`Failed to connect to market feed: ${err.message}`);
      this.handleConnectionError();
    }
  }

  private onOpen() {
    this.logger.log('Market feed WebSocket connected');
    this.reconnectAttempts = 0;
    this.isDegraded = false;
    this.feedMode = 'upstox';
    this.events.emit(FEED_STATUS_EVENT, { status: 'connected', source: 'upstox' });
    this.startHeartbeat();
    if (this.subscribedKeys.size > 0) {
      this.sendSubscribe([...this.subscribedKeys]);
    }
  }

  private onMessage(data: Buffer) {
    try {
      const ticks = this.decodeTicks(data);
      for (const tick of ticks) {
        this.processTick({ ...tick, source: 'upstox' });
      }
    } catch (err: any) {
      this.logger.error('Error processing market feed message:', err.message);
    }
  }

  private onError(err: Error) {
    this.logger.error('Market feed WebSocket error:', err.message);
  }

  private onClose(code: number, reason: string) {
    this.logger.warn(`Market feed closed: ${code} ${reason}`);
    this.clearHeartbeat();
    this.isDegraded = true;
    this.events.emit(FEED_STATUS_EVENT, { status: 'disconnected', code, reason });
    if (!this.isDestroyed) {
      this.handleConnectionError();
    }
  }

  private handleConnectionError() {
    this.scheduleReconnect();
    // If we were using Upstox, fall back to Yahoo
    if (this.feedMode === 'upstox') {
      this.logger.log('Falling back to Yahoo Finance quote API');
      this.feedMode = 'yahoo_quote';
      this.events.emit(FEED_STATUS_EVENT, { status: 'fallback', source: 'yahoo_quote' });
      this.startQuotePoller();
    }
  }

  private scheduleReconnect() {
    this.reconnectAttempts++;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, this.MAX_RECONNECT_DELAY);
    this.logger.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat() {
    this.clearHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 20_000);
  }

  private clearHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = null;
  }

  private clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearHeartbeat();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async subscribe(instrumentKeys: string[]) {
    for (const key of instrumentKeys) {
      this.subscribedKeys.add(key);
      await this.resolveMeta(key);
    }
    this.sendSubscribe(instrumentKeys);
    // Immediately fetch quotes for newly subscribed keys
    void this.fetchLiveBatch(instrumentKeys);
  }

  unsubscribe(instrumentKeys: string[]) {
    instrumentKeys.forEach((k) => this.subscribedKeys.delete(k));
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          guid: Date.now().toString(),
          method: 'unsub',
          data: { instrumentKeys },
        }),
      );
    }
  }

  private sendSubscribe(instrumentKeys: string[]) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const equityKeys = instrumentKeys.filter((k) => k.startsWith('NSE_EQ|') || k.startsWith('BSE_EQ|') || k.startsWith('NSE_INDEX|'));
    if (equityKeys.length === 0) return;
    this.ws.send(
      JSON.stringify({
        guid: Date.now().toString(),
        method: 'sub',
        data: { mode: 'full', instrumentKeys: equityKeys },
      }),
    );
    this.logger.debug(`Subscribed to ${equityKeys.length} instruments on Upstox WebSocket`);
  }

  private processTick(tick: MarketTick) {
    const meta = this.metaByKey.get(tick.instrumentKey);
    const enriched: MarketTick = {
      ...tick,
      symbol: tick.symbol || meta?.symbol,
      name: tick.name || meta?.name,
      isIndex: tick.isIndex ?? meta?.isIndex ?? false,
    };

    const quote = this.toLiveQuote(enriched);
    this.latestQuotes.set(tick.instrumentKey, quote);
    if (quote.symbol) {
      this.latestQuotes.set(`symbol:${quote.symbol.toUpperCase()}`, quote);
      this.latestQuotes.set(quote.symbol.toUpperCase(), quote);
    }

    try {
      this.redis.publish('market:tick', JSON.stringify(enriched));
      this.redis.setex(`quote:${tick.instrumentKey}`, 300, JSON.stringify(quote));
      if (quote.symbol) {
        this.redis.setex(`quote:symbol:${quote.symbol.toUpperCase()}`, 300, JSON.stringify(quote));
      }
    } catch {
      // Redis is optional
    }

    this.events.emit(TICK_EVENT, enriched);
  }

  toLiveQuote(tick: MarketTick): LiveQuote {
    const prev = tick.prevClose || tick.ltp;
    const change = tick.ltp - prev;
    const changePct = prev ? (change / prev) * 100 : 0;
    const meta = this.metaByKey.get(tick.instrumentKey);
    return {
      instrumentKey: tick.instrumentKey,
      symbol: tick.symbol || meta?.symbol || tick.instrumentKey,
      name: tick.name || meta?.name || tick.symbol || tick.instrumentKey,
      ltp: tick.ltp,
      change: Number(change.toFixed(2)),
      changePct: Number(changePct.toFixed(2)),
      volume: tick.totalVolume,
      bidPrice: tick.bidPrice,
      askPrice: tick.askPrice,
      isIndex: tick.isIndex ?? meta?.isIndex ?? false,
      source: tick.source || this.feedMode,
      updatedAt: Date.now(),
    };
  }

  private decodeTicks(data: Buffer): MarketTick[] {
    try {
      const parsed = JSON.parse(data.toString());
      if (Array.isArray(parsed)) return parsed;
      if (parsed.feeds) {
        return Object.entries(parsed.feeds).map(([key, feed]: [string, any]) => ({
          instrumentKey: key,
          ltp: feed.ff?.marketFF?.ltpc?.ltp ?? feed.ltpc?.ltp ?? 0,
          ltq: feed.ff?.marketFF?.ltpc?.ltq ?? feed.ltpc?.ltq ?? 0,
          ltt: feed.ff?.marketFF?.ltpc?.ltt ?? feed.ltpc?.ltt ?? Date.now(),
          prevClose: feed.ff?.marketFF?.ltpc?.cp ?? feed.ltpc?.cp ?? 0,
          totalVolume: feed.ff?.marketFF?.marketOHLC?.ohlc?.[0]?.vol ?? 0,
          bidPrice: feed.ff?.marketFF?.marketDepth?.bid?.[0]?.price ?? 0,
          bidQty: feed.ff?.marketFF?.marketDepth?.bid?.[0]?.quantity ?? 0,
          askPrice: feed.ff?.marketFF?.marketDepth?.ask?.[0]?.price ?? 0,
          askQty: feed.ff?.marketFF?.marketDepth?.ask?.[0]?.quantity ?? 0,
          marketStatus: 'NORMAL_OPEN',
        }));
      }
      return [];
    } catch {
      return [];
    }
  }

  private async getAccessToken(): Promise<string | null> {
    const fromEnv = this.config.get<string>('UPSTOX_ACCESS_TOKEN');
    if (fromEnv) return fromEnv;
    try {
      return await this.redis.get('feed:access_token');
    } catch {
      return null;
    }
  }

  private startLiveFeed() {
    this.feedMode = 'yahoo';
    this.isDegraded = false;
    this.events.emit(FEED_STATUS_EVENT, { status: 'connected', source: 'yahoo' });
    this.startQuotePoller();
  }

  private startQuotePoller() {
    if (this.pollTimer) return;
    void this.pollAllQuotes();
    // Adaptive polling: more frequent during market hours
    // Outside market hours: 30s is enough (data doesn't change)
    const interval = this.isIndianMarketHours() ? 3_000 : 30_000;
    this.pollTimer = setInterval(() => {
      void this.pollAllQuotes();
    }, interval);
  }

  private async pollAllQuotes() {
    if (this.isDestroyed || this.subscribedKeys.size === 0) return;

    const token = await this.getAccessToken();
    if (token && this.feedMode === 'upstox') {
      const ok = await this.pollUpstoxQuotes(token);
      if (ok) return;
    }

    await this.fetchLiveBatch([...this.subscribedKeys]);
  }

  private async pollUpstoxQuotes(token: string): Promise<boolean> {
    try {
      const keys = [...this.subscribedKeys].filter((k) => !k.startsWith('NSE_INDEX|India'));
      const chunks: string[][] = [];
      for (let i = 0; i < keys.length; i += 50) chunks.push(keys.slice(i, i + 50));

      for (const chunk of chunks) {
        const response = await axios.get('https://api.upstox.com/v2/market-quote/quotes', {
          params: { instrument_key: chunk.join(',') },
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          timeout: 8_000,
        });
        const data = response.data?.data || {};
        for (const [rawKey, quote] of Object.entries<any>(data)) {
          const instrumentKey = rawKey.replace(':', '|');
          const ohlc = quote.ohlc || {};
          const depth = quote.depth || {};
          this.processTick({
            instrumentKey,
            ltp: quote.last_price ?? 0,
            ltq: quote.last_traded_quantity ?? 0,
            ltt: quote.last_trade_time ? Date.parse(quote.last_trade_time) : Date.now(),
            prevClose: ohlc.close ?? quote.last_price ?? 0,
            totalVolume: quote.volume ?? 0,
            bidPrice: depth.buy?.[0]?.price ?? 0,
            bidQty: depth.buy?.[0]?.quantity ?? 0,
            askPrice: depth.sell?.[0]?.price ?? 0,
            askQty: depth.sell?.[0]?.quantity ?? 0,
            marketStatus: quote.oi ? 'NORMAL_OPEN' : 'NORMAL_OPEN',
            source: 'upstox',
          });
        }
      }
      this.feedMode = 'upstox';
      return true;
    } catch (err: any) {
      this.logger.warn(`Upstox REST quotes failed: ${err.response?.data?.message || err.message}`);
      return false;
    }
  }

  private async fetchLiveBatch(keys: string[]) {
    const metaList = await Promise.all(keys.map((k) => this.resolveMeta(k)));
    const validMetas = metaList.filter((m): m is LiveInstrument => m !== null);
    if (validMetas.length === 0) return;

    // Outside market hours — serve from Redis cache, avoid hitting Yahoo
    const marketOpen = this.isIndianMarketHours();

    // Sequential fetching with small delay to avoid Yahoo rate-limits
    // (concurrent requests get blocked/timed-out much more aggressively)
    for (const meta of validMetas) {
      try {
        // Always check memory + Redis cache first
        const cached = this.getCachedQuote(meta.yahoo);
        if (cached) {
          this.processTick(this.cachedToTick(cached, meta));
          continue;
        }

        // Outside market hours: try Redis only, skip live Yahoo fetch
        if (!marketOpen) {
          try {
            const redisVal = await this.redis.get(`quote:${meta.instrumentKey}`);
            if (redisVal) {
              const q: LiveQuote = JSON.parse(redisVal);
              this.cacheQuote(meta.yahoo, q);
              this.latestQuotes.set(meta.instrumentKey, q);
              continue;
            }
          } catch { /* Redis optional */ }
          // No cache at all outside hours — skip, don't hammer Yahoo
          continue;
        }

        const quote = await this.fetchSingleLiveQuoteWithRetry(meta);
        if (quote) {
          const liveQuote: LiveQuote = {
            instrumentKey: quote.instrumentKey,
            symbol: quote.symbol ?? '',
            name: quote.name ?? '',
            ltp: quote.ltp,
            change: quote.ltp - quote.prevClose,
            changePct: quote.prevClose ? ((quote.ltp - quote.prevClose) / quote.prevClose) * 100 : 0,
            volume: quote.totalVolume,
            bidPrice: quote.bidPrice,
            askPrice: quote.askPrice,
            isIndex: quote.isIndex ?? false,
            source: quote.source ?? 'yahoo',
            updatedAt: quote.ltt,
          };
          this.cacheQuote(meta.yahoo, liveQuote);
          this.processTick(quote);
        }
        // Small delay between Yahoo requests to stay under rate limit
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        this.logger.debug(`Skipping ${meta.symbol}: ${e.message}`);
      }
    }
  }

  private async fetchSingleLiveQuoteWithRetry(meta: LiveInstrument): Promise<MarketTick | null> {
    try {
      const quote = await this.fetchYahooQuote(meta);
      if (quote) return quote;
    } catch (err: any) {
      // Only retry once on transient errors (not timeouts — they'll just pile up)
      const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
      if (!isTimeout && this.MAX_RETRIES > 0) {
        this.logger.debug(`Yahoo fetch failed for ${meta.symbol}, retrying once`);
        await new Promise(r => setTimeout(r, this.BASE_RETRY_DELAY));
        try {
          return await this.fetchYahooQuote(meta);
        } catch { /* give up */ }
      } else if (isTimeout) {
        this.logger.debug(`Yahoo timeout for ${meta.symbol} — skipping retry`);
      }
    }
    return null;
  }

  private async fetchYahooQuote(meta: LiveInstrument): Promise<MarketTick | null> {
    try {
      // Use the v8 chart endpoint which does not require session cookies/crumbs
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(meta.yahoo)}?interval=1m&range=1d`;
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Referer': 'https://finance.yahoo.com/',
          'Origin': 'https://finance.yahoo.com',
        },
        timeout: 10_000, // 10s — Yahoo is slow sometimes
      });

      const result = response.data?.chart?.result?.[0];
      const resMeta = result?.meta;
      if (!resMeta || resMeta.regularMarketPrice === undefined) return null;

      const ltp = resMeta.regularMarketPrice ?? 0;
      const prevClose = resMeta.chartPreviousClose ?? resMeta.previousClose ?? ltp;
      const t = resMeta.regularMarketTime ? resMeta.regularMarketTime * 1000 : Date.now();

      return {
        instrumentKey: meta.instrumentKey,
        symbol: meta.symbol,
        name: meta.name,
        ltp,
        ltq: 0,
        ltt: t,
        prevClose,
        totalVolume: resMeta.regularMarketVolume ?? 0,
        bidPrice: ltp,
        bidQty: 0,
        askPrice: ltp,
        askQty: 0,
        marketStatus: 'NORMAL_OPEN',
        isIndex: meta.isIndex,
        source: 'yahoo_chart',
      };
    } catch (err: any) {
      this.logger.debug(`Yahoo chart API error for ${meta.symbol}: ${err.message}`);
      return null;
    }
  }

  private getCachedQuote(yahooSymbol: string): LiveQuote | null {
    const cached = this.quoteCache.get(yahooSymbol);
    if (!cached) return null;

    if (Date.now() - cached.timestamp > this.CACHE_TTL_MS) {
      this.quoteCache.delete(yahooSymbol);
      return null;
    }

    return cached.quote;
  }

  private cacheQuote(yahooSymbol: string, quote: LiveQuote): void {
    this.quoteCache.set(yahooSymbol, {
      quote,
      timestamp: Date.now()
    });

    // Limit cache size to prevent memory growth
    if (this.quoteCache.size > 100) {
      // Remove oldest entries
      const oldestKey = Array.from(this.quoteCache.entries())
        .sort(([,a], [,b]) => a.timestamp - b.timestamp)[0]?.[0];
      if (oldestKey) this.quoteCache.delete(oldestKey);
    }
  }

  private cachedToTick(cached: LiveQuote, meta: LiveInstrument): MarketTick {
    return {
      instrumentKey: meta.instrumentKey,
      symbol: meta.symbol,
      name: meta.name,
      ltp: cached.ltp,
      ltq: 0,
      ltt: cached.updatedAt,
      prevClose: cached.ltp - cached.change, // Approximate previous close
      totalVolume: cached.volume,
      bidPrice: cached.bidPrice,
      bidQty: 0,
      askPrice: cached.askPrice,
      askQty: 0,
      marketStatus: 'NORMAL_OPEN',
      isIndex: meta.isIndex,
      source: 'yahoo_cached',
    };
  }

  private async resolveMeta(instrumentKey: string): Promise<LiveInstrument | null> {
    if (this.metaByKey.has(instrumentKey)) return this.metaByKey.get(instrumentKey)!;

    // Index mappings
    if (instrumentKey === 'NSE_INDEX|Nifty 50' || instrumentKey === 'NIFTY 50') {
      const m: LiveInstrument = { instrumentKey: 'NSE_INDEX|Nifty 50', symbol: 'NIFTY 50', name: 'Nifty 50', yahoo: '^NSEI', isIndex: true };
      this.metaByKey.set(instrumentKey, m);
      return m;
    }
    if (instrumentKey === 'NSE_INDEX|Nifty Bank' || instrumentKey === 'BANK NIFTY') {
      const m: LiveInstrument = { instrumentKey: 'NSE_INDEX|Nifty Bank', symbol: 'BANK NIFTY', name: 'Nifty Bank', yahoo: '^NSEBANK', isIndex: true };
      this.metaByKey.set(instrumentKey, m);
      return m;
    }
    if (instrumentKey === 'NSE_INDEX|Nifty IT' || instrumentKey === 'NIFTY IT') {
      const m: LiveInstrument = { instrumentKey: 'NSE_INDEX|Nifty IT', symbol: 'NIFTY IT', name: 'Nifty IT', yahoo: '^CNXIT', isIndex: true };
      this.metaByKey.set(instrumentKey, m);
      return m;
    }
    if (instrumentKey === 'NSE_INDEX|India VIX' || instrumentKey === 'INDIA VIX') {
      const m: LiveInstrument = { instrumentKey: 'NSE_INDEX|India VIX', symbol: 'INDIA VIX', name: 'India VIX', yahoo: '^INDIAVIX', isIndex: true };
      this.metaByKey.set(instrumentKey, m);
      return m;
    }

    // Check DB for instrumentKey or tradingSymbol
    try {
      const inst =
        (await this.prisma.instrument.findUnique({ where: { instrumentKey } })) ||
        (await this.prisma.instrument.findFirst({
          where: { tradingSymbol: instrumentKey.toUpperCase(), active: true },
        }));

      if (inst) {
        const yahooSuffix = inst.exchange === 'BSE' ? 'BO' : 'NS';
        const m: LiveInstrument = {
          instrumentKey: inst.instrumentKey,
          symbol: inst.tradingSymbol,
          name: inst.companyName || inst.shortName || inst.tradingSymbol,
          yahoo: `${inst.tradingSymbol}.${yahooSuffix}`,
          isIndex: false,
        };
        this.metaByKey.set(instrumentKey, m);
        this.metaByKey.set(inst.instrumentKey, m);
        this.metaByKey.set(inst.tradingSymbol, m);
        this.metaByYahoo.set(m.yahoo, m);
        return m;
      }
    } catch {
      // DB lookup error fallback
    }

    // Direct symbol fallback (e.g. RELIANCE -> RELIANCE.NS)
    const cleanSym = instrumentKey.includes('|') ? instrumentKey.split('|')[1] : instrumentKey;
    if (/^[A-Z0-9&_-]+$/.test(cleanSym) && !cleanSym.startsWith('INE')) {
      const m: LiveInstrument = {
        instrumentKey,
        symbol: cleanSym,
        name: cleanSym,
        yahoo: `${cleanSym}.NS`,
        isIndex: false,
      };
      this.metaByKey.set(instrumentKey, m);
      this.metaByYahoo.set(m.yahoo, m);
      return m;
    }

    return null;
  }

  registerInstrument(item: LiveInstrument) {
    this.metaByKey.set(item.instrumentKey, item);
    this.metaByYahoo.set(item.yahoo, item);
  }

  async getQuote(instrumentKey: string): Promise<LiveQuote | null> {
    const mem =
      this.latestQuotes.get(instrumentKey) ||
      this.latestQuotes.get(`symbol:${instrumentKey.toUpperCase()}`) ||
      this.latestQuotes.get(instrumentKey.toUpperCase());
    if (mem && mem.ltp > 0) return mem;

    try {
      const cached = await this.redis.get(`quote:${instrumentKey}`);
      if (cached) return JSON.parse(cached);
    } catch {
      // Redis is optional
    }

    // On-demand fetch if not cached yet
    const meta = await this.resolveMeta(instrumentKey);
    if (meta) {
      const tick = await this.fetchSingleLiveQuoteWithRetry(meta);
      if (tick) {
        this.processTick(tick);
        return this.toLiveQuote(tick);
      }
    }

    return null;
  }

  async getQuotes(keys: string[]): Promise<LiveQuote[]> {
    if (keys.length === 0) {
      return [...this.latestQuotes.values()].filter(
        (q, i, arr) => arr.findIndex((x) => x.instrumentKey === q.instrumentKey) === i,
      );
    }

    // Resolve any missing keys and fetch in parallel
    await this.fetchLiveBatch(keys);

    const quotes: LiveQuote[] = [];
    const seen = new Set<string>();

    for (const key of keys) {
      const quote = await this.getQuote(key);
      if (quote && !seen.has(quote.instrumentKey)) {
        seen.add(quote.instrumentKey);
        quotes.push(quote);
      }
    }
    return quotes;
  }

  async getLiveSnapshot() {
    const keys = DEFAULT_LIVE_INSTRUMENTS.map((i) => i.instrumentKey);
    await this.fetchLiveBatch(keys);
    const quotes = await this.getQuotes(keys);
    const byKey = new Map(quotes.map((q) => [q.instrumentKey, q]));

    const indices = DEFAULT_LIVE_INSTRUMENTS.filter((i) => i.isIndex).map((i) => {
      const q = byKey.get(i.instrumentKey);
      return q && q.ltp > 0 ? q : this.placeholderQuote(i);
    });

    const watchlist = DEFAULT_LIVE_INSTRUMENTS.filter((i) => !i.isIndex).map((i) => {
      const q = byKey.get(i.instrumentKey);
      return q && q.ltp > 0 ? q : this.placeholderQuote(i);
    });

    return {
      status: this.getStatus(),
      marketOpen: this.isIndianMarketHours(),
      indices,
      watchlist,
    };
  }

  private placeholderQuote(item: LiveInstrument): LiveQuote {
    return {
      instrumentKey: item.instrumentKey,
      symbol: item.symbol,
      name: item.name,
      ltp: 0,
      change: 0,
      changePct: 0,
      volume: 0,
      bidPrice: 0,
      askPrice: 0,
      isIndex: !!item.isIndex,
      source: 'pending',
      updatedAt: 0,
    };
  }

  isIndianMarketHours() {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = now.getDay();
    if (day === 0 || day === 6) return false;
    const minutes = now.getHours() * 60 + now.getMinutes();
    return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
  }

  getStatus() {
    return {
      connected: this.feedMode === 'upstox' || this.feedMode === 'yahoo' || this.feedMode === 'yahoo_quote' || this.feedMode === 'yahoo_chart' || this.feedMode === 'yahoo_cached' || this.ws?.readyState === WebSocket.OPEN,
      source: this.feedMode,
      isDegraded: this.isDegraded,
      subscribedCount: this.subscribedKeys.size,
      reconnectAttempts: this.reconnectAttempts,
      marketOpen: this.isIndianMarketHours(),
      cacheSize: this.quoteCache.size,
    };
  }

  isConnected() {
    return this.feedMode === 'upstox' || this.feedMode === 'yahoo' || this.feedMode === 'yahoo_quote' || this.feedMode === 'yahoo_chart' || this.feedMode === 'yahoo_cached' || this.ws?.readyState === WebSocket.OPEN;
  }

  isFeedDegraded() {
    return this.isDegraded;
  }
}