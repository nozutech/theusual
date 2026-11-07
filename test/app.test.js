import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';

const running = [];

async function start(overrides = {}) {
  const config = loadConfig({
    ADMIN_PASSWORD: 'una-clave-larga',
    BUSINESS_NAME: 'Prueba',
    LANGUAGE: 'es',
    STAMPS: '3',
    ...overrides,
  });
  const store = new Store(':memory:', { total: config.stamps, hasReward: Boolean(config.reward) });
  const server = await new Promise((resolve) => {
    const listening = createApp({ config, store }).listen(0, '127.0.0.1', () => resolve(listening));
  });
  running.push(server);

  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Pages are not JSON.
    }
    return { status: response.status, json, text, headers: response.headers };
  };
  const login = async () => {
    const response = await call('/api/login', { method: 'POST', body: { password: 'una-clave-larga' } });
    cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
  const join = (name = 'Ana Prueba', phone = '') =>
    call('/api/join', { method: 'POST', body: { name, phone, consent: true } });
  const firstCardId = async () => (await call('/api/cards')).json[0].id;
  return { base, call, join, login, firstCardId };
}

after(() => {
  for (const server of running) {
    server.closeAllConnections();
    server.close();
  }
});

test('refuses to start without a strong enough password', () => {
  assert.throws(() => loadConfig({}), /ADMIN_PASSWORD/);
  assert.throws(() => loadConfig({ ADMIN_PASSWORD: 'admin' }), /ADMIN_PASSWORD/);
});

test('refuses a broken colour or stamp count', () => {
  const good = { ADMIN_PASSWORD: 'una-clave-larga' };
  assert.throws(() => loadConfig({ ...good, BRAND_COLOR: 'red;}' }), /BRAND_COLOR/);
  assert.throws(() => loadConfig({ ...good, ACCENT_COLOR: 'url(x)' }), /ACCENT_COLOR/);
  assert.throws(() => loadConfig({ ...good, STAMPS: '1' }), /STAMPS/);
});

test('a customer can create a card and read it with its token', async () => {
  const { call, join } = await start();
  const { status, json } = await join();
  assert.equal(status, 201);

  const card = await call(`/api/card/${json.token}`);
  assert.equal(card.json.name, 'Ana Prueba');
  assert.equal(card.json.stamps, 0);
});

test('joining needs consent and a name', async () => {
  const { call } = await start();
  const noConsent = await call('/api/join', { method: 'POST', body: { name: 'Ana Prueba' } });
  assert.equal(noConsent.json.error, 'consent');

  const noName = await call('/api/join', { method: 'POST', body: { name: ' ', consent: true } });
  assert.equal(noName.json.error, 'name');
});

test('joining with a phone already in use reveals nothing about its owner', async () => {
  const { call, join } = await start();
  const owner = await join('Ana Prueba', '+34 600 000 001');
  const stranger = await join('Otra Persona', '+34 600 000 001');

  assert.equal(stranger.status, 201);
  assert.notEqual(stranger.json.token, owner.json.token);
  assert.doesNotMatch(stranger.text, /Ana/);

  const card = await call(`/api/card/${stranger.json.token}`);
  assert.equal(card.json.name, 'Otra Persona');
});

test('an unknown card token gets nothing', async () => {
  const { call } = await start();
  assert.equal((await call('/api/card/no-existe')).status, 404);
});

test('staff routes need a session', async () => {
  const { call, join } = await start();
  await join();
  assert.equal((await call('/api/cards')).status, 401);
  assert.equal((await call('/api/cards/1/stamp', { method: 'POST' })).status, 401);
  assert.equal((await call('/api/cards/1', { method: 'DELETE' })).status, 401);
});

test('repeated wrong passwords get blocked', async () => {
  const { call } = await start();
  const attempts = [];
  for (let i = 0; i < 11; i += 1) {
    attempts.push((await call('/api/login', { method: 'POST', body: { password: `mal-${i}` } })).status);
  }
  assert.deepEqual(attempts.slice(0, 10), Array(10).fill(401));
  assert.equal(attempts[10], 429);
});

