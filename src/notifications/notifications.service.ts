import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import * as admin from 'firebase-admin';
import Redis from 'ioredis';

interface SignalNotificationPayload {
  signalId: string;
}

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly cooldowns = new Map<string, number>(); // instrumentKey → last notify timestamp

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleInit() {
    this.processNotificationQueue();
  }

  // ── Queue processor ────────────────────────────────────────────

  private async processNotificationQueue() {
    const subscriber = this.redis.duplicate();

    // Poll notification queue continuously
    const poll = async () => {
      while (true) {
        try {
          const item = await subscriber.blpop('notification:queue', 5);
          if (item) {
            const payload: SignalNotificationPayload = JSON.parse(item[1]);
            await this.sendSignalNotification(payload.signalId);
          }
        } catch (err) {
          this.logger.error('Notification queue error:', err);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    };

    poll().catch((err) => this.logger.error('Notification processor crashed:', err));
  }

  // ── Signal notification ────────────────────────────────────────

  async sendSignalNotification(signalId: string) {
    const signal = await this.prisma.scannerSignal.findUnique({
      where: { id: signalId },
      include: { instrument: { select: { tradingSymbol: true, companyName: true } } },
    });

    if (!signal) return;
    if (signal.state !== 'CONFIRMED') return;

    // Check cooldown (default 30 min per instrument)
    const cooldownMs = this.config.get<number>('NOTIFICATION_COOLDOWN_MINUTES', 30) * 60 * 1000;
    const lastNotify = this.cooldowns.get(signal.instrumentKey);
    if (lastNotify && Date.now() - lastNotify < cooldownMs) {
      this.logger.debug(`Cooldown active for ${signal.instrumentKey}`);
      return;
    }

    // Fetch all users who should receive this notification
    const users = await this.prisma.user.findMany({
      where: {
        notifyEnabled: true,
        scoreThreshold: { lte: signal.signalScore ?? 0 },
        rvolThreshold: { lte: signal.rvol },
      },
      include: { devices: true },
    });

    if (users.length === 0) return;

    const symbol = signal.instrument.tradingSymbol;
    const typeLabel = signal.type === 'BREAKOUT' ? '🚀 Breakout' : '📉 Breakdown';
    const title = `${typeLabel}: ${symbol}`;
    const body = [
      `Price: ₹${signal.price.toFixed(2)}`,
      `${signal.type === 'BREAKOUT' ? 'Resistance' : 'Support'}: ₹${signal.level.toFixed(2)}`,
      `Volume: ${signal.rvol.toFixed(1)}× | Score: ${signal.signalScore}/100`,
    ].join('\n');

    const data = {
      signalId,
      type: signal.type,
      instrumentKey: signal.instrumentKey,
      price: String(signal.price),
      level: String(signal.level),
      rvol: String(signal.rvol),
      score: String(signal.signalScore ?? 0),
    };

    // Send to all eligible user devices
    const tokens: string[] = [];
    for (const user of users) {
      // Apply watchlist-only filter
      if (user.watchlistOnly) {
        const onWatchlist = await this.prisma.watchlistItem.findFirst({
          where: { userId: user.id, instrumentKey: signal.instrumentKey },
        });
        if (!onWatchlist) continue;
      }
      user.devices.forEach((d) => tokens.push(d.fcmToken));
    }

    if (tokens.length === 0) return;

    if (!admin.apps.length) {
      this.logger.debug(`Skipping FCM send: Firebase not initialized. Would notify ${tokens.length} devices.`);
      return;
    }

    try {
      // Send in batches of 500 (FCM limit)
      const BATCH = 500;
      for (let i = 0; i < tokens.length; i += BATCH) {
        const batch = tokens.slice(i, i + BATCH);
        await admin.messaging().sendEachForMulticast({
          tokens: batch,
          notification: { title, body },
          data,
          android: {
            priority: 'high',
            notification: { channelId: 'scanner_signals', priority: 'high' },
          },
        });
      }

      this.cooldowns.set(signal.instrumentKey, Date.now());
      this.logger.log(`Notification sent for ${signal.instrumentKey} to ${tokens.length} devices`);

      // Record delivery
      await this.prisma.notification.createMany({
        data: users.map((u) => ({
          userId: u.id,
          signalId,
          title,
          body,
          data,
          deliveredAt: new Date(),
        })),
      });
    } catch (err) {
      this.logger.error('FCM send error:', err);
    }
  }

  async sendFailedSignalNotification(signalId: string) {
    const signal = await this.prisma.scannerSignal.findUnique({
      where: { id: signalId },
      include: { instrument: { select: { tradingSymbol: true } } },
    });

    if (!signal) return;

    const symbol = signal.instrument.tradingSymbol;
    const title = `⚠️ Signal Failed: ${symbol}`;
    const body = `The ${signal.type.toLowerCase()} signal at ₹${signal.level.toFixed(2)} has failed — price returned inside the level.`;

    // Find users who received the original notification
    const originalNotifications = await this.prisma.notification.findMany({
      where: { signalId },
      include: { user: { include: { devices: true } } },
    });

    const tokens = originalNotifications.flatMap((n) => n.user.devices.map((d) => d.fcmToken));
    if (tokens.length === 0) return;

    try {
      await admin.messaging().sendEachForMulticast({
        tokens: [...new Set(tokens)], // deduplicate
        notification: { title, body },
        data: { signalId, type: 'SIGNAL_FAILED' },
      });
    } catch (err) {
      this.logger.error('FCM failed signal error:', err);
    }
  }
}
