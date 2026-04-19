// SQLite-Backend – Zero-Config-Standard für neue Deployments
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DB_PATH = process.env.DB_PATH || './data/f3.db';

let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema(db);
  }
  return db;
}

function initSchema(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS cookies (
      Id          INTEGER PRIMARY KEY AUTOINCREMENT,
      Name        TEXT NOT NULL DEFAULT 'F3-Events',
      Cookie      TEXT DEFAULT '',
      Ablaufdatum TEXT,
      UpdatedAt   TEXT DEFAULT (datetime('now')),
      CreatedAt   TEXT DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO cookies (Id, Name) VALUES (1, 'F3-Events');

    CREATE TABLE IF NOT EXISTS events (
      Id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      EventName            TEXT NOT NULL,
      EventLink            TEXT,
      EventDatum           TEXT,
      "Event-Beschreibung" TEXT,
      Wochentag            TEXT,
      Anmeldestand         TEXT,
      Zusatzinfos          TEXT,
      Status               TEXT DEFAULT 'aktiv',
      EventBild            TEXT,
      Angemeldet           INTEGER,
      NichtBestaetigt      INTEGER,
      Maenner              INTEGER,
      Frauen               INTEGER,
      Paare                INTEGER,
      Vorgemerkt           INTEGER,
      Aufrufe              INTEGER,
      Preise               TEXT,
      Dresscode            TEXT,
      UpdatedAt            TEXT DEFAULT (datetime('now')),
      CreatedAt            TEXT DEFAULT (datetime('now'))
    );


    CREATE TABLE IF NOT EXISTS ladies_voting (
      Id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ProfilUrl     TEXT,
      Username      TEXT,
      "Alter"       INTEGER,
      Stadt         TEXT,
      Fotos         TEXT DEFAULT '[]',
      Status        TEXT DEFAULT 'neu',
      TelegramMsgId TEXT,
      UpdatedAt     TEXT DEFAULT (datetime('now')),
      CreatedAt     TEXT DEFAULT (datetime('now'))
    );
  `);
  // Migration: neue Spalten für bestehende DBs
  const cols = d.prepare("PRAGMA table_info(events)").all().map(c => c.name);
  if (!cols.includes('EventBild'))    d.exec('ALTER TABLE events ADD COLUMN EventBild TEXT');
  if (!cols.includes('Preise'))       d.exec('ALTER TABLE events ADD COLUMN Preise TEXT');
  if (!cols.includes('Dresscode'))    d.exec('ALTER TABLE events ADD COLUMN Dresscode TEXT');
  if (!cols.includes('Warteliste'))   d.exec('ALTER TABLE events ADD COLUMN Warteliste INTEGER');
  if (!cols.includes('IsExternal'))   d.exec('ALTER TABLE events ADD COLUMN IsExternal INTEGER DEFAULT 0');
}

function toPageResponse(rows, total) {
  return { list: rows, pageInfo: { totalRows: total, page: 1, pageSize: rows.length } };
}

module.exports = {
  getCookies() {
    const d = getDb();
    const rows = d.prepare('SELECT * FROM cookies LIMIT 10').all();
    return toPageResponse(rows, rows.length);
  },

  updateCookies(id, data) {
    const d = getDb();
    const fields = Object.keys(data).map(k => `"${k}"=?`).join(', ');
    d.prepare(`UPDATE cookies SET ${fields}, UpdatedAt=datetime('now') WHERE Id=?`)
      .run(...Object.values(data), id);
  },

  getEvents({ status, limit = 100, offset = 0 } = {}) {
    const d = getDb();
    const params = [];
    let where = '';
    if (status) { where = ' WHERE Status=?'; params.push(status); }
    const rows  = d.prepare(`SELECT * FROM events${where} ORDER BY EventDatum ASC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const total = d.prepare(`SELECT COUNT(*) as c FROM events${where}`).get(...params).c;
    return toPageResponse(rows, total);
  },

  getEvent(id) {
    return getDb().prepare('SELECT * FROM events WHERE Id=?').get(id) || null;
  },

  createEvent(data) {
    const d = getDb();
    const cols = Object.keys(data);
    const vals = Object.values(data);
    const result = d.prepare(
      `INSERT INTO events (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    ).run(...vals);
    return d.prepare('SELECT * FROM events WHERE Id=?').get(result.lastInsertRowid);
  },

  deleteEvent(id) {
    getDb().prepare('DELETE FROM events WHERE Id=?').run(id);
  },

  updateEvent(id, data) {
    const d = getDb();
    const fields = Object.keys(data).map(k => `"${k}"=?`).join(', ');
    d.prepare(`UPDATE events SET ${fields}, UpdatedAt=datetime('now') WHERE Id=?`)
      .run(...Object.values(data), id);
  },

  getLadiesVoting({ status, limit = 100, offset = 0 } = {}) {
    const d = getDb();
    const params = [];
    let where = '';
    if (status) { where = ' WHERE Status=?'; params.push(status); }
    const rows  = d.prepare(`SELECT * FROM ladies_voting${where} ORDER BY CreatedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const total = d.prepare(`SELECT COUNT(*) as c FROM ladies_voting${where}`).get(...params).c;
    return toPageResponse(rows, total);
  },

  createLadiesVotingCandidate(data) {
    const d = getDb();
    const cols = Object.keys(data);
    const vals = Object.values(data);
    const result = d.prepare(
      `INSERT INTO ladies_voting (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    ).run(...vals);
    return d.prepare('SELECT * FROM ladies_voting WHERE Id=?').get(result.lastInsertRowid);
  },

  updateLadiesVotingCandidate(id, data) {
    const d = getDb();
    const fields = Object.keys(data).map(k => `"${k}"=?`).join(', ');
    d.prepare(`UPDATE ladies_voting SET ${fields}, UpdatedAt=datetime('now') WHERE Id=?`)
      .run(...Object.values(data), id);
  },
};
