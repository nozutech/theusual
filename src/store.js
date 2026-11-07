import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SESSION_HOURS = 12;
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS cards (
    id          INTEGER PRIMARY KEY,
    token       TEXT NOT NULL UNIQUE,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    phone       TEXT,
    search_text TEXT NOT NULL,
    stamps      INTEGER NOT NULL DEFAULT 0,
    rounds      INTEGER NOT NULL DEFAULT 0,
    consent_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY,
    card_id       INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('stamp', 'reward')),
    stamps_before INTEGER NOT NULL,
    rounds_before INTEGER NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS google_passes (
    card_id    INTEGER PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL
  );
`;

function normalize(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function newCode() {
  return [...randomBytes(8)].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

function hash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export class Store {
  constructor(path, { total, hasReward }) {
    this.total = total;
    this.hasReward = hasReward;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createCard({ name, phone }) {
    const token = randomBytes(24).toString('base64url');
    const searchText = normalize(`${name} ${(phone || '').replace(/\D/g, '')}`);
    return this.db.prepare(`
      INSERT INTO cards (token, code, name, phone, search_text, consent_at)
      VALUES (?, ?, ?, ?, ?, datetime('now')) RETURNING *
    `).get(token, newCode(), name, phone || null, searchText);
  }

  byId(id) {
    return this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  }

  byToken(token) {
    return this.db.prepare('SELECT * FROM cards WHERE token = ?').get(token);
  }

  byCode(code) {
    return this.db.prepare('SELECT * FROM cards WHERE code = ?').get(code.trim().toUpperCase());
  }

  search(query) {
    const term = normalize(query.trim());
    if (!term) {
      return this.db.prepare('SELECT * FROM cards ORDER BY id DESC LIMIT 30').all();
    }
    return this.db.prepare(`
      SELECT * FROM cards WHERE search_text LIKE ? OR code = ? ORDER BY name LIMIT 30
    `).all(`%${term}%`, query.trim().toUpperCase());
  }

  samePhoneCount(card) {
    if (!card.phone) return 0;
    return this.db.prepare('SELECT COUNT(*) AS n FROM cards WHERE phone = ? AND id != ?')
      .get(card.phone, card.id).n;
  }

  history(id) {
    return this.db.prepare(`
      SELECT kind, created_at FROM events WHERE card_id = ? ORDER BY id DESC LIMIT 20
    `).all(id);
  }

  isFull(card) {
    return card.stamps >= this.total;
  }

  rewardReady(card) {
    return this.hasReward && this.isFull(card);
  }

  record(card, kind, stamps, rounds) {
    this.db.prepare(`
      INSERT INTO events (card_id, kind, stamps_before, rounds_before) VALUES (?, ?, ?, ?)
    `).run(card.id, kind, card.stamps, card.rounds);
    this.db.prepare('UPDATE cards SET stamps = ?, rounds = ? WHERE id = ?')
      .run(stamps, rounds, card.id);
  }

  addStamp(id) {
    return this.transaction(() => {
      const card = this.byId(id);
      if (!card) return null;
      if (this.rewardReady(card)) return { rewardPending: true, card };

      const full = this.isFull(card);
      this.record(card, 'stamp', full ? 1 : card.stamps + 1, full ? card.rounds + 1 : card.rounds);
      return { card: this.byId(id) };
    });
  }

  giveReward(id) {
    return this.transaction(() => {
      const card = this.byId(id);
      if (!card) return null;
      if (!this.rewardReady(card)) return { notReady: true, card };

      this.record(card, 'reward', 0, card.rounds + 1);
      return { card: this.byId(id) };
    });
  }

  undo(id) {
    return this.transaction(() => {
      const card = this.byId(id);
      if (!card) return null;

      const last = this.db.prepare('SELECT * FROM events WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(id);
      if (!last) return { nothing: true, card };

      this.db.prepare('UPDATE cards SET stamps = ?, rounds = ? WHERE id = ?')
        .run(last.stamps_before, last.rounds_before, id);
      this.db.prepare('DELETE FROM events WHERE id = ?').run(last.id);
      return { card: this.byId(id) };
    });
  }

  remove(id) {
    return this.db.prepare('DELETE FROM cards WHERE id = ?').run(id).changes > 0;
  }

  markGooglePass(id) {
    this.db.prepare('INSERT OR IGNORE INTO google_passes (card_id) VALUES (?)').run(id);
  }

  hasGooglePass(id) {
    return Boolean(this.db.prepare('SELECT 1 FROM google_passes WHERE card_id = ?').get(id));
  }

  createSession() {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
    this.db.prepare(`
      INSERT INTO sessions (token_hash, expires_at) VALUES (?, datetime('now', ?))
    `).run(hash(token), `+${SESSION_HOURS} hours`);
    return token;
  }

  hasSession(token) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')
    `).get(hash(token)));
  }

  dropSession(token) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
  }

  close() {
    this.db.close();
  }
}

export { SESSION_HOURS };
