import { Module } from '@nestjs/common';
import { StrategyService } from './strategy.service';
import { StrategyController } from './strategy.controller';
import { IndicatorsModule } from '../indicators/indicators.module';
import { CandlesModule } from '../candles/candles.module';
import { MarketFeedModule } from '../market-feed/market-feed.module';
import { SrScannerService } from './sr-scanner.service';

@Module({
  imports: [IndicatorsModule, CandlesModule, MarketFeedModule],
  controllers: [StrategyController],
  providers: [StrategyService, SrScannerService],
  exports: [StrategyService, SrScannerService],
})
export class StrategyModule {}

