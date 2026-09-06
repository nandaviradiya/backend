import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { TICK_EVENT, MarketTick, MarketFeedService } from '../market-feed/market-feed.service';

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/ws',
})
export class MarketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(MarketGateway.name);

  // Track subscriptions: clientId → Set<instrumentKey>
  private readonly subscriptions = new Map<string, Set<string>>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly feed: MarketFeedService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('WebSocket gateway initialized');
    this.setupRedisListeners();
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    this.subscriptions.set(client.id, new Set());
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.subscriptions.delete(client.id);
  }

  // ── Subscribe to instrument quotes ────────────────────────────

  @SubscribeMessage('subscribe:quotes')
  handleSubscribeQuotes(
    @MessageBody() data: { instrumentKeys?: string[] } | string,
    @ConnectedSocket() client: Socket,
  ) {
    const payload = typeof data === 'string' ? JSON.parse(data) : data || {};
    const keys: string[] = payload.instrumentKeys || [];
    const subs = this.subscriptions.get(client.id) || new Set<string>();
    keys.forEach((k) => subs.add(k));
    this.subscriptions.set(client.id, subs);
    if (keys.length) this.feed.subscribe(keys);
    client.emit('subscribed', { instrumentKeys: [...subs] });
  }

  @SubscribeMessage('scanner:subscribe')
  handleLegacyScannerSubscribe(@ConnectedSocket() client: Socket) {
    return this.handleSubscribeScanner(client);
  }

  @SubscribeMessage('chart:subscribe')
  handleLegacyChartSubscribe(
    @MessageBody() data: { instrumentKey: string; interval: string },
    @ConnectedSocket() client: Socket,
  ) {
    return this.handleSubscribeChart(data, client);
  }

  @SubscribeMessage('unsubscribe:quotes')
  handleUnsubscribe(
    @MessageBody() data: { instrumentKeys: string[] },
    @ConnectedSocket() client: Socket,
  ) {
    const subs = this.subscriptions.get(client.id)!;
    data.instrumentKeys.forEach((k) => subs.delete(k));
  }

  @SubscribeMessage('subscribe:chart')
  handleSubscribeChart(
    @MessageBody() data: { instrumentKey: string; interval: string },
    @ConnectedSocket() client: Socket,
  ) {
    const roomKey = `chart:${data.instrumentKey}:${data.interval}`;
    client.join(roomKey);
    client.emit('chart:subscribed', data);
  }

  @SubscribeMessage('subscribe:scanner')
  handleSubscribeScanner(@ConnectedSocket() client: Socket) {
    client.join('scanner:all');
    client.emit('scanner:subscribed', { ok: true });
  }

  // ── Emit to clients ────────────────────────────────────────────

  @OnEvent(TICK_EVENT)
  emitQuoteUpdate(tick: MarketTick) {
    // Send to clients subscribed to this instrument
    for (const [clientId, subs] of this.subscriptions) {
      if (subs.has(tick.instrumentKey)) {
        this.server.to(clientId).emit('market.quote.updated', this.feed.toLiveQuote(tick));
      }
    }
  }

  emitCandleUpdate(data: any) {
    const roomKey = `chart:${data.instrumentKey}:${data.interval}`;
    this.server.to(roomKey).emit('market.candle.updated', data);
  }

  emitSignalCreated(signal: any) {
    this.server.to('scanner:all').emit('scanner.signal.created', signal);
  }

  emitSignalUpdated(signal: any) {
    this.server.to('scanner:all').emit('scanner.signal.updated', signal);
  }

  emitOrderUpdate(order: any) {
    // Send only to the order owner
    this.server.to(`user:${order.userId}`).emit('order.status.changed', order);
  }

  // ── Redis pub/sub listener ─────────────────────────────────────

  private setupRedisListeners() {
    const subscriber = this.redis.duplicate();

    subscriber.subscribe('scanner:signal', 'order:update', 'market:tick');

    subscriber.on('message', (channel, message) => {
      try {
        const parsed = JSON.parse(message);
        if (channel === 'scanner:signal') {
          if (parsed.event === 'scanner.signal.created') this.emitSignalCreated(parsed.data);
          if (parsed.event === 'scanner.signal.updated') this.emitSignalUpdated(parsed.data);
        }
        if (channel === 'order:update') {
          this.emitOrderUpdate(parsed.data);
        }
      } catch (err) {
        this.logger.error('WebSocket relay error:', err);
      }
    });

    // Use psubscribe for pattern-based candle channels
    subscriber.psubscribe('candle:live:*');
    subscriber.on('pmessage', (_pattern, channel, message) => {
      const instrumentKey = channel.replace('candle:live:', '');
      try {
        const candle = JSON.parse(message);
        const roomKey = `chart:${instrumentKey}:${candle.interval}`;
        this.server.to(roomKey).emit('market.candle.updated', candle);
      } catch (err) {
        this.logger.error('Candle relay error:', err);
      }
    });
  }
}
