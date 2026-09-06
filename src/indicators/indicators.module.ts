import { Module } from '@nestjs/common';
import { IndicatorService } from './indicator.service';
import { IndicatorsController } from './indicators.controller';
import { CandlesModule } from '../candles/candles.module';
import { MarketFeedModule } from '../market-feed/market-feed.module';

@Module({
  imports: [CandlesModule, MarketFeedModule],
  controllers: [IndicatorsController],
  providers: [IndicatorService],
  exports: [IndicatorService],
})
export class IndicatorsModule {}
