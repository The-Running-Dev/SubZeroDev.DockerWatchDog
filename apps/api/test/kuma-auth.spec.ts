import { EventEmitter2 } from '@nestjs/event-emitter';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WatchdogEvents } from '../src/events.js';
import { container, createTestApp, type TestApp } from './helpers.js';

const KEY = 'kuma-test-key';
const ADMIN = { AdminUser: 'test-admin', AdminPassword: 'test-password', JwtSecret: 'test-secret' };
const DOWN = { monitor: { name: 'Display name', description: 'container-plex' }, heartbeat: { status: 0 } };

describe('Authenticated Uptime Kuma POST /restart', () => {
  let t: TestApp | undefined;

  afterEach(async () => {
    await t?.app.close();
    t = undefined;
  });

  async function setup(config: Parameters<typeof createTestApp>[0] = { ApiKey: KEY }) {
    const app = await createTestApp(config);

    t = app;
    app.docker.containers = [container('plex')];
    app.runner.calls.length = 0;

    const events = vi.fn();

    app.app.get(EventEmitter2).on(WatchdogEvents.Restart, events);

    const post = () => request(app.app.getHttpServer()).post('/restart');

    return { post, withKey: () => post().set('x-api-key', KEY), runner: app.runner, events };
  }

  it.each([
    { mode: 'API key only', config: { ApiKey: KEY } },
    { mode: 'API key and browser login', config: { ApiKey: KEY, ...ADMIN } },
  ])('restarts the description-selected target once with $mode', async ({ config }) => {
    const { withKey, runner, events } = await setup(config);

    await withKey().send(DOWN).expect(200, { status: 'plex Restarted' });
    expect(runner.calls).toEqual([expect.objectContaining({ file: 'docker', args: ['restart', 'plex'] })]);
    expect(events).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ target: 'plex', source: 'uptime-kuma', success: true }),
    );
  });

  it('rejects missing or invalid credentials before running or reporting a restart', async () => {
    const { post, runner, events } = await setup({ ApiKey: KEY, ...ADMIN });

    await post().send(DOWN).expect(401);
    await post().set('x-api-key', 'wrong').send(DOWN).expect(401);
    await post().set('authorization', 'Bearer invalid').send(DOWN).expect(401);
    expect(runner.calls).toEqual([]);
    expect(events).not.toHaveBeenCalled();
  });

  it('does not grant keyless access in browser-login-only mode', async () => {
    const { post, withKey, runner, events } = await setup(ADMIN);

    await post().send(DOWN).expect(401);
    await withKey().send(DOWN).expect(401);
    expect(runner.calls).toEqual([]);
    expect(events).not.toHaveBeenCalled();
  });

  it('accepts the notification test and ignores recovery without restarting', async () => {
    const { post, withKey, runner, events } = await setup();
    const test = { msg: 'Test notification', monitor: null, heartbeat: null };

    await post().send(test).expect(401);
    await withKey().send(test).expect(200, { status: 'healthy' });
    await withKey()
      .send({ monitor: { name: 'plex' }, heartbeat: { status: 1 } })
      .expect(200, { message: 'Ignored plex, Status: 1' });
    expect(runner.calls).toEqual([]);
    expect(events).not.toHaveBeenCalled();
  });

  it('rejects invalid payloads and unknown targets without restarting', async () => {
    const { withKey, runner, events } = await setup();

    await withKey().send({}).expect(400, { error: 'No JSON Received' });
    await withKey()
      .send({ ...DOWN, monitor: { name: 'missing' } })
      .expect(404, { error: 'container_not_found', details: "Container 'missing' Not Found", container: 'missing' });
    expect(runner.calls).toEqual([]);
    expect(events).not.toHaveBeenCalled();
  });

  it('reports Docker failure and allows a later restart selected by monitor name', async () => {
    const { withKey, runner, events } = await setup();
    const body = { ...DOWN, monitor: { name: 'plex' } };

    runner.failNext('daemon failed');
    await withKey().send(body).expect(500, { error: 'failed', details: 'daemon failed', container: 'plex' });
    expect(events).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ target: 'plex', success: false }));

    await withKey().send(body).expect(200, { status: 'plex Restarted' });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['restart', 'plex'],
      ['restart', 'plex'],
    ]);
    expect(events).toHaveBeenLastCalledWith(expect.objectContaining({ target: 'plex', success: true }));
  });

  it('rejects an overlapping request for the same container without a second command', async () => {
    const { withKey, runner, events } = await setup();
    let finish: (() => void) | undefined;

    const run = vi.spyOn(runner, 'run').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ code: 0, stdout: '', stderr: '' });
        }),
    );
    const first = withKey()
      .send(DOWN)
      .expect(200)
      .then((response) => response);

    try {
      await Promise.race([
        vi.waitFor(() => expect(finish).toBeDefined()),
        first.then(() => {
          throw new Error('Restart finished before Docker ran');
        }),
      ]);
      await withKey().send(DOWN).expect(409);
      expect(run).toHaveBeenCalledTimes(1);
      expect(events).not.toHaveBeenCalled();
    } finally {
      finish?.();
      await first;
    }

    expect(events).toHaveBeenCalledTimes(1);
  });
});
