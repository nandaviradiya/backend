import { gunzipSync } from "node:zlib";
import { Pool } from "pg";
import * as dotenv from "dotenv";

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://aitrading:aitrading_secret@localhost:5432/aitrading";
const pool = new Pool({ connectionString: DATABASE_URL });

const NSE_URL = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";
const BSE_URL = "https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz";
const SUSPENDED_URL = "https://assets.upstox.com/market-quote/instruments/exchange/suspended-instrument.json.gz";

export interface UpstoxInstrument {
  instrument_key: string;
  isin?: string;
  exchange: string;
  segment: string;
  instrument_type: string;
  trading_symbol: string;
  name?: string;
  short_name?: string;
  security_type?: string;
  tick_size?: number;
  lot_size?: number;
}

export async function downloadJsonGzip(url: string): Promise<UpstoxInstrument[]> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) from ${url}`);
  }
  const compressed = Buffer.from(await response.arrayBuffer());
  const json = gunzipSync(compressed).toString("utf8");
  return JSON.parse(json);
}

export function isOrdinaryStock(item: UpstoxInstrument): boolean {
  if (!item.instrument_key || !item.trading_symbol) return false;
  if (item.segment === "NSE_EQ" && (item.instrument_type === "EQ" || item.instrument_type === "BE")) return true;
  if (item.segment === "BSE_EQ" && ["A", "B", "X", "XT", "T", "M", "MT", "P", "Z", "E", "EQ", "G"].includes(item.instrument_type)) return true;
  return false;
}

export async function syncInstruments() {
  console.log("Starting Upstox instrument master synchronization...");
  const [nseData, bseData, suspendedData] = await Promise.all([
    downloadJsonGzip(NSE_URL),
    downloadJsonGzip(BSE_URL),
    downloadJsonGzip(SUSPENDED_URL),
  ]);

  const suspendedKeys = new Set(suspendedData.map((item) => item.instrument_key));
  const stocks = [...nseData, ...bseData].filter(isOrdinaryStock);

  console.log(`Downloaded ${nseData.length} NSE, ${bseData.length} BSE, ${suspendedData.length} Suspended entries.`);
  console.log(`Found ${stocks.length} valid ordinary equity stocks.`);

  if (stocks.length === 0) {
    throw new Error("Validation failed: No stocks parsed from Upstox master files. Aborting DB sync.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Chunked upserts for high throughput
    const CHUNK_SIZE = 1000;
    for (let i = 0; i < stocks.length; i += CHUNK_SIZE) {
      const chunk = stocks.slice(i, i + CHUNK_SIZE);
      const values: any[] = [];
      const placeholders: string[] = [];

      chunk.forEach((stock, idx) => {
        const offset = idx * 12;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, TRUE, CURRENT_DATE, NOW())`
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
          suspendedKeys.has(stock.instrument_key)
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
        ) VALUES ${placeholders.join(",\n")}
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

      await client.query(queryText, values);
    }

    // Stocks missing from today's file are retained for historical records,
    // but marked inactive and removed from scanner.
    await client.query(`
      UPDATE instruments
      SET active = FALSE,
          scanner_enabled = FALSE,
          updated_at = NOW()
      WHERE last_seen_on < CURRENT_DATE;
    `);

    // Enable scanner for top liquid ~1500 NSE stocks to respect Upstox 2000 full-mode limit
    await client.query(`
      UPDATE instruments SET scanner_enabled = FALSE;
    `);

    await client.query(`
      UPDATE instruments
      SET scanner_enabled = TRUE,
          updated_at = NOW()
      WHERE instrument_key IN (
        SELECT instrument_key
        FROM instruments
        WHERE active = TRUE AND suspended = FALSE AND segment = 'NSE_EQ'
        ORDER BY trading_symbol ASC
        LIMIT 1500
      );
    `);

    await client.query("COMMIT");
    console.log(`Successfully synchronized ${stocks.length} NSE/BSE stocks into PostgreSQL.`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Failed to synchronize instruments:", error);
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  syncInstruments()
    .catch((err) => {
      console.error("Fatal sync error:", err);
      process.exit(1);
    })
    .finally(() => pool.end());
}
