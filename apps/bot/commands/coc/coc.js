// commands/coc/coc.js
// -----------------------------------------------------------------------------
// /coc — Clash of Clans helper. Grouped subcommands rather than one flat
// "commands" string option, because Discord then gives you per-feature option
// validation, choices and autocomplete for free.
//
//   /coc clan register <tag>        Register the server's clan (1 per server)
//   /coc clan info                  Show registered clan stats
//   /coc clan war                   Current war state + who still has attacks
//   /coc clan unregister
//
//   /coc reminder add <kind> [in] [at] [note] [recurrence] [channel]
//   /coc reminder list
//   /coc reminder remove <id>
//
//   /coc link set <player-tag>      Link your Discord account to your in-game tag
//   /coc link who [user]
//   /coc link list
//
//   /coc config                     Timezone + automatic war-attack reminders
// -----------------------------------------------------------------------------

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const coc = require('../../utils/cocApi.js');
const store = require('../../utils/cocStore.js');

const COLOR = 0xF2A900; // CoC gold

const REMINDER_KINDS = [
    { name: 'Clan Wars',  value: 'war' },
    { name: 'Clan Games', value: 'clangames' },
    { name: 'CWL (Clan War League)', value: 'cwl' },
    { name: 'Raid Weekend', value: 'raids' },
    { name: 'Custom', value: 'custom' },
];

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

// "5h" / "90m" / "2d" / "1h30m" / "45" (bare number = minutes) -> milliseconds
function parseDuration(str) {
    if (!str) return null;
    const trimmed = str.trim();
    if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10) * 60000; // bare = minutes
    const re = /(\d+)\s*(d|h|m)/gi;
    const mult = { d: 86400000, h: 3600000, m: 60000 };
    let ms = 0, matched = false, m;
    while ((m = re.exec(trimmed)) !== null) {
        matched = true;
        ms += parseInt(m[1], 10) * mult[m[2].toLowerCase()];
    }
    return matched ? ms : null;
}

// Parse "21:00" or "2026-05-22 21:00" in the guild timezone -> UTC Date (or null).
function parseAbsolute(timeStr, tz) {
    const timeOnly = /^(\d{2}):(\d{2})$/;
    const full = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/;
    let datePart, hh, mm;
    if (timeOnly.test(timeStr)) {
        const x = timeOnly.exec(timeStr);
        hh = x[1]; mm = x[2];
        datePart = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
    } else if (full.test(timeStr)) {
        const x = full.exec(timeStr);
        datePart = x[1]; hh = x[2]; mm = x[3];
    } else {
        return null;
    }
    const naive = new Date(`${datePart}T${hh}:${mm}:00Z`);
    const tzDate = new Date(naive.toLocaleString('en-US', { timeZone: tz }) + ' UTC');
    const offset = naive - tzDate;
    return new Date(naive.getTime() + offset);
}

// Discord relative timestamp, e.g. "in 3 hours"
const rel = (date) => `<t:${Math.floor(date.getTime() / 1000)}:R>`;
const abs = (date) => `<t:${Math.floor(date.getTime() / 1000)}:f>`;

function friendlyApiError(err) {
    if (err instanceof coc.CocApiError) {
        if (err.reason === 'noToken') return 'The bot has no `COC_API_TOKEN` configured yet.';
        if (err.status === 403) return 'API access denied — the token is probably not whitelisted for this server\'s IP. See the proxy note in `cocApi.js`.';
        if (err.status === 404) return 'Not found — double-check the tag.';
        if (err.reason === 'accessDenied') return 'That clan\'s war log is private, so war data can\'t be read.';
        return `API error: ${err.message}`;
    }
    return `Unexpected error: ${err.message}`;
}

// ---------------------------------------------------------------------------
// clan
// ---------------------------------------------------------------------------

async function handleClanRegister(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need the **Manage Server** permission to register a clan.', ephemeral: true });
    }
    if (!coc.isConfigured()) {
        return interaction.reply({ content: 'The bot has no Clash of Clans API token configured (`COC_API_TOKEN`).', ephemeral: true });
    }
    const tag = interaction.options.getString('tag');
    await interaction.deferReply({ ephemeral: true });
    try {
        const clan = await coc.getClan(tag);
        store.registerClan(interaction.guildId, clan.tag, clan.name, interaction.user.id);
        return interaction.editReply(`Registered **${clan.name}** (\`${clan.tag}\`) as this server's clan.`);
    } catch (err) {
        return interaction.editReply(friendlyApiError(err));
    }
}

