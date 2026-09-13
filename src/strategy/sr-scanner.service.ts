import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import axios from 'axios';

export interface SrScanResult {
  symbol: string;
  instrumentKey: string;
  companyName: string;
  exchange: string;
  currentPrice: number;
  resistance20d: number;
  support20d: number;
  distToResistancePct: number;
  distToSupportPct: number;
  nearestLevel: 'RESISTANCE' | 'SUPPORT';
  nearestLevelPrice: number;
  distToNearestPct: number;
  signalType: 'POTENTIAL_BREAKOUT' | 'POTENTIAL_BREAKDOWN' | 'BREAKOUT' | 'BREAKDOWN';
  breakoutProbability: number;
  breakdownProbability: number;
  volume20dAvg: number;
  rvol: number;
  trend: 'UP' | 'DOWN' | 'SIDEWAYS';
  atr14: number;
  description: string;
}

export interface BreakoutRadarItem {
  id: string;
  symbol: string;
  instrumentKey: string;
  companyName: string;
  price: number;
  level: number;
  levelType: string;
  type: string;
  distancePercent: number;
  rvol: number;
  score: number;
  detectedAt: Date;
  volume: number;
  description: string;
  // Index & Sector metadata
  indexName?: string;
  sector?: string;
  // Liquidity grab fields
  isLiquidityTrap?: boolean;
  liquidityGrabType?: 'BOTH_SIDES' | 'BUY_SIDE' | 'SELL_SIDE' | 'NONE';
  liquidityGrabScore?: number;
  liquidityDescription?: string;
}

