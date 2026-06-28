const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getImapAuthHeaders } = require('./imap-auth');
const inboxEmail = require('./inbox-email');
const poolEmailImap = require('./pool-email-imap');

// 使用 stealth 插件
chromium.use(stealth);

/**
 * 核心工具：生成 PKCE 校验对
 */
function generatePKCE() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

/**
 * 核心工具：JWT Payload 解码器
 */
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
    if (!proxyValue) {
        return null;
    }

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
        console.warn(`⚠️ [代理] 代理格式无效，跳过代理配置: ${error.message}`);
        return null;
    }
}

function buildPlaywrightProxy(proxyValue) {
    const parsed = parseProxyUrl(proxyValue);
    if (!parsed) {
        return null;
    }

    const proxy = {
        server: parsed.server
    };

    if (parsed.username) {
        proxy.username = parsed.username;
    }

    if (parsed.password) {
        proxy.password = parsed.password;
    }

    return proxy;
}

function buildAxiosProxyConfig(proxyValue) {
    const parsed = parseProxyUrl(proxyValue);
    if (!parsed || !parsed.host || !parsed.port) {
        return {};
    }

    const proxy = {
        protocol: parsed.protocol,
        host: parsed.host,
        port: parsed.port
    };

    if (parsed.username || parsed.password) {
        proxy.auth = {
            username: parsed.username,
            password: parsed.password
        };
    }

    return { proxy };
}

async function buildAxiosTransportConfig(proxyValue) {
    if (!proxyValue) {
        return {};
    }

    const parsed = parseProxyUrl(proxyValue);
    if (!parsed) {
        return {};
    }

    if (parsed.protocol.startsWith('socks')) {
        const { SocksProxyAgent } = await import('socks-proxy-agent');
        const agent = new SocksProxyAgent(proxyValue);
        return {
            httpAgent: agent,
            httpsAgent: agent,
            proxy: false
        };
    }

    const { HttpsProxyAgent } = await import('https-proxy-agent');
    const agent = new HttpsProxyAgent(proxyValue);
    return {
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false
    };
}

/**
 * 获取验证码的工具函数
 */
function normalizeImapTimestamp(message) {
    const candidates = [
        message?.createdAt,
        message?.updatedAt,
        message?.receivedAt,
        message?.date,
        message?.timestamp
    ];

    for (const candidate of candidates) {
        if (!candidate) continue;
        const value = new Date(candidate).getTime();
        if (!Number.isNaN(value)) {
            return value;
        }
    }

    return Number(message?.id || 0);
}

function getRandomEmailDomain() {
    return String(process.env.RANDOM_EMAIL_DOMAIN || 'chiyiyi.cloud')
        .trim()
        .replace(/^@/, '')
        .toLowerCase()
        || 'chiyiyi.cloud';
}

