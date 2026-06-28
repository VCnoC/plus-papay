const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

function generatePKCE() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

function decodeJwt(token) {
    try {
        const base64Payload = token.split('.')[1];
        const payload = Buffer.from(base64Payload, 'base64').toString();
        return JSON.parse(payload);
    } catch (e) {
        return {};
    }
}

function parseProxyUrl(proxyValue) {
    if (!proxyValue) return null;
    try {
        const parsed = new URL(proxyValue);
        const hostWithPort = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
        return {
            protocol: parsed.protocol.replace(':', ''),
            server: `${parsed.protocol}//${hostWithPort}`,
            host: parsed.hostname,
            port: parsed.port ? parseInt(parsed.port, 10) : undefined,
            username: decodeURIComponent(parsed.username || ''),
            password: decodeURIComponent(parsed.password || '')
        };
    } catch (error) {
        console.warn(`代理格式无效: ${error.message}`);
        return null;
    }
}

async function buildAxiosTransportConfig(proxyValue) {
    if (!proxyValue) return {};
    const parsed = parseProxyUrl(proxyValue);
    if (!parsed) return {};
    if (parsed.protocol.startsWith('socks')) {
        const { SocksProxyAgent } = await import('socks-proxy-agent');
        const agent = new SocksProxyAgent(proxyValue);
        return { httpAgent: agent, httpsAgent: agent, proxy: false };
    }
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    const agent = new HttpsProxyAgent(proxyValue);
    return { httpAgent: agent, httpsAgent: agent, proxy: false };
}

function formatUtc8Timestamp(timestampMs) {
    const value = Number(timestampMs || 0);
    if (!Number.isFinite(value) || value <= 0) return '';
    return new Date(value + (8 * 60 * 60 * 1000))
        .toISOString()
        .replace(/\.\d{3}Z$/, '+08:00');
}

function saveIndividualAccountJson(entry, tokenBundle = {}) {
    const rootDir = path.join(__dirname, process.env.SUPPLY_MODE === '1' ? 'supply_files' : 'product_files');
    const sub2apiDir = path.join(rootDir, 'sub2api');
    const cpaDir = path.join(rootDir, 'cpa');
    fs.mkdirSync(sub2apiDir, { recursive: true });
    fs.mkdirSync(cpaDir, { recursive: true });

    const sub2apiWrapper = {
        exported_at: new Date().toISOString(),
        proxies: [],
        accounts: [entry]
    };

    const sub2apiFile = `${entry.name}.json`;
    const sub2apiPath = path.join(sub2apiDir, sub2apiFile);
    fs.writeFileSync(sub2apiPath, JSON.stringify(sub2apiWrapper, null, 2), 'utf-8');

    const accountId = entry?.credentials?.chatgpt_account_id || '';
    const accessPayload = decodeJwt(tokenBundle.access_token);
    const cpaData = {
        type: 'codex',
        email: entry.name,
        expired: formatUtc8Timestamp(Number(accessPayload.exp || 0) * 1000),
        id_token: tokenBundle.id_token || '',
        account_id: accountId,
        access_token: tokenBundle.access_token || '',
        last_refresh: formatUtc8Timestamp(Date.now()),
        refresh_token: tokenBundle.refresh_token || ''
    };
    const cpaFile = `${entry.name}.json`;
    const cpaPath = path.join(cpaDir, cpaFile);
    fs.writeFileSync(cpaPath, JSON.stringify(cpaData), 'utf-8');

    console.log(`\n🎉 [Success] sub2api 协议数据已导出至: ${sub2apiPath}`);
    console.log(`🎉 [Success] CPA 协议数据已导出至: ${cpaPath}`);

    return {
        filePath: sub2apiPath,
        fileName: sub2apiFile,
        sub2apiPath,
        sub2apiFile,
        cpaPath,
        cpaFile
    };
}

async function persistProductAsset(entry, exportInfo) {
    try {
        const store = require('./mysql-store');
        await store.ensureReady();
        await (process.env.SUPPLY_MODE === '1' ? store.addSupplyProduct : store.addProduct)(
            entry.name,
            exportInfo.sub2apiPath || exportInfo.filePath,
            null,
            entry?.credentials?.access_token || null
        );
        console.log(`📦 [Success] 成品号已同步入库: ${entry.name}`);
    } catch (error) {
        console.warn(`⚠️ 协议文件已导出，但同步成品号池失败: ${error.message}`);
    }
}

async function exchangeToken(code, verifier, email, proxyValue = '') {
    console.log("🎟️  [Step 3] 正在通过协议换取 Token Bundle...");
    const url = 'https://auth.openai.com/oauth/token';
    const payload = {
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        grant_type: "authorization_code",
        code: code,
        redirect_uri: "http://localhost:1455/auth/callback",
        code_verifier: verifier
    };

    try {
        const transportConfig = await buildAxiosTransportConfig(proxyValue);
        const resp = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' },
            ...transportConfig
        });
        const data = resp.data;

        const decodedAccess = decodeJwt(data.access_token);
        const decodedId = decodeJwt(data.id_token);
        const authInfo = decodedAccess["https://api.openai.com/auth"] || {};

        const accountEntry = {
            name: email,
            platform: "openai",
            type: "oauth",
            credentials: {
                access_token: data.access_token,
                chatgpt_account_id: authInfo.chatgpt_account_id,
                chatgpt_user_id: authInfo.chatgpt_user_id,
                expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
                expires_in: data.expires_in,
                organization_id: "",
                refresh_token: data.refresh_token
            },
            extra: {
                email: email,
                sub: decodedId.sub
            },
            concurrency: 10,
            priority: 1,
            rate_multiplier: 1,
            auto_pause_on_expired: true,
            plan_type: authInfo.chatgpt_plan_type || "plus"
        };

        const exportInfo = saveIndividualAccountJson(accountEntry, data);
        await persistProductAsset(accountEntry, exportInfo);
        return exportInfo;

    } catch (err) {
        console.error("换取 Token 失败:", err.response ? JSON.stringify(err.response.data) : err.message);
        throw err;
    }
}

module.exports = {
    generatePKCE,
    decodeJwt,
    parseProxyUrl,
    buildAxiosTransportConfig,
    formatUtc8Timestamp,
    saveIndividualAccountJson,
    persistProductAsset,
    exchangeToken
};
