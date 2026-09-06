import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (configService: ConfigService) => {
        const client = new Redis({
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          password: configService.get<string>('REDIS_PASSWORD') || undefined,
          retryStrategy: (times) => Math.min(times * 200, 5000),
          enableReadyCheck: false,
          maxRetriesPerRequest: null,
        });

        client.on('connect', () => console.log('[Redis] Connected'));
        client.on('error', (err) => console.warn('[Redis] Connection waiting/retrying:', err.message));
        client.on('reconnecting', () => console.warn('[Redis] Reconnecting...'));

        return client;
      },
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
