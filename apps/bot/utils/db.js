const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'usage.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
    CREATE TABLE IF NOT EXISTS usage_logs (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        type      TEXT NOT NULL,
        guild_id  TEXT,
        user_id   TEXT NOT NULL,
        username  TEXT NOT NULL,
        command   TEXT,
        detail    TEXT,
        timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
`);

module.exports = db;
