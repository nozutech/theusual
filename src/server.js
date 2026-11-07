import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { readGoogleKey } from './google-wallet.js';
import { Store } from './store.js';

let config;
let google = null;
try {
  config = loadConfig();
  if (config.googleWallet) google = { key: readGoogleKey(config.googleWallet.keyFile) };
} catch (error) {
  console.error(`The Usual cannot start: ${error.message}`);
  process.exit(1);
}

const store = new Store(config.databasePath, { total: config.stamps, hasReward: Boolean(config.reward) });

createApp({ config, store, google }).listen(config.port, config.host, () => {
  console.log(`The Usual is running on http://${config.host}:${config.port}`);
});
