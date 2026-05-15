const fs = require('node:fs');
const path = require('node:path');

const STORE_PATH = path.join(__dirname, '..', 'voiceHubs.json');

function load() {
    try {
        if (!fs.existsSync(STORE_PATH)) return { hubs: [], temp: [] };
        const raw = fs.readFileSync(STORE_PATH, 'utf8');
        const data = JSON.parse(raw);
        return {
            hubs: Array.isArray(data.hubs) ? data.hubs : [],
            temp: Array.isArray(data.temp) ? data.temp : [],
        };
    } catch (err) {
        console.error('Failed to read voiceHubs.json, resetting:', err);
        return { hubs: [], temp: [] };
    }
}

function save(data) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

function registerHub(guildId, channelId, categoryId) {
    const data = load();
    if (!data.hubs.some(h => h.channelId === channelId)) {
        data.hubs.push({ guildId, channelId, categoryId });
        save(data);
    }
}

function isHubChannel(channelId) {
    return load().hubs.some(h => h.channelId === channelId);
}

function getHub(channelId) {
    return load().hubs.find(h => h.channelId === channelId) || null;
}

function addTempChannel(channelId) {
    const data = load();
    if (!data.temp.includes(channelId)) {
        data.temp.push(channelId);
        save(data);
    }
}

function isTempChannel(channelId) {
    return load().temp.includes(channelId);
}

function removeTempChannel(channelId) {
    const data = load();
    const next = data.temp.filter(id => id !== channelId);
    if (next.length !== data.temp.length) {
        data.temp = next;
        save(data);
    }
}

module.exports = {
    registerHub,
    isHubChannel,
    getHub,
    addTempChannel,
    isTempChannel,
    removeTempChannel,
};
