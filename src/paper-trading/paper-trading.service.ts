import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { OrderSide, OrderType, ProductType, OrderStatus } from '@prisma/client';

const BROKERAGE_PER_ORDER = 20; // ₹20 flat or 0.03%
const STT_RATE_INTRADAY = 0.00025;   // 0.025% on sell side
const STT_RATE_DELIVERY = 0.001;     // 0.1% on buy and sell
const EXCHANGE_CHARGE = 0.0000345;
const GST_RATE = 0.18;
const SLIPPAGE_PERCENT = 0.0005;    // 0.05% market order slippage

interface PlaceOrderDto {
  userId: string;
  instrumentKey: string;
  side: OrderSide;
  type: OrderType;
  product: ProductType;
  qty: number;
  price?: number;
  idempotencyKey: string;
}

@Injectable()
export class PaperTradingService {
  private readonly logger = new Logger(PaperTradingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // ── Account management ─────────────────────────────────────────

  async getOrCreateAccount(userId: string) {
    return this.prisma.paperAccount.upsert({
      where: { userId },
      create: { userId, balance: 1_000_000, initialBalance: 1_000_000 },
      update: {},
    });
  }

  async resetAccount(userId: string) {
    const account = await this.getOrCreateAccount(userId);
    await this.prisma.$transaction([
      this.prisma.order.deleteMany({
        where: { userId, accountType: 'PAPER', paperAccountId: account.id },
      }),
      this.prisma.cashLedger.deleteMany({ where: { accountId: account.id } }),
      this.prisma.paperAccount.update({
        where: { id: account.id },
        data: { balance: account.initialBalance },
      }),
    ]);
    return { message: 'Paper account reset', balance: account.initialBalance };
  }

  // ── Order placement ────────────────────────────────────────────

  async placeOrder(dto: PlaceOrderDto) {
    const account = await this.getOrCreateAccount(dto.userId);

    // Idempotency check
    const existing = await this.prisma.order.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (existing) return existing;

    // Get current LTP
    const ltp = await this.getLtp(dto.instrumentKey);
    if (!ltp) throw new BadRequestException('No live price available for this instrument');

    const fillPrice = this.getFillPrice(dto.type, dto.side, ltp, dto.price);
    const charges = this.calculateCharges(fillPrice, dto.qty, dto.side, dto.product);
    const totalCost = fillPrice * dto.qty + (dto.side === 'BUY' ? charges.total : 0);

    // Check balance for buy orders
    if (dto.side === 'BUY' && account.balance < totalCost) {
      throw new BadRequestException(
        `Insufficient balance. Required: ₹${totalCost.toFixed(2)}, Available: ₹${account.balance.toFixed(2)}`
      );
    }

    // Create order and update balance in a transaction
    const order = await this.prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          idempotencyKey: dto.idempotencyKey,
          userId: dto.userId,
          accountType: 'PAPER',
          paperAccountId: account.id,
          instrumentKey: dto.instrumentKey,
          side: dto.side,
          type: dto.type,
          product: dto.product,
          qty: dto.qty,
          filledQty: dto.qty, // paper orders fill immediately
          price: dto.price,
          avgFillPrice: fillPrice,
          status: OrderStatus.FILLED,
          brokerage: charges.brokerage,
          taxes: charges.taxes,
          slippage: dto.type === 'MARKET' ? Math.abs(fillPrice - ltp) * dto.qty : 0,
          filledAt: new Date(),
        },
      });

      // Create trade record
      await tx.trade.create({
        data: { orderId: newOrder.id, qty: dto.qty, price: fillPrice, tradedAt: new Date() },
      });

      // Update account balance
      const balanceDelta =
        dto.side === 'BUY'
          ? -(fillPrice * dto.qty + charges.total)
          : fillPrice * dto.qty - charges.total;

      const updatedAccount = await tx.paperAccount.update({
        where: { id: account.id },
        data: { balance: { increment: balanceDelta } },
      });

      // Cash ledger entry
      await tx.cashLedger.create({
        data: {
          accountId: account.id,
          type: dto.side === 'BUY' ? 'DEBIT' : 'CREDIT',
          amount: Math.abs(balanceDelta),
          description: `${dto.side} ${dto.qty} × ${dto.instrumentKey} @ ₹${fillPrice}`,
          balance: updatedAccount.balance,
        },
      });

      return newOrder;
    });

    this.logger.log(
      `Paper order: ${dto.side} ${dto.qty} ${dto.instrumentKey} @ ₹${fillPrice} (user: ${dto.userId})`
    );

    // Emit order update
    this.redis.publish(
      'order:update',
      JSON.stringify({ event: 'order.status.changed', data: order }),
    );

    return order;
  }

  // ── Portfolio ──────────────────────────────────────────────────

  async getPortfolio(userId: string) {
    const account = await this.getOrCreateAccount(userId);

    // Aggregate positions from filled orders
    const orders = await this.prisma.order.findMany({
      where: {
        userId,
        accountType: 'PAPER',
        status: 'FILLED',
        paperAccountId: account.id,
      },
      orderBy: { filledAt: 'asc' },
    });

    // Build positions map
    const positions: Record<string, {
      instrumentKey: string;
      qty: number;
      avgPrice: number;
      side: string;
      realizedPnl: number;
    }> = {};

    for (const order of orders) {
      const key = `${order.instrumentKey}:${order.product}`;
      if (!positions[key]) {
        positions[key] = { instrumentKey: order.instrumentKey, qty: 0, avgPrice: 0, side: 'BUY', realizedPnl: 0 };
      }

      const pos = positions[key];
      if (order.side === 'BUY') {
        const totalCost = pos.qty * pos.avgPrice + order.qty * (order.avgFillPrice ?? 0);
        pos.qty += order.qty;
        pos.avgPrice = pos.qty > 0 ? totalCost / pos.qty : 0;
      } else {
        pos.realizedPnl += (order.avgFillPrice! - pos.avgPrice) * order.qty;
        pos.qty -= order.qty;
      }
    }

    // Get live prices for unrealized P&L
    const openPositions = await Promise.all(
      Object.values(positions)
        .filter((p) => p.qty !== 0)
        .map(async (p) => {
          const ltp = await this.getLtp(p.instrumentKey);
          const unrealizedPnl = ltp ? (ltp - p.avgPrice) * p.qty : 0;
          return { ...p, ltp: ltp ?? p.avgPrice, unrealizedPnl };
        }),
    );

    return {
      balance: account.balance,
      initialBalance: account.initialBalance,
      positions: openPositions,
      totalUnrealizedPnl: openPositions.reduce((s, p) => s + p.unrealizedPnl, 0),
    };
  }

  async getOrders(userId: string, limit = 50) {
    return this.prisma.order.findMany({
      where: { userId, accountType: 'PAPER' },
      include: { instrument: { select: { tradingSymbol: true, companyName: true } } },
      orderBy: { placedAt: 'desc' },
      take: limit,
    });
  }

  // ── Helpers ────────────────────────────────────────────────────

  private getFillPrice(type: OrderType, side: OrderSide, ltp: number, limitPrice?: number): number {
    if (type === 'MARKET') {
      // Apply slippage
      const slippage = ltp * SLIPPAGE_PERCENT;
      return side === 'BUY' ? ltp + slippage : ltp - slippage;
    }
    return limitPrice ?? ltp;
  }

  private calculateCharges(price: number, qty: number, side: OrderSide, product: ProductType) {
    const turnover = price * qty;

    const brokerage = Math.min(BROKERAGE_PER_ORDER, turnover * 0.0003);
    const stt = product === 'DELIVERY'
      ? turnover * STT_RATE_DELIVERY
      : side === 'SELL' ? turnover * STT_RATE_INTRADAY : 0;
    const exchangeCharge = turnover * EXCHANGE_CHARGE;
    const subtotal = brokerage + stt + exchangeCharge;
    const gst = subtotal * GST_RATE;
    const total = subtotal + gst;

    return { brokerage, stt, exchangeCharge, gst, taxes: stt + exchangeCharge + gst, total };
  }

  private async getLtp(instrumentKey: string): Promise<number | null> {
    const cached = await this.redis.get(`quote:${instrumentKey}`);
    if (!cached) return null;
    const quote = JSON.parse(cached);
    return quote.ltp;
  }
}
