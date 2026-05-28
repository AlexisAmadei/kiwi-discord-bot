const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const CATEGORIES = [
    {
        name: '🎮 Fun',
        value: [
            '`/pfc` — Rock Paper Scissors against the bot',
            '`/stack create/add/remove/list/call/cancel/config` — Valorant five-stack pool manager',
        ].join('\n'),
    },
    {
        name: '⚔️ Clash of Clans',
        value: [
            '`/coc clan register/info/war/unregister` — Manage & inspect the server clan',
            '`/coc reminder add/list/remove` — Schedule CoC event reminders',
            '`/coc link set/who/list` — Link Discord accounts to in-game tags',
            '`/coc config` — Server timezone & automatic war reminders',
        ].join('\n'),
    },
    {
        name: '🔧 Server Setup',
        value: [
            '`/create-voice-hub` — Create a voice hub (joining spawns a personal channel)',
            '`/add-game` — Create a game category with text & voice channels',
            '`/create-category` — Create a channel category',
            '`/create-text-channel` — Create a text channel',
            '`/create-voice-channel` — Create a voice channel',
        ].join('\n'),
    },
    {
        name: '🛠️ Utility',
        value: [
            '`/avatar` — Display a user\'s avatar',
            '`/date` — Show the current date and time',
            '`/user` — Show info about a user',
            '`/stats commands/users/voicehub` — Bot usage statistics',
            '`/help` — Show this message',
        ].join('\n'),
    },
];

module.exports = {
    cooldown: 60,
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('List all available commands.'),
    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setTitle('Star Command — Commands')
            .setColor(0x5865F2)
            .addFields(CATEGORIES)
            .setFooter({ text: 'Use / to see command options and descriptions.' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
    },
};