export const STOCK_INDEX_MAP: Record<string, { indexName: string; sector: string }> = {
  // NIFTY BANK / Financials
  HDFCBANK: { indexName: 'NIFTY BANK', sector: 'Private Bank' },
  ICICIBANK: { indexName: 'NIFTY BANK', sector: 'Private Bank' },
  KOTAKBANK: { indexName: 'NIFTY BANK', sector: 'Private Bank' },
  AXISBANK: { indexName: 'NIFTY BANK', sector: 'Private Bank' },
  SBIN: { indexName: 'NIFTY BANK', sector: 'PSU Bank' },
  INDUSINDBK: { indexName: 'NIFTY BANK', sector: 'Private Bank' },
  BANKBARODA: { indexName: 'NIFTY BANK', sector: 'PSU Bank' },
  PNB: { indexName: 'NIFTY BANK', sector: 'PSU Bank' },
  CANBK: { indexName: 'NIFTY BANK', sector: 'PSU Bank' },
  FEDERALBNK: { indexName: 'NIFTY BANK', sector: 'Private Bank' },
  IDFCFIRSTB: { indexName: 'NIFTY BANK', sector: 'Private Bank' },
  BANDHANBNK: { indexName: 'NIFTY BANK', sector: 'Private Bank' },
  AUBANK: { indexName: 'NIFTY BANK', sector: 'Private Bank' },
  BAJFINANCE: { indexName: 'NIFTY FIN SERVICE', sector: 'NBFC' },
  BAJAJFINSV: { indexName: 'NIFTY FIN SERVICE', sector: 'Financial Services' },
  SBILIFE: { indexName: 'NIFTY FIN SERVICE', sector: 'Life Insurance' },
  HDFCLIFE: { indexName: 'NIFTY FIN SERVICE', sector: 'Life Insurance' },
  ICICIPRULI: { indexName: 'NIFTY FIN SERVICE', sector: 'Life Insurance' },
  ICICIGI: { indexName: 'NIFTY FIN SERVICE', sector: 'General Insurance' },
  HDFCAMC: { indexName: 'NIFTY FIN SERVICE', sector: 'Asset Management' },
  PFC: { indexName: 'NIFTY FIN SERVICE', sector: 'NBFC / Power Finance' },
  REC: { indexName: 'NIFTY FIN SERVICE', sector: 'NBFC / Power Finance' },
  JIOFIN: { indexName: 'NIFTY FIN SERVICE', sector: 'Financial Services' },
  MUTHOOTFIN: { indexName: 'NIFTY FIN SERVICE', sector: 'Gold Finance' },
  CHOLAFIN: { indexName: 'NIFTY FIN SERVICE', sector: 'Auto Finance' },
  SHRIRAMFIN: { indexName: 'NIFTY FIN SERVICE', sector: 'NBFC' },

  // NIFTY IT
  TCS: { indexName: 'NIFTY IT', sector: 'IT Services' },
  INFY: { indexName: 'NIFTY IT', sector: 'IT Services' },
  HCLTECH: { indexName: 'NIFTY IT', sector: 'IT Services' },
  WIPRO: { indexName: 'NIFTY IT', sector: 'IT Services' },
  TECHM: { indexName: 'NIFTY IT', sector: 'IT Services' },
  LTIM: { indexName: 'NIFTY IT', sector: 'IT Services' },
  PERSISTENT: { indexName: 'NIFTY IT', sector: 'IT Services' },
  COFORGE: { indexName: 'NIFTY IT', sector: 'IT Services' },
  MPHASIS: { indexName: 'NIFTY IT', sector: 'IT Services' },
  LTTS: { indexName: 'NIFTY IT', sector: 'Engineering R&D' },
  TATAELXSI: { indexName: 'NIFTY IT', sector: 'Design & Technology' },
  OFSS: { indexName: 'NIFTY IT', sector: 'Financial Software' },

  // NIFTY AUTO
  TATAMOTORS: { indexName: 'NIFTY AUTO', sector: 'Automobiles' },
  MARUTI: { indexName: 'NIFTY AUTO', sector: 'Automobiles' },
  'M&M': { indexName: 'NIFTY AUTO', sector: 'Automobiles' },
  HEROMOTOCO: { indexName: 'NIFTY AUTO', sector: 'Two Wheelers' },
  'BAJAJ-AUTO': { indexName: 'NIFTY AUTO', sector: 'Two Wheelers' },
  EICHERMOT: { indexName: 'NIFTY AUTO', sector: 'Automobiles' },
  TVSMOTOR: { indexName: 'NIFTY AUTO', sector: 'Two Wheelers' },
  ASHOKLEY: { indexName: 'NIFTY AUTO', sector: 'Commercial Vehicles' },
  MOTHERSON: { indexName: 'NIFTY AUTO', sector: 'Auto Ancillaries' },
  BHARATFORG: { indexName: 'NIFTY AUTO', sector: 'Forgings / Defence' },
  BALKRISIND: { indexName: 'NIFTY AUTO', sector: 'Tyres' },
  MRF: { indexName: 'NIFTY AUTO', sector: 'Tyres' },
  APOLLOTYRE: { indexName: 'NIFTY AUTO', sector: 'Tyres' },
  BOSCHLTD: { indexName: 'NIFTY AUTO', sector: 'Auto Parts' },

  // NIFTY PHARMA & HEALTHCARE
  SUNPHARMA: { indexName: 'NIFTY PHARMA', sector: 'Pharmaceuticals' },
  CIPLA: { indexName: 'NIFTY PHARMA', sector: 'Pharmaceuticals' },
  DRREDDY: { indexName: 'NIFTY PHARMA', sector: 'Pharmaceuticals' },
  DIVISLAB: { indexName: 'NIFTY PHARMA', sector: 'Active Ingredients' },
  APOLLOHOSP: { indexName: 'NIFTY PHARMA', sector: 'Healthcare & Hospitals' },
  LUPIN: { indexName: 'NIFTY PHARMA', sector: 'Pharmaceuticals' },
  AUROPHARMA: { indexName: 'NIFTY PHARMA', sector: 'Pharmaceuticals' },
  BIOCON: { indexName: 'NIFTY PHARMA', sector: 'Biotechnology' },
  TORNTPHARM: { indexName: 'NIFTY PHARMA', sector: 'Pharmaceuticals' },
  ALKEM: { indexName: 'NIFTY PHARMA', sector: 'Pharmaceuticals' },
  MANKIND: { indexName: 'NIFTY PHARMA', sector: 'Pharmaceuticals' },
  ZYDUSLIFE: { indexName: 'NIFTY PHARMA', sector: 'Pharmaceuticals' },
  MAXHEALTH: { indexName: 'NIFTY PHARMA', sector: 'Hospitals' },
  FORTIS: { indexName: 'NIFTY PHARMA', sector: 'Hospitals' },

  // NIFTY METAL
  TATASTEEL: { indexName: 'NIFTY METAL', sector: 'Iron & Steel' },
  JSWSTEEL: { indexName: 'NIFTY METAL', sector: 'Iron & Steel' },
  HINDALCO: { indexName: 'NIFTY METAL', sector: 'Aluminium & Copper' },
  VEDL: { indexName: 'NIFTY METAL', sector: 'Diversified Metals' },
  JINDALSTEL: { indexName: 'NIFTY METAL', sector: 'Iron & Steel' },
  SAIL: { indexName: 'NIFTY METAL', sector: 'Iron & Steel' },
  NMDC: { indexName: 'NIFTY METAL', sector: 'Mining' },
  COALINDIA: { indexName: 'NIFTY METAL', sector: 'Coal Mining' },
  NATIONALUM: { indexName: 'NIFTY METAL', sector: 'Aluminium' },
  HINDCOPPER: { indexName: 'NIFTY METAL', sector: 'Copper' },

  // NIFTY FMCG
  ITC: { indexName: 'NIFTY FMCG', sector: 'Cigarettes & FMCG' },
  HINDUNILVR: { indexName: 'NIFTY FMCG', sector: 'Personal Care & Foods' },
  NESTLEIND: { indexName: 'NIFTY FMCG', sector: 'Packaged Foods' },
  BRITANNIA: { indexName: 'NIFTY FMCG', sector: 'Bakery & Dairy' },
  TATACONSUM: { indexName: 'NIFTY FMCG', sector: 'Tea & Food Products' },
  DABUR: { indexName: 'NIFTY FMCG', sector: 'Ayurvedic & Healthcare' },
  MARICO: { indexName: 'NIFTY FMCG', sector: 'Edible Oils & Hair Care' },
  COLPAL: { indexName: 'NIFTY FMCG', sector: 'Oral Care' },
  GODREJCP: { indexName: 'NIFTY FMCG', sector: 'Household Products' },
  VBL: { indexName: 'NIFTY FMCG', sector: 'Beverages' },

  // NIFTY ENERGY / OIL & GAS
  RELIANCE: { indexName: 'NIFTY 50', sector: 'Oil & Telecom' },
  ONGC: { indexName: 'NIFTY ENERGY', sector: 'Oil Exploration' },
  NTPC: { indexName: 'NIFTY ENERGY', sector: 'Power Generation' },
  POWERGRID: { indexName: 'NIFTY ENERGY', sector: 'Power Transmission' },
  BPCL: { indexName: 'NIFTY ENERGY', sector: 'Oil Refining' },
  IOC: { indexName: 'NIFTY ENERGY', sector: 'Oil Refining' },
  GAIL: { indexName: 'NIFTY ENERGY', sector: 'Natural Gas' },
  TATAPOWER: { indexName: 'NIFTY ENERGY', sector: 'Renewable Power' },
  ADANIGREEN: { indexName: 'NIFTY ENERGY', sector: 'Renewable Energy' },
  ADANIPOWER: { indexName: 'NIFTY ENERGY', sector: 'Thermal Power' },
  PETRONET: { indexName: 'NIFTY ENERGY', sector: 'LNG Import' },
  OIL: { indexName: 'NIFTY ENERGY', sector: 'Oil & Gas' },
  JSWENERGY: { indexName: 'NIFTY ENERGY', sector: 'Power' },
  SUZLON: { indexName: 'NIFTY ENERGY', sector: 'Wind Energy' },

  // NIFTY INFRA & CAPITAL GOODS
  LT: { indexName: 'NIFTY 50', sector: 'Engineering & Construction' },
  ULTRACEMCO: { indexName: 'NIFTY 50', sector: 'Cement' },
  GRASIM: { indexName: 'NIFTY 50', sector: 'Viscose & Chemicals' },
  AMBUJACEM: { indexName: 'NIFTY INFRA', sector: 'Cement' },
  ACC: { indexName: 'NIFTY INFRA', sector: 'Cement' },
  BEL: { indexName: 'NIFTY INFRA', sector: 'Aerospace & Defence' },
  HAL: { indexName: 'NIFTY INFRA', sector: 'Aerospace & Defence' },
  BHEL: { indexName: 'NIFTY INFRA', sector: 'Heavy Electricals' },
  SIEMENS: { indexName: 'NIFTY INFRA', sector: 'Capital Goods' },
  ABB: { indexName: 'NIFTY INFRA', sector: 'Power Equipment' },
  RVNL: { indexName: 'NIFTY INFRA', sector: 'Railways Infrastructure' },
  IRCTC: { indexName: 'NIFTY INFRA', sector: 'Railway Ticketing' },
  ADANIENT: { indexName: 'NIFTY 50', sector: 'Diversified Conglomerate' },
  ADANIPORTS: { indexName: 'NIFTY 50', sector: 'Ports & Logistics' },

  // NIFTY REALTY
  DLF: { indexName: 'NIFTY REALTY', sector: 'Real Estate' },
  GODREJPROP: { indexName: 'NIFTY REALTY', sector: 'Real Estate' },
  OBEROIRLTY: { indexName: 'NIFTY REALTY', sector: 'Real Estate' },
  LODHA: { indexName: 'NIFTY REALTY', sector: 'Real Estate' },

  // CONSUMPTION & CONSUMER DURABLES
  TITAN: { indexName: 'NIFTY 50', sector: 'Jewellery & Watches' },
  TRENT: { indexName: 'NIFTY 50', sector: 'Fashion & Retail' },
  ZOMATO: { indexName: 'NIFTY 50', sector: 'Food Delivery & Tech' },
  ASIANPAINT: { indexName: 'NIFTY 50', sector: 'Paints & Décor' },
  POLYCAB: { indexName: 'NIFTY CONSUMPTION', sector: 'Wires & Cables' },
  HAVELLS: { indexName: 'NIFTY CONSUMPTION', sector: 'Electrical Consumer Goods' },
  VOLTAS: { indexName: 'NIFTY CONSUMPTION', sector: 'Air Conditioners' },
  DIXON: { indexName: 'NIFTY CONSUMPTION', sector: 'Electronics Manufacturing' },
  KALYANKJIL: { indexName: 'NIFTY CONSUMPTION', sector: 'Jewellery' },
  INDHOTEL: { indexName: 'NIFTY CONSUMPTION', sector: 'Hotels & Hospitality' },

  // TELECOM
  BHARTIARTL: { indexName: 'NIFTY 50', sector: 'Telecom Services' },
  INDUSTOWER: { indexName: 'NIFTY INFRA', sector: 'Telecom Towers' },
};

