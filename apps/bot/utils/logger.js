const db = require('./db.js');

const insert = db.prepare(`
    INSERT INTO usage_logs (type, guild_id, user_id, username, command, detail)
    VALUES (@type, @guild_id, @user_id, @username, @command, @detail)
`);

function logCommand(type, { guildId, userId, username, command, detail = null }) {
    try {
        insert.run({ type, guild_id: guildId ?? null, user_id: userId, username, command, detail });
    } catch (err) {
        console.error('[logger] Failed to write usage log:', err);
    }
}

module.exports = { logCommand };
