import { Module } from '@nestjs/common';
import { BrokerGatewayService } from './broker-gateway.service';
import { BrokerGatewayController } from './broker-gateway.controller';

@Module({
  controllers: [BrokerGatewayController],
  providers: [BrokerGatewayService],
  exports: [BrokerGatewayService],
})
export class BrokerGatewayModule {}