export function getStockIndexMeta(symbol: string): { indexName: string; sector: string } {
  const cleanSym = symbol.toUpperCase().replace('.NS', '').replace('.BO', '');
  if (STOCK_INDEX_MAP[cleanSym]) {
    return STOCK_INDEX_MAP[cleanSym];
  }
  return { indexName: 'NIFTY 500', sector: 'Equities' };
}

const PRIORITY_SYMBOLS = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN', 'BHARTIARTL',
  'ITC', 'KOTAKBANK', 'LT', 'AXISBANK', 'HINDUNILVR', 'BAJFINANCE', 'MARUTI',
  'TITAN', 'TATASTEEL', 'TATAPOWER', 'SUNPHARMA', 'NTPC',
  'ONGC', 'POWERGRID', 'COALINDIA', 'ADANIENT', 'ADANIPORTS', 'JSWSTEEL',
  'TECHM', 'WIPRO', 'HCLTECH', 'ULTRACEMCO', 'ASIANPAINT', 'BPCL', 'GRASIM',
  'CIPLA', 'HEROMOTOCO', 'DRREDDY', 'EICHERMOT', 'DIVISLAB', 'APOLLOHOSP',
  'BRITANNIA', 'HINDALCO', 'TATACONSUM', 'SBILIFE', 'HDFCLIFE', 'BAJAJFINSV',
  'NESTLEIND', 'INDUSINDBK', 'BEL', 'HAL', 'VEDL', 'BHEL', 'DLF', 'TRENT',
  'ZOMATO', 'JIOFIN', 'IRCTC', 'REC', 'PFC', 'RVNL', 'CANBK', 'PNB', 'BANKBARODA',
  'IOC', 'GAIL', 'SAIL', 'NMDC', 'IDFCFIRSTB', 'FEDERALBNK', 'INDHOTEL',
  'MOTHERSON', 'ASHOKLEY', 'TVSMOTOR', 'PERSISTENT', 'COFORGE',
  'LTIM', 'MPHASIS', 'POLYCAB', 'HAVELLS', 'VOLTAS', 'DIXON', 'KALYANKJIL'
];

