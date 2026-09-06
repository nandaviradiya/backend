import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import axios from 'axios';

/** AngelOne ScripMaster instrument record */
export interface AngelOneInstrument {
  token: string;
  symbol: string;
  name: string;
  expiry: string;
  strike: string;
  lotsize: string;
  instrumenttype: string;
  exch_seg: string;   // NSE, BSE, NFO, MCX …
  tick_size: string;
}

/** Normalised instrument for internal use */
export interface InstrumentRecord {
  instrument_key: string;
  isin: string | null;
  exchange: string;
  segment: string;
  instrument_type: string;
  trading_symbol: string;
  name: string | null;
  short_name: string | null;
  security_type: string | null;
  tick_size: number | null;
  lot_size: number;
}

export interface StockSearchItem {
  instrument_key: string;
  isin: string | null;
  trading_symbol: string;
  company_name: string | null;
  short_name: string | null;
  exchange: string;
}

export interface PaginatedStocksResponse {
  page: number;
  limit: number;
  total?: number;
  items: StockSearchItem[];
}

const ANGELONE_MASTER_URL =
  'https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json';

const NSE_EQUITY_CSV_URL =
  'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv';

@Injectable()
export class InstrumentsService implements OnModuleInit {
  private readonly logger = new Logger(InstrumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    // Download instruments on startup if table is empty — run async so server starts immediately
    this.prisma.instrument.count()
      .then(count => {
        if (count === 0) {
          this.logger.log('No instruments found — starting async sync from NSE equity list');
          this.syncInstruments().catch(err =>
            this.logger.warn(`Instrument sync failed: ${err.message}`)
          );
        } else {
          this.logger.log(`Instruments DB ready: ${count} records`);
        }
      })
      .catch(err => this.logger.warn(`Could not verify instrument count: ${err.message}`));
  }

  /**
   * Runs every trading day (Mon-Fri) at 7:00 AM IST (Asia/Kolkata).
   * Downloads the complete NSE & BSE master files, filters ordinary equities,
   * updates suspended status, and deactivates delisted securities.
   */
  @Cron('0 7 * * 1-5', { name: 'daily-instrument-sync', timeZone: 'Asia/Kolkata' })
  async scheduledSync() {
    this.logger.log('Cron triggered: Starting daily morning instrument master sync at 07:00 AM IST');
    await this.syncInstruments();
  }

  /**
   * Downloads the AngelOne OpenAPI ScripMaster JSON file.
   * Falls back to NSE official equity CSV if AngelOne URL is unavailable.
   */
  private async downloadAngelOneMaster(): Promise<AngelOneInstrument[]> {
    // Try AngelOne first
    try {
      this.logger.log(`Trying AngelOne ScripMaster...`);
      const response = await axios.get<AngelOneInstrument[]>(ANGELONE_MASTER_URL, {
        timeout: 20_000,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        maxContentLength: 200 * 1024 * 1024,
      });
      if (Array.isArray(response.data) && response.data.length > 0) {
        this.logger.log(`AngelOne master: ${response.data.length} records`);
        return response.data;
      }
    } catch (e: any) {
      this.logger.warn(`AngelOne master unavailable (${e.message}), falling back to NSE CSV`);
    }

    // Fallback: NSE official equity list
    return this.downloadNseEquityList();
  }

  /**
   * Downloads NSE's official EQUITY_L.csv and converts to AngelOneInstrument format.
   */
  private async downloadNseEquityList(): Promise<AngelOneInstrument[]> {
    this.logger.log('Downloading NSE official equity list CSV...');
    const response = await axios.get<string>(NSE_EQUITY_CSV_URL, {
      timeout: 30_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'text/csv,text/plain',
        'Referer': 'https://www.nseindia.com/',
      },
      responseType: 'text',
      maxContentLength: 50 * 1024 * 1024,
    });

    const lines = response.data.split('\n').filter(l => l.trim());
    if (lines.length < 2) throw new Error('NSE CSV empty or malformed');

