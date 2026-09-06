import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface ScoreFeaturesDto {
  rvol: number;
  breakDistanceAtr: number;
  bodyPercent: number;
  vwapDistance: number;
  ema20Slope: number;
  ema50Slope: number;
  levelTouches: number;
  levelAgeDays: number;
  gapPercent: number;
  marketTrend: number;
  timeOfDayMinutes: number;
}

export interface ExplainRequestDto {
  symbol: string;
  type: 'BREAKOUT' | 'BREAKDOWN';
  price: number;
  level: number;
  rvol: number;
  score: number;
  vwapDistance: number;
  marketTrend: string;
  sectorStrength: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly mlServiceUrl: string;

  constructor(private readonly config: ConfigService) {
    this.mlServiceUrl = this.config.get<string>('ML_SERVICE_URL', 'http://localhost:8000');
  }

  async scoreSignal(features: ScoreFeaturesDto): Promise<{ score: number; followThroughProb: number; modelVersion: string }> {
    try {
      const response = await axios.post(`${this.mlServiceUrl}/inference/score`, features, {
        timeout: 2500,
      });
      return response.data;
    } catch (err: any) {
      this.logger.warn(`ML Service unavailable (${err.message}). Using rule-based fallback score.`);
      return this.fallbackScore(features);
    }
  }

  async explainSignal(data: ExplainRequestDto): Promise<{ explanation: string; keyStrengths: string[]; keyRisks: string[] }> {
    try {
      const response = await axios.post(`${this.mlServiceUrl}/inference/explain`, data, {
        timeout: 4000,
      });
      return response.data;
    } catch (err: any) {
      this.logger.warn(`ML explanation service unavailable (${err.message}). Using fallback template.`);
      return this.fallbackExplain(data);
    }
  }

  private fallbackScore(f: ScoreFeaturesDto) {
    // Robust heuristic scoring model out of 100
    let score = 50;
    if (f.rvol >= 2.0) score += 15;
    else if (f.rvol >= 1.5) score += 10;

    if (f.bodyPercent >= 0.7) score += 12;
    else if (f.bodyPercent >= 0.5) score += 6;

    if (f.breakDistanceAtr >= 0.2 && f.breakDistanceAtr <= 0.8) score += 10;
    if (f.ema20Slope > 0 && f.ema50Slope > 0) score += 8;
    if (f.levelTouches >= 3) score += 5;

    score = Math.min(Math.max(score, 10), 98);
    const followThroughProb = parseFloat((score / 100).toFixed(2));

    return {
      score,
      followThroughProb,
      modelVersion: 'heuristic-rule-v1',
    };
  }

  private fallbackExplain(data: ExplainRequestDto) {
    const isBreakout = data.type === 'BREAKOUT';
    const action = isBreakout ? 'surpassed resistance' : 'breached support';
    const explanation = `${data.symbol} has cleanly ${action} at ₹${data.level.toFixed(
      2,
    )} backed by strong institutional volume (${data.rvol.toFixed(
      1,
    )}× RVOL). The setup exhibits a high confidence score of ${data.score}/100 with favorable alignment against VWAP.`;

    const keyStrengths = [
      `Significant volume surge: ${data.rvol.toFixed(1)}× historical median`,
      `Clean price action breaking key level ₹${data.level.toFixed(2)}`,
      `Favorable risk-reward with clear invalidation zone`,
    ];

    const keyRisks = [
      `Watch for potential fakeout / retest rejection near level`,
      `Intraday market volatility swings`,
    ];

    return {
      explanation,
      keyStrengths,
      keyRisks,
    };
  }
}
