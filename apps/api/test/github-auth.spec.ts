import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { SupabaseAuthClient } from '../src/auth/supabase-auth.client.js';
import { createTestApp, type TestApp } from './helpers.js';

const OWNER = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const GITHUB = {
  SupabaseUrl: 'https://project.supabase.co/auth/v1',
  SupabasePublishableKey: 'sb_publishable_test',
  AllowedUserIds: [OWNER],
  PublicUrl: 'https://watchdog.example.com',
  JwtSecret: 'test-secret',
};

interface FakeCall {
  url: string;
  init?: RequestInit;
}

type Server = Parameters<typeof request>[0];

/** Answers Supabase's /token and /user like Auth does, for the given user. */
function fakeSupabase(
  t: TestApp,
  user: Record<string, unknown> = { id: OWNER, user_metadata: { user_name: 'octocat' } },
) {
  const calls: FakeCall[] = [];

  t.app.get(SupabaseAuthClient).fetch = async (input, init) => {
    const url = String(input);

    calls.push({ url, init });

    if (url.includes('/token?grant_type=pkce')) return Response.json({ access_token: 'supabase-access' });
    if (url.endsWith('/user')) return Response.json(user);

    return new Response('not found', { status: 404 });
  };

  return calls;
}

function setCookie(res: request.Response): string {
  return ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0] ?? '';
}

/** Starts the flow; returns the flow cookie (name=value) and the Supabase authorize URL. */
async function startFlow(server: Server): Promise<{ cookie: string; location: URL }> {
  const res = await request(server).get('/api/auth/github').expect(302);

  return { cookie: setCookie(res).split(';')[0] ?? '', location: new URL(String(res.headers.location)) };
}

function errorOf(res: request.Response): string | null {
  return new URL(String(res.headers.location), 'http://x').searchParams.get('error');
}

describe('GitHub sign-in', () => {
  let t: TestApp | undefined;

  afterEach(async () => {
    await t?.app.close();
    t = undefined;
  });

  it('is off until all of its settings are set', async () => {
    t = await createTestApp({ ...GITHUB, AllowedUserIds: [] });
    const server = t.app.getHttpServer();

    await request(server)
      .get('/api/auth/status')
      .expect(200, { authEnabled: false, loginEnabled: false, githubEnabled: false });
    await request(server).get('/api/auth/github').expect(404);
    await request(server).get('/api/auth/callback?code=x').expect(404);
  });

  it('sends the browser to Supabase with a PKCE challenge and a flow cookie', async () => {
    t = await createTestApp(GITHUB);
    const server = t.app.getHttpServer();

    await request(server)
      .get('/api/auth/status')
      .expect(200, { authEnabled: true, loginEnabled: false, githubEnabled: true });

    const res = await request(server).get('/api/auth/github').expect(302);
    const location = new URL(String(res.headers.location));
    const cookie = setCookie(res);

    expect(location.origin + location.pathname).toBe('https://project.supabase.co/auth/v1/authorize');
    expect(Object.fromEntries(location.searchParams)).toEqual({
      provider: 'github',
      redirect_to: 'https://watchdog.example.com/api/auth/callback',
      code_challenge: expect.stringMatching(/^[\w-]{43}$/),
      code_challenge_method: 's256',
    });
    expect(cookie).toMatch(/^watchdog_github_flow=/);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it('signs in an allowed user and hands the UI a working token', async () => {
    t = await createTestApp(GITHUB);
    const server = t.app.getHttpServer();
    const calls = fakeSupabase(t);
    const { cookie, location } = await startFlow(server);

    await request(server).get('/api/projects').expect(401);

    const res = await request(server).get('/api/auth/callback?code=the-code').set('cookie', cookie).expect(302);
    const [path, fragment] = String(res.headers.location).split('#');
    const handoff = new URLSearchParams(fragment);

    expect(path).toBe('/login');
    expect(handoff.get('username')).toBe('octocat');
    expect(setCookie(res)).toMatch(/^watchdog_github_flow=;/);

    // The verifier sent to /token matches the challenge sent to /authorize.
    const exchange = JSON.parse(String(calls[0]!.init?.body)) as { auth_code: string; code_verifier: string };

    expect(calls[0]!.url).toBe('https://project.supabase.co/auth/v1/token?grant_type=pkce');
    expect(exchange.auth_code).toBe('the-code');
    expect(createHash('sha256').update(exchange.code_verifier).digest('base64url')).toBe(
      location.searchParams.get('code_challenge'),
    );
    expect((calls[0]!.init?.headers as Record<string, string>).apikey).toBe('sb_publishable_test');
    expect((calls[1]!.init?.headers as Record<string, string>).authorization).toBe('Bearer supabase-access');

    await request(server)
      .get('/api/projects')
      .set('authorization', `Bearer ${handoff.get('token')}`)
      .expect(200);
  });

  it('refuses a user who is not in AllowedUserIds', async () => {
    t = await createTestApp(GITHUB);
    const server = t.app.getHttpServer();

    fakeSupabase(t, { id: '00000000-0000-4000-8000-000000000000', email: 'someone@example.com' });

    const { cookie } = await startFlow(server);
    const res = await request(server).get('/api/auth/callback?code=c').set('cookie', cookie).expect(302);

    expect(String(res.headers.location)).not.toContain('#');
    expect(errorOf(res)).toMatch(/someone@example\.com.*not allowed/);
  });

  it('refuses a callback without the flow cookie, or with a provider error', async () => {
    t = await createTestApp(GITHUB);
    const server = t.app.getHttpServer();
    const calls = fakeSupabase(t);

    expect(errorOf(await request(server).get('/api/auth/callback?code=c').expect(302))).toMatch(/expired/);

    const { cookie } = await startFlow(server);
    const denied = await request(server)
      .get('/api/auth/callback?error=access_denied&error_description=User+denied')
      .set('cookie', cookie)
      .expect(302);

    expect(errorOf(denied)).toBe('GitHub sign-in failed: User denied');
    expect(calls).toHaveLength(0);
  });

  it('reports a Supabase failure without its details', async () => {
    t = await createTestApp(GITHUB);
    const server = t.app.getHttpServer();

    t.app.get(SupabaseAuthClient).fetch = async () => new Response('{"msg":"secret detail"}', { status: 400 });

    const { cookie } = await startFlow(server);
    const res = await request(server).get('/api/auth/callback?code=c').set('cookie', cookie).expect(302);

    expect(errorOf(res)).toBe('Supabase refused the sign-in (HTTP 400)');
  });

  it('never accepts the flow cookie as a login token', async () => {
    t = await createTestApp(GITHUB);
    const server = t.app.getHttpServer();
    const { cookie } = await startFlow(server);
    const flowToken = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));

    expect(flowToken).not.toBe('');
    await request(server).get('/api/projects').set('authorization', `Bearer ${flowToken}`).expect(401);
  });
});
