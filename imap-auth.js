const axios = require('axios');

const IMAP_BASE_URL = 'https://imap.chiyiyi.cloud';
const IMAP_LOGIN_URL = `${IMAP_BASE_URL}/api/login`;
const IMAP_PASSWORD = process.env.IMAP_ADMIN_PASSWORD || '';
const IMAP_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

let cachedToken = '';
let tokenIssuedAt = 0;
let refreshPromise = null;
let refreshTimer = null;
let started = false;

function scheduleRefresh() {
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }

    refreshTimer = setTimeout(async () => {
        try {
            await refreshImapToken(true);
        } catch (error) {
            console.error(`❌ [IMAP] 定时刷新失败: ${error.message}`);
            scheduleRefresh();
        }
    }, IMAP_REFRESH_INTERVAL_MS);
}

async function refreshImapToken(force = false) {
    if (!force && cachedToken) {
        return cachedToken;
    }

    if (refreshPromise) {
        return refreshPromise;
    }

    refreshPromise = (async () => {
        const response = await axios.post(
            IMAP_LOGIN_URL,
            { password: IMAP_PASSWORD },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                timeout: 30000
            }
        );

        const token = String(response?.data?.token || '').trim();
        if (!token) {
            throw new Error('IMAP 登录失败：接口未返回 token');
        }

        cachedToken = token;
        tokenIssuedAt = Date.now();
        // (静默) IMAP Token 已刷新
        scheduleRefresh();
        return cachedToken;
    })();

    try {
        return await refreshPromise;
    } finally {
        refreshPromise = null;
    }
}

async function ensureImapToken() {
    return refreshImapToken(false);
}

async function forceRefreshImapToken() {
    cachedToken = '';
    return refreshImapToken(true);
}

async function getImapAuthHeaders(force = false) {
    const token = force ? await forceRefreshImapToken() : await ensureImapToken();
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0'
    };
}

async function initializeImapAuth() {
    if (started) {
        return ensureImapToken();
    }
    started = true;
    return forceRefreshImapToken();
}

initializeImapAuth().catch((error) => {
    console.error(`❌ [IMAP] 启动预刷新失败: ${error.message}`);
});

module.exports = {
    initializeImapAuth,
    ensureImapToken,
    forceRefreshImapToken,
    getImapAuthHeaders
};
