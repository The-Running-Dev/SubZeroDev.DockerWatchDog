import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { loginRequestSchema, type AuthStatus, type LoginResponse } from '@subzerodev/watchdog-shared';
import type { CookieOptions, Request, Response } from 'express';
import { parseBody } from '../common/parse-body.js';
import { ConfigService } from '../config/config.service.js';
import { LogService } from '../logging/log.service.js';
import { AuthService } from './auth.service.js';
import { Public } from './public.decorator.js';
import { SupabaseAuthClient, SupabaseAuthError } from './supabase-auth.client.js';

export const FLOW_COOKIE = 'watchdog_github_flow';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly supabase: SupabaseAuthClient,
    private readonly config: ConfigService,
    private readonly log: LogService,
  ) {}

  /** Lets the UI decide whether to show the login page. */
  @Public()
  @Get('status')
  status(): AuthStatus {
    return {
      authEnabled: this.auth.enabled,
      loginEnabled: this.auth.loginEnabled,
      githubEnabled: this.auth.githubEnabled,
    };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown): LoginResponse {
    if (!this.auth.loginEnabled) throw new NotFoundException('Login is not configured');

    const { username, password } = parseBody(loginRequestSchema, body);
    const token = this.auth.login(username, password);

    if (!token) {
      this.log.warn(`Failed login for '${username}'`);
      throw new UnauthorizedException('Invalid credentials');
    }

    this.log.info(`'${username}' logged in`);

    return { username, token, expiresIn: this.auth.tokenLifetime };
  }

  /** Starts GitHub sign-in: binds a PKCE verifier to this browser, then sends it to Supabase. */
  @Public()
  @Get('github')
  github(@Res() res: Response): void {
    if (!this.auth.githubEnabled) throw new NotFoundException('GitHub sign-in is not configured');

    const { verifier, url } = this.supabase.start();

    res.cookie(FLOW_COOKIE, this.auth.signFlow(verifier), { ...this.flowCookie, maxAge: 5 * 60 * 1000 });
    res.redirect(302, url);
  }

  /**
   * Supabase returns here with a code. Only an allowed user gets a login token, handed to the UI in the URL
   * fragment, which never reaches a server or a log.
   */
  @Public()
  @Get('callback')
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code: unknown,
    @Query('error_description') providerError: unknown,
  ): Promise<void> {
    if (!this.auth.githubEnabled) throw new NotFoundException('GitHub sign-in is not configured');

    const verifier = this.auth.readFlow(readCookie(req, FLOW_COOKIE));

    res.clearCookie(FLOW_COOKIE, this.flowCookie);

    const fail = (message: string) => res.redirect(302, `/login?${new URLSearchParams({ error: message })}`);

    if (typeof providerError === 'string' && providerError) {
      return fail(`GitHub sign-in failed: ${providerError.slice(0, 200)}`);
    }
    if (!verifier) return fail('The sign-in expired or was started in another browser. Try again.');
    if (typeof code !== 'string' || !code || code.length > 1024) return fail('Supabase did not return a sign-in code.');

    let user;

    try {
      user = await this.supabase.finish(code, verifier);
    } catch (error) {
      this.log.warn(`GitHub sign-in failed: ${(error as Error).message}`);

      return fail(error instanceof SupabaseAuthError ? error.message : 'Supabase sent an unexpected answer');
    }

    if (!this.config.values.AllowedUserIds.includes(user.id)) {
      this.log.warn(`GitHub sign-in refused for '${user.name}' (${user.id}): not in AllowedUserIds`);

      return fail(`'${user.name}' is not allowed to use this watchdog.`);
    }

    this.log.info(`'${user.name}' signed in with GitHub`);

    const fragment = new URLSearchParams({ token: this.auth.issue(user.name), username: user.name });

    res.redirect(302, `/login#${fragment}`);
  }

  private get flowCookie(): CookieOptions {
    return {
      path: '/api/auth',
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.values.PublicUrl.startsWith('https:'),
    };
  }
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');

    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}
