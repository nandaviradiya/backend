import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Req,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsBoolean, IsNumber, IsOptional, Min, Max } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

class RegisterDeviceDto {
  @IsString()
  fcmToken: string;

  @IsString()
  platform: 'android' | 'ios';

  @IsOptional()
  @IsString()
  appVersion?: string;
}

class UpdatePreferencesDto {
  @IsOptional()
  @IsBoolean()
  notifyEnabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  scoreThreshold?: number;

  @IsOptional()
  @IsNumber()
  @Min(1.0)
  @Max(10.0)
  rvolThreshold?: number;

  @IsOptional()
  @IsBoolean()
  watchlistOnly?: boolean;
}

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List notifications for current user' })
  async getNotifications(@Req() req: any) {
    const userId = req.user.id;
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        signal: {
          select: {
            id: true,
            type: true,
            state: true,
            price: true,
            level: true,
            rvol: true,
            signalScore: true,
            detectedAt: true,
          },
        },
      },
    });
  }

  @Post('device')
  @HttpCode(200)
  @ApiOperation({ summary: 'Register FCM device token for push notifications' })
  async registerDevice(@Req() req: any, @Body() dto: RegisterDeviceDto) {
    const userId = req.user.id;
    const device = await this.prisma.device.upsert({
      where: {
        userId_fcmToken: {
          userId,
          fcmToken: dto.fcmToken,
        },
      },
      create: {
        userId,
        fcmToken: dto.fcmToken,
        platform: dto.platform,
        appVersion: dto.appVersion,
      },
      update: {
        platform: dto.platform,
        appVersion: dto.appVersion,
        updatedAt: new Date(),
      },
    });

    return { status: 'OK', deviceId: device.id };
  }

  @Delete('device')
  @ApiOperation({ summary: 'Unregister FCM device token' })
  async unregisterDevice(@Req() req: any, @Body('fcmToken') fcmToken: string) {
    const userId = req.user.id;
    await this.prisma.device.deleteMany({
      where: { userId, fcmToken },
    });
    return { status: 'OK' };
  }

  @Get('preferences')
  @ApiOperation({ summary: 'Get user notification alert preferences' })
  async getPreferences(@Req() req: any) {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        notifyEnabled: true,
        scoreThreshold: true,
        rvolThreshold: true,
        watchlistOnly: true,
      },
    });
    return user;
  }

  @Put('preferences')
  @ApiOperation({ summary: 'Update notification alert preferences' })
  async updatePreferences(@Req() req: any, @Body() dto: UpdatePreferencesDto) {
    const user = await this.prisma.user.update({
      where: { id: req.user.id },
      data: {
        notifyEnabled: dto.notifyEnabled,
        scoreThreshold: dto.scoreThreshold,
        rvolThreshold: dto.rvolThreshold,
        watchlistOnly: dto.watchlistOnly,
      },
      select: {
        notifyEnabled: true,
        scoreThreshold: true,
        rvolThreshold: true,
        watchlistOnly: true,
      },
    });
    return user;
  }
}
