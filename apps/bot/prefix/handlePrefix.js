const { logCommand } = require('../utils/logger.js');
const myID = "376774687209947136"

function handlePrefix(message) {
    let messageArray = [];
    let args = null;

    messageArray = message.content.split(' ');
    if (message.content === 'ping' && message.author.id === myID) {
        logCommand('prefix', {
            guildId: message.guildId,
            userId: message.author.id,
            username: message.author.username,
            command: 'ping',
        });
        console.log(`# ${new Date().toString().slice(4, 24)} --> Nouveau message de ${message.author.username} avec ping`);
        message.channel.send('pong !');
    }
    // if (message.content[0] === '-') {
    //     messageArray = message.content.split(' ');
    //     if (messageArray[0] === '-deezer') {
    //         args = messageArray[1];
    //     }
    //     console.log(`# ${messageArray[0]}`);
    // }
}

module.exports = handlePrefix;