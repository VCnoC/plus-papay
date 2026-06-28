/**
 * free_token/mode_register_rc.js
 *
 * 由 register_openai.js 在「邮箱已注册 + 已登录」的浏览器上下文里调用。
 * 唯一职责：从已登录的 chatgpt.com 里抽出 __Secure-next-auth.session-token
 * （文档里说的 RefreshCookie），写到批次 .txt 和单账号 JSON 里。
 *
 * NextAuth 5+ 把 >4KB 的 JWE token 分片成 `<name>.0`, `<name>.1`, ...
 * 必须按序号拼接才是完整 RefreshCookie。
 */
const fs = require('fs');
const path = require('path');

const SESSION_COOKIE_NAME = '__Secure-next-auth.session-token';
const OUTPUT_DIR = path.join(__dirname, '..', process.env.SUPPLY_MODE === '1' ? 'supply_files' : 'product_files');

function jobKeyFromEnv() {
    return String(process.env.FREE_TOKEN_JOB_KEY || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * 把 jobKey 头部毫秒时间戳转成可读时间，作为每批 txt 的文件名。
 * jobKey 形如 "1782579531935-7jk03ggd" → "20260628_010931"
 * 找不到时间戳就退化为当前时间。
 * 注意：同一 jobKey 会产生同一时间戳，多 worker 并发可正确追加同一批文件。
 */
function batchStampFromJobKey() {
    const jk = String(process.env.FREE_TOKEN_JOB_KEY || '');
    const m = jk.match(/^(\d{10,16})/);
    const ms = m ? Number(m[1]) : Date.now();
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear()
        + pad(d.getMonth() + 1)
        + pad(d.getDate())
        + '_'
        + pad(d.getHours())
        + pad(d.getMinutes())
        + pad(d.getSeconds());
}

/**
 * 抽取 session-token cookie，自动处理分片。
 *   1. 旧版整体 cookie
 *   2. 新版分片 cookie `.0`, `.1`, `.2` ... 按序拼接
 */
async function extractSessionCookie(page) {
    if (!page || page.isClosed()) {
        throw new Error('页面已关闭，无法读取 cookie');
    }
    const cookies = await page.context().cookies([
        'https://chatgpt.com',
        'https://chat.openai.com',
        'https://auth.openai.com',
    ]);

    const whole = cookies.find(c => c.name === SESSION_COOKIE_NAME);
    if (whole && whole.value) {
        return {
            name: SESSION_COOKIE_NAME,
            value: whole.value,
            domain: whole.domain,
            path: whole.path,
            expires: whole.expires,
            chunked: false,
        };
    }

    const chunkPattern = new RegExp('^' + SESSION_COOKIE_NAME.replace(/\./g, '\\.') + '\\.(\\d+)$');
    const chunks = cookies
        .map(c => {
            const m = c.name.match(chunkPattern);
            return m ? { idx: Number(m[1]), cookie: c } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.idx - b.idx);

    if (chunks.length > 0) {
        const value = chunks.map(x => x.cookie.value).join('');
        const first = chunks[0].cookie;
        return {
            name: SESSION_COOKIE_NAME,
            value,
            domain: first.domain,
            path: first.path,
            expires: first.expires,
            chunked: true,
            chunkCount: chunks.length,
        };
    }

    const names = cookies.map(c => c.name + '@' + c.domain).join(', ');
    throw new Error(
        'RefreshCookie 提取失败:未在登录浏览器找到 ' + SESSION_COOKIE_NAME +
        '(含分片)。当前 cookie: ' + (names || '(空)')
    );
}

function persist({ email, cookie, accessToken }) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const sub2apiDir = path.join(OUTPUT_DIR, 'sub2api');
    fs.mkdirSync(sub2apiDir, { recursive: true });
    // 🆕 专门的批次文件夹：supply_files/batches/<时间戳>.txt
    const batchesDir = path.join(OUTPUT_DIR, 'batches');
    fs.mkdirSync(batchesDir, { recursive: true });

    const jobKey = jobKeyFromEnv();
    const stamp = batchStampFromJobKey();
    const cookieLine = email + '----' + cookie.value + '\n';

    // 🆕 主输出：按批次时间戳命名的 txt（VC 指定格式）
    const batchTxtPath = path.join(batchesDir, stamp + '.txt');
    fs.appendFileSync(batchTxtPath, cookieLine, 'utf-8');

    // 兼容旧路径（下游 ZIP 打包等仍可能依赖）
    fs.appendFileSync(path.join(OUTPUT_DIR, 'refresh_cookies_' + jobKey + '.txt'), cookieLine, 'utf-8');
    fs.appendFileSync(path.join(OUTPUT_DIR, 'refresh_cookies.txt'), cookieLine, 'utf-8');

    if (accessToken) {
        fs.appendFileSync(
            path.join(OUTPUT_DIR, 'access_tokens_' + jobKey + '.txt'),
            email + '----' + accessToken + '\n',
            'utf-8'
        );
    }

    const wrapper = {
        exported_at: new Date().toISOString(),
        proxies: [],
        accounts: [{
            name: email,
            platform: 'openai',
            type: 'refresh_cookie',
            credentials: {
                refresh_cookie: cookie.value,
                cookie_domain: cookie.domain,
                cookie_path: cookie.path || '/',
                cookie_expires: cookie.expires || 0,
                cookie_chunked: !!cookie.chunked,
                cookie_chunk_count: cookie.chunkCount || 1,
                access_token: accessToken || '',
            },
            extra: { email },
            concurrency: 10,
            priority: 1,
            rate_multiplier: 1,
            auto_pause_on_expired: true,
            plan_type: 'free',
        }],
    };
    const jsonPath = path.join(sub2apiDir, email + '.json');
    fs.writeFileSync(jsonPath, JSON.stringify(wrapper, null, 2), 'utf-8');

    return {
        cookieTxt: path.join(OUTPUT_DIR, 'refresh_cookies_' + jobKey + '.txt'),
        batchTxt: batchTxtPath,
        batchStamp: stamp,
        jsonPath,
    };
}

async function processCtx(ctx) {
    const email = String(ctx?.email || '').trim();
    if (!email) {
        throw new Error('mode_register_rc: ctx.email 为空');
    }
    const cookie = await extractSessionCookie(ctx.page);
    const accessToken = String(ctx?.sessionData?.accessToken || '');
    const paths = persist({ email, cookie, accessToken });

    const tag = cookie.chunked ? '[chunked x' + cookie.chunkCount + ']' : '[whole]';
    console.log('🍪 [mode_register_rc] ' + email + ' ' + tag + ' value len=' + cookie.value.length);
    console.log('   🗂️  批次文件: ' + paths.batchTxt);
    console.log('   📝 兼容文件: ' + paths.cookieTxt);
    console.log('   📦 sub2api JSON: ' + paths.jsonPath);

    // 入库到对应表（SUPPLY_MODE 决定走 supply_assets 还是 product_assets）
    try {
        const store = require('../mysql-store');
        await store.ensureReady();
        const isSupply = process.env.SUPPLY_MODE === '1';
        const fn = isSupply ? store.addSupplyProduct : store.addProduct;
        await fn(email, paths.jsonPath, null, accessToken || null);
        console.log('   💾 已入库 ' + (isSupply ? 'supply_assets' : 'product_assets'));
    } catch (e) {
        console.warn('   ⚠️ 入库失败（不影响写盘）: ' + e.message);
    }

    // 🆕 SUPPLY 模式：把 RC 推送到 fakeoai/tokens 服务（tokens-mysql.foai_tokens 表）
    if (process.env.SUPPLY_MODE === '1') {
        try {
            await pushToTokensService({ email, cookieValue: cookie.value });
            console.log('   🚀 已推送到 tokens.foai_tokens (platform=chatgpt, type=refresh_cookie)');
        } catch (e) {
            console.warn('   ⚠️ tokens push 失败（不影响其他流程）: ' + e.message);
        }
    }

    return {
        success: true,
        mode: 'rc',
        email,
        cookieValue: cookie.value,
        cookieDomain: cookie.domain,
        cookieChunked: !!cookie.chunked,
        cookieChunkCount: cookie.chunkCount || 1,
        accessToken,
        paths,
        batchStamp: paths.batchStamp,
        batchTxt: paths.batchTxt,
    };
}

/**
 * 把 RC 推送到 fakeoai/tokens 服务（走 8200 的 admin-api，让 8200 自己 OAuth 转 JWT 入库）。
 * 不再直接写 MySQL，因为直接 INSERT 跳过了 8200 的 OAuth 转换 → 状态会变 DEACTIVATE。
 *
 * 配置通过 env 覆盖：
 *   TOKENS_SERVICE_BASE   默认 http://127.0.0.1:8200
 *   TOKENS_ADMIN_USER     默认 magic
 *   TOKENS_ADMIN_PASSWORD 默认 magic666.
 *   TOKENS_PUSH_PLATFORM  默认 chatgpt
 */
async function pushToTokensService({ email, cookieValue }) {
    const base = (process.env.TOKENS_SERVICE_BASE || 'http://127.0.0.1:8200').replace(/\/+$/, '');
    const user = process.env.TOKENS_ADMIN_USER || 'magic';
    const password = process.env.TOKENS_ADMIN_PASSWORD || 'magic666.';
    const platform = process.env.TOKENS_PUSH_PLATFORM || 'chatgpt';

    // 1) 登录拿 JWT
    const loginResp = await httpJson('POST', base + '/admin-api/login', null, { username: user, password });
    const jwt = loginResp.access_token;
    if (!jwt) throw new Error('admin-api login failed: 无 access_token');

    // 2) POST /admin-api/tokens 让 8200 自己 OAuth 转 JWT 入库
    const addResp = await httpJson('POST', base + '/admin-api/tokens', jwt, { platform, token: cookieValue });
    // 返回是 [] 表示无错误（成功），返回非空数组表示部分错误
    if (Array.isArray(addResp) && addResp.length > 0) {
        const errs = addResp.map(r => r.error || 'unknown').join('; ');
        throw new Error('admin-api add token reported errors: ' + errs);
    }
}

function httpJson(method, url, bearer, body) {
    return new Promise((resolve, reject) => {
        const http = require(url.startsWith('https:') ? 'https' : 'http');
        const u = new URL(url);
        const data = body ? JSON.stringify(body) : '';
        const req = http.request({
            method,
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
            },
            timeout: 120000,
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const txt = Buffer.concat(chunks).toString();
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(txt ? JSON.parse(txt) : null); } catch { resolve(txt); }
                } else {
                    reject(new Error('HTTP ' + res.statusCode + ' ' + txt.substring(0, 200)));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
        if (data) req.write(data);
        req.end();
    });
}

module.exports = { process: processCtx, extractSessionCookie, persist, batchStampFromJobKey, pushToTokensService, SESSION_COOKIE_NAME };