    // CSV columns: SYMBOL,NAME OF COMPANY,SERIES,DATE OF LISTING,PAID UP VALUE,MARKET LOT,ISIN NUMBER,FACE VALUE
    const instruments: AngelOneInstrument[] = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 7) continue;
      const symbol = parts[0]?.trim();
      const name   = parts[1]?.trim();
      const series = parts[2]?.trim();   // EQ, BE, etc.
      const lot    = parts[5]?.trim() || '1';
      if (!symbol || !name) continue;
      instruments.push({
        token: symbol,          // Use symbol as token for NSE fallback
        symbol,
        name,
        expiry: '',
        strike: '0',
        lotsize: lot,
        instrumenttype: series || 'EQ',
        exch_seg: 'NSE',
        tick_size: '0.05',
      });
    }
    this.logger.log(`NSE equity CSV: ${instruments.length} stocks loaded`);
    return instruments;
  }

  /**
   * Converts AngelOne instrument record to internal normalised format.
   * instrument_key = exch_seg|token (e.g. NSE|3045)
   */
  private normaliseAngelOne(item: AngelOneInstrument): InstrumentRecord {
    const exchange = item.exch_seg.includes('NSE') ? 'NSE' : 'BSE';
    return {
      instrument_key: `${item.exch_seg}|${item.token}`,
      isin: null,
      exchange,
      segment: item.exch_seg,
      instrument_type: item.instrumenttype || 'EQ',
      trading_symbol: item.symbol,
      name: item.name || null,
      short_name: item.symbol || null,
      security_type: null,
      tick_size: item.tick_size ? parseFloat(item.tick_size) : null,
      lot_size: item.lotsize ? parseInt(item.lotsize, 10) : 1,
    };
  }

  /**
   * Filter: only plain equity stocks from NSE or BSE cash segments.
   */
  private isOrdinaryStock(item: AngelOneInstrument): boolean {
    if (!item.token || !item.symbol) return false;
    const seg = item.exch_seg;
    const type = (item.instrumenttype || '').toUpperCase();
    if (seg === 'NSE' && (type === 'EQ' || type === 'BE' || type === '')) return true;
    if (seg === 'BSE' && (type === 'EQ' || type === 'A' || type === 'B' || type === '')) return true;
    return false;
  }

  /**
   * Synchronizes NSE/BSE stocks from AngelOne master file with the database.
   */
  async syncInstruments(): Promise<{ total: number; nseCount: number; bseCount: number; suspendedCount: number }> {
    const allInstruments = await this.downloadAngelOneMaster();

    const equityStocks = allInstruments.filter((item) => this.isOrdinaryStock(item));
    const nseStocks = equityStocks.filter((i) => i.exch_seg === 'NSE');
    const bseStocks = equityStocks.filter((i) => i.exch_seg === 'BSE');
    const stocks = equityStocks.map((item) => this.normaliseAngelOne(item));

    this.logger.log(
      `AngelOne master downloaded: ${allInstruments.length} total instruments. ` +
      `Filtered to ${stocks.length} equity stocks (${nseStocks.length} NSE, ${bseStocks.length} BSE).`,
    );

    if (stocks.length === 0) {
      throw new Error('Validation failed: 0 stocks parsed from AngelOne master. Aborting sync.');
    }

    // Process chunked upserts using raw SQL for high performance
    const CHUNK_SIZE = 1000;
    for (let i = 0; i < stocks.length; i += CHUNK_SIZE) {
      const chunk = stocks.slice(i, i + CHUNK_SIZE);
      const values: any[] = [];
      const placeholders: string[] = [];

      chunk.forEach((stock, idx) => {
        const offset = idx * 12;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, TRUE, CURRENT_DATE, NOW())`,
        );
        values.push(
          stock.instrument_key,
          stock.isin ?? null,
          stock.exchange,
          stock.segment,
          stock.instrument_type,
          stock.trading_symbol,
          stock.name ?? null,
          stock.short_name ?? null,
          stock.security_type ?? null,
          stock.tick_size ? Number(stock.tick_size) : null,
          stock.lot_size ? Number(stock.lot_size) : 1,
          false, // AngelOne master doesn't flag suspended stocks separately
        );
      });

      const queryText = `
        INSERT INTO instruments (
          instrument_key,
          isin,
          exchange,
          segment,
          instrument_type,
          trading_symbol,
          company_name,
          short_name,
          security_type,
          tick_size,
          lot_size,
          suspended,
          active,
          last_seen_on,
          updated_at
        ) VALUES ${placeholders.join(',\n')}
        ON CONFLICT (instrument_key) DO UPDATE SET
          isin = EXCLUDED.isin,
          exchange = EXCLUDED.exchange,
          segment = EXCLUDED.segment,
          instrument_type = EXCLUDED.instrument_type,
          trading_symbol = EXCLUDED.trading_symbol,
          company_name = EXCLUDED.company_name,
          short_name = EXCLUDED.short_name,
          security_type = EXCLUDED.security_type,
          tick_size = EXCLUDED.tick_size,
          lot_size = EXCLUDED.lot_size,
          active = TRUE,
          suspended = EXCLUDED.suspended,
          last_seen_on = CURRENT_DATE,
          updated_at = NOW();
      `;

      await this.prisma.$executeRawUnsafe(queryText, ...values);
    }

    // Stocks missing from today's master are retained for historical records but marked inactive
    await this.prisma.$executeRawUnsafe(`
      UPDATE instruments
      SET active = FALSE,
          scanner_enabled = FALSE,
          updated_at = NOW()
      WHERE last_seen_on < CURRENT_DATE;
    `);

    // Reset scanner enabled flags and enable top ~1,500 liquid NSE stocks
    await this.prisma.$executeRawUnsafe(`
      UPDATE instruments SET scanner_enabled = FALSE;
    `);

    await this.prisma.$executeRawUnsafe(`
      UPDATE instruments
      SET scanner_enabled = TRUE,
          updated_at = NOW()
      WHERE instrument_key IN (
        SELECT instrument_key
        FROM instruments
        WHERE active = TRUE AND suspended = FALSE AND segment IN ('NSE_EQ', 'NSE')
        ORDER BY trading_symbol ASC
        LIMIT 1500
      );
    `);

    this.logger.log(`Synchronized ${stocks.length} NSE/BSE equity stocks from AngelOne master. Enabled scanner for top 1500 liquid stocks.`);

    return {
      total: stocks.length,
      nseCount: nseStocks.length,
      bseCount: bseStocks.length,
      suspendedCount: 0,
    };
  }

  /**
   * Search instruments with server-side pagination and prefix match prioritization.
   * Both NSE and BSE instruments are returned (groupable by isin in the mobile UI).
   */
  async search(
    query = '',
    exchange = '',
    page = 1,
    limit = 50,
  ): Promise<PaginatedStocksResponse> {
    const cleanQuery = (query || '').trim();
    const cleanExchange = (exchange || '').trim().toUpperCase();
    const validPage = Math.max(Number(page) || 1, 1);
    const validLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const offset = (validPage - 1) * validLimit;

    const rows = await this.prisma.$queryRawUnsafe<StockSearchItem[]>(
      `
      SELECT
        instrument_key,
        isin,
        trading_symbol,
        company_name,
        short_name,
        exchange
      FROM instruments
      WHERE active = TRUE
        AND suspended = FALSE
        AND ($1 = '' OR exchange = $1)
        AND (
          $2 = ''
          OR trading_symbol ILIKE $2 || '%'
          OR company_name ILIKE '%' || $2 || '%'
          OR isin = $2
        )
      ORDER BY
        CASE WHEN trading_symbol ILIKE $2 || '%' THEN 0 ELSE 1 END,
        trading_symbol ASC
      LIMIT $3 OFFSET $4
      `,
      cleanExchange,
      cleanQuery,
      validLimit,
      offset,
    );

    return {
      page: validPage,
      limit: validLimit,
      items: rows,
    };
  }

  /**
   * Get all scanner-enabled instrument keys (up to ~1,500 liquid stocks) for WebSocket live subscriptions.
   */
  async getScanUniverse(): Promise<string[]> {
    const result = await this.prisma.$queryRaw<Array<{ instrument_key: string }>>`
      SELECT instrument_key
      FROM instruments
      WHERE active = TRUE
        AND suspended = FALSE
        AND scanner_enabled = TRUE
      ORDER BY trading_symbol ASC
    `;
    return result.map((r) => r.instrument_key);
  }

  async getByKey(instrumentKey: string) {
    return this.prisma.instrument.findUnique({
      where: { instrumentKey },
    });
  }

  async getAll(exchange?: string) {
    return this.prisma.instrument.findMany({
      where: {
        active: true,
        suspended: false,
        ...(exchange ? { exchange: exchange.toUpperCase() } : {}),
      },
      orderBy: { tradingSymbol: 'asc' },
    });
  }
}
