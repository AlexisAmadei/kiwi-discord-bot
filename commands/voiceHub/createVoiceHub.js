const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
const { registerHub } = require('../../utils/voiceHubStore.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('create-voice-hub')
        .setDescription('Create a voice hub. Joining its channel spawns a personal voice channel for the user.')
        .addStringOption(option =>
            option.setName('hub-name')
                .setDescription('The name of the hub category.')
                .setRequired(false)
        )
        .addChannelOption(option =>
            option.setName('category')
                .setDescription('An existing category to place the hub channel in. If omitted, a new category is created.')
                .addChannelTypes(ChannelType.GuildCategory)
                .setRequired(false)
        ),
    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        }

        const hubName = interaction.options.getString('hub-name') || 'Voice Hub';
        let category = interaction.options.getChannel('category');

        await interaction.deferReply({ ephemeral: true });

        try {
            if (!category) {
                category = await interaction.guild.channels.create({
                    name: hubName,
                    type: ChannelType.GuildCategory,
                });
            }

            const hubChannel = await interaction.guild.channels.create({
                name: `➕ Join to create`,
                type: ChannelType.GuildVoice,
                parent: category.id,
                permissionOverwrites: [
                    {
                        id: interaction.guild.roles.everyone.id,
                        allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel],
                    },
                ],
            });

            registerHub(interaction.guild.id, hubChannel.id, category.id);

            await interaction.followUp({
                content: `Voice hub ready: <#${hubChannel.id}>. Joining it will spawn a personal voice channel.`,
                ephemeral: true,
            });
        } catch (error) {
            console.error('Error creating voice hub:', error);
            await interaction.followUp({ content: 'There was an error while creating the voice hub.', ephemeral: true });
        }
    },
};
