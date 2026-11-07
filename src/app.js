import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import QRCode from 'qrcode';
import { createGoogleWallet, logoImageName, stampImageName } from './google-wallet.js';
import { initial, renderLogo, renderStamps } from './stamp-image.js';
import { SESSION_HOURS } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const COOKIE = 'theusual_session';

function digest(text) {
  return createHash('sha256').update(text).digest();
}

function readableOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const light = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return light > 0.55 ? '#16141c' : '#ffffff';
}

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const value = parseInt(hex.slice(i, i + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// The page sits a step away from the card, so the card reads as an object.
function pageOf(color, ink) {
  const channels = [1, 3, 5].map((i) => {
    const [from, to] = [color, ink].map((hex) => parseInt(hex.slice(i, i + 2), 16));
    return Math.round(from + (to - from) * 0.09).toString(16).padStart(2, '0');
  });
  return `#${channels.join('')}`;
}

// Some colour pairs can't carry text: the card then writes in plain ink instead.
const leafOf = ({ accent, color }) => (contrast(accent, color) >= 3 ? accent : readableOn(color));

function contrast(first, second) {
  const [low, high] = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (high + 0.05) / (low + 0.05);
}

function readSession(req) {
  const pair = (req.headers.cookie || '').split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`));
  return pair ? pair.slice(COOKIE.length + 1) : '';
}

function limiter(windowMinutes, limit) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'too_many' },
  });
}

export function createApp({ config, store, google = null }) {
  const app = express();
  const texts = JSON.parse(readFileSync(path.join(ROOT, 'locales', `${config.language}.json`), 'utf8'));
  const secure = config.baseUrl.startsWith('https://');
  const watchers = new Map();
  const wallet = google ? createGoogleWallet({ config, texts, ...google }) : null;
  let walletQueue = Promise.resolve();

  // One at a time, so a slow update can't overwrite a newer one. A Google failure never stops a stamp.
  const queueWallet = (work) => {
    walletQueue = walletQueue.then(work).catch((error) => console.error(`Google Wallet: ${error.message}`));
  };

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    next();
  });
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(PUBLIC, { index: false }));
  app.use('/vendor', express.static(path.join(ROOT, 'node_modules', 'jsqr', 'dist')));
  app.use('/fonts', express.static(path.join(ROOT, 'node_modules', '@fontsource-variable', 'schibsted-grotesk', 'files')));

  const page = (file) => (_req, res) => res.sendFile(file, { root: PUBLIC });
  app.get('/', page('join.html'));
  app.get('/c/:token', page('card.html'));
  app.get('/panel', page('panel.html'));
  app.get('/privacy', page('privacy.html'));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.get('/theme.css', (_req, res) => {
    const onBrand = readableOn(config.color);
    const leaf = leafOf(config);
    res.type('text/css').send(
      `:root{color-scheme:${onBrand === '#ffffff' ? 'dark' : 'light'};` +
      `--brand:${config.color};--on-brand:${onBrand};--page:${pageOf(config.color, onBrand)};` +
      `--accent:${config.accent};--on-accent:${readableOn(config.accent)};` +
      `--leaf:${leaf};--on-leaf:${readableOn(leaf)}}`,
    );
  });

  app.get('/api/site', (_req, res) => {
    res.json({
      businessName: config.businessName,
      contactEmail: config.contactEmail,
      googleWallet: Boolean(wallet),
      language: config.language,
      reward: config.reward,
      stamps: config.stamps,
      texts,
    });
  });

  // Public: customers

  const publicCard = (card) => ({
    code: card.code,
    name: card.name,
    rewardReady: store.rewardReady(card),
    stamps: card.stamps,
  });

  app.post('/api/join', limiter(60, 30), (req, res) => {
    const name = String(req.body?.name ?? '').trim().replace(/\s+/g, ' ');
    const phone = String(req.body?.phone ?? '').trim();
    if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'name' });
    if (phone && !/^\+?[\d\s().-]{7,20}$/.test(phone)) return res.status(400).json({ error: 'phone' });
    if (req.body?.consent !== true) return res.status(400).json({ error: 'consent' });

    // Never check for an existing customer here: the answer would reveal who is registered.
    const card = store.createCard({ name, phone });
    res.status(201).json({ token: card.token });
  });

  const cardFromToken = (req, res, next) => {
    req.card = store.byToken(req.params.token);
    if (!req.card) return res.status(404).json({ error: 'not_found' });
    next();
  };

  app.get('/api/card/:token', cardFromToken, (req, res) => res.json(publicCard(req.card)));

  app.get('/api/card/:token/qr.svg', cardFromToken, async (req, res) => {
    const svg = await QRCode.toString(req.card.code, { type: 'svg', margin: 1 });
    res.type('image/svg+xml').send(svg);
  });

  app.get('/api/card/:token/events', cardFromToken, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(': connected\n\n');

    const id = req.card.id;
    if (!watchers.has(id)) watchers.set(id, new Set());
    watchers.get(id).add(res);

    req.on('close', () => {
      watchers.get(id)?.delete(res);
      if (!watchers.get(id)?.size) watchers.delete(id);
    });
  });

  app.get('/api/card/:token/google-wallet', limiter(60, 30), cardFromToken, async (req, res) => {
    if (!wallet) return res.status(404).json({ error: 'not_found' });
    try {
      const url = await wallet.saveUrl(req.card);
      store.markGooglePass(req.card.id);
      res.redirect(url);
    } catch (error) {
      console.error(`Google Wallet: ${error.message}`);
      res.redirect(`/c/${req.card.token}?wallet=failed`);
    }
  });

  if (wallet) {
    const images = new Map();
    const look = {
      brand: config.color,
      accent: config.accent,
      leaf: leafOf(config),
      onAccent: readableOn(config.accent),
      onBrand: readableOn(config.color),
      letter: initial(config.businessName),
    };
    const label = texts.card_of.replace('{total}', config.stamps);
    const drawings = new Map([[logoImageName(config), () => renderLogo(look)]]);
    for (let filled = 0; filled <= config.stamps; filled += 1) {
      drawings.set(stampImageName(config, filled), () => renderStamps({ ...look, filled, total: config.stamps, label }));
    }

    app.get('/wallet/stamps/:file', (req, res) => {
      const { file } = req.params;
      if (!drawings.has(file)) return res.status(404).json({ error: 'not_found' });
      if (!images.has(file)) images.set(file, drawings.get(file)());
      res.set('Cache-Control', 'public, max-age=31536000, immutable').type('png').send(images.get(file));
    });
  }

  const notify = (card) => {
    const message = `data: ${JSON.stringify(publicCard(card))}\n\n`;
    for (const watcher of watchers.get(card.id) ?? []) watcher.write(message);
  };

  // Staff

  app.post('/api/login', limiter(15, 10), (req, res) => {
    const given = digest(String(req.body?.password ?? ''));
    if (!timingSafeEqual(given, digest(config.adminPassword))) {
      return res.status(401).json({ error: 'password' });
    }
    const flags = `HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure ? '; Secure' : ''}`;
    res.set('Set-Cookie', `${COOKIE}=${store.createSession()}; ${flags}`).json({ ok: true });
  });

  const staff = (req, res, next) => {
    const session = readSession(req);
    if (!session || !store.hasSession(session)) return res.status(401).json({ error: 'login' });
    next();
  };

  app.post('/api/logout', staff, (req, res) => {
    store.dropSession(readSession(req));
    res.set('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`).json({ ok: true });
  });

  const summary = (card) => ({
    id: card.id,
    name: card.name,
    phone: card.phone,
    rewardReady: store.rewardReady(card),
    stamps: card.stamps,
  });

  const detail = (card) => ({
    ...summary(card),
    code: card.code,
    history: store.history(card.id),
    rounds: card.rounds,
    samePhone: store.samePhoneCount(card),
    url: `${config.baseUrl}/c/${card.token}`,
  });

  app.get('/api/cards', staff, (req, res) => {
    res.json(store.search(String(req.query.q ?? '')).map(summary));
  });

  app.get('/api/cards/code/:code', staff, (req, res) => {
    const card = store.byCode(req.params.code);
    if (!card) return res.status(404).json({ error: 'not_found' });
    res.json(detail(card));
  });

  app.get('/api/cards/:id', staff, (req, res) => {
    const card = store.byId(Number(req.params.id));
    if (!card) return res.status(404).json({ error: 'not_found' });
    res.json(detail(card));
  });

  const change = (action, refusal) => (req, res) => {
    const result = store[action](Number(req.params.id));
    if (!result) return res.status(404).json({ error: 'not_found' });
    if (result[refusal]) return res.status(409).json({ error: refusal, card: detail(result.card) });
    notify(result.card);
    if (wallet && store.hasGooglePass(result.card.id)) {
      queueWallet(() => {
        const latest = store.byId(result.card.id);
        return latest && wallet.update(latest);
      });
    }
    res.json(detail(result.card));
  };

  app.post('/api/cards/:id/stamp', staff, change('addStamp', 'rewardPending'));
  app.post('/api/cards/:id/reward', staff, change('giveReward', 'notReady'));
  app.post('/api/cards/:id/undo', staff, change('undo', 'nothing'));

  app.delete('/api/cards/:id', staff, (req, res) => {
    const card = store.byId(Number(req.params.id));
    if (!card) return res.status(404).json({ error: 'not_found' });

    const saved = wallet && store.hasGooglePass(card.id);
    store.remove(card.id);
    if (saved) queueWallet(() => wallet.retire(card));
    res.json({ ok: true });
  });

  return app;
}
