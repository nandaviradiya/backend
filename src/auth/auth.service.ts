import { Injectable, UnauthorizedException, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import * as admin from 'firebase-admin';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID');
    const clientEmail = this.config.get<string>('FIREBASE_CLIENT_EMAIL');
    const privateKey = this.config.get<string>('FIREBASE_PRIVATE_KEY');

    if (!admin.apps.length && projectId && clientEmail && privateKey) {
      try {
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey: privateKey.replace(/\\n/g, '\n'),
          }),
        });
        this.logger.log('Firebase Admin initialized');
      } catch (err: any) {
        this.logger.warn(`Firebase Admin init failed: ${err.message}`);
      }
    } else {
      this.logger.warn('Firebase credentials not configured — running in mock auth mode');
    }
  }

  /**
   * Verify a Firebase ID token, upsert user in DB, return app JWT.
   */
  async verifyFirebaseToken(idToken: string) {
    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      throw new UnauthorizedException('Invalid Firebase token');
    }

    const user = await this.prisma.user.upsert({
      where: { firebaseUid: decoded.uid },
      create: {
        firebaseUid: decoded.uid,
        email: decoded.email ?? '',
        displayName: decoded.name ?? null,
        photoUrl: decoded.picture ?? null,
      },
      update: {
        email: decoded.email ?? undefined,
        displayName: decoded.name ?? undefined,
        photoUrl: decoded.picture ?? undefined,
      },
    });

    const payload = { sub: user.id, uid: decoded.uid, email: user.email };
    return {
      accessToken: this.jwtService.sign(payload),
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        photoUrl: user.photoUrl,
        isAdmin: user.isAdmin,
      },
    };
  }

  /**
   * Register or update a device's FCM token.
   */
  async registerDevice(userId: string, fcmToken: string, platform: string, appVersion?: string) {
    return this.prisma.device.upsert({
      where: { userId_fcmToken: { userId, fcmToken } },
      create: { userId, fcmToken, platform, appVersion },
      update: { appVersion, updatedAt: new Date() },
    });
  }

  async getUser(userId: string) {
    return this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
  }

  async updateNotificationPrefs(
    userId: string,
    prefs: {
      notifyEnabled?: boolean;
      scoreThreshold?: number;
      rvolThreshold?: number;
      watchlistOnly?: boolean;
    },
  ) {
    return this.prisma.user.update({
      where: { id: userId },
      data: prefs,
    });
  }
}
