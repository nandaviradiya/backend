import { Module } from '@nestjs/common';
import { MarketFeedService } from './market-feed.service';
import { MarketFeedController } from './market-feed.controller';
import { InstrumentsModule } from '../instruments/instruments.module';

@Module({
  imports: [InstrumentsModule],
  controllers: [MarketFeedController],
  providers: [MarketFeedService],
  exports: [MarketFeedService],
})
export class MarketFeedModule {}
