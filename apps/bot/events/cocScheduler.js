// events/cocScheduler.js
// -----------------------------------------------------------------------------
// Background loop for /coc. Registered from index.js
//     const cocScheduler = require('./events/cocScheduler.js');
//     cocScheduler.register(client);
//
// Two jobs, both driven off one 60s tick:
//   1. Fire any reminder whose fire_at has passed (and reschedule recurring ones).
//      Because fire_at is an ABSOLUTE timestamp in the DB, reminders survive a
//      bot restart — unlike in-memory setTimeout timers.
//   2. Every 5 minutes, poll each registered clan that has auto war-reminders on
//      and ping members who still have unused attacks as the war nears its end.
// -----------------------------------------------------------------------------

const { Events } = require('discord.js');
const coc = require('../utils/cocApi.js');
const store = require('../utils/cocStore.js');
const { parseCocDate } = require('../commands/coc/coc.js');

const TICK_MS = 60 * 1000;
const WAR_POLL_EVERY_TICKS = 5; // => every 5 minutes

// In-memory de-dupe so each war is nagged once per end-time. Lost on restart,
// which is fine: worst case is one extra ping after a restart.
const naggedWars = new Map(); // guildId -> Set<endTimeIso>

function nextOccurrence(fireAt, recurrence) {
    const d = new Date(fireAt);
    if (recurrence === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
    else if (recurrence === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
    else return null;
    // Roll forward until it's in the future (covers long downtime).
    while (d.getTime() <= Date.now()) {
        if (recurrence === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
        else d.setUTCMonth(d.getUTCMonth() + 1);
    }
    return d;
}

async function fireDueReminders(client) {
    const due = store.getDueReminders(new Date().toISOString());
    for (const r of due) {
        try {
            const channel = await client.channels.fetch(r.channel_id).catch(() => null);
            if (channel?.isTextBased?.()) {
                const note = r.note ? `\n> ${r.note}` : '';
                await channel.send(`⏰ **${r.title}** reminder!${note}`);
            }
        } catch (err) {
            console.error('[coc] failed to send reminder', r.id, err);
        } finally {
            const next = nextOccurrence(r.fire_at, r.recurrence);
            if (next) store.rescheduleReminder(r.id, next.toISOString());
            else store.deleteReminderById(r.id);
        }
    }
}

async function pollWars(client) {
    for (const reg of store.allRegisteredClans()) {
        const cfg = store.getConfig(reg.guild_id);
        if (!cfg.war_reminder || !cfg.war_channel_id) continue;

        let war;
        try {
            war = await coc.getCurrentWar(reg.clan_tag);
        } catch (err) {
            console.error('[coc] war poll failed for', reg.guild_id, err.message);
            continue;
        }
        if (war.state !== 'inWar') continue;

        const end = parseCocDate(war.endTime);
        if (!end) continue;
        const minutesLeft = (end.getTime() - Date.now()) / 60000;
        if (minutesLeft < 0 || minutesLeft > cfg.war_lead_minutes) continue;

        const seen = naggedWars.get(reg.guild_id) ?? new Set();
        if (seen.has(war.endTime)) continue; // already nagged this war

        const perMember = war.attacksPerMember ?? 2;
        const slackers = (war.clan.members ?? [])
            .filter(m => (m.attacks?.length ?? 0) < perMember)
            .sort((a, b) => a.mapPosition - b.mapPosition);
        if (slackers.length === 0) continue;

        const mentions = slackers.map(m => {
            const link = store.getLinkByTag(reg.guild_id, m.tag);
            return link ? `<@${link.user_id}>` : `**${m.name}**`;
        }).join(' ');

        try {
            const channel = await client.channels.fetch(cfg.war_channel_id).catch(() => null);
            if (channel?.isTextBased?.()) {
                await channel.send(
                    `⚔️ War vs **${war.opponent?.name ?? 'opponent'}** ends ${`<t:${Math.floor(end.getTime() / 1000)}:R>`}!\n` +
                    `${slackers.length} still have attacks: ${mentions}`
                );
            }
        } catch (err) {
            console.error('[coc] failed to send war nag', err);
        }

        seen.add(war.endTime);
        naggedWars.set(reg.guild_id, seen);
    }
}

function register(client) {
    client.once(Events.ClientReady, () => {
        let ticks = 0;
        setInterval(async () => {
            ticks++;
            try { await fireDueReminders(client); } catch (err) { console.error('[coc] reminder loop error', err); }
            if (ticks % WAR_POLL_EVERY_TICKS === 0 && coc.isConfigured()) {
                try { await pollWars(client); } catch (err) { console.error('[coc] war loop error', err); }
            }
        }, TICK_MS);
        console.log('# [coc] scheduler started');
    });
}

module.exports = { register };