import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Req,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { BrokerGatewayService } from './broker-gateway.service';

@ApiTags('broker-gateway')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('broker')
export class BrokerGatewayController {
  constructor(private readonly brokerGatewayService: BrokerGatewayService) {}

  @Get('login-url')
  @ApiOperation({ summary: 'Get OAuth login URL for Upstox broker authorization' })
  getLoginUrl(@Req() req: any, @Query('redirectUri') redirectUri: string) {
    const state = req.user.id;
    const url = this.brokerGatewayService.getUpstoxLoginUrl(redirectUri, state);
    return { loginUrl: url };
  }

  @Post('callback')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange OAuth authorization code for session tokens' })
  async handleCallback(
    @Req() req: any,
    @Body('code') code: string,
    @Body('redirectUri') redirectUri: string,
  ) {
    return this.brokerGatewayService.handleUpstoxCallback(req.user.id, code, redirectUri);
  }

  @Get('positions')
  @ApiOperation({ summary: 'Fetch live holdings & positions from connected broker' })
  async getPositions(@Req() req: any) {
    return this.brokerGatewayService.getPositions(req.user.id);
  }

  @Post('disconnect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Disconnect current broker session' })
  async disconnect(@Req() req: any) {
    return this.brokerGatewayService.disconnect(req.user.id);
  }

  // ── AngelOne SmartAPI Routes ───────────────────────────────────

  @Post('angelone/login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Login to AngelOne SmartAPI using TOTP (no OAuth redirect needed)',
    description: 'Uses Client ID, PIN and TOTP secret from .env to authenticate. Returns JWT token.',
  })
  async loginAngelOne(@Req() req: any) {
    return this.brokerGatewayService.loginAngelOne(req.user.id);
  }

  @Get('angelone/positions')
  @ApiOperation({
    summary: 'Fetch live positions from AngelOne SmartAPI',
    description: 'Auto-logins if session expired. Returns current open positions.',
  })
  async getAngelOnePositions(@Req() req: any) {
    return this.brokerGatewayService.getAngelOnePositions(req.user.id);
  }

  @Post('angelone/order')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Place an order via AngelOne SmartAPI',
    description: 'Accepts order payload and places it through SmartAPI. Auto-renews session if expired.',
  })
  async placeAngelOneOrder(@Req() req: any, @Body() orderData: any) {
    return this.brokerGatewayService.placeAngelOneOrder(req.user.id, orderData);
  }

  @Post('angelone/disconnect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Disconnect AngelOne session' })
  async disconnectAngelOne(@Req() req: any) {
    return this.brokerGatewayService.disconnectAngelOne(req.user.id);
  }
}
