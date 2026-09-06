import { Injectable, Logger, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import Redis from 'ioredis';
import { PaperTradingService } from '../paper-trading/paper-trading.service';

@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paperTradingService: PaperTradingService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async getOverview(userId: string) {
    const paperAccount = await this.paperTradingService.getOrCreateAccount(userId);
    const paperPortfolio = await this.paperTradingService.getPortfolio(userId);

    const realBrokerConn = await this.prisma.brokerConnection.findFirst({
      where: { userId, isActive: true },
      select: { broker: true, brokerUserId: true, brokerUserName: true, connectedAt: true },
    });

    const totalInvestedValue = paperPortfolio.positions.reduce((sum, p) => sum + (p.avgPrice * p.qty), 0);
    const totalCurrentValue = paperPortfolio.positions.reduce((sum, p) => sum + (p.ltp * p.qty), 0);

    return {
      paper: {
        balance: paperAccount.balance,
        initialBalance: paperAccount.initialBalance,
        totalUnrealizedPnl: paperPortfolio.totalUnrealizedPnl,
        totalCurrentValue,
        totalInvestedValue,
        positionsCount: paperPortfolio.positions.length,
        positions: paperPortfolio.positions,
      },
      broker: realBrokerConn || null,
    };
  }

  async getTradeHistory(userId: string, limit = 50) {
    return this.prisma.order.findMany({
      where: { userId, status: 'FILLED' },
      include: {
        instrument: {
          select: {
            tradingSymbol: true,
            companyName: true,
            exchange: true,
          },
        },
        trades: true,
      },
      orderBy: { filledAt: 'desc' },
      take: limit,
    });
  }

  async getPerformanceMetrics(userId: string) {
    const paperAccount = await this.prisma.paperAccount.findUnique({
      where: { userId },
      include: {
        ledger: {
          orderBy: { createdAt: 'asc' },
          take: 100,
        },
      },
    });

    if (!paperAccount) {
      return {
        initialBalance: 1000000,
        currentBalance: 1000000,
        winRate: 0,
        totalTrades: 0,
        equityCurve: [],
      };
    }

    const filledOrders = await this.prisma.order.findMany({
      where: { userId, status: 'FILLED' },
      include: { instrument: true },
    });

    // Compute basic trade statistics
    const totalTrades = filledOrders.length;

    // Build equity curve from cash ledger balance points
    const equityCurve = paperAccount.ledger.map((entry) => ({
      timestamp: entry.createdAt,
      balance: entry.balance,
      change: entry.amount,
      type: entry.type,
      description: entry.description,
    }));

    return {
      initialBalance: paperAccount.initialBalance,
      currentBalance: paperAccount.balance,
      totalTrades,
      equityCurve,
    };
  }
}
