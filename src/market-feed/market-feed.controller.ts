import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { MarketFeedService } from './market-feed.service';

@ApiTags('market')
@Controller('market')
export class MarketFeedController {
  constructor(private readonly feedService: MarketFeedService) {}

  @Get('feed/status')
  @ApiOperation({ summary: 'Get market data feed connection status' })
  getStatus() {
    return this.feedService.getStatus();
  }

  @Get('live')
  @ApiOperation({ summary: 'Live indices + default watchlist quotes' })
  getLive() {
    return this.feedService.getLiveSnapshot();
  }

  @Get('quotes')
  @ApiOperation({ summary: 'Get latest quotes for multiple instruments' })
  @ApiQuery({ name: 'keys', required: false, description: 'Comma-separated instrument keys or symbols' })
  async getQuotes(@Query('keys') keys?: string) {
    const list = (keys || '')
      .split(',')
      .map((k) => decodeURIComponent(k.trim()))
      .filter(Boolean);
    return this.feedService.getQuotes(list);
  }

  @Get('quote/:instrumentKey')
  @ApiOperation({ summary: 'Get latest quote for an instrument' })
  async getQuote(@Param('instrumentKey') instrumentKey: string) {
    const key = decodeURIComponent(instrumentKey);
    const cached = await this.feedService.getQuote(key);
    if (!cached) return { error: 'No live data available for this instrument' };
    return cached;
  }
}
