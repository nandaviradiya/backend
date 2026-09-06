import { Controller, Get, Post, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiQuery, ApiOperation } from '@nestjs/swagger';
import { InstrumentsService } from './instruments.service';

@ApiTags('market')
@Controller()
export class InstrumentsController {
  constructor(private readonly instrumentsService: InstrumentsService) {}

  /**
   * Search / Paginated stocks API for Android client
   * GET /api/v1/market/stocks or GET /api/v1/market/search
   */
  @Get(['market/stocks', 'market/search', 'stocks'])
  @ApiOperation({ summary: 'Search and paginate stocks with prefix match prioritization' })
  @ApiQuery({ name: 'q', required: false, description: 'Symbol or company name search query' })
  @ApiQuery({ name: 'exchange', required: false, enum: ['NSE', 'BSE'] })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (starts at 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default 50)' })
  searchStocks(
    @Query('q') q?: string,
    @Query('exchange') exchange?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.instrumentsService.search(q, exchange, page, limit);
  }

  @Get('market/instruments')
  @ApiOperation({ summary: 'Get all active instruments' })
  @ApiQuery({ name: 'exchange', required: false })
  getAll(@Query('exchange') exchange?: string) {
    return this.instrumentsService.getAll(exchange);
  }

  @Get('market/instruments/:instrumentKey')
  @ApiOperation({ summary: 'Get instrument by key' })
  getOne(@Param('instrumentKey') instrumentKey: string) {
    return this.instrumentsService.getByKey(decodeURIComponent(instrumentKey));
  }

  @Post('market/sync-instruments')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Trigger manual sync of Upstox NSE/BSE instrument masters' })
  syncNow() {
    return this.instrumentsService.syncInstruments();
  }
}
