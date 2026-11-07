import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { logoImageName, readGoogleKey, stampImageName } from '../src/google-wallet.js';
import { Store } from '../src/store.js';

const API = 'https://walletobjects.googleapis.com/walletobjects/v1';
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const key = { client_email: 'theusual@example.iam.gserviceaccount.com', private_key: privateKey };
const running = [];

function fakeGoogle(answer = () => 200) {
  const calls = [];
  const request = async (url, options) => {
    if (url.startsWith('https://oauth2.googleapis.com/')) {
      calls.push({ method: 'TOKEN', assertion: options.body.get('assertion') });
      return Response.json({ access_token: 'fake-token', expires_in: 3600 });
    }
    const call = { method: options.method, path: url.replace(`${API}/`, ''), body: JSON.parse(options.body) };
    calls.push(call);
    return new Response('{}', { status: answer(call) });
  };
  return { calls, request };
}

async function start({ google = fakeGoogle(), env = {} } = {}) {
  const config = loadConfig({
    ADMIN_PASSWORD: 'una-clave-larga',
    BASE_URL: 'https://theusual.example',
    BUSINESS_NAME: 'Prueba',
    GOOGLE_WALLET_ISSUER_ID: '3388000000000000000',
    LANGUAGE: 'es',
    STAMPS: '3',
    ...env,
  });
  const store = new Store(':memory:', { total: config.stamps, hasReward: Boolean(config.reward) });
  const app = createApp({ config, store, google: config.googleWallet ? { key, request: google.request } : null });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  running.push(server);

  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = (route, { method = 'GET', body } = {}) => fetch(base + route, {
    method,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const login = async () => {
    const response = await call('/api/login', { method: 'POST', body: { password: 'una-clave-larga' } });
    cookie = response.headers.get('set-cookie').split(';')[0];
  };
  const join = async (name = 'Ana Prueba', phone = '600000001') => {
    const response = await call('/api/join', { method: 'POST', body: { name, phone, consent: true } });
    return (await response.json()).token;
  };
  const save = (token) => call(`/api/card/${token}/google-wallet`);
  const firstCardId = async () => (await (await call('/api/cards')).json())[0].id;
  return { call, calls: google.calls, config, firstCardId, join, login, save };
}

async function until(check) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('It never happened.');
}

function readPng(buffer) {
  assert.deepEqual([...buffer.subarray(1, 4)], [...Buffer.from('PNG')]);
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const parts = [];
  for (let at = 8; at < buffer.length;) {
    const length = buffer.readUInt32BE(at);
    if (buffer.toString('latin1', at + 4, at + 8) === 'IDAT') parts.push(buffer.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const rows = inflateSync(Buffer.concat(parts));
  const pixel = (x, y) => [...rows.subarray(y * (width * 4 + 1) + 1 + x * 4).subarray(0, 4)];
  return { width, height, pixel };
}

after(() => running.forEach((server) => server.close()));

test('without an issuer ID, The Usual works and offers no Wallet', async () => {
  const { call, join } = await start({ env: { GOOGLE_WALLET_ISSUER_ID: '' } });
  const token = await join();

  assert.equal((await (await call('/api/site')).json()).googleWallet, false);
  assert.equal((await call(`/api/card/${token}/google-wallet`)).status, 404);
});

test('saving creates the pass and sends the customer to a signed Google link', async () => {
  const { call, calls, join, save } = await start();
  assert.equal((await (await call('/api/site')).json()).googleWallet, true);

  const token = await join();
  const response = await save(token);
  assert.equal(response.status, 302);

  const link = response.headers.get('location');
  assert.ok(link.startsWith('https://pay.google.com/gp/v/save/'));
  const [header, claims, signature] = link.split('/').pop().split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, signature, 'base64url'));

  const { aud, iss, payload, typ } = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(aud, 'google');
  assert.equal(typ, 'savetowallet');
  assert.equal(iss, key.client_email);

  const pass = calls.find((item) => item.path === 'genericObject').body;
  assert.equal(payload.genericObjects[0].id, pass.id);
  assert.equal(calls.find((item) => item.path === 'genericClass').body.id, '3388000000000000000.theusual');
  assert.equal(pass.classId, '3388000000000000000.theusual');
  assert.equal(pass.header.defaultValue.value, 'Ana Prueba');
  assert.equal(pass.heroImage.sourceUri.uri.startsWith('https://theusual.example/wallet/stamps/'), true);
  assert.equal(pass.logo.sourceUri.uri.endsWith('-logo.png'), true);
  assert.equal(pass.textModulesData[0].body, '0 / 3');
});

test('Google only receives what the pass needs', async () => {
  const { calls, join, save } = await start();
  const token = await join();
  await save(token);

  const sent = JSON.stringify(calls.filter((item) => item.body));
  assert.ok(!sent.includes(token));
  assert.ok(!sent.includes('600000001'));
});

test('the pass uses the same code the staff scanner reads', async () => {
  const { call, calls, join, save } = await start();
  const token = await join();
  await save(token);

  const { code } = await (await call(`/api/card/${token}`)).json();
  assert.equal(calls.find((item) => item.path === 'genericObject').body.barcode.value, code);
});

test('saving again updates the pass that already exists', async () => {
  const google = fakeGoogle(({ method }) => (method === 'POST' ? 409 : 200));
  const { calls, join, save } = await start({ google });

  assert.equal((await save(await join())).status, 302);
  assert.ok(calls.some(({ method, path: route }) => method === 'PATCH' && route.startsWith('genericObject/')));
});

test('a stamp reaches saved passes, and only those', async () => {
  const { call, calls, firstCardId, join, login, save } = await start();
  await join('Sin Wallet');
  await login();
  const unsaved = await firstCardId();
  await call(`/api/cards/${unsaved}/stamp`, { method: 'POST' });

  await save(await join('Con Wallet'));
  const saved = await firstCardId();
  await call(`/api/cards/${saved}/stamp`, { method: 'POST' });
  await call(`/api/cards/${saved}/stamp`, { method: 'POST' });
  await call(`/api/cards/${saved}/undo`, { method: 'POST' });

  const updates = () => calls.filter(({ method }) => method === 'PATCH');
  await until(() => updates().length === 3);
  assert.deepEqual(updates().map(({ body }) => body.textModulesData[0].body), ['1 / 3', '2 / 3', '1 / 3']);
});

test('a Google failure never stops a stamp', async () => {
  const google = fakeGoogle(({ method }) => (method === 'PATCH' ? 500 : 200));
  const { call, calls, firstCardId, join, login, save } = await start({ google });
  await save(await join());
  await login();

  const response = await call(`/api/cards/${await firstCardId()}/stamp`, { method: 'POST' });
  assert.equal(response.status, 200);
  await until(() => calls.some(({ method }) => method === 'PATCH'));
});

test('when Google refuses a save, the customer goes back to the card', async () => {
  const google = fakeGoogle(() => 403);
  const { join, save } = await start({ google });
  const token = await join();

  assert.equal((await save(token)).headers.get('location'), `/c/${token}?wallet=failed`);
});

test('deleting a card expires its pass and removes the name', async () => {
  const { call, calls, firstCardId, join, login, save } = await start();
  await save(await join());
  await login();
  await call(`/api/cards/${await firstCardId()}`, { method: 'DELETE' });

  await until(() => calls.some(({ method }) => method === 'PATCH'));
  const { body } = calls.find(({ method }) => method === 'PATCH');
  assert.equal(body.state, 'EXPIRED');
  assert.equal(body.header.defaultValue.value, 'Prueba');
});

test('the images can live on another address, and card links keep the public one', async () => {
  const { calls, config, join, save } = await start({ env: { GOOGLE_WALLET_IMAGES_URL: 'https://images.example/' } });
  await save(await join());

  const pass = calls.find((item) => item.path === 'genericObject').body;
  assert.equal(pass.heroImage.sourceUri.uri.startsWith('https://images.example/wallet/stamps/'), true);
  assert.equal(pass.logo.sourceUri.uri.startsWith('https://images.example/wallet/stamps/'), true);
  assert.equal(config.baseUrl, 'https://theusual.example');
});

test('the stamp image fills one bar per stamp, over a transparent background', async () => {
  const { call, config } = await start();
  const image = async (stamps) => {
    const response = await call(`/wallet/stamps/${stampImageName(config, stamps)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    return readPng(Buffer.from(await response.arrayBuffer()));
  };
  const empty = await image(0);
  const stamped = await image(1);

  assert.equal(empty.width, 1032);
  const firstBar = [120, empty.height - 80];
  assert.notDeepEqual(stamped.pixel(...firstBar), empty.pixel(...firstBar));
  assert.equal(empty.pixel(...firstBar)[3], 255);
  assert.equal(stamped.pixel(4, stamped.height - 4)[3], 0);
});

test('the logo carries the first letter of the business', async () => {
  const { call, config } = await start();
  const response = await call(`/wallet/stamps/${logoImageName(config)}`);
  assert.equal(response.status, 200);

  const { width, height, pixel } = readPng(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual([width, height], [660, 660]);
  assert.equal(pixel(4, 4)[3], 255);
});

test('a business name without a drawable letter still gets its images', async () => {
  const { call, config } = await start({ env: { BUSINESS_NAME: '東京' } });

  assert.equal((await call(`/wallet/stamps/${stampImageName(config, 1)}`)).status, 200);
  assert.equal((await call(`/wallet/stamps/${logoImageName(config)}`)).status, 200);
});

test('stamp images outside the card, or from another look, do not exist', async () => {
  const { call, config } = await start();

  assert.equal((await call(`/wallet/stamps/${stampImageName(config, 4)}`)).status, 404);
  assert.equal((await call('/wallet/stamps/00000000-1.png')).status, 404);
  assert.equal((await call('/wallet/stamps/nada.png')).status, 404);
});

test('a broken key file stops The Usual without showing its contents', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'theusual-'));
  const broken = path.join(folder, 'broken.json');
  writeFileSync(broken, 'PRIVATE-KEY-MATERIAL');
  assert.throws(() => readGoogleKey(broken), (error) => !error.message.includes('PRIVATE-KEY-MATERIAL'));

  const incomplete = path.join(folder, 'incomplete.json');
  writeFileSync(incomplete, '{"type":"service_account"}');
  assert.throws(() => readGoogleKey(incomplete), /service account/);
});

test('the issuer ID and card type are checked at start', () => {
  const base = { ADMIN_PASSWORD: 'una-clave-larga' };

  assert.throws(() => loadConfig({ ...base, GOOGLE_WALLET_ISSUER_ID: 'abc' }), /ISSUER_ID/);
  assert.throws(() => loadConfig({ ...base, GOOGLE_WALLET_ISSUER_ID: '1', GOOGLE_WALLET_CLASS: 'a b' }), /CLASS/);
  assert.equal(loadConfig(base).googleWallet, null);
});
