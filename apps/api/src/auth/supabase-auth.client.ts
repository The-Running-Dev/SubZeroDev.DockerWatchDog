import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ConfigService } from '../config/config.service.js';

const tokenResponse = z.object({ access_token: z.string().min(1).max(4096) });
const userResponse = z.object({
  id: z.string().uuid(),
  email: z.string().optional(),
  user_metadata: z.object({ user_name: z.string().optional() }).passthrough().optional(),
});

export interface SupabaseUser {
  id: string;
  /** The GitHub login when Supabase has it, else the email, else the ID. */
  name: string;
}

/** Supabase's error, or an answer that is not what Auth sends. Its message is safe to show. */
export class SupabaseAuthError extends Error {}

/**
 * The GitHub step of the Dashboard's Supabase sign-in: /authorize?provider=github with PKCE, then
 * /token?grant_type=pkce and /user with the publishable key. Nothing is stored at Supabase's side.
 */
@Injectable()
export class SupabaseAuthClient {
  /** Replaced in tests. */
  fetch: typeof fetch = (...args) => fetch(...args);

  constructor(private readonly config: ConfigService) {}

  get callbackUrl(): string {
    return `${this.config.values.PublicUrl}/api/auth/callback`;
  }

  /** A new PKCE verifier and the authorize URL that carries its challenge. */
  start(): { verifier: string; url: string } {
    const verifier = randomBytes(32).toString('base64url');
    const url = new URL(`${this.base}/authorize`);

    url.searchParams.set('provider', 'github');
    url.searchParams.set('redirect_to', this.callbackUrl);
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 's256');

    return { verifier, url: url.href };
  }

  /** Exchanges the code for an access token and returns the signed-in user. */
  async finish(code: string, verifier: string): Promise<SupabaseUser> {
    const { access_token } = tokenResponse.parse(
      await this.call('/token?grant_type=pkce', { body: { auth_code: code, code_verifier: verifier } }),
    );
    const user = userResponse.parse(await this.call('/user', { access: access_token }));

    return { id: user.id, name: user.user_metadata?.user_name || user.email || user.id };
  }

  private get base(): string {
    return `${this.config.values.SupabaseUrl}/auth/v1`;
  }

  private async call(path: string, { body, access }: { body?: unknown; access?: string }): Promise<unknown> {
    let response: Response;

    try {
      response = await this.fetch(`${this.base}${path}`, {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          apikey: this.config.values.SupabasePublishableKey,
          ...(access ? { authorization: `Bearer ${access}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new SupabaseAuthError('Supabase did not answer');
    }

    const text = (await response.text()).slice(0, 64 * 1024);

    if (!response.ok) throw new SupabaseAuthError(`Supabase refused the sign-in (HTTP ${response.status})`);

    try {
      return JSON.parse(text);
    } catch {
      throw new SupabaseAuthError('Supabase sent an unreadable answer');
    }
  }
}
