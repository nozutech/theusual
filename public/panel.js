import { api, createPass, loadSite, miniBars } from './common.js';

const site = await loadSite();
const element = (id) => document.getElementById(id);

let current = null;
let pass = null;
let scanning = null;
let view = 'login';

// On a wide screen the list stays next to the open card.
const wide = matchMedia('(min-width: 880px)');

function show(next) {
  view = next;
  element('login').hidden = view !== 'login';
  element('list').hidden = view === 'login' || (view === 'detail' && !wide.matches);
  element('detail').hidden = view !== 'detail';
  element('idle').hidden = view !== 'list' || !wide.matches;
}

wide.addEventListener('change', () => show(view));

function renderResults(cards) {
  const items = cards.map((card) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    const name = document.createElement('span');
    const count = document.createElement('b');
    name.textContent = card.name;
    count.textContent = card.stamps;
    button.classList.toggle('ready', card.rewardReady);
    button.append(name, miniBars(card.stamps, site.stamps), count);
    if (card.id === current?.id) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => openCard(card.id));
    item.append(button);
    return item;
  });
  element('results').replaceChildren(...items);
  element('empty').hidden = cards.length > 0;
}

async function search() {
  const query = encodeURIComponent(element('search').value);
  const { status, body } = await api(`/api/cards?q=${query}`);
  if (status === 401) return show('login');
  renderResults(body);
  // A slow search must not pull staff out of the card they just opened.
  if (element('detail').hidden) show('list');
}

function backToList() {
  current = null;
  show('list');
  search();
}

function renderCard(card) {
  if (card.id !== current?.id) {
    pass = createPass(site);
    element('detail-pass').replaceChildren(pass.root);
  }
  current = card;
  pass.setName(card.name);
  pass.update(card);

  element('detail-phone').textContent = [card.phone, card.samePhone ? site.t('panel_same_phone') : '']
    .filter(Boolean).join(' · ');
  element('detail-error').textContent = '';
  element('add').hidden = card.rewardReady;
  element('reward').hidden = !card.rewardReady;
  element('reward').textContent = site.t('panel_reward', { reward: site.reward });
  show('detail');
  if (wide.matches) search();
}

async function openCard(id) {
  const { ok, body } = await api(`/api/cards/${id}`);
  if (ok) renderCard(body);
}

async function act(action) {
  const { ok, status, body } = await api(`/api/cards/${current.id}/${action}`, { method: 'POST' });
  if (status === 401) return show('login');
  if (ok) return renderCard(body);
  element('detail-error').textContent = body.error === 'nothing' ? site.t('panel_undone') : site.t('error_generic');
}

function stopScan() {
  if (scanning) {
    scanning.stream.getTracks().forEach((track) => track.stop());
    cancelAnimationFrame(scanning.frame);
    scanning = null;
  }
  element('video').hidden = true;
  element('scan-stop').hidden = true;
  element('scan').hidden = false;
}

async function foundCode(code) {
  stopScan();
  const { ok, body } = await api(`/api/cards/code/${encodeURIComponent(code)}`);
  if (ok) return renderCard(body);
  element('scan-error').textContent = site.t('panel_scan_unknown');
}

async function startScan() {
  element('scan-error').textContent = '';
  const video = element('video');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    scanning = { stream, frame: 0 };
    video.srcObject = stream;
    video.hidden = false;
    element('scan').hidden = true;
    element('scan-stop').hidden = false;
    await video.play();
  } catch {
    stopScan();
    element('scan-error').textContent = site.t('panel_scan_error');
    return;
  }

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const look = () => {
    if (!scanning) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = window.jsQR(image.data, image.width, image.height);
      if (result?.data) return foundCode(result.data);
    }
    scanning.frame = requestAnimationFrame(look);
  };
  look();
}

element('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const { ok, body } = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ password: form.elements.password.value }),
  });
  if (ok) {
    form.reset();
    element('login-error').textContent = '';
    return search();
  }
  element('login-error').textContent = body.error === 'too_many' ? site.t('error_too_many') : site.t('panel_wrong');
});

let typing;
element('search').addEventListener('input', () => {
  clearTimeout(typing);
  typing = setTimeout(search, 200);
});

element('scan').addEventListener('click', startScan);
element('scan-stop').addEventListener('click', stopScan);
element('add').addEventListener('click', () => act('stamp'));
element('reward').addEventListener('click', () => act('reward'));
element('undo').addEventListener('click', () => act('undo'));
element('back').addEventListener('click', backToList);

element('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(current.url);
  element('detail-error').textContent = site.t('panel_copied');
});

element('delete').addEventListener('click', async () => {
  if (!confirm(site.t('panel_delete_confirm', { name: current.name }))) return;
  await api(`/api/cards/${current.id}`, { method: 'DELETE' });
  backToList();
});

element('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  show('login');
});

search();
