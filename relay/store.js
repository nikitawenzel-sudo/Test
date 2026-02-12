const Database = require('better-sqlite3');
const path = require('path');

class EventStore {
  constructor(dbPath = path.join(__dirname, 'data', 'events.db')) {
    // Erstelle data-Verzeichnis falls nötig
    const fs = require('fs');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        pubkey TEXT NOT NULL,
        kind INTEGER NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        sig TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kind ON events(kind);
      CREATE INDEX IF NOT EXISTS idx_pubkey ON events(pubkey);
      CREATE INDEX IF NOT EXISTS idx_created_at ON events(created_at);
      CREATE INDEX IF NOT EXISTS idx_kind_created ON events(kind, created_at);
    `);

    this._insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO events (id, pubkey, kind, content, tags, created_at, sig)
      VALUES (@id, @pubkey, @kind, @content, @tags, @created_at, @sig)
    `);
  }

  saveEvent(event) {
    // Speichere Event - kind 25000 (signaling) wird NICHT gespeichert
    if (event.kind === 25000) return false;

    const result = this._insertStmt.run({
      id: event.id,
      pubkey: event.pubkey,
      kind: event.kind,
      content: event.content,
      tags: JSON.stringify(event.tags),
      created_at: event.created_at,
      sig: event.sig
    });
    return result.changes > 0;
  }

  queryEvents(filter) {
    let conditions = [];
    let params = {};

    if (filter.ids && filter.ids.length > 0) {
      conditions.push(`id IN (${filter.ids.map((_, i) => `@id${i}`).join(',')})`);
      filter.ids.forEach((id, i) => params[`id${i}`] = id);
    }

    if (filter.kinds && filter.kinds.length > 0) {
      conditions.push(`kind IN (${filter.kinds.map((_, i) => `@kind${i}`).join(',')})`);
      filter.kinds.forEach((k, i) => params[`kind${i}`] = k);
    }

    if (filter.authors && filter.authors.length > 0) {
      conditions.push(`pubkey IN (${filter.authors.map((_, i) => `@author${i}`).join(',')})`);
      filter.authors.forEach((a, i) => params[`author${i}`] = a);
    }

    if (filter.since) {
      conditions.push('created_at >= @since');
      params.since = filter.since;
    }

    if (filter.until) {
      conditions.push('created_at <= @until');
      params.until = filter.until;
    }

    // Tag-Filter: #e, #p, #channel etc.
    // Tags sind als JSON gespeichert, wir müssen LIKE verwenden
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith('#') && Array.isArray(values)) {
        const tagName = key.slice(1);
        const tagConditions = values.map((val, i) => {
          const paramName = `tag_${tagName}_${i}`;
          params[paramName] = `["${tagName}","${val}"`;
          return `tags LIKE '%' || @${paramName} || '%'`;
        });
        if (tagConditions.length > 0) {
          conditions.push(`(${tagConditions.join(' OR ')})`);
        }
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ? Math.min(filter.limit, 1000) : 500;

    const sql = `SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT ${limit}`;

    const rows = this.db.prepare(sql).all(params);
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
