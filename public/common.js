export async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

export async function loadSite() {
  const { body: site } = await api('/api/site');
  document.documentElement.lang = site.language;
  document.title = site.businessName;
  site.t = (key, values = {}) => site.texts[key].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
  for (const element of document.querySelectorAll('[data-t]')) {
    element.textContent = site.t(element.dataset.t, { business: site.businessName });
  }
  addCredit(site);
  paintBrowser();
  return site;
}

// Phones colour their browser bar with this.
function paintBrowser() {
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = getComputedStyle(document.documentElement).getPropertyValue('--page').trim();
  document.head.append(meta);
}

// NOTICE requires this credit in every copy and modified version.
function addCredit(site) {
  const credit = make('footer', 'credit');
  const link = make('a');
  link.href = 'https://nozutech.dev';
  link.rel = 'noopener';
  link.append(make('span', 'credit-mark'), make('span', '', site.t('credit')));
  credit.append(link);
  document.body.append(credit);
}

function make(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function drawBars(container, { stamps, total, landedFrom }) {
  container.replaceChildren();
  container.classList.toggle('long', total > 10);
  container.style.setProperty('--columns', total > 10 ? Math.ceil(total / 2) : total);

  for (let index = 0; index < total; index += 1) {
    const bar = make('span', 'bar');
    bar.classList.toggle('filled', index < stamps);
    bar.classList.toggle('landing', index >= landedFrom && index < stamps);
    container.append(bar);
  }
}

export function miniBars(stamps, total) {
  const bars = make('span', 'mini');
  bars.setAttribute('aria-hidden', 'true');
  drawBars(bars, { stamps, total, landedFrom: stamps });
  return bars;
}

// The card as the customer sees it. Customer data only ever goes in through textContent.
export function createPass(site, { withCode = false } = {}) {
  const root = make('article', 'pass');
  const tally = make('p', 'pass-tally');
  const number = make('span', 'pass-number');
  const outOf = make('span', 'pass-of');
  const name = make('h1', 'pass-name');
  const stamps = make('div', 'stamps');
  const done = make('p', 'pass-done');
  const foot = make('div', 'pass-foot');
  const code = make('div', 'pass-code');
  const qr = make('img');
  const codeText = make('p', 'code-text');

  tally.setAttribute('aria-hidden', 'true');
  tally.append(number, outOf);
  stamps.setAttribute('role', 'img');
  done.hidden = true;
  qr.alt = '';
  code.append(qr, codeText);
  foot.append(code);
  const prize = make('p', 'pass-prize');
  prize.append(make('strong', '', site.reward), make('span', '', site.t('card_prize')));
  if (site.reward) foot.append(prize);
  root.append(
    make('span', 'pass-lines'),
    make('span', 'pass-mark'),
    make('p', 'pass-business', site.businessName),
    tally,
    name,
    stamps,
    done,
  );
  if (withCode) root.append(foot);

  let shown = null;

  return {
    root,
    setName(text, placeholder = false) {
      name.textContent = text;
      name.classList.toggle('placeholder', placeholder);
      name.classList.toggle('long', text.length > 18);
    },
    setCode(value, image) {
      codeText.textContent = value;
      qr.src = image;
    },
    update(card) {
      number.textContent = card.stamps;
      number.classList.toggle('landing', shown !== null && card.stamps > shown);
      outOf.textContent = site.t('card_of', { total: site.stamps });
      drawBars(stamps, { stamps: card.stamps, total: site.stamps, landedFrom: shown ?? card.stamps });
      stamps.setAttribute('aria-label', site.t('card_count', { stamps: card.stamps, total: site.stamps }));
      done.hidden = card.stamps < site.stamps;
      prize.hidden = !done.hidden;
      done.textContent = card.rewardReady ? site.t('card_reward', { reward: site.reward }) : site.t('card_full');
      shown = card.stamps;
    },
  };
}
