const db = require('./db.js');

const stmts = {
    addPlayer:    db.prepare('INSERT OR IGNORE INTO stack_pool (guild_id, user_id, username) VALUES (?, ?, ?)'),
    removePlayer: db.prepare('DELETE FROM stack_pool WHERE guild_id = ? AND user_id = ?'),
    listPool:     db.prepare('SELECT user_id, username FROM stack_pool WHERE guild_id = ? ORDER BY added_at'),
    poolCount:    db.prepare('SELECT COUNT(*) AS n FROM stack_pool WHERE guild_id = ?'),
    getConfig:    db.prepare('SELECT timezone FROM stack_config WHERE guild_id = ?'),
    upsertConfig: db.prepare(`
        INSERT INTO stack_config (guild_id, timezone)
        VALUES (?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
            timezone   = excluded.timezone,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `),
};

// Returns { added, skipped }
function addPlayers(guildId, users) {
    let added = 0, skipped = 0;
    for (const u of users) {
        stmts.addPlayer.run(guildId, u.id, u.username).changes > 0 ? added++ : skipped++;
    }
    return { added, skipped };
}

// Returns true if actually removed
function removePlayer(guildId, userId) {
    return stmts.removePlayer.run(guildId, userId).changes > 0;
}

function listPool(guildId) {
    return stmts.listPool.all(guildId);
}

function poolCount(guildId) {
    return stmts.poolCount.get(guildId).n;
}

function getTimezone(guildId) {
    return stmts.getConfig.get(guildId)?.timezone ?? 'UTC';
}

function setTimezone(guildId, tz) {
    stmts.upsertConfig.run(guildId, tz);
}

// In-memory active call state — lost on restart, acceptable per spec
// Shape: Map<guildId, ActiveCall>
const activeCalls = new Map();

function getActiveCall(guildId)        { return activeCalls.get(guildId) ?? null; }
function setActiveCall(guildId, state) { activeCalls.set(guildId, state); }
function clearActiveCall(guildId)      { activeCalls.delete(guildId); }

module.exports = {
    addPlayers, removePlayer, listPool, poolCount,
    getTimezone, setTimezone,
    getActiveCall, setActiveCall, clearActiveCall,
};
