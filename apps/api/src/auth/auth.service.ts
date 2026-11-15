import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '../config/config.service.js';
import { LogService } from '../logging/log.service.js';

export interface Credentials {
  apiKey?: string;
  /** A login token, without the "Bearer " prefix. */
  token?: string;
}

/**
 * Auth is off unless ApiKey, AdminUser + AdminPassword, or GitHub sign-in is set. When on, a request
 * needs either the API key or a login token (from POST /api/auth/login or GitHub sign-in).
 */
@Injectable()
export class AuthService {
  private readonly jwt: JwtService;
  /** Signs the short-lived GitHub sign-in cookie with its own key, so it never passes as a login token. */
  private readonly flowJwt: JwtService;

  constructor(
    private readonly config: ConfigService,
    log: LogService,
  ) {
    const { JwtSecret, JwtExpiresIn } = config.values;

    if (config.tokensEnabled && !JwtSecret) {
      log.warn('JwtSecret is not set; using a random one, so logins end when the service restarts.');
    }

    const secret = JwtSecret || randomBytes(32).toString('hex');

    this.jwt = new JwtService({ secret, signOptions: { expiresIn: JwtExpiresIn as `${number}` } });
    this.flowJwt = new JwtService({
      secret: createHmac('sha256', secret).update('watchdog:github-flow').digest('hex'),
      signOptions: { expiresIn: '5m' },
    });
  }

  get enabled(): boolean {
    return this.config.authEnabled;
  }

  get loginEnabled(): boolean {
    return this.config.loginEnabled;
  }

  get githubEnabled(): boolean {
    return this.config.githubEnabled;
  }

  get tokenLifetime(): string {
    return this.config.values.JwtExpiresIn;
  }

  /** A signed token for valid admin credentials, otherwise null. */
  login(username: string, password: string): string | null {
    if (!this.loginEnabled) return null;

    // Compare both, always, so the timing says nothing about which one was wrong.
    const userMatches = safeEqual(username, this.config.values.AdminUser);
    const passwordMatches = safeEqual(password, this.config.values.AdminPassword);

    return userMatches && passwordMatches ? this.jwt.sign({ sub: username }) : null;
  }

  /** A login token for a user GitHub sign-in has already checked against AllowedUserIds. */
  issue(username: string): string {
    return this.jwt.sign({ sub: username });
  }

  signFlow(verifier: string): string {
    return this.flowJwt.sign({ verifier });
  }

  /** The PKCE verifier from a valid, unexpired flow cookie, otherwise null. */
  readFlow(cookie: string | undefined): string | null {
    if (!cookie) return null;

    try {
      const { verifier } = this.flowJwt.verify<{ verifier?: unknown }>(cookie);

      return typeof verifier === 'string' ? verifier : null;
    } catch {
      return null;
    }
  }

  authenticate({ apiKey, token }: Credentials): boolean {
    if (!this.enabled) return true;
    if (apiKey && this.config.values.ApiKey && safeEqual(apiKey, this.config.values.ApiKey)) return true;

    if (token && this.config.tokensEnabled) {
      try {
        this.jwt.verify(token);

        return true;
      } catch {
        return false;
      }
    }

    return false;
  }
}

function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();

  return timingSafeEqual(digest(a), digest(b));
}
