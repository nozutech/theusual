const LANGUAGES = ['es', 'en'];

export function loadConfig(env = process.env) {
  const adminPassword = env.ADMIN_PASSWORD ?? '';
  if (adminPassword.length < 10) {
    throw new Error('ADMIN_PASSWORD is required and must have at least 10 characters.');
  }

  const color = env.BRAND_COLOR || '#141216';
  const accent = env.ACCENT_COLOR || '#f6a823';
  for (const [name, value] of [['BRAND_COLOR', color], ['ACCENT_COLOR', accent]]) {
    if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} must look like #141216.`);
  }

  const stamps = Number(env.STAMPS || 10);
  if (!Number.isInteger(stamps) || stamps < 3 || stamps > 20) {
    throw new Error('STAMPS must be a whole number between 3 and 20.');
  }

  const language = env.LANGUAGE || 'en';
  if (!LANGUAGES.includes(language)) {
    throw new Error(`LANGUAGE must be one of: ${LANGUAGES.join(', ')}.`);
  }

  const googleIssuer = (env.GOOGLE_WALLET_ISSUER_ID || '').trim();
  if (googleIssuer && !/^\d+$/.test(googleIssuer)) {
    throw new Error('GOOGLE_WALLET_ISSUER_ID must be a number.');
  }
  const googleClass = env.GOOGLE_WALLET_CLASS || 'theusual';
  if (!/^[\w-]+$/.test(googleClass)) {
    throw new Error('GOOGLE_WALLET_CLASS can only have letters, numbers, - and _.');
  }

  const port = Number(env.PORT || 3000);
  const baseUrl = (env.BASE_URL || `http://127.0.0.1:${port}`).replace(/\/$/, '');
  return {
    adminPassword,
    businessName: (env.BUSINESS_NAME || 'My Business').trim(),
    baseUrl,
    color,
    accent,
    stamps,
    language,
    contactEmail: (env.CONTACT_EMAIL || '').trim(),
    reward: (env.REWARD || '').trim(),
    trustProxy: env.TRUST_PROXY === '1',
    host: env.HOST || '127.0.0.1',
    port,
    databasePath: env.DATABASE_PATH || 'theusual.db',
    googleWallet: googleIssuer
      ? {
          issuerId: googleIssuer,
          classSuffix: googleClass,
          keyFile: env.GOOGLE_WALLET_KEY_FILE || 'secrets/google-wallet.json',
          imagesUrl: (env.GOOGLE_WALLET_IMAGES_URL || baseUrl).replace(/\/$/, ''),
        }
      : null,
  };
}
