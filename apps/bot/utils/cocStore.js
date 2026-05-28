// utils/cocStore.js
// -----------------------------------------------------------------------------
// Persistence for the /coc command. Uses the shared better-sqlite3 instance.
// Schema is created with IF NOT EXISTS so this file is safe to require anywhere
// (mirrors how stackStore.js owns the stack_* tables).
// -----------------------------------------------------------------------------

const db = require('./db.js');

// --- schema ------------------------------------------------------------------
db.exec(`
    CREATE TABLE IF NOT EXISTS coc_clans (
        guild_id      TEXT PRIMARY KEY,            -- one registered clan per server
        clan_tag      TEXT NOT NULL,
        clan_name     TEXT,
        registered_by TEXT,
        registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS coc_config (
        guild_id         TEXT PRIMARY KEY,
        timezone         TEXT    NOT NULL DEFAULT 'UTC',
        war_reminder     INTEGER NOT NULL DEFAULT 0,   -- auto "unused attacks" nag on/off
        war_channel_id   TEXT,                          -- where the nag is posted
        war_lead_minutes INTEGER NOT NULL DEFAULT 60,  -- minutes before war end to nag
        updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS coc_links (
        guild_id    TEXT NOT NULL,                 -- discord user <-> in-game player
        user_id     TEXT NOT NULL,
        player_tag  TEXT NOT NULL,
        player_name TEXT,
        linked_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS coc_reminders (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        kind        TEXT NOT NULL,                 -- war | clangames | cwl | raids | custom
        title       TEXT NOT NULL,
        fire_at     TEXT NOT NULL,                 -- ABSOLUTE ISO-8601 UTC (survives restarts)
        recurrence  TEXT NOT NULL DEFAULT 'once',  -- once | weekly | monthly
        note        TEXT,
        created_by  TEXT,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
`);

// --- prepared statements -----------------------------------------------------
const stmts = {
    setClan: db.prepare(`
        INSERT INTO coc_clans (guild_id, clan_tag, clan_name, registered_by)
        VALUES (@guild_id, @clan_tag, @clan_name, @registered_by)
        ON CONFLICT(guild_id) DO UPDATE SET
            clan_tag      = excluded.clan_tag,
            clan_name     = excluded.clan_name,
            registered_by = excluded.registered_by,
            registered_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    `),
    getClan:    db.prepare('SELECT * FROM coc_clans WHERE guild_id = ?'),
    deleteClan: db.prepare('DELETE FROM coc_clans WHERE guild_id = ?'),
    allClans:   db.prepare('SELECT * FROM coc_clans'),

    ensureConfig: db.prepare('INSERT OR IGNORE INTO coc_config (guild_id) VALUES (?)'),
    getConfig:    db.prepare('SELECT * FROM coc_config WHERE guild_id = ?'),

    setLink: db.prepare(`
        INSERT INTO coc_links (guild_id, user_id, player_tag, player_name)
        VALUES (@guild_id, @user_id, @player_tag, @player_name)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
            player_tag  = excluded.player_tag,
            player_name = excluded.player_name,
            linked_at   = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    `),
    getLinkByUser:   db.prepare('SELECT * FROM coc_links WHERE guild_id = ? AND user_id = ?'),
    getLinkByTag:    db.prepare('SELECT * FROM coc_links WHERE guild_id = ? AND UPPER(player_tag) = UPPER(?)'),
    listLinks:       db.prepare('SELECT * FROM coc_links WHERE guild_id = ? ORDER BY linked_at'),
    deleteLink:      db.prepare('DELETE FROM coc_links WHERE guild_id = ? AND user_id = ?'),

    addReminder: db.prepare(`
        INSERT INTO coc_reminders (guild_id, channel_id, kind, title, fire_at, recurrence, note, created_by)
        VALUES (@guild_id, @channel_id, @kind, @title, @fire_at, @recurrence, @note, @created_by)
    `),
    listReminders:  db.prepare('SELECT * FROM coc_reminders WHERE guild_id = ? ORDER BY fire_at'),
    getReminder:    db.prepare('SELECT * FROM coc_reminders WHERE id = ? AND guild_id = ?'),
    deleteReminder: db.prepare('DELETE FROM coc_reminders WHERE id = ? AND guild_id = ?'),
    dueReminders:   db.prepare('SELECT * FROM coc_reminders WHERE fire_at <= ? ORDER BY fire_at'),
    rescheduleReminder: db.prepare('UPDATE coc_reminders SET fire_at = ? WHERE id = ?'),
};