async function handleClanInfo(interaction) {
    const reg = store.getRegisteredClan(interaction.guildId);
    if (!reg) return interaction.reply({ content: 'No clan registered. Use `/coc clan register` first.', ephemeral: true });

    await interaction.deferReply();
    try {
        const c = await coc.getClan(reg.clan_tag);
        const embed = new EmbedBuilder()
            .setTitle(`${c.name} (${c.tag})`)
            .setColor(COLOR)
            .setThumbnail(c.badgeUrls?.medium ?? null)
            .setDescription(c.description?.slice(0, 200) || null)
            .addFields(
                { name: 'Level', value: `${c.clanLevel}`, inline: true },
                { name: 'Members', value: `${c.members}/50`, inline: true },
                { name: 'War Frequency', value: `${c.warFrequency ?? 'unknown'}`, inline: true },
                { name: 'War Win Streak', value: `${c.warWinStreak ?? 0}`, inline: true },
                { name: 'War Record', value: `${c.warWins ?? 0}W / ${c.warTies ?? 0}T / ${c.warLosses ?? 0}L`, inline: true },
                { name: 'Points', value: `${c.clanPoints}`, inline: true },
            );
        return interaction.editReply({ embeds: [embed] });
    } catch (err) {
        return interaction.editReply(friendlyApiError(err));
    }
}

async function handleClanWar(interaction) {
    const reg = store.getRegisteredClan(interaction.guildId);
    if (!reg) return interaction.reply({ content: 'No clan registered. Use `/coc clan register` first.', ephemeral: true });

    await interaction.deferReply();
    try {
        const war = await coc.getCurrentWar(reg.clan_tag);
        if (war.state === 'notInWar') {
            return interaction.editReply(`**${reg.clan_name ?? reg.clan_tag}** is not currently in a war.`);
        }

        const endTime = parseCocDate(war.endTime);
        const perMember = war.attacksPerMember ?? 2;
        const slackers = (war.clan.members ?? [])
            .filter(m => (m.attacks?.length ?? 0) < perMember)
            .sort((a, b) => a.mapPosition - b.mapPosition);

        const mention = (m) => {
            const link = store.getLinkByTag(interaction.guildId, m.tag);
            const used = m.attacks?.length ?? 0;
            const who = link ? `<@${link.user_id}>` : m.name;
            return `${who} — ${used}/${perMember}`;
        };

        const embed = new EmbedBuilder()
            .setTitle(`War vs ${war.opponent?.name ?? 'opponent'}`)
            .setColor(COLOR)
            .addFields(
                { name: 'State', value: war.state, inline: true },
                { name: 'Size', value: `${war.teamSize}v${war.teamSize}`, inline: true },
                { name: 'Ends', value: endTime ? rel(endTime) : 'unknown', inline: true },
                { name: 'Score', value: `⭐ ${war.clan.stars} (${(war.clan.destructionPercentage ?? 0).toFixed(1)}%) — ${war.opponent.stars} ⭐`, inline: false },
                {
                    name: `Still have attacks (${slackers.length})`,
                    value: slackers.length ? slackers.slice(0, 25).map(mention).join('\n') : 'Everyone has attacked. 🎉',
                },
            );
        return interaction.editReply({ embeds: [embed] });
    } catch (err) {
        return interaction.editReply(friendlyApiError(err));
    }
}

async function handleClanUnregister(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need the **Manage Server** permission.', ephemeral: true });
    }
    const removed = store.unregisterClan(interaction.guildId);
    return interaction.reply({ content: removed ? 'Clan unregistered.' : 'No clan was registered.', ephemeral: true });
}