@Injectable()
export class SrScannerService {
  private readonly logger = new Logger(SrScannerService.name);

  private cache: BreakoutRadarItem[] = [];
  private cacheTime = 0;
  private readonly CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes cache
  private isScanning = false;

  constructor(private readonly prisma: PrismaService) {}

  async getBreakoutRadarItems(limit = 100): Promise<BreakoutRadarItem[]> {
    if (this.cache.length > 0 && Date.now() - this.cacheTime < this.CACHE_TTL_MS) {
      return this.cache.slice(0, limit);
    }

    // Trigger scan
    await this.scanUniverse();

    if (this.cache.length === 0) {
      // Return safe fallback if network was completely unavailable
      return this.getFallbackSeedRadar();
    }

    return this.cache.slice(0, limit);
  }

  /**
   * Returns only stocks where a confirmed liquidity grab (stop-hunt sweep) was
   * detected on at least one side of a key S/R level, sorted by liquidity grab
   * score descending. Only items with score >= 70 are returned for >70% accuracy.
   */
  async getLiquidityTrapItems(limit = 50): Promise<BreakoutRadarItem[]> {
    // Ensure cache is fresh
    if (this.cache.length === 0 || Date.now() - this.cacheTime >= this.CACHE_TTL_MS) {
      await this.scanUniverse();
    }

    const source = this.cache.length > 0 ? this.cache : this.getFallbackSeedRadar();

    return source
      .filter(item => item.isLiquidityTrap === true && (item.liquidityGrabScore ?? 0) >= 70)
      .sort((a, b) => (b.liquidityGrabScore ?? 0) - (a.liquidityGrabScore ?? 0))
      .slice(0, limit);
  }

  async scanUniverse(): Promise<void> {
    if (this.isScanning) return;
    this.isScanning = true;

    try {
      this.logger.log('SR Scanner: Scanning market for all stocks near S/R...');

      // 1. Fetch DB instruments
      const dbInstruments = await this.prisma.instrument.findMany({
        where: {
          exchange: 'NSE',
          active: true,
          suspended: false,
        },
        select: {
          instrumentKey: true,
          tradingSymbol: true,
          companyName: true,
          shortName: true,
          exchange: true,
        },
        take: 300,
        orderBy: { tradingSymbol: 'asc' },
      });

      // Index DB instruments by symbol
      const instMap = new Map<string, typeof dbInstruments[0]>();
      for (const inst of dbInstruments) {
        instMap.set(inst.tradingSymbol.toUpperCase(), inst);
      }

      // 2. Build prioritized symbol list: priority symbols first, then remaining DB instruments
      const prioritySet = new Set(PRIORITY_SYMBOLS);
      const symbolList: { symbol: string; inst?: typeof dbInstruments[0] }[] = [];

      for (const sym of PRIORITY_SYMBOLS) {
        symbolList.push({ symbol: sym, inst: instMap.get(sym) });
      }

      for (const inst of dbInstruments) {
        if (!prioritySet.has(inst.tradingSymbol.toUpperCase())) {
          symbolList.push({ symbol: inst.tradingSymbol, inst });
        }
      }

      // Take up to 120 stocks for the radar
      const targets = symbolList.slice(0, 120);

      const items: BreakoutRadarItem[] = [];
      const batchSize = 12;

      for (let i = 0; i < targets.length; i += batchSize) {
        const batch = targets.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(
          batch.map(item => this.analyzeSymbol(item.symbol, item.inst))
        );

        for (const res of batchResults) {
          if (res.status === 'fulfilled' && res.value) {
            items.push(res.value);
          }
        }
      }

      // Sort: Confirmed breakouts/breakdowns first, then by closest distance to S/R
      items.sort((a, b) => {
        const aConfirmed = a.type === 'BREAKOUT' || a.type === 'BREAKDOWN';
        const bConfirmed = b.type === 'BREAKOUT' || b.type === 'BREAKDOWN';
        if (aConfirmed && !bConfirmed) return -1;
        if (!aConfirmed && bConfirmed) return 1;
        return Math.abs(a.distancePercent) - Math.abs(b.distancePercent);
      });

      if (items.length > 0) {
        this.cache = items;
        this.cacheTime = Date.now();
        this.logger.log(`SR Scanner completed: ${items.length} stocks near S/R with calculated probabilities`);
      }
    } catch (err) {
      this.logger.error('SR Scanner error during scan:', err);
    } finally {
      this.isScanning = false;
    }
  }

