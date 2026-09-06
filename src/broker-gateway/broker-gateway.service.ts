import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';
import axios from 'axios';

@Injectable()
export class BrokerGatewayService {
  private readonly logger = new Logger(BrokerGatewayService.name);
  private readonly algorithm = 'aes-256-gcm';
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const rawKey = this.config.get<string>('BROKER_TOKEN_ENCRYPTION_KEY') || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    this.encryptionKey = Buffer.from(rawKey, 'hex');
  }

  // ── Encryption utilities ───────────────────────────────────────

  private encrypt(text: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(this.algorithm, this.encryptionKey, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  private decrypt(encryptedData: string): string {
    const [ivHex, authTagHex, cipherText] = encryptedData.split(':');
    if (!ivHex || !authTagHex || !cipherText) {
      throw new Error('Invalid encrypted data format');
    }
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(this.algorithm, this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(cipherText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  // ── Upstox OAuth Flow ──────────────────────────────────────────

  getUpstoxLoginUrl(redirectUri: string, state: string): string {
    const clientId = this.config.get<string>('UPSTOX_CLIENT_ID');
    const url = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(
      redirectUri,
    )}&state=${encodeURIComponent(state)}`;
    return url;
  }

  async handleUpstoxCallback(userId: string, code: string, redirectUri: string) {
    const clientId = this.config.get<string>('UPSTOX_CLIENT_ID');
    const clientSecret = this.config.get<string>('UPSTOX_CLIENT_SECRET');

    const params = new URLSearchParams();
    params.append('code', code);
    params.append('client_id', clientId || '');
    params.append('client_secret', clientSecret || '');
    params.append('redirect_uri', redirectUri);
    params.append('grant_type', 'authorization_code');

    try {
      const response = await axios.post(
        'https://api.upstox.com/v2/login/authorization/token',
        params.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
        },
      );

      const { access_token, user_id, user_name } = response.data;
      const encryptedToken = this.encrypt(access_token);
      // Upstox token valid for current trading day till 3:30 AM next day
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const brokerConnection = await this.prisma.brokerConnection.upsert({
        where: {
          userId_broker: {
            userId,
            broker: 'upstox',
          },
        },
        create: {
          userId,
          broker: 'upstox',
          accessToken: encryptedToken,
          tokenExpiresAt: expiresAt,
          brokerUserId: user_id,
          brokerUserName: user_name,
          isActive: true,
        },
        update: {
          accessToken: encryptedToken,
          tokenExpiresAt: expiresAt,
          brokerUserId: user_id,
          brokerUserName: user_name,
          isActive: true,
          connectedAt: new Date(),
        },
      });

      return {
        success: true,
        broker: 'upstox',
        brokerUserId: user_id,
        brokerUserName: user_name,
      };
    } catch (err: any) {
      this.logger.error('Upstox token exchange failed:', err.response?.data || err.message);
      throw new BadRequestException('Failed to authenticate with Upstox: ' + (err.response?.data?.message || err.message));
    }
  }

  async getActiveBrokerToken(userId: string): Promise<string> {
    const conn = await this.prisma.brokerConnection.findUnique({
      where: { userId_broker: { userId, broker: 'upstox' } },
    });

    if (!conn || !conn.isActive) {
      throw new BadRequestException('No active broker connection found for user');
    }

    if (new Date() > conn.tokenExpiresAt) {
      await this.prisma.brokerConnection.update({
        where: { id: conn.id },
        data: { isActive: false },
      });
      throw new BadRequestException('Broker session has expired. Please reconnect your account.');
    }

    return this.decrypt(conn.accessToken);
  }

  // ── Upstox Order Execution & Position Fetching ─────────────────

  async placeOrder(userId: string, orderData: any) {
    const token = await this.getActiveBrokerToken(userId);
    try {
      const response = await axios.post(
        'https://api.upstox.com/v2/order/place',
        orderData,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        },
      );
      return response.data;
    } catch (err: any) {
      this.logger.error('Broker order placement error:', err.response?.data || err.message);
      throw new BadRequestException(err.response?.data?.message || 'Broker order placement failed');
    }
  }

  async getPositions(userId: string) {
    const token = await this.getActiveBrokerToken(userId);
    try {
      const response = await axios.get('https://api.upstox.com/v2/portfolio/short-term-positions', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });
      return response.data;
    } catch (err: any) {
      this.logger.error('Broker positions error:', err.response?.data || err.message);
      return { status: 'error', data: [] };
    }
  }

  async disconnect(userId: string) {
    await this.prisma.brokerConnection.updateMany({
      where: { userId, broker: 'upstox' },
      data: { isActive: false },
    });
    return { success: true, message: 'Broker disconnected successfully' };
  }

  // ── AngelOne SmartAPI ──────────────────────────────────────────

  /**
   * Generates a TOTP code from the base32 secret stored in .env.
   * Uses RFC 6238 TOTP algorithm (SHA-1, 30s window, 6 digits).
   */
  private generateTotp(secret: string): string {
    const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const secretClean = secret.toUpperCase().replace(/=+$/, '');
    let bits = '';
    for (const char of secretClean) {
      const val = base32Chars.indexOf(char);
      if (val === -1) continue;
      bits += val.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }
    const keyBuffer = Buffer.from(bytes);

    const counter = Math.floor(Date.now() / 1000 / 30);
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    counterBuffer.writeUInt32BE(counter >>> 0, 4);

    const hmac = crypto.createHmac('sha1', keyBuffer).update(counterBuffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code =
      (((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff)) %
      1_000_000;

    return code.toString().padStart(6, '0');
  }

  /**
   * Logs into AngelOne SmartAPI using Client ID, PIN and TOTP.
   * No OAuth redirect needed — uses direct credential-based login.
   */
  async loginAngelOne(userId: string): Promise<{ jwtToken: string; refreshToken: string; feedToken: string }> {
    const apiKey     = this.config.get<string>('ANGELONE_API_KEY') || '';
    const clientId   = this.config.get<string>('ANGELONE_CLIENT_ID') || '';
    const pin        = this.config.get<string>('ANGELONE_CLIENT_PIN') || '';
    const totpSecret = this.config.get<string>('ANGELONE_TOTP_SECRET') || '';
    const baseUrl    = this.config.get<string>('ANGELONE_API_BASE') || 'https://apiconnect.angelone.in';

    const totp = this.generateTotp(totpSecret);
    this.logger.log(`[AngelOne] Logging in as ${clientId}`);

    try {
      const response = await axios.post(
        `${baseUrl}/rest/auth/angelbroking/user/v1/loginByPassword`,
        { clientcode: clientId, password: pin, totp },
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-UserType': 'USER',
            'X-SourceID': 'WEB',
            'X-ClientLocalIP': '127.0.0.1',
            'X-ClientPublicIP': '106.213.155.95',
            'X-MACAddress': '00:00:00:00:00:00',
            'X-PrivateKey': apiKey,
          },
        },
      );

      const { jwtToken, refreshToken, feedToken } = response.data.data;
      const encryptedToken = this.encrypt(jwtToken);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await this.prisma.brokerConnection.upsert({
        where: { userId_broker: { userId, broker: 'angelone' } },
        create: {
          userId,
          broker: 'angelone',
          accessToken: encryptedToken,
          tokenExpiresAt: expiresAt,
          brokerUserId: clientId,
          brokerUserName: clientId,
          isActive: true,
        },
        update: {
          accessToken: encryptedToken,
          tokenExpiresAt: expiresAt,
          brokerUserId: clientId,
          brokerUserName: clientId,
          isActive: true,
          connectedAt: new Date(),
        },
      });

      this.logger.log(`[AngelOne] Login successful for ${clientId}`);
      return { jwtToken, refreshToken, feedToken };
    } catch (err: any) {
      this.logger.error('[AngelOne] Login failed:', err.response?.data || err.message);
      throw new BadRequestException(
        'AngelOne login failed: ' + (err.response?.data?.message || err.message),
      );
    }
  }

  async getAngelOneToken(userId: string): Promise<string> {
    const conn = await this.prisma.brokerConnection.findUnique({
      where: { userId_broker: { userId, broker: 'angelone' } },
    });

    if (!conn || !conn.isActive || new Date() > conn.tokenExpiresAt) {
      // Auto-login / re-login using stored credentials from .env
      const { jwtToken } = await this.loginAngelOne(userId);
      return jwtToken;
    }

    return this.decrypt(conn.accessToken);
  }

  async placeAngelOneOrder(userId: string, orderData: any) {
    const token   = await this.getAngelOneToken(userId);
    const apiKey  = this.config.get<string>('ANGELONE_API_KEY') || '';
    const baseUrl = this.config.get<string>('ANGELONE_API_BASE') || 'https://apiconnect.angelone.in';

    try {
      const response = await axios.post(
        `${baseUrl}/rest/secure/angelbroking/order/v1/placeOrder`,
        orderData,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-UserType': 'USER',
            'X-SourceID': 'WEB',
            'X-ClientLocalIP': '127.0.0.1',
            'X-ClientPublicIP': '106.213.155.95',
            'X-MACAddress': '00:00:00:00:00:00',
            'X-PrivateKey': apiKey,
          },
        },
      );
      return response.data;
    } catch (err: any) {
      this.logger.error('[AngelOne] Order placement error:', err.response?.data || err.message);
      throw new BadRequestException(err.response?.data?.message || 'AngelOne order placement failed');
    }
  }

  async getAngelOnePositions(userId: string) {
    const token   = await this.getAngelOneToken(userId);
    const apiKey  = this.config.get<string>('ANGELONE_API_KEY') || '';
    const baseUrl = this.config.get<string>('ANGELONE_API_BASE') || 'https://apiconnect.angelone.in';

    try {
      const response = await axios.get(
        `${baseUrl}/rest/secure/angelbroking/order/v1/getPosition`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'X-UserType': 'USER',
            'X-SourceID': 'WEB',
            'X-ClientLocalIP': '127.0.0.1',
            'X-ClientPublicIP': '106.213.155.95',
            'X-MACAddress': '00:00:00:00:00:00',
            'X-PrivateKey': apiKey,
          },
        },
      );
      return response.data;
    } catch (err: any) {
      this.logger.error('[AngelOne] Positions error:', err.response?.data || err.message);
      return { status: 'error', data: [] };
    }
  }

  async disconnectAngelOne(userId: string) {
    await this.prisma.brokerConnection.updateMany({
      where: { userId, broker: 'angelone' },
      data: { isActive: false },
    });
    return { success: true, message: 'AngelOne disconnected successfully' };
  }
}