// CoC timestamps are like "20260522T193000.000Z" (no dashes/colons). Normalise.
function parseCocDate(s) {
    if (!s) return null;
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(s);
    if (!m) return new Date(s);
    return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

// ---------------------------------------------------------------------------
// reminder
// ---------------------------------------------------------------------------

async function handleReminderAdd(interaction) {
    const guildId = interaction.guildId;
    const kind = interaction.options.getString('kind');
    const inStr = interaction.options.getString('in');
    const atStr = interaction.options.getString('at');
    const note = interaction.options.getString('note');
    const recurrence = interaction.options.getString('recurrence') ?? 'once';
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;

    if (!inStr && !atStr) {
        return interaction.reply({ content: 'Provide either `in:` (e.g. `5h`, `1h30m`) or `at:` (e.g. `21:00`).', ephemeral: true });
    }

    const tz = store.getTimezone(guildId);
    let fireAt;
    if (inStr) {
        const ms = parseDuration(inStr);
        if (ms === null || ms <= 0) return interaction.reply({ content: `Could not parse \`in: ${inStr}\`. Try \`5h\`, \`90m\`, \`2d\`, \`1h30m\`.`, ephemeral: true });
        fireAt = new Date(Date.now() + ms);
    } else {
        fireAt = parseAbsolute(atStr, tz);
        if (!fireAt || fireAt.getTime() <= Date.now()) {
            return interaction.reply({ content: `Invalid or past time \`${atStr}\`. Use \`21:00\` or \`2026-05-22 21:00\` (timezone: \`${tz}\`).`, ephemeral: true });
        }
    }

    const title = REMINDER_KINDS.find(k => k.value === kind)?.name ?? 'Reminder';
    const id = store.addReminder({
        guildId, channelId: channel.id, kind, title,
        fireAt: fireAt.toISOString(), recurrence, note, createdBy: interaction.user.id,
    });

    const recurNote = recurrence !== 'once' ? ` (repeats **${recurrence}**)` : '';
    return interaction.reply({
        content: `⏰ Reminder #${id} set: **${title}** in <#${channel.id}> at ${abs(fireAt)} (${rel(fireAt)})${recurNote}.`,
        ephemeral: true,
    });
}

async function handleReminderList(interaction) {
    const rows = store.listReminders(interaction.guildId);
    if (rows.length === 0) return interaction.reply({ content: 'No reminders set.', ephemeral: true });

    const embed = new EmbedBuilder()
        .setTitle('Clash of Clans reminders')
        .setColor(COLOR)
        .setDescription(rows.map(r => {
            const when = new Date(r.fire_at);
            const recur = r.recurrence !== 'once' ? ` · ${r.recurrence}` : '';
            const note = r.note ? ` — ${r.note}` : '';
            return `**#${r.id}** ${r.title} → ${abs(when)} (${rel(when)})${recur} in <#${r.channel_id}>${note}`;
        }).join('\n'));
    return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleReminderRemove(interaction) {
    const id = interaction.options.getInteger('id');
    const removed = store.removeReminder(id, interaction.guildId);
    return interaction.reply({ content: removed ? `Removed reminder #${id}.` : `No reminder #${id} on this server.`, ephemeral: true });
}

// ---------------------------------------------------------------------------
// link
// ---------------------------------------------------------------------------

async function handleLinkSet(interaction) {
    if (!coc.isConfigured()) {
        return interaction.reply({ content: 'The bot has no API token configured, so player tags can\'t be verified.', ephemeral: true });
    }
    const tag = interaction.options.getString('player-tag');
    await interaction.deferReply({ ephemeral: true });
    try {
        const player = await coc.getPlayer(tag);
        store.linkPlayer(interaction.guildId, interaction.user.id, player.tag, player.name);
        return interaction.editReply(`Linked you to **${player.name}** (\`${player.tag}\`), TH${player.townHallLevel}.`);
    } catch (err) {
        return interaction.editReply(friendlyApiError(err));
    }
}

async function handleLinkWho(interaction) {
    const user = interaction.options.getUser('user') ?? interaction.user;
    const link = store.getLinkByUser(interaction.guildId, user.id);
    if (!link) return interaction.reply({ content: `${user.username} has not linked a player tag.`, ephemeral: true });
    return interaction.reply({ content: `${user} is linked to **${link.player_name ?? '?'}** (\`${link.player_tag}\`).`, ephemeral: true });
}

async function handleLinkList(interaction) {
    const links = store.listLinks(interaction.guildId);
    if (links.length === 0) return interaction.reply({ content: 'No linked players yet.', ephemeral: true });
    const embed = new EmbedBuilder()
        .setTitle('Linked players')
        .setColor(COLOR)
        .setDescription(links.map(l => `<@${l.user_id}> → **${l.player_name ?? '?'}** (\`${l.player_tag}\`)`).join('\n'));
    return interaction.reply({ embeds: [embed], ephemeral: true });
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

async function handleConfig(interaction) {
    const guildId = interaction.guildId;
    const tz = interaction.options.getString('timezone');
    const warReminder = interaction.options.getBoolean('war-reminders');
    const warChannel = interaction.options.getChannel('war-channel');
    const lead = interaction.options.getInteger('war-lead-minutes');

    // No options -> show current config
    if (tz === null && warReminder === null && warChannel === null && lead === null) {
        const cfg = store.getConfig(guildId);
        return interaction.reply({
            content: [
                `**Timezone:** \`${cfg.timezone}\``,
                `**Auto war reminders:** ${cfg.war_reminder ? 'on' : 'off'}`,
                `**War channel:** ${cfg.war_channel_id ? `<#${cfg.war_channel_id}>` : 'not set'}`,
                `**Lead time:** ${cfg.war_lead_minutes} min before war ends`,
            ].join('\n'),
            ephemeral: true,
        });
    }

    const patch = {};
    if (tz !== null) {
        if (!Intl.supportedValuesOf('timeZone').includes(tz)) {
            return interaction.reply({ content: `Invalid timezone \`${tz}\`. Use an IANA name like \`Europe/Paris\`.`, ephemeral: true });
        }
        patch.timezone = tz;
    }
    if (warReminder !== null) patch.war_reminder = warReminder ? 1 : 0;
    if (warChannel !== null) patch.war_channel_id = warChannel.id;
    if (lead !== null) patch.war_lead_minutes = Math.max(5, lead);

    const cfg = store.setConfig(guildId, patch);
    return interaction.reply({ content: `Saved. Auto war reminders: **${cfg.war_reminder ? 'on' : 'off'}**, channel: ${cfg.war_channel_id ? `<#${cfg.war_channel_id}>` : 'not set'}, lead: **${cfg.war_lead_minutes}m**, tz: \`${cfg.timezone}\`.`, ephemeral: true });
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const data = new SlashCommandBuilder()
    .setName('coc')
    .setDescription('Clash of Clans tools: clan stats, war info, reminders')
    .addSubcommandGroup(g => g
        .setName('clan')
        .setDescription('Manage and inspect the server clan')
        .addSubcommand(s => s.setName('register').setDescription('Register this server\'s clan (1 per server)')
            .addStringOption(o => o.setName('tag').setDescription('Clan tag, e.g. #2PP0JJ8QL').setRequired(true)))
        .addSubcommand(s => s.setName('info').setDescription('Show registered clan stats'))
        .addSubcommand(s => s.setName('war').setDescription('Current war state and who still has attacks'))
        .addSubcommand(s => s.setName('unregister').setDescription('Remove the registered clan')))
    .addSubcommandGroup(g => g
        .setName('reminder')
        .setDescription('Schedule reminders')
        .addSubcommand(s => s.setName('add').setDescription('Add a reminder')
            .addStringOption(o => o.setName('kind').setDescription('What the reminder is for').setRequired(true).addChoices(...REMINDER_KINDS))
            .addStringOption(o => o.setName('in').setDescription('Relative time: 5h, 90m, 2d, 1h30m'))
            .addStringOption(o => o.setName('at').setDescription('Absolute time: 21:00 or 2026-05-22 21:00 (server timezone)'))
            .addStringOption(o => o.setName('note').setDescription('Free text shown in the ping'))
            .addStringOption(o => o.setName('recurrence').setDescription('Repeat?').addChoices(
                { name: 'Once', value: 'once' },
                { name: 'Weekly', value: 'weekly' },
                { name: 'Monthly', value: 'monthly' },
            ))
            .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (defaults to here)')))
        .addSubcommand(s => s.setName('list').setDescription('List scheduled reminders'))
        .addSubcommand(s => s.setName('remove').setDescription('Remove a reminder by id')
            .addIntegerOption(o => o.setName('id').setDescription('Reminder id (see /coc reminder list)').setRequired(true))))
    .addSubcommandGroup(g => g
        .setName('link')
        .setDescription('Link Discord accounts to in-game players')
        .addSubcommand(s => s.setName('set').setDescription('Link your account to a player tag')
            .addStringOption(o => o.setName('player-tag').setDescription('Your player tag, e.g. #ABC123').setRequired(true)))
        .addSubcommand(s => s.setName('who').setDescription('Show who a user is linked to')
            .addUserOption(o => o.setName('user').setDescription('User to check (defaults to you)')))
        .addSubcommand(s => s.setName('list').setDescription('List all linked players')))
    .addSubcommand(s => s
        .setName('config')
        .setDescription('Server timezone and automatic war reminders')
        .addStringOption(o => o.setName('timezone').setDescription('IANA timezone, e.g. Europe/Paris'))
        .addBooleanOption(o => o.setName('war-reminders').setDescription('Auto-ping members with unused war attacks'))
        .addChannelOption(o => o.setName('war-channel').setDescription('Channel for automatic war reminders'))
        .addIntegerOption(o => o.setName('war-lead-minutes').setDescription('Minutes before war end to ping (min 5)')));

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function execute(interaction) {
    if (!interaction.guildId) {
        return interaction.reply({ content: 'This command only works in a server.', ephemeral: true });
    }

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (group === 'clan') {
        if (sub === 'register')   return handleClanRegister(interaction);
        if (sub === 'info')       return handleClanInfo(interaction);
        if (sub === 'war')        return handleClanWar(interaction);
        if (sub === 'unregister') return handleClanUnregister(interaction);
    } else if (group === 'reminder') {
        if (sub === 'add')    return handleReminderAdd(interaction);
        if (sub === 'list')   return handleReminderList(interaction);
        if (sub === 'remove') return handleReminderRemove(interaction);
    } else if (group === 'link') {
        if (sub === 'set')  return handleLinkSet(interaction);
        if (sub === 'who')  return handleLinkWho(interaction);
        if (sub === 'list') return handleLinkList(interaction);
    } else if (sub === 'config') {
        return handleConfig(interaction);
    }
}

module.exports = { cooldown: 5, data, execute, parseCocDate };