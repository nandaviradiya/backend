import { Body, Controller, Get, Post, UseGuards, Req, HttpCode } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { IsString, IsOptional, IsIn, IsBoolean, IsNumber, Min, Max } from 'class-validator';
import { AuthService } from './auth.service';

class LoginDto {
  @IsString() idToken: string;
}

class RegisterDeviceDto {
  @IsString() fcmToken: string;
  @IsIn(['android', 'ios']) platform: string;
  @IsOptional() @IsString() appVersion?: string;
}

class UpdatePrefsDto {
  @IsOptional() @IsBoolean() notifyEnabled?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(100) scoreThreshold?: number;
  @IsOptional() @IsNumber() @Min(1) rvolThreshold?: number;
  @IsOptional() @IsBoolean() watchlistOnly?: boolean;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange Firebase ID token for app JWT' })
  login(@Body() dto: LoginDto) {
    return this.authService.verifyFirebaseToken(dto.idToken);
  }

  @Post('device')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Register device FCM token' })
  registerDevice(@Req() req: any, @Body() dto: RegisterDeviceDto) {
    return this.authService.registerDevice(req.user.id, dto.fcmToken, dto.platform, dto.appVersion);
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  me(@Req() req: any) {
    return this.authService.getUser(req.user.id);
  }

  @Post('preferences')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update notification preferences' })
  updatePrefs(@Req() req: any, @Body() dto: UpdatePrefsDto) {
    return this.authService.updateNotificationPrefs(req.user.id, dto);
  }
}
