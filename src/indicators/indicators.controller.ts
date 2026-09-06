import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IndicatorService } from './indicator.service';

@ApiTags('indicators')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('indicators')
export class IndicatorsController {
  constructor(private readonly indicatorService: IndicatorService) {}

  @Get(':instrumentKey/levels')
  @ApiOperation({ summary: 'Get current technical levels (20-day high/low, ATR, RVOL baseline, VWAP)' })
  getLevels(@Param('instrumentKey') instrumentKey: string) {
    const level = this.indicatorService.getLevel(instrumentKey);
    if (!level) {
      return { status: 'NO_DATA', instrumentKey, message: 'Technical levels not computed yet for today' };
    }
    return {
      instrumentKey: level.instrumentKey,
      tradingDate: level.tradingDate,
      resistance20d: level.resistance20d,
      support20d: level.support20d,
      atr14: level.atr14,
      vwap: level.vwap,
      prevDayClose: level.prevDayClose,
    };
  }

  @Get(':instrumentKey/vwap')
  @ApiOperation({ summary: 'Get live session VWAP for an instrument' })
  getVwap(@Param('instrumentKey') instrumentKey: string) {
    const vwap = this.indicatorService.getVwap(instrumentKey);
    return { instrumentKey, vwap };
  }
}
