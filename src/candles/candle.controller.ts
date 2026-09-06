import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { CandleService } from './candle.service';

type Interval = '1m' | '5m' | '15m' | '1h' | '1d' | '1w';

@ApiTags('market')
@Controller()
export class CandleController {
  constructor(private readonly candleService: CandleService) {}

  @Get(['market/candles/:instrumentKey', 'candles/:instrumentKey'])
  @ApiOperation({ summary: 'Get OHLCV candles for TradingView chart datafeed' })
  @ApiQuery({ name: 'interval', required: false })
  @ApiQuery({ name: 'from', description: 'Unix timestamp (seconds)', required: false })
  @ApiQuery({ name: 'to', description: 'Unix timestamp (seconds)', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getCandles(
    @Param('instrumentKey') instrumentKey: string,
    @Query('interval') interval?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: number,
  ) {
    const selectedInterval = interval || '5m';
    const toDate = to && !isNaN(Number(to)) ? new Date(Number(to) * 1000) : new Date();
    const fromDate = from && !isNaN(Number(from))
      ? new Date(Number(from) * 1000)
      : new Date(toDate.getTime() - 7 * 86400_000);

    return this.candleService.getCandles(
      decodeURIComponent(instrumentKey),
      selectedInterval,
      fromDate,
      toDate,
      limit ? Number(limit) : 500,
    );
  }
}
