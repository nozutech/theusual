import { createHash, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { initial } from './stamp-image.js';

const API = 'https://walletobjects.googleapis.com/walletobjects/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';
const TIMEOUT_MS = 10_000;

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const seconds = () => Math.floor(Date.now() / 1000);

function signJwt(claims, privateKey) {
  const body = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey, 'base64url')}`;
}

export function readGoogleKey(file) {
  let key;
  try {
    key = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // The parser's message can quote the file, and this file holds a private key.
    throw new Error(`GOOGLE_WALLET_KEY_FILE can't be read as JSON: ${file}`);
  }
  if (!key.client_email || !key.private_key) {
    throw new Error(`GOOGLE_WALLET_KEY_FILE isn't a service account key: ${file}`);
  }
  return key;
}

const DESIGN = 3;

// The name changes with the look of the card, so Google never shows a cached old image.
const lookOf = (config) => createHash('sha256')
  .update(`${DESIGN}${config.language}${config.color}${config.accent}${config.stamps}${initial(config.businessName)}`)
  .digest('hex')
  .slice(0, 8);

export const stampImageName = (config, stamps) => `${lookOf(config)}-${stamps}.png`;
export const logoImageName = (config) => `${lookOf(config)}-logo.png`;

export function createGoogleWallet({ config, texts, key, request = fetch }) {
  const { issuerId, classSuffix } = config.googleWallet;
  const classId = `${issuerId}.${classSuffix}`;
  const objectId = (card) => `${classId}-${card.code}`;
  const localized = (value) => ({ defaultValue: { language: config.language, value } });
  let token = null;

  const accessToken = async () => {
    const now = seconds();
    if (token && token.expires > now + 60) return token.value;

    const assertion = signJwt(
      { iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 },
      key.private_key,
    );
    const response = await request(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`sign-in failed with status ${response.status}`);

    const { access_token: value, expires_in: lifetime } = await response.json();
    token = { value, expires: now + lifetime };
    return value;
  };

  const send = async (method, path, body) => {
    const response = await request(`${API}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok || response.status === 409) return response.status;
    const reason = (await response.text()).slice(0, 300);
    throw new Error(`${method} ${path} failed with status ${response.status}: ${reason}`);
  };

  const save = async (collection, body) => {
    const status = await send('POST', collection, body);
    if (status === 409) await send('PATCH', `${collection}/${encodeURIComponent(body.id)}`, body);
  };

  const row = (id) => ({ firstValue: { fields: [{ fieldPath: `object.textModulesData["${id}"]` }] } });

  const passClass = () => ({
    id: classId,
    classTemplateInfo: {
      cardTemplateOverride: {
        cardRowTemplateInfos: [
          config.reward
            ? { twoItems: { startItem: row('stamps'), endItem: row('reward') } }
            : { oneItem: { item: row('stamps') } },
        ],
      },
    },
  });

  const { imagesUrl } = config.googleWallet;

  const progress = (card) => {
    const stamps = Math.min(card.stamps, config.stamps);
    return {
      // Google only downloads images from public HTTPS addresses.
      ...(imagesUrl.startsWith('https://') && {
        heroImage: {
          sourceUri: { uri: `${imagesUrl}/wallet/stamps/${stampImageName(config, stamps)}` },
          contentDescription: localized(`${stamps} / ${config.stamps}`),
        },
      }),
      textModulesData: [
        { id: 'stamps', header: texts.wallet_stamps, body: `${stamps} / ${config.stamps}` },
        ...(config.reward ? [{ id: 'reward', header: texts.wallet_reward, body: config.reward }] : []),
      ],
    };
  };

  const logo = () => (imagesUrl.startsWith('https://') ? {
    logo: {
      sourceUri: { uri: `${imagesUrl}/wallet/stamps/${logoImageName(config)}` },
      contentDescription: localized(config.businessName),
    },
  } : {});

  const passObject = (card) => ({
    id: objectId(card),
    classId,
    state: 'ACTIVE',
    cardTitle: localized(config.businessName),
    header: localized(card.name),
    subheader: localized(texts.card_label),
    hexBackgroundColor: config.color,
    barcode: { type: 'QR_CODE', value: card.code, alternateText: card.code },
    linksModuleData: { uris: [{ id: 'credit', uri: 'https://nozutech.dev', description: texts.credit }] },
    ...logo(),
    ...progress(card),
  });

  return {
    async saveUrl(card) {
      await save('genericClass', passClass());
      await save('genericObject', passObject(card));
      const claims = {
        iss: key.client_email,
        aud: 'google',
        typ: 'savetowallet',
        iat: seconds(),
        origins: [],
        payload: { genericObjects: [{ id: objectId(card) }] },
      };
      return `https://pay.google.com/gp/v/save/${signJwt(claims, key.private_key)}`;
    },

    update(card) {
      return send('PATCH', `genericObject/${encodeURIComponent(objectId(card))}`, progress(card));
    },

    // Google has no way to delete a pass, so it expires and loses the customer's name.
    retire(card) {
      return send('PATCH', `genericObject/${encodeURIComponent(objectId(card))}`, {
        state: 'EXPIRED',
        header: localized(config.businessName),
      });
    },
  };
}
