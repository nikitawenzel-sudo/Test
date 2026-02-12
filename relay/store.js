const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'relay.db');

class EventStore {
  constructor() {
    const dir = path.dirname(DB_PATH);
    const fs = require('fs');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this._createTables();
    this._prepareStatements();
  }

  _createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        pubkey TEXT NOT NULL,
        kind INTEGER NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        sig TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
      CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events(pubkey);
      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
    `);
  }

  _prepareStatements() {
    this.insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO events (id, pubkey, kind, content, tags, created_at, sig)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
  }

  saveEvent(event) {
    this.insertStmt.run(
      event.id,
      event.pubkey,
      event.kind,
      event.content,
      JSON.stringify(event.tags),
      event.created_at,
      event.sig
    );
  }

  queryEvents(filter) {
    let conditions = [];
    let params = [];

    if (filter.kinds && filter.kinds.length > 0) {
      conditions.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`);
      params.push(...filter.kinds);
    }

    if (filter.authors && filter.authors.length > 0) {
      conditions.push(`pubkey IN (${filter.authors.map(() => '?').join(',')})`);
      params.push(...filter.authors);
    }

    if (filter.ids && filter.ids.length > 0) {
      conditions.push(`id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }

    if (filter.since) {
      conditions.push('created_at >= ?');
      params.push(filter.since);
    }

    if (filter.until) {
      conditions.push('created_at <= ?');
      params.push(filter.until);
    }

    // Filter by tag values (e.g. #channel)
    if (filter['#channel'] && filter['#channel'].length > 0) {
      const tagConditions = filter['#channel'].map(() =>
        `EXISTS (SELECT 1 FROM json_each(tags) WHERE json_extract(value, '$[0]') = 'channel' AND json_extract(value, '$[1]') = ?)`
      );
      conditions.push(`(${tagConditions.join(' OR ')})`);
      params.push(...filter['#channel']);
    }

    if (filter['#p'] && filter['#p'].length > 0) {
      const tagConditions = filter['#p'].map(() =>
        `EXISTS (SELECT 1 FROM json_each(tags) WHERE json_extract(value, '$[0]') = 'p' AND json_extract(value, '$[1]') = ?)`
      );
      conditions.push(`(${tagConditions.join(' OR ')})`);
      params.push(...filter['#p']);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ? `LIMIT ${parseInt(filter.limit, 10)}` : 'LIMIT 500';

    const rows = this.db.prepare(
      `SELECT * FROM events ${where} ORDER BY created_at ASC ${limit}`
    ).all(...params);

    return rows.map(row => ({
      id: row.id,
      pubkey: row.pubkey,
      kind: row.kind,
      content: row.content,
      tags: JSON.parse(row.tags),
      created_at: row.created_at,
      sig: row.sig
    }));
  }

  close() {
    this.db.close();
  }
}

module.exports = EventStore;
