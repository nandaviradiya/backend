import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { SignalType, SignalState } from '@prisma/client';
import { StrategyService } from './strategy.service';
import { SrScannerService } from './sr-scanner.service';

@ApiTags('scanner')
@Controller('scanner')
export class StrategyController {
  constructor(
    private readonly strategyService: StrategyService,
    private readonly srScannerService: SrScannerService,
  ) {}

  @Get('radar')
  @ApiOperation({ summary: 'Get stocks nearest to Support/Resistance on high volume (Breakout Radar)' })
  getRadar() {
    return this.strategyService.getBreakoutRadar();
  }

  @Get('radar/all')
  @ApiOperation({ summary: 'Scan all stocks for S/R proximity & breakout/breakdown probability' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getRadarAll(@Query('limit') limit?: number) {
    return this.srScannerService.getBreakoutRadarItems(limit ? Number(limit) : 100);
  }

  @Get('signals')
  @ApiOperation({ summary: 'Get scanner signals for today' })
  @ApiQuery({ name: 'type', required: false, enum: SignalType })
  @ApiQuery({ name: 'state', required: false, enum: SignalState })
  @ApiQuery({ name: 'minScore', required: false, type: Number })
  @ApiQuery({ name: 'minRvol', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getSignals(
    @Query('type') type?: SignalType,
    @Query('state') state?: SignalState,
    @Query('minScore') minScore?: number,
    @Query('minRvol') minRvol?: number,
    @Query('limit') limit?: number,
  ) {
    return this.strategyService.getSignals({ type, state, minScore, minRvol, limit });
  }

  @Get('signals/:id')
  @ApiOperation({ summary: 'Get a single signal with full details' })
  getSignal(@Param('id') id: string) {
    return this.strategyService.getSignalById(id);
  }

  @Get('status')
  @ApiOperation({ summary: 'Get scanner health status' })
  getStatus() {
    return {
      degraded: this.strategyService.isScannerDegraded(),
      message: this.strategyService.isScannerDegraded()
        ? 'Market feed disconnected — scanner paused. Reconnecting...'
        : 'Scanner operational',
    };
  }
}
