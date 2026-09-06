import { Module } from '@nestjs/common';
import { CandleService } from './candle.service';
import { CandleController } from './candle.controller';

@Module({
  controllers: [CandleController],
  providers: [CandleService],
  exports: [CandleService],
})
export class CandlesModule {}
