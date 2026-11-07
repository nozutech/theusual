import { api, createPass, loadSite } from './common.js';

const site = await loadSite();
const token = location.pathname.split('/').pop();
const element = (id) => document.getElementById(id);

const { ok, body: card } = await api(`/api/card/${token}`);

if (!ok) {
  element('missing').hidden = false;
} else {
  const pass = createPass(site, { withCode: true });
  pass.setName(card.name);
  pass.setCode(card.code, `/api/card/${token}/qr.svg`);
  pass.update(card);
  element('card').append(pass.root);
  element('card').hidden = false;

  if (site.googleWallet && /Android/i.test(navigator.userAgent)) {
    element('wallet').href = `/api/card/${token}/google-wallet`;
    element('wallet-button').src = `/google-wallet-${site.language}.svg`;
    element('wallet-button').alt = site.t('wallet_add');
    element('wallet').hidden = false;
    element('wallet-error').hidden = new URLSearchParams(location.search).get('wallet') !== 'failed';
  } else {
    element('hint').hidden = false;
  }

  new EventSource(`/api/card/${token}/events`).addEventListener('message', (event) => {
    pass.update(JSON.parse(event.data));
  });
}
