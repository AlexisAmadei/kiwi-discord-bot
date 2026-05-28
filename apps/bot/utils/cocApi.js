// utils/cocApi.js
// -----------------------------------------------------------------------------
// Thin wrapper around the official Clash of Clans API (uses native fetch — Node 20).
//
// IMPORTANT — the IP-whitelist gotcha:
//   Tokens from https://developer.clashofclans.com are locked to the public IP
//   that created them. A Dockerised bot on a VPS/cloud host usually does NOT have
//   a stable, known egress IP, so the token silently 403s ("accessDenied.invalidIp").
//
//   Two ways to deal with it:
//     1) Bot has a static IP  -> whitelist it on the token, use the official base.
//     2) Bot has a dynamic IP -> use the RoyaleAPI proxy: whitelist 45.79.218.79
//        on your token and set COC_API_BASE=https://proxy.royaleapi.dev/v1
//        (https://docs.royaleapi.com/proxy)
// -----------------------------------------------------------------------------

const BASE = (process.env.COC_API_BASE || 'https://cocproxy.royaleapi.dev/v1').replace(/\/+$/, '');
const TOKEN = (process.env.COC_API_TOKEN || '').trim();

class CocApiError extends Error {
    constructor(message, status, reason) {
        super(message);
        this.name = 'CocApiError';
        this.status = status;   // HTTP status (0 if request never left)
        this.reason = reason;   // Supercell "reason" code, e.g. accessDenied.invalidIp
    }
}

// Tags look like "#2PP0JJ8QL". The '#' must be percent-encoded to %23.
// Supercell's tag alphabet has no letter O, so the common "O vs 0" typo is normalised.
function encodeTag(tag) {
    const clean = String(tag).trim().toUpperCase().replace(/O/g, '0');
    const withHash = clean.startsWith('#') ? clean : `#${clean}`;
    return encodeURIComponent(withHash);
}

async function request(pathname) {
    if (!TOKEN) throw new CocApiError('COC_API_TOKEN is not set.', 0, 'noToken');

    let res;
    try {
        res = await fetch(`${BASE}${pathname}`, {
            headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
        });
    } catch (err) {
        throw new CocApiError(`Network error reaching CoC API: ${err.message}`, 0, 'network');
    }

    if (!res.ok) {
        let reason = res.statusText;
        try { reason = (await res.json()).reason || reason; } catch { /* body not JSON */ }
        throw new CocApiError(`CoC API ${res.status}: ${reason}`, res.status, reason);
    }
    return res.json();
}

module.exports = {
    CocApiError,
    encodeTag,
    isConfigured: () => Boolean(TOKEN),

    getClan:        (tag) => request(`/clans/${encodeTag(tag)}`),
    getMembers:     (tag) => request(`/clans/${encodeTag(tag)}/members`),
    getCurrentWar:  (tag) => request(`/clans/${encodeTag(tag)}/currentwar`),
    getWarLog:      (tag) => request(`/clans/${encodeTag(tag)}/warlog?limit=10`),
    getCapitalRaids:(tag) => request(`/clans/${encodeTag(tag)}/capitalraidseasons?limit=1`),
    getPlayer:      (tag) => request(`/players/${encodeTag(tag)}`),
};