function escapeRegex(str) {
    return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeCloudEmail(email) {
    let normalized = String(email || '').trim().toLowerCase();
    if (!normalized) {
        return normalized;
    }

    const domain = getRandomEmailDomain();
    const dupRe = new RegExp(`@${escapeRegex(domain)}(?:\\.${escapeRegex(domain.split('.').pop() || '')})+$`, 'i');
    normalized = normalized.replace(dupRe, `@${domain}`);
    if (!normalized.includes('@')) {
        normalized = `${normalized}@${domain}`;
    }

    return normalized;
}

async function getLatestCode(email, maxRetries = 30, excludeCode = '', options = {}) {
    const normalizedEmail = normalizeCloudEmail(email);

    // 🆕 注册阶段如果用的是 Inbox 临时邮箱（temp-email-api），oauth_login 也必须用同一个 API 取码，
    // 否则会跑去问 chiyiyi.cloud 拿邮件，永远拿不到。
    const emailSource = String(process.env.EMAIL_SOURCE || '').toLowerCase();
    const inboxJwt = String(process.env.INBOX_JWT || '');
    const inboxApiBase = String(process.env.INBOX_API_BASE || '').trim().replace(/\/+$/, '');
    if (emailSource === 'inbox' && inboxJwt && inboxApiBase) {
        return inboxEmail.fetchLatestOpenAiOtp({
            baseUrl: inboxApiBase,
            jwt: inboxJwt,
            address: normalizedEmail,
            maxRetries,
            excludeCode,
            onNoNewCodeFor30Seconds: options.onNoNewCodeFor30Seconds || null,
            onBeforePoll: options.onBeforePoll || null
        });
    }

    if (emailSource === 'pool') {
        const poolPassword = String(process.env.POOL_EMAIL_PASSWORD || '');
        const poolClientId = String(process.env.POOL_EMAIL_CLIENT_ID || '');
        const poolRefreshToken = String(process.env.POOL_EMAIL_REFRESH_TOKEN || '');
        const poolHost = String(process.env.POOL_EMAIL_IMAP_HOST || 'outlook.office365.com').trim() || 'outlook.office365.com';
        const includeJunk = String(process.env.POOL_EMAIL_INCLUDE_JUNK || '1') === '1';

        if (!poolRefreshToken && !poolPassword) {
            throw new Error('邮箱池模式下缺少 IMAP 凭据（refresh_token 或 password），无法获取验证码');
        }

        console.log(`📨 [IMAP] 正在为 ${normalizedEmail} 获取验证码（邮箱池 IMAP）...`);
        const onBeforePoll = typeof options.onBeforePoll === 'function' ? options.onBeforePoll : null;

        for (let i = 0; i < maxRetries; i++) {
            if (i === 0 || (i + 1) % 5 === 0 || i + 1 === maxRetries) {
                console.log(`📨 [IMAP] 轮询中 ${i + 1}/${maxRetries}...`);
            }

            if (onBeforePoll) {
                const recovered = await onBeforePoll(i + 1);
                if (recovered) {
                    console.log('📨 [IMAP] 页面已恢复，继续等待新验证码...');
                }
            }

            try {
                const code = await poolEmailImap.fetchLatestOpenAiOtpOnce({
                    email: normalizedEmail,
                    password: poolPassword,
                    clientId: poolClientId,
                    refreshToken: poolRefreshToken,
                    host: poolHost,
                    includeJunk,
                    excludeCode
                });
                if (code) {
                    console.log(`📨 [IMAP] 已获取验证码: ${code}`);
                    return code;
                }
            } catch (err) {
                console.warn(`📨 [IMAP] 本次轮询失败: ${err.message || err}`);
            }

            await sleep(5000);
        }
        throw new Error('获取验证码超时');
    }

    console.log(`📨 [IMAP] 正在为 ${normalizedEmail} 获取验证码...`);
    const url = 'https://imap.chiyiyi.cloud/api/admin/all-messages?limit=15';
    const onNoNewCodeFor30Seconds = typeof options.onNoNewCodeFor30Seconds === 'function'
        ? options.onNoNewCodeFor30Seconds
        : null;
    const onBeforePoll = typeof options.onBeforePoll === 'function'
        ? options.onBeforePoll
        : null;
    let lastResendAt = 0;

    for (let i = 0; i < maxRetries; i++) {
        // 每 5 轮打印一次进度，避免刷屏
        if (i === 0 || (i + 1) % 5 === 0 || i + 1 === maxRetries) {
            console.log(`📨 [IMAP] 轮询中 ${i + 1}/${maxRetries}...`);
        }

        if (onBeforePoll) {
            const recovered = await onBeforePoll(i + 1);
            if (recovered) {
                console.log('📨 [IMAP] 页面已恢复，继续等待新验证码...');
            }
        }

        try {
            let headers = await getImapAuthHeaders(false);
            const response = await axios.get(url, {
                headers
            });
            const messages = response.data.messages;
            if (Array.isArray(messages) && messages.length > 0) {
                const targetMessages = messages
                    .filter(m =>
                        m?.targetEmail?.toLowerCase() === normalizedEmail &&
                        (m?.service === 'ChatGPT' || String(m?.subject || '').toLowerCase().includes('verification'))
                    )
                    .sort((a, b) => normalizeImapTimestamp(b) - normalizeImapTimestamp(a));

                const targetMsg = targetMessages.find(m => String(m.code || '').trim() && String(m.code).trim() !== excludeCode)
                    || targetMessages.find(m => String(m.code || '').trim());

                if (targetMsg) {
                    const code = String(targetMsg.code).trim();
                    if (excludeCode && code === excludeCode) {
                        // (静默) 仍是旧验证码
                    } else {
                        console.log(`📨 [IMAP] 已获取验证码: ${code}`);
                        return code;
                    }
                }
                // (静默) 暂未读取到新验证码
            }
            // (静默) 邮件列表为空
        } catch (err) {
            if (err.response && err.response.status === 401) {
                console.warn('📨 [IMAP] 鉴权失败 (401)，正在强制刷新 Token 后重试...');
                try {
                    const headers = await getImapAuthHeaders(true);
                    const retryResponse = await axios.get(url, { headers });
                    const messages = retryResponse.data.messages;
                    if (Array.isArray(messages) && messages.length > 0) {
                        const targetMessages = messages
                            .filter(m =>
                                m?.targetEmail?.toLowerCase() === normalizedEmail &&
                                (m?.service === 'ChatGPT' || String(m?.subject || '').toLowerCase().includes('verification'))
                            )
                            .sort((a, b) => normalizeImapTimestamp(b) - normalizeImapTimestamp(a));

                        const targetMsg = targetMessages.find(m => String(m.code || '').trim() && String(m.code).trim() !== excludeCode)
                            || targetMessages.find(m => String(m.code || '').trim());

                        if (targetMsg) {
                            const code = String(targetMsg.code).trim();
                            if (excludeCode && code === excludeCode) {
                                console.log(`📨 [IMAP] 当前最新验证码仍是旧值 ${code}，继续等待新验证码...`);
                            } else {
                                console.log(`📨 [IMAP] 成功获取验证码: ${code}`);
                                return code;
                            }
                        } else {
                            console.log('📨 [IMAP] 刷新 Token 后暂未读取到该邮箱的新验证码，继续轮询...');
                        }
                    } else {
                        console.log('📨 [IMAP] 刷新 Token 后邮件列表为空，继续轮询...');
                    }
                } catch (refreshErr) {
                    console.warn(`📨 [IMAP] Token 刷新后轮询仍失败: ${refreshErr.message || refreshErr}`);
                }
            } else {
                console.warn(`📨 [IMAP] 本次轮询失败: ${err.message || err}`);
            }
        }

        if (excludeCode && onNoNewCodeFor30Seconds && (i + 1) % 6 === 0) {
            const now = Date.now();
            if (now - lastResendAt >= 28000) {
                lastResendAt = now;
                await onNoNewCodeFor30Seconds();
            }
        }

        for (let waitTick = 0; waitTick < 10; waitTick += 1) {
            if (onBeforePoll) {
                const recovered = await onBeforePoll(i + 1);
                if (recovered) {
                    console.log('📨 [IMAP] 页面恢复完成，保持旧验证码排除，继续等待新验证码...');
                    break;
                }
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    throw new Error('获取验证码超时');
}

function formatUtc8Timestamp(timestampMs) {
    const value = Number(timestampMs || 0);
    if (!Number.isFinite(value) || value <= 0) {
        return '';
    }
    return new Date(value + (8 * 60 * 60 * 1000))
        .toISOString()
        .replace(/\.\d{3}Z$/, '+08:00');
}

/**
 * 导出成品协议文件：
 * 1. 保持现有 sub2api 文件格式不变
 * 2. 额外生成一份 CPA 兼容文件
 */
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
        await store.ensureReady();
        await (process.env.SUPPLY_MODE === '1' ? store.addSupplyProduct : store.addProduct)(
            entry.name,
            exportInfo.sub2apiPath || exportInfo.filePath,
            null,
            entry?.credentials?.access_token || null
        );
        console.log(`📦 [Success] 成品号已同步入库: ${entry.name}`);
    } catch (error) {
        console.warn(`⚠️ ⚠️  [Warn] 协议文件已导出，但同步成品号池失败: ${error.message}`);
    }
}

/**
 * 核心流程：使用 Code 换取 Token 并解析
 */
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
        console.log(authInfo);
        
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

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function saveFailureScreenshot(page, prefix = 'oauth_login_error') {
    if (!page || page.isClosed()) {
        return null;
    }

    const screenshotDir = path.join(__dirname, 'debug_screenshots', '上号');
    fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, `${prefix}_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`📸 [系统] 异常截图已保存: ${screenshotPath}`);
    return screenshotPath;
}

async function humanType(page, selector, text) {
    await page.focus(selector);
    for (const char of text) {
        await page.type(selector, char, { delay: Math.random() * 100 + 50 });
    }
}

async function humanClick(page, selector) {
    const element = await page.waitForSelector(selector, { visible: true });
    await element.hover();
    await sleep(Math.random() * 500 + 200);
    await element.click();
}

async function clearAndType(page, selector, text) {
    const input = page.locator(selector).first();
    await input.waitFor({ state: 'visible', timeout: 30000 });
    await input.click({ clickCount: 3 });
    await input.fill('');
    await sleep(Math.random() * 400 + 150);
    await humanType(page, selector, text);
}

const OTP_INPUT_SELECTORS = [
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[name="code"]',
    'input[type="tel"]',
    'input[type="text"]'
];

const MAX_OTP_RETRIES = 5;
const OTP_RETRY_EXCEEDED_ERROR = `验证码重试超过 ${MAX_OTP_RETRIES} 次，需要重新上号`;
const OTP_REFETCH_AFTER_RECOVERY = 'OTP_REFETCH_AFTER_RECOVERY';
const ADD_PHONE_REQUIRED_ERROR = '当前账号触发手机号验证';

async function isAddPhoneRequiredPage(page) {
    try {
        const url = String(page.url() || '').toLowerCase();
        const bodyText = String(await page.textContent('body', { timeout: 3000 }).catch(() => '') || '');
        return url.includes('/add-phone')
            || bodyText.includes('电话号码是必填项')
            || bodyText.includes('请继续添加电话号码')
            || bodyText.includes('我们将向该号码发送一次性验证码以进行验证')
            || bodyText.toLowerCase().includes('Phone number');
    } catch (_) {
        return false;
    }
}

async function assertNotAddPhoneRequired(page) {
    if (await isAddPhoneRequiredPage(page)) {
        throw new Error(ADD_PHONE_REQUIRED_ERROR);
    }
}

async function findVisibleOtpSelector(page, timeout = 30000) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        await assertNotAddPhoneRequired(page);
        for (const selector of OTP_INPUT_SELECTORS) {
            const locator = page.locator(selector).first();
            if (await locator.isVisible().catch(() => false)) {
                return selector;
            }
        }
        await page.waitForTimeout(500);
    }

    const bodyText = String(await page.textContent('body', { timeout: 3000 }).catch(() => '') || '').slice(0, 500);
    throw new Error(`未找到可见的验证码输入框，页面片段: ${bodyText}`);
}

async function isOtpIncorrect(page) {
    const errorPatterns = [
        '代码不正确',
        'code incorrect',
        'the code is incorrect',
        'invalid code',
        'incorrect code'
    ];

    try {
        const bodyText = String(await page.textContent('body', { timeout: 4000 }).catch(() => '') || '').toLowerCase();
        return errorPatterns.some(pattern => bodyText.includes(pattern.toLowerCase()));
    } catch (_) {
        return false;
    }
}

async function isConnectionClosedPage(page) {
    try {
        const bodyText = String(await page.textContent('body', { timeout: 3000 }).catch(() => '') || '');
        return bodyText.includes('ERR_CONNECTION_CLOSED')
            || bodyText.includes('无法访问此网站')
            || bodyText.includes('意外终止了连接')
            || bodyText.includes('This site can’t be reached')
            || bodyText.includes('This site cannot be reached');
    } catch (_) {
        return false;
    }
}

async function isOperationTimedOutPage(page) {
    try {
        const bodyText = String(await page.textContent('body', { timeout: 3000 }).catch(() => '') || '');
        return bodyText.includes('Operation timed out') || bodyText.includes('糟糕，出错了');
    } catch (_) {
        return false;
    }
}

async function recoverOperationTimeout(page, email, authUrl = '') {
    if (!(await isOperationTimedOutPage(page))) {
        return false;
    }

    console.warn('⚠️  [Warn] 检测到 OpenAI 超时页，尝试点击“重试”并重新填写邮箱...');
    const retryButton = page.getByRole('button', { name: /重试|Try again/i }).first();
    await retryButton.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });
    if (await retryButton.isVisible().catch(() => false)) {
        let clicked = false;
        clicked = await retryButton.click({ force: true }).then(() => true).catch(() => false);
        if (!clicked) {
            clicked = await retryButton.dispatchEvent('click').then(() => true).catch(() => false);
        }
        if (!clicked) {
            clicked = await retryButton.evaluate((node) => {
                if (node instanceof HTMLElement) {
                    node.click();
                    return true;
                }
                return false;
            }).catch(() => false);
        }
        if (clicked) {
            console.log('ℹ️  [Info] 超时恢复：已点击“重试”按钮。');
            await page.waitForTimeout(3000);
        } else {
            console.warn('⚠️  [Warn] 超时恢复：未能成功点击“重试”按钮，将尝试直接回到授权入口。');
        }
    }

    if (await isOperationTimedOutPage(page)) {
        const nextUrl = authUrl || page.url();
        if (nextUrl) {
            await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
            await page.waitForTimeout(3000);
        }
    }

    const emailInput = page.locator('input[type="email"]').first();
    const emailReady = await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => { })
        .then(async () => {
            await page.waitForTimeout(1500);
            return emailInput.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
        });
    if (emailReady) {
        console.log('ℹ️  [Info] 超时恢复：邮箱页已加载完成，正在重新输入邮箱...');
        await clearAndType(page, 'input[type="email"]', email);
        await sleep(Math.random() * 1000 + 500);
        await humanClick(page, 'button[type="submit"]');
        await page.waitForTimeout(1500);

        const recoveredToOtp = await Promise.race([
            findVisibleOtpSelector(page, 15000).then(() => true).catch(() => false),
            page.waitForTimeout(15000).then(() => false)
        ]);

        if (recoveredToOtp) {
            console.log('ℹ️  [Info] 超时恢复：已重新提交邮箱，并回到验证码页面。');
        } else {
            console.warn('⚠️  [Warn] 超时恢复：邮箱已重新提交，但验证码页尚未明确出现，后续继续等待页面推进。');
        }
        return true;
    }

    return !(await isOperationTimedOutPage(page));
}

async function recoverConnectionClosed(page, fallbackUrl = '') {
    if (!(await isConnectionClosedPage(page))) {
        return false;
    }

    console.warn('⚠️  [Warn] 检测到浏览器连接关闭错误页，正在尝试自动重载...');
    for (let attempt = 1; attempt <= 3; attempt++) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(async () => {
            const nextUrl = fallbackUrl || page.url();
            if (nextUrl) {
                return page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
            }
        });
        await page.waitForTimeout(3000);
        if (!(await isConnectionClosedPage(page))) {
            console.log(`ℹ️  [Info] 连接关闭错误页已恢复 (第 ${attempt} 次重载成功)。`);
            return true;
        }
    }

    return false;
}

async function waitForOtpInputReady(page, email, authUrl = '', timeout = 45000) {
    const deadline = Date.now() + timeout;
    let lastStateLog = 0;

    while (Date.now() < deadline) {
        await assertNotAddPhoneRequired(page);
        const otpSelector = await findVisibleOtpSelector(page, 2000).catch(() => '');
        if (otpSelector) {
            return otpSelector;
        }

        if (await recoverConnectionClosed(page, authUrl)) {
            await page.waitForTimeout(1500);
            continue;
        }

        if (await recoverOperationTimeout(page, email, authUrl)) {
            console.warn('[OTP] 拿到验证码后页面又恢复了，当前验证码作废，准备重新获取新验证码...');
            throw new Error(OTP_REFETCH_AFTER_RECOVERY);
        }

        const now = Date.now();
        if (now - lastStateLog >= 5000) {
            lastStateLog = now;
            const emailVisible = await page.locator('input[type="email"]').first().isVisible().catch(() => false);
            if (emailVisible) {
                console.warn('[OTP] 已拿到验证码，但页面仍停留在邮箱页，继续等待验证码输入框或恢复流程...');
            } else {
                console.log('[OTP] 已拿到验证码，正在等待验证码输入框出现...');
            }
        }

        await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => { });
        await page.waitForTimeout(1000);
    }

    const bodyText = String(await page.textContent('body', { timeout: 3000 }).catch(() => '') || '').slice(0, 500);
    throw new Error(`未找到可见的验证码输入框，页面片段: ${bodyText}`);
}

async function submitOtpWithRetry(page, email, maxAttempts = MAX_OTP_RETRIES, options = {}) {
    const normalizedEmail = normalizeCloudEmail(email);
    let lastCode = '';
    const beforeAttempt = typeof options.beforeAttempt === 'function' ? options.beforeAttempt : null;

    const clickResendEmail = async () => {
        const resendButton = page.locator('button[type="submit"][name="intent"][value="resend"]').first();
        if (await resendButton.isVisible().catch(() => false)) {
            console.warn('[OTP] 超过 30 秒未收到新验证码，正在点击“重新发送电子邮件”...');
            await resendButton.click({ force: true }).catch(() => { });
            await page.waitForTimeout(2000);
        }
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (beforeAttempt) {
            await beforeAttempt(attempt);
        }

        const code = await getLatestCode(normalizedEmail, attempt === 1 ? 30 : 36, lastCode, {
            onNoNewCodeFor30Seconds: clickResendEmail,
            onBeforePoll: async () => recoverOperationTimeout(page, normalizedEmail, page.url())
        });
        lastCode = code;
        if (beforeAttempt) {
            await beforeAttempt(attempt);
        }
        let otpSelector = '';
        try {
            otpSelector = await waitForOtpInputReady(page, normalizedEmail, page.url(), 45000);
        } catch (error) {
            if (error && error.message === OTP_REFETCH_AFTER_RECOVERY) {
                if (attempt < maxAttempts) {
                    console.warn(`[OTP] 页面恢复后需要重新拉取验证码，准备重试 (${attempt}/${maxAttempts})...`);
                    continue;
                }
                throw new Error(OTP_RETRY_EXCEEDED_ERROR);
            }
            throw error;
        }

        console.log(`[OTP] 第 ${attempt} 次提交验证码: ${code}`);
        await clearAndType(page, otpSelector, code);
        await sleep(Math.random() * 1000 + 500);
        await humanClick(page, 'button[type="submit"]');
        await page.waitForTimeout(3000);
        await assertNotAddPhoneRequired(page);

        if (!(await isOtpIncorrect(page))) {
            return code;
        }

        if (attempt < maxAttempts) {
            console.warn(`[OTP] 验证码被判定为错误，等待新验证码后重试 (${attempt}/${maxAttempts})...`);
        }
    }

    throw new Error(OTP_RETRY_EXCEEDED_ERROR);
}

/** 外网探针：httpbin 偶发 400/限流时换 ipify；与 exchangeToken 一致走 buildAxiosTransportConfig（支持 SOCKS 等） */
const PROXY_PROBE_URLS = [
    'https://httpbin.org/ip',
    'https://api.ipify.org?format=json'
];

/**
 * 检查代理可用性（多 URL、每 URL 多次重试）
 * @param {string} proxyUrl - 代理URL
 * @returns {Promise<boolean>} - 代理是否可用
 */
async function checkProxyAvailability(proxyUrl) {
    if (!proxyUrl) return true;

    // (静默) 验证代理可用性

    let transportConfig = {};
    try {
        transportConfig = await buildAxiosTransportConfig(proxyUrl);
    } catch (error) {
        console.error(`❌ [代理检查] 构建传输配置失败: ${error.message}`);
        return false;
    }

    const perUrlAttempts = 2;
    const pauseBetweenAttemptsMs = 2000;
    const pauseBetweenUrlsMs = 1500;

    for (const url of PROXY_PROBE_URLS) {
        for (let attempt = 1; attempt <= perUrlAttempts; attempt += 1) {
            try {
                const response = await axios.get(url, {
                    ...transportConfig,
                    timeout: 18000,
                    validateStatus: () => true
                });

                if (response.status === 200 && response.data) {
                    // (静默) 代理可用
                    return true;
                }
                // (静默) 单次探针异常
            } catch (error) {
                // (静默) 探针失败，继续下一次
            }

            if (attempt < perUrlAttempts) {
                await sleep(pauseBetweenAttemptsMs);
            }
        }
        await sleep(pauseBetweenUrlsMs);
    }

    console.error(`❌ [代理检查] 全部探针失败`);
    return false;
}

const store = require('./mysql-store');

async function runFullProtocolFlow(email) {
    email = normalizeCloudEmail(email);
    // 阶段三代理检查（仅取代理，不锁定手机/卡资产）；失败则重新拉取配置并多轮重试
    const maxProxyRounds = 5;
    let proxyValue = '';
    let proxyOk = false;
    for (let round = 1; round <= maxProxyRounds; round += 1) {
        try {
            proxyValue = await store.getActiveProxy();
        } catch (e) {
            console.warn(`[!] [系统] 无法从后端获取代理配置: ${e.message}`);
        }

        proxyOk = !proxyValue || (await checkProxyAvailability(proxyValue));
        if (proxyOk) {
            break;
        }

        console.warn(`⚠️ [代理检查] 第 ${round}/${maxProxyRounds} 轮未通过，2s 后重新拉取代理并重试...`);
        if (round >= maxProxyRounds) {
            throw new Error('代理不可用');
        }
        await sleep(2000);
    }

    const { verifier, challenge } = generatePKCE();
    const state = crypto.randomBytes(16).toString('hex');

    const authUrl = `https://auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann&code_challenge=${challenge}&code_challenge_method=S256&codex_cli_simplified_flow=true&id_token_add_organizations=true&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&response_type=code&scope=openid+profile+email+offline_access&state=${state}`;

    let browser;
    let page = null;
    try {
        const launchOptions = {
            headless: true
        };
        const playwrightProxy = buildPlaywrightProxy(proxyValue);
        if (playwrightProxy) {
            launchOptions.proxy = playwrightProxy;
            const _proxyHost = (() => { try { return new URL(proxyValue).host; } catch (_) { return '已配置'; } })();
            console.log(`🌐 [系统] 代理已配置`);
        }

        browser = await chromium.launch(launchOptions);
        let context;

        // 普号提取模式：加载注册时保存的完整浏览器状态复用session
        if (process.env.FREE_TOKEN_FLOW === '1') {
            try {
                const statePath = `/tmp/free_token_state_${email.replace(/[^a-zA-Z0-9]/g, '_')}.json`;
                if (fs.existsSync(statePath)) {
                    context = await browser.newContext({ storageState: statePath });
                    console.log(`[FreeToken] 已加载浏览器完整状态: ${statePath}`);
                } else {
                    context = await browser.newContext();
                }
            } catch (stateErr) {
                console.warn(`[FreeToken] 加载浏览器状态失败: ${stateErr.message}`);
                context = await browser.newContext();
            }
        } else {
            context = await browser.newContext();
        }

        page = await context.newPage();

        console.log("🔐 [Step 1] 正在处理授权登录...");
        await page.goto(authUrl, { waitUntil: 'domcontentloaded' });
        await recoverConnectionClosed(page, authUrl);
        await recoverOperationTimeout(page, email, authUrl);

        // 普号提取模式：检测是否已登录（复用session）
        let isAlreadyLoggedIn = false;
        let isAlreadyAuthorized = false;
        if (process.env.FREE_TOKEN_FLOW === '1') {
            await sleep(3000);
            const currentUrl = page.url();
            const bodyText = String(await page.textContent('body', { timeout: 3000 }).catch(() => '') || '');
            // 已授权完成：直接跳转到回调URL
            if (currentUrl.includes('localhost:1455/auth/callback')) {
                isAlreadyLoggedIn = true;
                isAlreadyAuthorized = true;
                console.log('✅ [FreeToken] 检测到已授权完成，直接提取code');
            } else if (!currentUrl.includes('/authorize') && !bodyText.includes('Continue with') && !bodyText.includes('Welcome back')) {
                isAlreadyLoggedIn = true;
                console.log('✅ [FreeToken] 检测到已登录，跳过登录步骤');
            } else if (bodyText.includes('Welcome back') || bodyText.includes('Choose an account') || bodyText.includes('选择帐户') || bodyText.includes('选择账号')) {
                // 🆕 [PATCH] Welcome back 页面：OAuth 域 cookie 还在，但需要手动选已存在账号
                try {
                    const existingBtn = page.locator('button[name="session_id"]').first();
                    if (await existingBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                        console.log('🎯 [FreeToken] Welcome back 页面，点击已存在账号继续...');
                        await existingBtn.click();
                        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
                        await sleep(3000);
                        const newUrl = page.url();
                        if (newUrl.includes('localhost:1455/auth/callback')) {
                            isAlreadyLoggedIn = true;
                            isAlreadyAuthorized = true;
                            console.log('✅ [FreeToken] 点击账号后直接到达 callback');
                        } else if (!newUrl.includes('/login') && !newUrl.toLowerCase().includes('/log_in')) {
                            isAlreadyLoggedIn = true;
                            console.log('✅ [FreeToken] 点击账号后已登录，进入授权确认');
                        } else {
                            console.log('⚠️ [FreeToken] 点击账号后仍未登录，走完整登录流程');
                        }
                    } else {
                        console.log('⚠️ [FreeToken] Welcome back 页面但未找到账号按钮，走完整登录流程');
                    }
                } catch (welcomeErr) {
                    console.warn(`⚠️ [FreeToken] Welcome back 处理失败: ${welcomeErr.message}`);
                }
            } else {
                console.log('⚠️ [FreeToken] 未检测到登录状态，需要重新登录');
            }
        }

        if (!isAlreadyLoggedIn) {
            await sleep(Math.random() * 2000 + 1000);
            await recoverConnectionClosed(page, authUrl);
            await recoverOperationTimeout(page, email, authUrl);
            await humanType(page, 'input[type="email"]', email);
            await sleep(Math.random() * 1000 + 500);
            await humanClick(page, 'button[type="submit"]');

            await sleep(Math.random() * 2000 + 1000);
            await recoverConnectionClosed(page, authUrl);
            await recoverOperationTimeout(page, email, authUrl);
            await submitOtpWithRetry(page, email, MAX_OTP_RETRIES, {
                beforeAttempt: async () => recoverOperationTimeout(page, email, authUrl)
            });
            await assertNotAddPhoneRequired(page);
        }

        if (isAlreadyAuthorized) {
            // 已授权完成，直接从当前URL提取code
            const currentUrl = page.url();
            const code = new URL(currentUrl).searchParams.get('code');
            if (code) {
                console.log('✅ [FreeToken] 已从回调URL提取code');
                const result = await exchangeToken(code, verifier, email, proxyValue);
                return result;
            }
            throw new Error('已授权完成但未获取到code');
        }

        console.log("✍️  [Step 2] 正在确认授权...");
        await page.waitForTimeout(2000);
        await recoverConnectionClosed(page, authUrl);
        await recoverOperationTimeout(page, email, authUrl);
        await assertNotAddPhoneRequired(page);
        await sleep(Math.random() * 1500 + 500);
        await humanClick(page, 'button[type="submit"]');

        console.log("⏳ [Wait] 正在等待回调跳转...");
        const request = await page.waitForRequest(req =>
            req.url().includes('localhost:1455/auth/callback'),
            { timeout: 60000 }
        );

        const code = new URL(request.url()).searchParams.get('code');
        const result = await exchangeToken(code, verifier, email, proxyValue);
        return result;

    } catch (e) {
        const msg = String(e?.message || e || '协议提取失败');
        // 已知错误（验证码超时 / 代理问题）只打一行；不再打长堆栈和截图
        const isKnown = /获取验证码超时|代理不可用|代理或网络持续超时|page\.goto/i.test(msg);
        if (isKnown) {
            console.error(`❌ [协议] ${msg}`);
        } else {
            console.error("致命错误:", msg);
            try {
                await saveFailureScreenshot(page);
            } catch (_) { }
        }
        throw e;
    } finally {
        if (browser) await browser.close();
    }
}

if (require.main === module) {
    const email = process.argv[2] || "test@example.com";
    runFullProtocolFlow(email)
        .then((result) => {
            if (process.send) {
                process.send({ type: 'result', result });
            }
            process.exit(0);
        })
        .catch((error) => {
            const msg = String(error?.message || error || '协议提取失败');
            if (process.send) {
                process.send({ type: 'error', message: msg });
            }
            // 已知错误只打一行；其它错误才打完整堆栈
            const isKnown = /获取验证码超时|代理不可用|代理或网络持续超时|page\.goto/i.test(msg);
            if (isKnown) {
                console.error(`❌ [协议] ${msg}`);
            } else {
                console.error(error);
            }
            process.exit(1);
        });
}

module.exports = { runFullProtocolFlow };