test('without a reward, a full card simply starts again', async () => {
  const { call, join, login, firstCardId } = await start();
  await join();
  await login();
  const id = await firstCardId();

  const stamp = () => call(`/api/cards/${id}/stamp`, { method: 'POST' });
  await stamp();
  await stamp();
  const full = await stamp();
  assert.equal(full.json.stamps, 3);
  assert.equal(full.json.rewardReady, false);

  const next = await stamp();
  assert.equal(next.json.stamps, 1);
  assert.equal(next.json.rounds, 1);
});

test('with a reward, staff must hand it over before stamping again', async () => {
  const { call, join, login, firstCardId } = await start({ REWARD: 'Un corte gratis' });
  await join();
  await login();
  const id = await firstCardId();

  const stamp = () => call(`/api/cards/${id}/stamp`, { method: 'POST' });
  await stamp();
  await stamp();
  const full = await stamp();
  assert.equal(full.json.rewardReady, true);

  const blocked = await stamp();
  assert.equal(blocked.status, 409);

  const given = await call(`/api/cards/${id}/reward`, { method: 'POST' });
  assert.equal(given.json.stamps, 0);
  assert.equal(given.json.rounds, 1);
});

test('undo reverts a stamp and a reward', async () => {
  const { call, join, login, firstCardId } = await start({ REWARD: 'Un corte gratis' });
  await join();
  await login();
  const id = await firstCardId();

  for (let i = 0; i < 3; i += 1) await call(`/api/cards/${id}/stamp`, { method: 'POST' });
  await call(`/api/cards/${id}/reward`, { method: 'POST' });

  const reward = await call(`/api/cards/${id}/undo`, { method: 'POST' });
  assert.equal(reward.json.stamps, 3);
  assert.equal(reward.json.rounds, 0);

  const stamp = await call(`/api/cards/${id}/undo`, { method: 'POST' });
  assert.equal(stamp.json.stamps, 2);
});

test('undo with no history says so', async () => {
  const { call, join, login, firstCardId } = await start();
  await join();
  await login();
  const undo = await call(`/api/cards/${await firstCardId()}/undo`, { method: 'POST' });
  assert.equal(undo.status, 409);
  assert.equal(undo.json.error, 'nothing');
});

test('search ignores accents and case, and finds by code', async () => {
  const { call, join, login, firstCardId } = await start();
  await join('María Núñez', '600 000 002');
  await login();
  assert.equal((await call('/api/cards?q=maria%20nun')).json.length, 1);
  assert.equal((await call('/api/cards?q=600000')).json.length, 1);

  const card = await call(`/api/cards/${await firstCardId()}`);
  assert.equal((await call(`/api/cards/code/${card.json.code.toLowerCase()}`)).json.name, 'María Núñez');
});

test('staff can see when two cards share a phone', async () => {
  const { call, join, login, firstCardId } = await start();
  await join('Ana Prueba', '600 000 003');
  await join('Ana P', '600 000 003');
  await login();
  assert.equal((await call(`/api/cards/${await firstCardId()}`)).json.samePhone, 1);
});

test('the open card page receives a stamp live', async () => {
  const { base, call, join, login, firstCardId } = await start();
  const { json } = await join();
  await login();

  const controller = new AbortController();
  const stream = await fetch(`${base}/api/card/${json.token}/events`, { signal: controller.signal });
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  await reader.read();

  await call(`/api/cards/${await firstCardId()}/stamp`, { method: 'POST' });
  const { value } = await reader.read();
  controller.abort();
  assert.match(value, /"stamps":1/);
});

test('pages hide the card link from other sites', async () => {
  const { call, join } = await start();
  const { json } = await join();
  const page = await call(`/c/${json.token}`);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
});

test('deleting a card removes it for good', async () => {
  const { call, join, login, firstCardId } = await start();
  const { json } = await join();
  await login();
  const id = await firstCardId();
  await call(`/api/cards/${id}/stamp`, { method: 'POST' });

  assert.equal((await call(`/api/cards/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/card/${json.token}`)).status, 404);
});

test('the accent writes on the page only when it can be read there', async () => {
  const readable = await start({ BRAND_COLOR: '#141216', ACCENT_COLOR: '#f6a823' });
  assert.match((await readable.call('/theme.css')).text, /--leaf:#f6a823;--on-leaf:#16141c/);

  const tooClose = await start({ BRAND_COLOR: '#7a1f3d', ACCENT_COLOR: '#8a2448' });
  assert.match((await tooClose.call('/theme.css')).text, /--leaf:#ffffff;--on-leaf:#16141c/);
});
