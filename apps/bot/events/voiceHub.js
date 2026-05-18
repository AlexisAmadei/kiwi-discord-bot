const { ChannelType, PermissionFlagsBits, Events } = require('discord.js');
const {
    getHub,
    addTempChannel,
    isTempChannel,
    removeTempChannel,
} = require('../utils/voiceHubStore.js');
const { logCommand } = require('../utils/logger.js');

function register(client) {
    client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
        try {
            if (newState.channelId && newState.channelId !== oldState.channelId) {
                const hub = getHub(newState.channelId);
                if (hub && newState.guild) {
                    const member = newState.member;
                    const displayName = member?.displayName || member?.user?.username || 'user';
                    const channel = await newState.guild.channels.create({
                        name: `${displayName}'s channel`,
                        type: ChannelType.GuildVoice,
                        parent: hub.categoryId,
                        permissionOverwrites: [
                            {
                                id: newState.guild.roles.everyone.id,
                                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
                            },
                            {
                                id: member.id,
                                allow: [
                                    PermissionFlagsBits.ManageChannels,
                                    PermissionFlagsBits.MoveMembers,
                                    PermissionFlagsBits.MuteMembers,
                                    PermissionFlagsBits.DeafenMembers,
                                ],
                            },
                        ],
                    });
                    addTempChannel(channel.id);
                    logCommand('voice_hub', {
                        guildId: newState.guild.id,
                        userId: member.id,
                        username: member.user?.username ?? displayName,
                        command: 'voice_hub_join',
                        detail: channel.id,
                    });
                    await member.voice.setChannel(channel).catch(async (err) => {
                        console.error('Failed to move member into temp channel:', err);
                        await channel.delete().catch(() => {});
                        removeTempChannel(channel.id);
                    });
                }
            }

            if (oldState.channelId && oldState.channelId !== newState.channelId) {
                if (isTempChannel(oldState.channelId)) {
                    const channel = oldState.guild.channels.cache.get(oldState.channelId)
                        || await oldState.guild.channels.fetch(oldState.channelId).catch(() => null);
                    if (channel && channel.members.size === 0) {
                        await channel.delete().catch((err) => {
                            console.error('Failed to delete temp voice channel:', err);
                        });
                        removeTempChannel(oldState.channelId);
                    }
                }
            }
        } catch (err) {
            console.error('voiceStateUpdate handler error:', err);
        }
    });
}

module.exports = { register };