  private async analyzeSymbol(
    symbol: string,
    instrument?: {
      instrumentKey: string;
      tradingSymbol: string;
      companyName: string | null;
      shortName: string | null;
    }
  ): Promise<BreakoutRadarItem | null> {
    try {
      const instKey = instrument?.instrumentKey || `NSE_EQ|${symbol}`;
      const companyName = instrument?.companyName || instrument?.shortName || symbol;

      // Fetch 2 months of daily candles
      const candles = await this.fetchYahooCandles(symbol);
      if (!candles || candles.length < 15) return null;

      const closes = candles.map(c => c.close);
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);
      const volumes = candles.map(c => c.volume);

      // 2-3 days swing range (previous 3 sessions lookback excluding current session)
      const priorCandles = candles.length >= 4 ? candles.slice(-4, -1) : candles.slice(0, -1);
      const windowCandles = priorCandles.length >= 2 ? priorCandles : candles.slice(-3);

      const resistance3d = Math.max(...windowCandles.map(c => c.high));
      const support3d = Math.min(...windowCandles.map(c => c.low));
      const currentPrice = closes[closes.length - 1];
      const prevClose = closes.length >= 2 ? closes[closes.length - 2] : currentPrice;

      const volumeAvg = volumes.slice(-15).reduce((a, b) => a + b, 0) / Math.min(15, volumes.length);
      const lastVol = volumes[volumes.length - 1];
      const rvol = volumeAvg > 0 ? Number((lastVol / volumeAvg).toFixed(2)) : 1.2;
      const atr14 = this.calcAtr14(highs, lows, closes);

      // Trend: 20 EMA vs 50 EMA
      const ema20 = this.calcEma(closes, 20);
      const ema50 = closes.length >= 50 ? this.calcEma(closes, 50) : ema20;
      const lastEma20 = ema20[ema20.length - 1];
      const lastEma50 = ema50[ema50.length - 1];
      const trend: 'UP' | 'DOWN' | 'SIDEWAYS' =
        lastEma20 > lastEma50 * 1.008 ? 'UP' :
        lastEma20 < lastEma50 * 0.992 ? 'DOWN' : 'SIDEWAYS';

      // Distance calculations
      const distToRes = ((resistance3d - currentPrice) / resistance3d) * 100; // positive = below resistance
      const distToSup = ((currentPrice - support3d) / support3d) * 100; // positive = above support

      // Technical Factors: RSI 14
      const rsi14 = this.calcRsi14(closes);

      // Price action: Candle wick and body quality
      const lastCandle = candles[candles.length - 1];
      const candleRange = Math.max(0.01, lastCandle.high - lastCandle.low);
      const upperWick = (lastCandle.high - Math.max(lastCandle.open || lastCandle.close, lastCandle.close)) / candleRange;
      const lowerWick = (Math.min(lastCandle.open || lastCandle.close, lastCandle.close) - lastCandle.low) / candleRange;

      // Volatility Contraction Pattern (VCP / Squeeze): tight range before breakout
      const last5Range = Math.max(...candles.slice(-5).map(c => c.high)) - Math.min(...candles.slice(-5).map(c => c.low));
      const isSqueeze = atr14 > 0 && last5Range < (atr14 * 2.8);

      // Level touches (how many times did price test near this level in last 2-3 days)
      const touchesRes = windowCandles.filter(c => Math.abs(c.high - resistance3d) / resistance3d < 0.015).length;
      const touchesSup = windowCandles.filter(c => Math.abs(c.low - support3d) / support3d < 0.015).length;

      let type: 'BREAKOUT' | 'BREAKDOWN' | 'POTENTIAL_BREAKOUT' | 'POTENTIAL_BREAKDOWN';
      let level: number;
      let levelType: 'RESISTANCE' | 'SUPPORT';
      let distancePercent: number;
      let score: number;
      let description: string;

      // Check breakout conditions (2-3 days swing high/low):
      if (currentPrice >= resistance3d * 0.999) {
        // Confirmed Breakout
        type = 'BREAKOUT';
        level = resistance3d;
        levelType = 'RESISTANCE';
        distancePercent = Number((((currentPrice - resistance3d) / resistance3d) * 100).toFixed(2));
        
        let breakoutScore = 84;
        if (rvol >= 2.0) breakoutScore += 7;
        else if (rvol >= 1.5) breakoutScore += 4;
        if (trend === 'UP') breakoutScore += 5;
        if (rsi14 >= 55 && rsi14 <= 74) breakoutScore += 5; // Sweetspot momentum
        else if (rsi14 > 80) breakoutScore -= 8; // Overextended / exhaustion trap
        if (upperWick < 0.25) breakoutScore += 4; // Closed near highs
        else if (upperWick > 0.45) breakoutScore -= 7; // Seller rejection wick
        if (isSqueeze) breakoutScore += 4;
        score = Math.min(99, Math.max(60, Math.round(breakoutScore)));

        description = `Confirmed Breakout above 3D resistance ₹${resistance3d.toFixed(2)} (+${distancePercent}%). RVOL ${rvol}x | RSI ${Math.round(rsi14)}. Probability ${score}%.`;
      } else if (currentPrice <= support3d * 1.001) {
        // Confirmed Breakdown
        type = 'BREAKDOWN';
        level = support3d;
        levelType = 'SUPPORT';
        distancePercent = Number((-((support3d - currentPrice) / support3d) * 100).toFixed(2));
        
        let breakdownScore = 84;
        if (rvol >= 2.0) breakdownScore += 7;
        else if (rvol >= 1.5) breakdownScore += 4;
        if (trend === 'DOWN') breakdownScore += 5;
        if (rsi14 <= 45 && rsi14 >= 25) breakdownScore += 5;
        else if (rsi14 < 20) breakdownScore -= 8; // Oversold bounce risk
        if (lowerWick < 0.25) breakdownScore += 4;
        else if (lowerWick > 0.45) breakdownScore -= 7;
        if (isSqueeze) breakdownScore += 4;
        score = Math.min(99, Math.max(60, Math.round(breakdownScore)));

        description = `Confirmed Breakdown below 3D support ₹${support3d.toFixed(2)} (${distancePercent}%). RVOL ${rvol}x | RSI ${Math.round(rsi14)}. Probability ${score}%.`;
      } else if (distToRes <= distToSup) {
        // Near Resistance (Potential Breakout)
        if (distToRes > 5.0) return null;
        type = 'POTENTIAL_BREAKOUT';
        level = resistance3d;
        levelType = 'RESISTANCE';
        distancePercent = -Number(distToRes.toFixed(2));
        score = this.calcProbabilityScore({
          distPct: distToRes,
          trend,
          targetTrend: 'UP',
          rvol,
          rsi: rsi14,
          upperWick,
          lowerWick,
          isSqueeze,
          touches: touchesRes,
        });
        description = `Testing 3D resistance ₹${resistance3d.toFixed(2)} (${distToRes.toFixed(1)}% away). RVOL ${rvol}x | RSI ${Math.round(rsi14)}. Probability ${score}%.`;
      } else {
        // Near Support (Potential Breakdown)
        if (distToSup > 5.0) return null;
        type = 'POTENTIAL_BREAKDOWN';
        level = support3d;
        levelType = 'SUPPORT';
        distancePercent = Number(distToSup.toFixed(2));
        score = this.calcProbabilityScore({
          distPct: distToSup,
          trend,
          targetTrend: 'DOWN',
          rvol,
          rsi: rsi14,
          upperWick,
          lowerWick,
          isSqueeze,
          touches: touchesSup,
        });
        description = `Testing 3D support ₹${support3d.toFixed(2)} (${distToSup.toFixed(1)}% away). RVOL ${rvol}x | RSI ${Math.round(rsi14)}. Probability ${score}%.`;
      }

      // ── Liquidity Grab / Stop-Hunt Detection ──────────────────
      const liquidityResult = this.calcLiquidityGrab({
        candles: candles.slice(-15),  // last 15 sessions
        resistance: resistance3d,
        support: support3d,
        atr14,
        volumeAvg,
      });

      const indexMeta = getStockIndexMeta(symbol);

      return {
        id: `radar-${symbol}-${Math.round(currentPrice)}`,
        symbol,
        instrumentKey: instKey,
        companyName,
        price: Number(currentPrice.toFixed(2)),
        level: Number(level.toFixed(2)),
        levelType,
        type,
        distancePercent,
        rvol,
        score,
        detectedAt: new Date(),
        volume: Math.round(lastVol || volumeAvg),
        description,
        indexName: indexMeta.indexName,
        sector: indexMeta.sector,
        isLiquidityTrap: liquidityResult.isLiquidityTrap,
        liquidityGrabType: liquidityResult.grabType,
        liquidityGrabScore: liquidityResult.score,
        liquidityDescription: liquidityResult.description,
      };
    } catch {
      return null;
    }
  }

  /**
   * Detects liquidity grabs (SMC stop-hunts) on both sides of a key S/R level.
   * A liquidity grab = price wick sweeps beyond a level then CLOSES back inside.
   * When both buy-side AND sell-side grabs are detected (both-sides trap), it
   * indicates institutional accumulation/distribution and has high directional accuracy.
   */
  private calcLiquidityGrab(params: {
    candles: { high: number; low: number; close: number; volume: number; open?: number }[];
    resistance: number;
    support: number;
    atr14: number;
    volumeAvg: number;
  }): { isLiquidityTrap: boolean; grabType: 'BOTH_SIDES' | 'BUY_SIDE' | 'SELL_SIDE' | 'NONE'; score: number; description: string } {
    const { candles, resistance, support, atr14, volumeAvg } = params;
    if (candles.length < 5 || atr14 <= 0) {
      return { isLiquidityTrap: false, grabType: 'NONE', score: 0, description: '' };
    }

    const minSweepDepth = atr14 * 0.25; // Minimum wick depth beyond level to count as a sweep

    let buySideSweepDepth = 0;   // wick above resistance then close below
    let sellSideSweepDepth = 0;  // wick below support then close above
    let buySideVolume = 0;
    let sellSideVolume = 0;
    let sweepCandleCount = 0;

    // Analyze each candle for sweeps (exclude the very last candle which is current)
    for (let i = 0; i < candles.length - 1; i++) {
      const c = candles[i];
      const candleOpen = c.open ?? c.close;

      // Buy-side liquidity grab: wick above resistance, close back BELOW resistance
      if (c.high > resistance + minSweepDepth && c.close < resistance) {
        const sweepDepth = c.high - resistance;
        if (sweepDepth > buySideSweepDepth) {
          buySideSweepDepth = sweepDepth;
          buySideVolume = c.volume;
        }
        sweepCandleCount++;
      }

      // Sell-side liquidity grab: wick below support, close back ABOVE support
      if (c.low < support - minSweepDepth && c.close > support) {
        const sweepDepth = support - c.low;
        if (sweepDepth > sellSideSweepDepth) {
          sellSideSweepDepth = sweepDepth;
          sellSideVolume = c.volume;
        }
        sweepCandleCount++;
      }
    }

    const hasBuySide = buySideSweepDepth > 0;
    const hasSellSide = sellSideSweepDepth > 0;

    if (!hasBuySide && !hasSellSide) {
      return { isLiquidityTrap: false, grabType: 'NONE', score: 0, description: '' };
    }

    // ── Score Calculation ──────────────────────────────────────────
    let score = 40; // base

    // Sweep depth bonus (deeper sweep = stronger liquidity grab)
    if (hasBuySide) {
      const depthRatio = buySideSweepDepth / atr14;
      score += Math.min(15, Math.round(depthRatio * 20)); // up to +15
    }
    if (hasSellSide) {
      const depthRatio = sellSideSweepDepth / atr14;
      score += Math.min(15, Math.round(depthRatio * 20)); // up to +15
    }

    // Volume on sweep candle (institutional signature)
    const maxSweepVol = Math.max(buySideVolume, sellSideVolume);
    if (volumeAvg > 0) {
      const sweepRvol = maxSweepVol / volumeAvg;
      if (sweepRvol >= 3.0) score += 20;
      else if (sweepRvol >= 2.0) score += 14;
      else if (sweepRvol >= 1.5) score += 8;
      else if (sweepRvol >= 1.2) score += 4;
    }

    // Both-sides multiplier (institutional confirmation)
    if (hasBuySide && hasSellSide) {
      score = Math.round(score * 1.18); // +18% bonus for both-sides trap
    }

    // Multiple sweep candles = more conviction
    if (sweepCandleCount >= 3) score += 8;
    else if (sweepCandleCount === 2) score += 4;

    score = Math.min(99, Math.max(0, score));

    // Determine grab type
    const grabType: 'BOTH_SIDES' | 'BUY_SIDE' | 'SELL_SIDE' | 'NONE' =
      hasBuySide && hasSellSide ? 'BOTH_SIDES' :
      hasBuySide ? 'BUY_SIDE' : 'SELL_SIDE';

    // Only a true "trap" if score ≥ 70
    const isLiquidityTrap = score >= 70;

    // Description
    const parts: string[] = [];
    if (hasBuySide) parts.push(`Buy-side sweep above ₹${resistance.toFixed(2)} (+${(buySideSweepDepth).toFixed(2)} wick)`);
    if (hasSellSide) parts.push(`Sell-side sweep below ₹${support.toFixed(2)} (-${(sellSideSweepDepth).toFixed(2)} wick)`);
    const description = parts.join(' | ') + `. Liquidity score: ${score}%.`;

    return { isLiquidityTrap, grabType, score, description };
  }

  private calcProbabilityScore(params: {
    distPct: number;
    trend: string;
    targetTrend: string;
    rvol: number;
    rsi: number;
    upperWick: number;
    lowerWick: number;
    isSqueeze: boolean;
    touches: number;
  }): number {
    let score = 52; // base probability

    // 1. Proximity factor (closer = higher probability of testing/breaking)
    if (params.distPct < 1.0) score += 22;
    else if (params.distPct < 2.5) score += 16;
    else if (params.distPct < 4.0) score += 10;
    else if (params.distPct < 6.0) score += 5;

    // 2. Trend alignment
    if (params.trend === params.targetTrend) score += 14;
    else if (params.trend === 'SIDEWAYS') score += 6;

    // 3. Volume surge
    if (params.rvol >= 2.5) score += 14;
    else if (params.rvol >= 1.5) score += 9;
    else if (params.rvol >= 1.1) score += 4;

    // 4. RSI momentum factor
    if (params.targetTrend === 'UP') {
      if (params.rsi >= 55 && params.rsi <= 72) score += 7; // Ideal momentum sweetspot
      else if (params.rsi > 78) score -= 8; // Overbought exhaustion risk
      else if (params.rsi < 45) score -= 6; // Weak momentum
    } else {
      if (params.rsi <= 45 && params.rsi >= 28) score += 7;
      else if (params.rsi < 22) score -= 8; // Oversold bounce risk
      else if (params.rsi > 55) score -= 6;
    }

    // 5. Candle rejection wicks (traps vs conviction)
    if (params.targetTrend === 'UP') {
      if (params.upperWick < 0.25) score += 5; // Minimal selling wick
      else if (params.upperWick > 0.45) score -= 8; // Long upper wick rejection
    } else {
      if (params.lowerWick < 0.25) score += 5;
      else if (params.lowerWick > 0.45) score -= 8;
    }

    // 6. Volatility Contraction / Squeeze (energy coiling)
    if (params.isSqueeze) score += 6;

    // 7. Tested level touches (VCP confirmation)
    if (params.touches >= 3) score += 5;
    else if (params.touches === 2) score += 3;

    return Math.min(98, Math.max(55, Math.round(score)));
  }

  private calcRsi14(closes: number[]): number {
    if (closes.length < 15) return 50;
    let gains = 0;
    let losses = 0;
    for (let i = closes.length - 14; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    const avgGain = gains / 14;
    const avgLoss = losses / 14;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  private calcAtr14(highs: number[], lows: number[], closes: number[]): number {
    const n = Math.min(14, highs.length - 1);
    if (n < 1) return 0;
    let sum = 0;
    for (let i = closes.length - n; i < closes.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      );
      sum += tr;
    }
    return sum / n;
  }

  private calcEma(data: number[], period: number): number[] {
    const k = 2 / (period + 1);
    const ema: number[] = [];
    ema[0] = data[0];
    for (let i = 1; i < data.length; i++) {
      ema[i] = data[i] * k + ema[i - 1] * (1 - k);
    }
    return ema;
  }

  private async fetchYahooCandles(symbol: string): Promise<{ high: number; low: number; close: number; volume: number; open?: number }[] | null> {
    try {
      const yahooSymbol = symbol.endsWith('.NS') ? symbol : `${symbol}.NS`;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=2mo`;
      const { data } = await axios.get(url, {
        timeout: 6000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });

      const result = data?.chart?.result?.[0];
      if (!result) return null;

      const timestamps: number[] = result.timestamp ?? [];
      const q = result.indicators?.quote?.[0];
      if (!q || !timestamps.length) return null;

      return timestamps.map((_, i) => ({
        open: q.open[i] ?? q.close[i] ?? 0,
        high: q.high[i] ?? 0,
        low: q.low[i] ?? 0,
        close: q.close[i] ?? 0,
        volume: q.volume[i] ?? 0,
      })).filter(c => c.close > 0);
    } catch {
      return null;
    }
  }


  async getRadarItemsByIndex(indexName?: string, limit = 100): Promise<BreakoutRadarItem[]> {
    const items = await this.getBreakoutRadarItems(limit);
    if (!indexName || indexName.toUpperCase() === 'ALL' || indexName.toUpperCase() === 'ALL RADAR') {
      return items;
    }
    const filterUpper = indexName.toUpperCase();
    return items.filter(
      item =>
        (item.indexName && item.indexName.toUpperCase().includes(filterUpper)) ||
        (item.sector && item.sector.toUpperCase().includes(filterUpper))
    );
  }

  private getFallbackSeedRadar(): BreakoutRadarItem[] {
    return [
      {
        id: 'seed-tata-1',
        symbol: 'TATASTEEL',
        instrumentKey: 'NSE_EQ|TATASTEEL',
        companyName: 'Tata Steel Limited',
        price: 156.80,
        level: 154.20,
        levelType: 'RESISTANCE',
        type: 'BREAKOUT',
        distancePercent: 1.68,
        rvol: 3.2,
        score: 92,
        detectedAt: new Date(),
        volume: 48200000,
        description: 'Broke 3-day resistance at ₹154.20 on 3.2× volume surge. Breakout probability 92%.',
        indexName: 'NIFTY METAL',
        sector: 'Iron & Steel',
      },
      {
        id: 'seed-rel-2',
        symbol: 'RELIANCE',
        instrumentKey: 'NSE_EQ|RELIANCE',
        companyName: 'Reliance Industries Limited',
        price: 1322.00,
        level: 1335.00,
        levelType: 'RESISTANCE',
        type: 'POTENTIAL_BREAKOUT',
        distancePercent: -0.98,
        rvol: 2.1,
        score: 88,
        detectedAt: new Date(),
        volume: 12450000,
        description: 'Approaching 3D resistance at ₹1,335.00 (0.98% away). Breakout probability 88%.',
        indexName: 'NIFTY 50',
        sector: 'Oil & Telecom',
      },
      {
        id: 'seed-infy-3',
        symbol: 'INFY',
        instrumentKey: 'NSE_EQ|INFY',
        companyName: 'Infosys Limited',
        price: 1130.00,
        level: 1120.00,
        levelType: 'SUPPORT',
        type: 'POTENTIAL_BREAKDOWN',
        distancePercent: 0.89,
        rvol: 1.9,
        score: 82,
        detectedAt: new Date(),
        volume: 8700000,
        description: '0.89% above 3D support ₹1,120.00 with elevated volume. Breakdown probability 82%.',
        indexName: 'NIFTY IT',
        sector: 'IT Services',
      },
    ];
  }
}
