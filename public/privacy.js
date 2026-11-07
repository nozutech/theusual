import { loadSite } from './common.js';

const site = await loadSite();

if (site.googleWallet) {
  document.getElementById('share').textContent = site.t('privacy_share_wallet');
}

if (site.contactEmail) {
  const contact = document.getElementById('contact');
  contact.textContent = site.t('privacy_contact', { email: site.contactEmail });
  contact.hidden = false;
}
