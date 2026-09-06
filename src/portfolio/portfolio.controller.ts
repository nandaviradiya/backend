import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { PortfolioService } from './portfolio.service';

@ApiTags('portfolio')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('portfolio')
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Get unified portfolio overview (paper and real broker status)' })
  getOverview(@Req() req: any) {
    return this.portfolioService.getOverview(req.user.id);
  }

  @Get('trades')
  @ApiOperation({ summary: 'Get trade history and execution logs' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getTradeHistory(@Req() req: any, @Query('limit') limit?: number) {
    return this.portfolioService.getTradeHistory(req.user.id, limit ? Number(limit) : 50);
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Get performance metrics and equity curve history' })
  getMetrics(@Req() req: any) {
    return this.portfolioService.getPerformanceMetrics(req.user.id);
  }
}
