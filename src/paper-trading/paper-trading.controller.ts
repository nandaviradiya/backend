import {
  Controller, Get, Post, Body, Query, Req, UseGuards, HttpCode
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsEnum, IsNumber, IsOptional, IsPositive, Min } from 'class-validator';
import { OrderSide, OrderType, ProductType } from '@prisma/client';
import { PaperTradingService } from './paper-trading.service';
import { randomUUID } from 'crypto';

class PlaceOrderDto {
  @IsString() instrumentKey: string;
  @IsEnum(OrderSide) side: OrderSide;
  @IsEnum(OrderType) type: OrderType;
  @IsEnum(ProductType) product: ProductType;
  @IsNumber() @IsPositive() qty: number;
  @IsOptional() @IsNumber() @Min(0) price?: number;
  @IsOptional() @IsString() idempotencyKey?: string;
}

@ApiTags('paper')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('paper')
export class PaperTradingController {
  constructor(private readonly paperService: PaperTradingService) {}

  @Get('account')
  @ApiOperation({ summary: 'Get paper trading account balance' })
  getAccount(@Req() req: any) {
    return this.paperService.getOrCreateAccount(req.user.id);
  }

  @Post('orders')
  @ApiOperation({ summary: 'Place a paper trade order' })
  placeOrder(@Req() req: any, @Body() dto: PlaceOrderDto) {
    return this.paperService.placeOrder({
      userId: req.user.id,
      instrumentKey: dto.instrumentKey,
      side: dto.side,
      type: dto.type,
      product: dto.product,
      qty: dto.qty,
      price: dto.price,
      idempotencyKey: dto.idempotencyKey ?? randomUUID(),
    });
  }

  @Get('orders')
  @ApiOperation({ summary: 'Get paper order history' })
  getOrders(@Req() req: any, @Query('limit') limit?: number) {
    return this.paperService.getOrders(req.user.id, limit);
  }

  @Get('portfolio')
  @ApiOperation({ summary: 'Get paper trading portfolio with live P&L' })
  getPortfolio(@Req() req: any) {
    return this.paperService.getPortfolio(req.user.id);
  }

  @Post('reset')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reset paper account to starting balance' })
  reset(@Req() req: any) {
    return this.paperService.resetAccount(req.user.id);
  }
}
