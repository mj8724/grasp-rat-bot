// persistence.js - 本地持久化与结构化日志

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '.data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const DB_FILE = path.join(DATA_DIR, 'bot.sqlite');

const CAMPER_REST_MS = [
  10 * 60 * 1000,
  20 * 60 * 1000,
  40 * 60 * 1000,
  60 * 60 * 1000,
];

function nowIso() {
  return new Date().toISOString();
}

function safeJson(value) {
  return JSON.stringify(value ?? null);
}

function restMsForCount(count) {
  const index = Math.min(Math.max(count, 1), CAMPER_REST_MS.length) - 1;
  return CAMPER_REST_MS[index];
}

export class Persistence {
  constructor() {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    this.db = new DatabaseSync(DB_FILE);
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS killers (
        name TEXT PRIMARY KEY,
        kills INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT NOT NULL,
        last_victim TEXT,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS campers (
        user_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        attack_count INTEGER NOT NULL DEFAULT 0,
        last_attack_at TEXT NOT NULL,
        next_rest_ms INTEGER NOT NULL,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS death_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        killed_at TEXT NOT NULL,
        killer_name TEXT,
        self_hp INTEGER,
        nearby_players_json TEXT,
        state_json TEXT
      );
    `);
  }

  close() {
    this.db.close();
  }

  appendLog(type, payload = {}) {
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(LOG_DIR, `${date}.jsonl`);
    const entry = {
      ts: nowIso(),
      type,
      ...payload,
    };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  }

  logMessage(source, message, context = {}) {
    this.appendLog('log', { source, message, context });
  }

  loadKillers() {
    const rows = this.db.prepare('SELECT * FROM killers').all();
    const killers = {};
    for (const row of rows) {
      killers[row.name] = {
        name: row.name,
        kills: row.kills,
        lastTime: Date.parse(row.last_seen_at) || 0,
      };
    }
    return killers;
  }

  loadCampers() {
    const rows = this.db.prepare('SELECT * FROM campers').all();
    const campers = {};
    for (const row of rows) {
      campers[row.user_id] = {
        count: row.attack_count,
        name: row.name,
        lastTime: Date.parse(row.last_attack_at) || 0,
        restMs: row.next_rest_ms,
      };
    }
    return campers;
  }

  recordKiller(name, victim = '', metadata = {}) {
    if (!name) return null;
    const seenAt = nowIso();
    this.db.prepare(`
      INSERT INTO killers (name, kills, last_seen_at, last_victim, metadata_json)
      VALUES (?, 1, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        kills = kills + 1,
        last_seen_at = excluded.last_seen_at,
        last_victim = excluded.last_victim,
        metadata_json = excluded.metadata_json
    `).run(name, seenAt, victim || null, safeJson(metadata));

    const row = this.db.prepare('SELECT * FROM killers WHERE name = ?').get(name);
    this.appendLog('killer', { name, victim, kills: row.kills, metadata });
    return {
      name: row.name,
      kills: row.kills,
      lastTime: Date.parse(row.last_seen_at) || Date.now(),
    };
  }

  recordCamper(userId, name, metadata = {}) {
    if (!userId) return null;
    const key = String(userId);
    const existing = this.db.prepare('SELECT attack_count FROM campers WHERE user_id = ?').get(key);
    const count = (existing?.attack_count || 0) + 1;
    const restMs = restMsForCount(count);
    const attackedAt = nowIso();

    this.db.prepare(`
      INSERT INTO campers (user_id, name, attack_count, last_attack_at, next_rest_ms, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        name = excluded.name,
        attack_count = excluded.attack_count,
        last_attack_at = excluded.last_attack_at,
        next_rest_ms = excluded.next_rest_ms,
        metadata_json = excluded.metadata_json
    `).run(key, name || `User ${key}`, count, attackedAt, restMs, safeJson(metadata));

    this.appendLog('camper_attack', { userId: key, name, count, restMs, metadata });
    return {
      count,
      name: name || `User ${key}`,
      lastTime: Date.parse(attackedAt) || Date.now(),
      restMs,
    };
  }

  recordDeath({ killerName, selfHp, nearbyPlayers, state }) {
    const killedAt = nowIso();
    this.db.prepare(`
      INSERT INTO death_events (killed_at, killer_name, self_hp, nearby_players_json, state_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      killedAt,
      killerName || null,
      Number.isFinite(Number(selfHp)) ? Number(selfHp) : null,
      safeJson(nearbyPlayers || []),
      safeJson(state || {})
    );
    this.appendLog('death', { killerName, selfHp, nearbyPlayers, state });
  }
}

export { restMsForCount };
