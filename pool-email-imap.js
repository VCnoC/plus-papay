const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const axios = require('axios');

// 微软「common」端点：兼容个人账户与组织账户
const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
// IMAP + offline_access：换 access_token 给 IMAP 用
const MS_IMAP_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access';

function stripHtml(html) {
    return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function looksLikeOpenAiVerification(subject, bodyText) {
    const haystack = `${subject || ''}\n${bodyText || ''}`.toLowerCase();
    return /openai|chatgpt|verification|verify|验证码/.test(haystack);
}

function extractSixDigitCodes(text) {
    const codes = [];
    const re = /\b(\d{6})\b/g;
    let match = re.exec(text);
    while (match) {
        codes.push(match[1]);
        match = re.exec(text);
    }
    return codes;
}

function envelopeTimestampMs(msg) {
    if (msg.internalDate) {
        const t = new Date(msg.internalDate).getTime();
        if (!Number.isNaN(t)) {
            return t;
        }
    }
    const envDate = msg.envelope?.date;
    if (envDate) {
        const t = new Date(envDate).getTime();
        if (!Number.isNaN(t)) {
            return t;
        }
    }
    return 0;
}

function formatAddresses(list) {
    if (!Array.isArray(list)) {
        return '';
    }
    return list
        .map((entry) => entry.address || entry.name || '')
        .filter(Boolean)
        .join(', ');
}

async function resolveMailboxPaths(client, includeJunk) {
    const paths = ['INBOX'];
    if (!includeJunk) {
        return paths;
    }

    let folders = [];
    try {
        folders = await client.list();
    } catch (_) {
        return paths;
    }

    const extras = [];
    for (const folder of folders) {
        const su = folder.specialUse || '';
        const p = folder.path || '';
        if (!p || p === 'INBOX') {
            continue;
        }
        if (su === '\\Junk' || /junk|spam|垃圾箱/i.test(p)) {
            extras.push(p);
        }
    }

    return [...new Set([...paths, ...extras])];
}

async function fetchRecentMessagesFromMailbox(client, mailboxPath, spanSeq = 90) {
    const rows = [];
    const lock = await client.getMailboxLock(mailboxPath);

    try {
        const exists = client.mailbox.exists;
        if (!exists) {
            return rows;
        }

        const span = Math.min(spanSeq, exists);
        const startSeq = Math.max(1, exists - span + 1);

        for await (const msg of client.fetch(`${startSeq}:${exists}`, {
            uid: true,
            envelope: true,
            internalDate: true,
            source: true
        })) {
            rows.push(msg);
        }
    } finally {
        lock.release();
    }

    return rows;
}

/**
 * 用 refresh_token 向微软换一个 IMAP access_token。
 * 兼容个人 Outlook（@hotmail/@outlook/@live）与企业账户。
 */
async function refreshMicrosoftAccessToken({ clientId, refreshToken }) {
    const cid = String(clientId || '').trim();
    const rt = String(refreshToken || '').trim();
    if (!cid || !rt) {
        throw new Error('缺少 client_id 或 refresh_token');
    }

    const params = new URLSearchParams();
    params.append('client_id', cid);
    params.append('refresh_token', rt);
    params.append('grant_type', 'refresh_token');
    params.append('scope', MS_IMAP_SCOPE);

    const resp = await axios.post(MS_TOKEN_URL, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 20000,
        validateStatus: () => true
    });

    if (resp.status !== 200 || !resp.data || !resp.data.access_token) {
        const err = resp.data && (resp.data.error_description || resp.data.error)
            ? `${resp.data.error || ''} ${resp.data.error_description || ''}`.trim()
            : `HTTP ${resp.status}`;
        throw new Error(`刷新 access_token 失败: ${err}`);
    }
    return String(resp.data.access_token);
}

