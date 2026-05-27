/**
 * Grok Pro 订阅 Node 包装器
 * 通过 spawn 调用现有 Python 脚本 grok开卡/card_subscribe.py
 * - 不修改 Python 源码
 * - 实时按行解析 stdout 推送日志
 * - 进程结束时从末尾解析最后一段 JSON 作为结果
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PY_SCRIPT = path.join(__dirname, 'grok开卡', 'card_subscribe.py');

function pickPythonBin() {
    if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
    return process.platform === 'win32' ? 'python' : 'python3';
}

function parseFinalJson(text) {
    const trimmed = String(text || '').trimEnd();
    if (!trimmed.endsWith('}')) return null;
    let depth = 0;
    let start = -1;
    for (let i = trimmed.length - 1; i >= 0; i--) {
        const ch = trimmed[i];
        if (ch === '}') depth++;
        else if (ch === '{') {
            depth--;
            if (depth === 0) { start = i; break; }
        }
    }
    if (start < 0) return null;
    try { return JSON.parse(trimmed.slice(start)); } catch (_) { return null; }
}

function classifyLine(line) {
    const stepMatch = line.match(/^\[(\d+)\]\s*(.+)$/);
    if (stepMatch) return { kind: 'step', step: Number(stepMatch[1]), text: stepMatch[2] };
    if (/^\s{2,}/.test(line)) return { kind: 'log', text: line.trim() };
    return { kind: 'info', text: line.trim() };
}

function normalizeExp(rawExp, expMonth, expYear) {
    if (rawExp) {
        const parts = String(rawExp).split(/[\/\-\s]+/).filter(Boolean);
        if (parts.length >= 2) {
            const mm = String(parts[0]).padStart(2, '0');
            const yyRaw = String(parts[1]);
            const yyyy = yyRaw.length === 2 ? `20${yyRaw}` : yyRaw;
            return `${mm}/${yyyy}`;
        }
    }
    const mm = String(expMonth || '').padStart(2, '0');
    const yyRaw = String(expYear || '');
    const yyyy = yyRaw.length === 2 ? `20${yyRaw}` : yyRaw;
    return `${mm}/${yyyy}`;
}

/**
 * 启动 Grok Pro 订阅
 * @param {object} opts
 * @param {string} opts.sso             - Grok SSO token
 * @param {string} opts.cardNumber      - 卡号
 * @param {string} [opts.exp]           - "MM/YY" 或 "MM/YYYY"
 * @param {string} [opts.expMonth]      - 月份（与 exp 二选一）
 * @param {string} [opts.expYear]       - 年份（与 exp 二选一）
 * @param {string} opts.cvc             - CVC
 * @param {string} opts.billingName     - 持卡人姓名
 * @param {string} opts.billingZip      - ZIP / 邮编
 * @param {string} [opts.proxy]         - 代理 URL（可空）
 * @param {string} [opts.yesCaptchaKey] - YesCaptcha key（不传则读 env）
 * @param {(evt:{kind:string,text:string,step?:number})=>void} [opts.onLog]
 * @param {number} [opts.timeoutMs=300000] - 超时毫秒
 * @returns {Promise<{success?:boolean,error?:string,status?:string,_exitCode?:number,_stderrTail?:string}>}
 */
async function subscribeGrokPro(opts) {
    const {
        sso, cardNumber, cvc,
        exp, expMonth, expYear,
        billingName, billingZip,
        proxy = '',
        yesCaptchaKey = '',
        onLog = () => {},
        timeoutMs = 5 * 60 * 1000
    } = opts || {};

    if (!sso) throw new Error('sso 必填');
    if (!cardNumber) throw new Error('cardNumber 必填');
    if (!cvc) throw new Error('cvc 必填');
    if (!billingName) throw new Error('billingName 必填');
    if (!billingZip) throw new Error('billingZip 必填');
    if (!fs.existsSync(PY_SCRIPT)) throw new Error(`Python 脚本不存在: ${PY_SCRIPT}`);

    const finalExp = normalizeExp(exp, expMonth, expYear);
    if (!/^\d{2}\/\d{4}$/.test(finalExp)) {
        throw new Error(`exp 格式错误（应为 MM/YY 或 MM/YYYY，实得 "${exp || expMonth + '/' + expYear}"）`);
    }

    const args = [
        PY_SCRIPT,
        '--sso', String(sso),
        '--card', String(cardNumber),
        '--exp', finalExp,
        '--cvc', String(cvc),
        '--name', String(billingName),
        '--zip', String(billingZip),
    ];
    if (proxy) {
        args.push('--proxy', String(proxy));
    } else {
        // 显式传空，覆盖 .py 默认的 127.0.0.1:10808
        args.push('--proxy', '');
    }

    const env = {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        YESCAPTCHA_KEY: yesCaptchaKey || process.env.YESCAPTCHA_KEY || '',
    };

    const child = spawn(pickPythonBin(), args, {
        cwd: __dirname,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let lineBuf = '';

    const flushLine = (line) => {
        if (!line) return;
        try { onLog(classifyLine(line)); } catch (_) { /* ignore */ }
    };

    child.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf-8');
        stdoutBuf += text;
        lineBuf += text;
        let idx;
        while ((idx = lineBuf.indexOf('\n')) >= 0) {
            const raw = lineBuf.slice(0, idx).replace(/\r$/, '');
            lineBuf = lineBuf.slice(idx + 1);
            flushLine(raw);
        }
    });

    child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf-8'); });

    return await new Promise((resolve) => {
        let resolved = false;
        const done = (val) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(killTimer);
            resolve(val);
        };

        const killTimer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) {}
            done({ error: `Grok 开通超时（${Math.round(timeoutMs / 1000)}s）`, _exitCode: -1 });
        }, timeoutMs);

        child.on('error', (err) => {
            done({ error: `进程启动失败: ${err.message}`, _exitCode: -1 });
        });

        child.on('close', (code) => {
            if (lineBuf.trim()) flushLine(lineBuf);
            const final = parseFinalJson(stdoutBuf);
            if (final && (final.success !== undefined || final.error !== undefined)) {
                final._exitCode = code;
                if (stderrBuf.trim()) final._stderrTail = stderrBuf.trim().split('\n').slice(-3).join(' | ');
                done(final);
                return;
            }
            // 优先抽取 stderr 中"最后一行真正的错误"（去掉 traceback 噪音）
            const stderrLines = stderrBuf.trim().split('\n').map((l) => l.trim()).filter(Boolean);
            const meaningful = [...stderrLines].reverse().find((l) =>
                !l.startsWith('File "') &&
                !l.startsWith('Traceback') &&
                !l.match(/^\s*~+\^+/) &&
                l.length < 400
            );
            const tail = meaningful
                || stderrLines.slice(-3).join(' | ')
                || stdoutBuf.trim().split('\n').slice(-3).join(' | ');
            done({ error: tail || `Python 脚本异常退出（code=${code}）`, _exitCode: code });
        });
    });
}

module.exports = { subscribeGrokPro, PY_SCRIPT };