// --- clan --------------------------------------------------------------------
function registerClan(guildId, clanTag, clanName, userId) {
    stmts.setClan.run({ guild_id: guildId, clan_tag: clanTag, clan_name: clanName ?? null, registered_by: userId ?? null });
}
const getRegisteredClan = (guildId) => stmts.getClan.get(guildId) ?? null;
const unregisterClan    = (guildId) => stmts.deleteClan.run(guildId).changes > 0;
const allRegisteredClans = () => stmts.allClans.all();

// --- config ------------------------------------------------------------------
function getConfig(guildId) {
    stmts.ensureConfig.run(guildId);
    return stmts.getConfig.get(guildId);
}
function setConfig(guildId, partial) {
    stmts.ensureConfig.run(guildId);
    const allowed = ['timezone', 'war_reminder', 'war_channel_id', 'war_lead_minutes'];
    const keys = Object.keys(partial).filter(k => allowed.includes(k) && partial[k] !== undefined);
    if (keys.length === 0) return getConfig(guildId);
    const setSql = keys.map(k => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE coc_config SET ${setSql}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE guild_id = @guild_id`)
      .run({ guild_id: guildId, ...partial });
    return getConfig(guildId);
}
const getTimezone = (guildId) => getConfig(guildId).timezone;

// --- links -------------------------------------------------------------------
function linkPlayer(guildId, userId, playerTag, playerName) {
    stmts.setLink.run({ guild_id: guildId, user_id: userId, player_tag: playerTag, player_name: playerName ?? null });
}
const getLinkByUser = (guildId, userId) => stmts.getLinkByUser.get(guildId, userId) ?? null;
const getLinkByTag  = (guildId, tag)    => stmts.getLinkByTag.get(guildId, tag) ?? null;
const listLinks     = (guildId)         => stmts.listLinks.all(guildId);
const unlinkPlayer  = (guildId, userId) => stmts.deleteLink.run(guildId, userId).changes > 0;

// --- reminders ---------------------------------------------------------------
function addReminder(reminder) {
    const info = stmts.addReminder.run({
        guild_id:   reminder.guildId,
        channel_id: reminder.channelId,
        kind:       reminder.kind,
        title:      reminder.title,
        fire_at:    reminder.fireAt,        // ISO string, UTC
        recurrence: reminder.recurrence ?? 'once',
        note:       reminder.note ?? null,
        created_by: reminder.createdBy ?? null,
    });
    return info.lastInsertRowid;
}
const listReminders  = (guildId)     => stmts.listReminders.all(guildId);
const getReminder    = (id, guildId) => stmts.getReminder.get(id, guildId) ?? null;
const removeReminder = (id, guildId) => stmts.deleteReminder.run(id, guildId).changes > 0;
const getDueReminders = (nowIso)     => stmts.dueReminders.all(nowIso);
const rescheduleReminder = (id, fireAtIso) => stmts.rescheduleReminder.run(fireAtIso, id);
const deleteReminderById = (id)      => db.prepare('DELETE FROM coc_reminders WHERE id = ?').run(id);

module.exports = {
    registerClan, getRegisteredClan, unregisterClan, allRegisteredClans,
    getConfig, setConfig, getTimezone,
    linkPlayer, getLinkByUser, getLinkByTag, listLinks, unlinkPlayer,
    addReminder, listReminders, getReminder, removeReminder,
    getDueReminders, rescheduleReminder, deleteReminderById,
};