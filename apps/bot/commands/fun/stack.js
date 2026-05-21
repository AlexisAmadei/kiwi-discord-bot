const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
    addPlayers, removePlayer, listPool, poolCount,
    getTimezone, setTimezone,
    getActiveCall, setActiveCall, clearActiveCall,
} = require('../../utils/stackStore.js');

// ---------------------------------------------------------------------------
// SlashCommandBuilder
// ---------------------------------------------------------------------------

const data = new SlashCommandBuilder()
    .setName('stack')
    .setDescription('Valorant five-stack pool manager')
    .addSubcommand(sub => {
        sub.setName('create').setDescription('Create the pool, optionally pre-seeded with players');
        for (let i = 1; i <= 10; i++) {
            sub.addStringOption(o =>
                o.setName(`user${i}`).setDescription(`Player ${i}`).setRequired(false).setAutocomplete(true)
            );
        }
        return sub;
    })
    .addSubcommand(sub =>
        sub.setName('add')
           .setDescription('Add a player to the pool')
           .addUserOption(o => o.setName('user').setDescription('Player to add').setRequired(true))
    )
    .addSubcommand(sub =>
        sub.setName('remove')
           .setDescription('Remove a player from the pool')
           .addUserOption(o => o.setName('user').setDescription('Player to remove').setRequired(true))
    )
    .addSubcommand(sub =>
        sub.setName('list').setDescription('List current pool members')
    )
    .addSubcommand(sub =>
        sub.setName('call')
           .setDescription('Assemble the squad')
           .addStringOption(o =>
               o.setName('time')
                .setDescription('Schedule for later: "21:00" or "2026-05-22 21:00"')
                .setRequired(false)
           )
           .addStringOption(o =>
               o.setName('note')
                .setDescription('Free-text note shown in the ping')
                .setRequired(false)
           )
    )
    .addSubcommand(sub =>
        sub.setName('cancel').setDescription('Cancel the active or scheduled call')
    )
    .addSubcommand(sub =>
        sub.setName('config')
           .setDescription('Server configuration')
           .addStringOption(o =>
               o.setName('timezone')
                .setDescription('IANA timezone, e.g. "Europe/Paris"')
                .setRequired(false)
           )
    );

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildStatusText(call) {
    const { yes, no, maybe } = call.reactions;
    const pending = Math.max(0, call.poolSnapshot.length - yes.size - no.size - maybe.size);
    return `**Stack status:** ${yes.size}/5 ✅ · ${no.size} ❌ · ${maybe.size} ⏰ · ${pending} pending`;
}

async function updateStatusMessage(statusMsg, call) {
    try {
        await statusMsg.edit(buildStatusText(call));
    } catch {
        // message may have been deleted — not fatal
    }
}

function shouldStop(call) {
    const { yes, no, maybe } = call.reactions;
    const totalResponded = yes.size + no.size + maybe.size;
    return (
        totalResponded >= call.poolSnapshot.length ||
        yes.size >= 5 ||
        call.repingRound >= 5
    );
}

async function finalizeCall(guildId, channel, call) {
    if (call.repingTimer) clearInterval(call.repingTimer);
    clearActiveCall(guildId);

    if (call.reactions.yes.size >= 5) {
        const confirmed = [...call.reactions.yes].slice(0, 5).map(id => `<@${id}>`).join(' ');
        await channel.send(`🎯 Stack locked: ${confirmed}`);
    } else {
        await channel.send(`Stack incomplete: ${call.reactions.yes.size}/5 confirmed.`);
    }
}

// Parse "21:00" or "2026-05-22 21:00" relative to guild timezone. Returns a Date or null.
function parseScheduledTime(timeStr, tz) {
    const timeOnlyRe = /^(\d{2}):(\d{2})$/;
    const fullRe     = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/;

    let datePart, hh, mm;

    if (timeOnlyRe.test(timeStr)) {
        const m = timeOnlyRe.exec(timeStr);
        hh = m[1]; mm = m[2];
        datePart = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
    } else if (fullRe.test(timeStr)) {
        const m = fullRe.exec(timeStr);
        datePart = m[1]; hh = m[2]; mm = m[3];
    } else {
        return null;
    }

    // Build a UTC Date that represents datePart hh:mm in the guild timezone.
    // Strategy: parse as UTC naive, then shift by the tz offset for that moment.
    const naive = new Date(`${datePart}T${hh}:${mm}:00Z`);
    const localStr = naive.toLocaleString('en-US', { timeZone: tz });
    const tzDate = new Date(localStr + ' UTC');
    const offset = naive - tzDate;
    return new Date(naive.getTime() + offset);
}

function formatDateTime(date, tz) {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        weekday: 'short', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    }).format(date);
}

// ---------------------------------------------------------------------------
// Call cycle
// ---------------------------------------------------------------------------

