import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { TerminusModule } from '@nestjs/terminus';
import Joi from 'joi';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { InstrumentsModule } from './instruments/instruments.module';
import { MarketFeedModule } from './market-feed/market-feed.module';
import { CandlesModule } from './candles/candles.module';
import { IndicatorsModule } from './indicators/indicators.module';
import { StrategyModule } from './strategy/strategy.module';
import { PaperTradingModule } from './paper-trading/paper-trading.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PortfolioModule } from './portfolio/portfolio.module';
import { BrokerGatewayModule } from './broker-gateway/broker-gateway.module';
import { AiModule } from './ai/ai.module';
import { MarketGateway } from './gateway/market.gateway';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    // ── Configuration ────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validationSchema: Joi.object({
        NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
        PORT: Joi.number().default(3000),
        DATABASE_URL: Joi.string().default('postgresql://aitrading:aitrading_secret@localhost:5432/aitrading'),
        REDIS_HOST: Joi.string().default('localhost'),
        REDIS_PORT: Joi.number().default(6379),
        FIREBASE_PROJECT_ID: Joi.string().allow('').optional(),
        FIREBASE_CLIENT_EMAIL: Joi.string().allow('').optional(),
        FIREBASE_PRIVATE_KEY: Joi.string().allow('').optional(),
        JWT_SECRET: Joi.string().min(16).default('development_jwt_secret_key_1234567890'),
        UPSTOX_CLIENT_ID: Joi.string().allow('').optional(),
        UPSTOX_CLIENT_SECRET: Joi.string().allow('').optional(),
        ML_SERVICE_URL: Joi.string().default('http://localhost:8000'),
        BROKER_TOKEN_ENCRYPTION_KEY: Joi.string()
          .length(64)
          .default('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
      }),
    }),

    // ── Scheduling ───────────────────────────────────────────────
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot({ wildcard: true }),

    // ── Rate limiting ────────────────────────────────────────────
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1000, limit: 10 },
      { name: 'medium', ttl: 10000, limit: 50 },
      { name: 'long', ttl: 60000, limit: 200 },
    ]),

    // ── Health checks ─────────────────────────────────────────────
    TerminusModule,

    // ── Core modules ──────────────────────────────────────────────
    PrismaModule,
    RedisModule,

    // ── Feature modules ───────────────────────────────────────────
    AuthModule,
    InstrumentsModule,
    MarketFeedModule,
    CandlesModule,
    IndicatorsModule,
    StrategyModule,
    PaperTradingModule,
    NotificationsModule,
    PortfolioModule,
    BrokerGatewayModule,
    AiModule,
  ],
  controllers: [HealthController],
  providers: [MarketGateway],
})
export class AppModule {}
