import { api, createPass, loadSite } from './common.js';

const site = await loadSite();
const form = document.getElementById('form');
const error = document.getElementById('error');
const pass = createPass(site);

document.getElementById('preview').append(pass.root);
pass.setName(site.t('field_name'), true);
pass.update({ stamps: 0, rewardReady: false });

form.elements.name.addEventListener('input', (event) => {
  const name = event.target.value.trim();
  pass.setName(name || site.t('field_name'), !name);
});

if (site.reward) {
  const goal = document.getElementById('goal');
  goal.textContent = site.t('join_goal', { total: site.stamps, reward: site.reward });
  goal.hidden = false;
}

function savedToken() {
  try {
    return localStorage.getItem('theusual_card');
  } catch {
    return null;
  }
}

function saveToken(token) {
  try {
    localStorage.setItem('theusual_card', token);
  } catch {
    // Private windows can refuse storage; the card link still works.
  }
}

if (savedToken()) {
  document.getElementById('existing-link').href = `/c/${savedToken()}`;
  document.getElementById('existing').hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  const button = form.querySelector('button');
  button.disabled = true;

  const { ok, body } = await api('/api/join', {
    method: 'POST',
    body: JSON.stringify({
      name: form.elements.name.value,
      phone: form.elements.phone.value,
      consent: form.elements.consent.checked,
    }),
  });

  if (ok) {
    saveToken(body.token);
    location.href = `/c/${body.token}`;
    return;
  }
  button.disabled = false;
  const key = `error_${body.error}`;
  error.textContent = site.texts[key] ?? site.t('error_generic');
});