async function runCallCycle(channel, poolSnapshot, note, guildId) {
    const mentions = poolSnapshot.map(id => `<@${id}>`).join(' ');
    let body = mentions;
    if (note) body += `\n> ${note}`;
    body += '\nReact: ✅ in · ❌ out · ⏰ later';

    const callMsg = await channel.send(body);
    await callMsg.react('✅');
    await callMsg.react('❌');
    await callMsg.react('⏰');

    const call = getActiveCall(guildId);
    if (!call) return; // cancelled before reactions were added

    call.callMessageId = callMsg.id;

    const statusMsg = await channel.send(buildStatusText(call));
    call.statusMessageId = statusMsg.id;

    // Reaction collector — only pool members, no bots
    const filter = (reaction, user) =>
        ['✅', '❌', '⏰'].includes(reaction.emoji.name) &&
        !user.bot &&
        call.poolSnapshot.includes(user.id);

    const collector = callMsg.createReactionCollector({ filter, dispose: true });

    collector.on('collect', async (reaction, user) => {
        const current = getActiveCall(guildId);
        if (!current) { collector.stop(); return; }

        // Mutual exclusivity: replace any prior reaction from this user
        current.reactions.yes.delete(user.id);
        current.reactions.no.delete(user.id);
        current.reactions.maybe.delete(user.id);

        if (reaction.emoji.name === '✅') current.reactions.yes.add(user.id);
        else if (reaction.emoji.name === '❌') current.reactions.no.add(user.id);
        else if (reaction.emoji.name === '⏰') current.reactions.maybe.add(user.id);

        await updateStatusMessage(statusMsg, current);

        if (shouldStop(current)) {
            collector.stop('conditions_met');
        }
    });

    collector.on('remove', async (reaction, user) => {
        const current = getActiveCall(guildId);
        if (!current) return;
        current.reactions.yes.delete(user.id);
        current.reactions.no.delete(user.id);
        current.reactions.maybe.delete(user.id);
        await updateStatusMessage(statusMsg, current);
    });

    collector.on('end', async (_, reason) => {
        const current = getActiveCall(guildId);
        if (!current) return; // already finalized by cancel
        if (reason !== 'cancelled') {
            await finalizeCall(guildId, channel, current);
        }
    });

    // Re-ping interval every 5 minutes
    call.repingTimer = setInterval(async () => {
        const current = getActiveCall(guildId);
        if (!current) return;

        current.repingRound++;

        if (shouldStop(current)) {
            clearInterval(current.repingTimer);
            collector.stop('conditions_met');
            return;
        }

        const responded = new Set([
            ...current.reactions.yes,
            ...current.reactions.no,
            ...current.reactions.maybe,
        ]);
        const pending = current.poolSnapshot.filter(id => !responded.has(id));

        if (pending.length > 0) {
            await channel.send(
                pending.map(id => `<@${id}>`).join(' ') + ' — still waiting on your reaction!'
            );
        }
    }, 5 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function handleCreate(interaction) {
    const guildId = interaction.guildId;
    const users = [];
    for (let i = 1; i <= 10; i++) {
        const val = interaction.options.getString(`user${i}`);
        if (!val) continue;
        try {
            const member = await interaction.guild.members.fetch(val);
            users.push({ id: member.id, username: member.user.username });
        } catch {
            return interaction.reply({ content: `Could not resolve user \`${val}\`. Pick from the autocomplete list.`, ephemeral: true });
        }
    }

    const count = poolCount(guildId);

    if (users.length === 0) {
        if (count > 0) {
            return interaction.reply({
                content: `Pool already exists with ${count} player${count !== 1 ? 's' : ''}. Use \`/stack list\` to see them.`,
                ephemeral: true,
            });
        }
        return interaction.reply('Empty pool created. Use `/stack add @user` to add players.');
    }

    const { added, skipped } = addPlayers(guildId, users);
    return interaction.reply(`Added **${added}**, skipped **${skipped}** already in pool.`);
}

async function handleAdd(interaction) {
    const guildId = interaction.guildId;
    const user = interaction.options.getUser('user');
    const { added } = addPlayers(guildId, [{ id: user.id, username: user.username }]);
    if (added === 0) {
        return interaction.reply({ content: `${user.username} is already in the pool.`, ephemeral: true });
    }
    const count = poolCount(guildId);
    return interaction.reply(`Added **${user.username}** to the pool. Pool now has **${count}** player${count !== 1 ? 's' : ''}.`);
}

async function handleRemove(interaction) {
    const guildId = interaction.guildId;
    const user = interaction.options.getUser('user');
    const removed = removePlayer(guildId, user.id);
    if (!removed) {
        return interaction.reply({ content: `${user.username} is not in the pool.`, ephemeral: true });
    }
    return interaction.reply(`Removed **${user.username}** from the pool.`);
}

async function handleList(interaction) {
    const guildId = interaction.guildId;
    const pool = listPool(guildId);
    if (pool.length === 0) {
        return interaction.reply({ content: 'Pool is empty.', ephemeral: true });
    }
    const embed = new EmbedBuilder()
        .setTitle(`Stack Pool — ${pool.length} player${pool.length !== 1 ? 's' : ''}`)
        .setDescription(pool.map((p, i) => `${i + 1}. <@${p.user_id}>`).join('\n'))
        .setColor(0xff4655);
    return interaction.reply({ embeds: [embed] });
}

async function handleCall(interaction) {
    const guildId = interaction.guildId;
    const pool = listPool(guildId);

    if (pool.length === 0) {
        return interaction.reply({ content: 'Pool is empty. Add players first.', ephemeral: true });
    }

    if (getActiveCall(guildId)) {
        return interaction.reply({ content: 'A call is already active. Use `/stack cancel` first.', ephemeral: true });
    }

    const timeStr = interaction.options.getString('time');
    const note    = interaction.options.getString('note');
    const tz      = getTimezone(guildId);

    const baseCall = {
        guildId,
        channelId: interaction.channelId,
        poolSnapshot: pool.map(p => p.user_id),
        note,
        callMessageId: null,
        statusMessageId: null,
        reactions: { yes: new Set(), no: new Set(), maybe: new Set() },
        repingRound: 0,
        repingTimer: null,
        scheduledTimer: null,
        isScheduled: false,
        scheduledFor: null,
    };

    if (timeStr) {
        const scheduledDate = parseScheduledTime(timeStr, tz);
        if (!scheduledDate || scheduledDate.getTime() <= Date.now()) {
            return interaction.reply({
                content: `Invalid or past time \`${timeStr}\`. Use \`"21:00"\` or \`"2026-05-22 21:00"\`.`,
                ephemeral: true,
            });
        }

        const delayMs = scheduledDate.getTime() - Date.now();
        const client = require('../../index.js');

        baseCall.isScheduled = true;
        baseCall.scheduledFor = scheduledDate;
        baseCall.scheduledTimer = setTimeout(async () => {
            const current = getActiveCall(guildId);
            if (!current) return;
            current.scheduledTimer = null;
            current.isScheduled = false;

            const channel = await client.channels.fetch(current.channelId).catch(() => null);
            if (!channel) { clearActiveCall(guildId); return; }
            await runCallCycle(channel, current.poolSnapshot, current.note, guildId);
        }, delayMs);

        setActiveCall(guildId, baseCall);
        return interaction.reply(`Scheduled call for **${formatDateTime(scheduledDate, tz)}**.`);
    }

    setActiveCall(guildId, baseCall);
    await interaction.deferReply();

    const channel = interaction.channel;
    // Delete the deferred "thinking" reply so the call message is first
    await interaction.deleteReply().catch(() => {});

    await runCallCycle(channel, baseCall.poolSnapshot, note, guildId);
}

async function handleCancel(interaction) {
    const guildId = interaction.guildId;
    const call = getActiveCall(guildId);

    if (!call) {
        return interaction.reply({ content: 'No active or scheduled call to cancel.', ephemeral: true });
    }

    if (call.repingTimer)    clearInterval(call.repingTimer);
    if (call.scheduledTimer) clearTimeout(call.scheduledTimer);

    clearActiveCall(guildId);

    // Try to edit the status message to reflect cancellation
    if (call.statusMessageId) {
        try {
            const channel = interaction.channel;
            const statusMsg = await channel.messages.fetch(call.statusMessageId);
            await statusMsg.edit(`**Stack status:** Cancelled by <@${interaction.user.id}>`);
        } catch {
            // not fatal
        }
    }

    return interaction.reply('Call cancelled.');
}

async function handleConfig(interaction) {
    const guildId = interaction.guildId;
    const tz = interaction.options.getString('timezone');

    if (!tz) {
        const current = getTimezone(guildId);
        return interaction.reply({ content: `Current timezone: \`${current}\``, ephemeral: true });
    }

    const valid = Intl.supportedValuesOf('timeZone').includes(tz);
    if (!valid) {
        return interaction.reply({
            content: `Invalid timezone \`${tz}\`. Use an IANA name like \`Europe/Paris\`.`,
            ephemeral: true,
        });
    }

    setTimezone(guildId, tz);
    return interaction.reply(`Server timezone set to \`${tz}\`.`);
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

async function autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const pool = listPool(interaction.guildId);

    // Exclude IDs already chosen in other user slots of this invocation
    const chosen = new Set();
    for (let i = 1; i <= 10; i++) {
        const val = interaction.options.getString(`user${i}`);
        if (val) chosen.add(val);
    }

    const choices = pool
        .filter(p => !chosen.has(p.user_id))
        .filter(p => p.username.toLowerCase().includes(focused))
        .slice(0, 25)
        .map(p => ({ name: p.username, value: p.user_id }));

    await interaction.respond(choices);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

async function execute(interaction) {
    const sub = interaction.options.getSubcommand();
    switch (sub) {
        case 'create': return handleCreate(interaction);
        case 'add':    return handleAdd(interaction);
        case 'remove': return handleRemove(interaction);
        case 'list':   return handleList(interaction);
        case 'call':   return handleCall(interaction);
        case 'cancel': return handleCancel(interaction);
        case 'config': return handleConfig(interaction);
    }
}

module.exports = { cooldown: 5, data, execute, autocomplete };