async function connectOutlookImap({ email, password, clientId, refreshToken, host }) {
    const useOAuth = Boolean(refreshToken && clientId);
    let auth;

    if (useOAuth) {
        const accessToken = await refreshMicrosoftAccessToken({ clientId, refreshToken });
        auth = { user: email, accessToken };
    } else {
        if (!password) {
            throw new Error('未配置邮箱密码或 OAuth2 凭证');
        }
        auth = { user: email, pass: password };
    }

    const client = new ImapFlow({
        host: host || 'outlook.office365.com',
        port: 993,
        secure: true,
        auth,
        logger: false,
        // 个人 Outlook 偶发首包慢，放宽超时
        socketTimeout: 60000
    });
    await client.connect();
    return client;
}

/**
 * 单次扫描 INBOX +（可选）垃圾箱等文件夹，按邮件时间从新到旧解析 OpenAI 6 位验证码。
 */
async function fetchLatestOpenAiOtpOnce({
    email,
    password,
    clientId,
    refreshToken,
    host,
    includeJunk,
    excludeCode
}) {
    const client = await connectOutlookImap({ email, password, clientId, refreshToken, host });

    try {
        const boxes = await resolveMailboxPaths(client, Boolean(includeJunk));
        const collected = [];

        for (const box of boxes) {
            const msgs = await fetchRecentMessagesFromMailbox(client, box, 100);
            for (const msg of msgs) {
                collected.push({ mailboxPath: box, msg });
            }
        }

        collected.sort((a, b) => envelopeTimestampMs(b.msg) - envelopeTimestampMs(a.msg));

        for (const { msg } of collected) {
            if (!msg.source) {
                continue;
            }

            let parsed;
            try {
                parsed = await simpleParser(msg.source);
            } catch (_) {
                continue;
            }

            const subject = parsed.subject || '';
            const bodyText = [parsed.text || '', stripHtml(parsed.html || '')].join('\n');

            if (!looksLikeOpenAiVerification(subject, bodyText)) {
                continue;
            }

            const blob = `${subject}\n${bodyText}`;
            const codes = extractSixDigitCodes(blob);
            for (const code of codes) {
                if (code && code !== excludeCode) {
                    return code;
                }
            }
        }

        return '';
    } finally {
        await client.logout().catch(() => { });
    }
}

/**
 * 管理端：最近邮件列表（含文件夹名），按时间倒序。
 */
async function listRecentEmailsForAdmin({
    email,
    password,
    clientId,
    refreshToken,
    host,
    includeJunk,
    limit = 50
}) {
    const client = await connectOutlookImap({ email, password, clientId, refreshToken, host });

    try {
        const boxes = await resolveMailboxPaths(client, Boolean(includeJunk));
        const collected = [];

        for (const box of boxes) {
            const msgs = await fetchRecentMessagesFromMailbox(client, box, 120);
            for (const msg of msgs) {
                const ts = envelopeTimestampMs(msg);
                let bodyPreview = '';
                if (msg.source) {
                    try {
                        const parsed = await simpleParser(msg.source);
                        bodyPreview = [parsed.text || '', stripHtml(parsed.html || '')].join('\n').substring(0, 500);
                    } catch (_) { /* 解析失败则留空 */ }
                }
                collected.push({
                    folder: box,
                    uid: msg.uid,
                    subject: msg.envelope?.subject || '',
                    from: formatAddresses(msg.envelope?.from),
                    date: ts ? new Date(ts).toISOString() : '',
                    bodyPreview,
                    internalTs: ts
                });
            }
        }

        collected.sort((a, b) => b.internalTs - a.internalTs);
        return collected.slice(0, Math.max(1, Number(limit) || 50)).map(({ folder, uid, subject, from, date, bodyPreview }) => ({
            folder,
            uid,
            subject,
            from,
            date,
            bodyPreview
        }));
    } finally {
        await client.logout().catch(() => { });
    }
}

module.exports = {
    fetchLatestOpenAiOtpOnce,
    listRecentEmailsForAdmin,
    refreshMicrosoftAccessToken
};
