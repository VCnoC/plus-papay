const { runFullProtocolFlow } = require('./oauth_login');
const { fork } = require('child_process');
const path = require('path');
const axios = require('axios');
const store = require('./mysql-store');
const runtimeLog = require('./runtime-log');
const { getImapAuthHeaders, forceRefreshImapToken } = require('./imap-auth');

const CONFIG = {
    MAX_ACCOUNT_RETRIES: 15,
    MAX_ACT_RETRIES_PER_ACCOUNT: 10,
    MAX_PROTOCOL_RETRIES: 2,
    MAX_TOPUP_FAILURES_BEFORE_STOP: 10,
    RETRY_DELAY_MS: 5000,
    CHILD_IDLE_TIMEOUT_MS: 60 * 1000
};

const IMAP_ADMIN_EMAIL_API = 'https://imap.chiyiyi.cloud/api/admin/emails';
const OAUTH_ADD_PHONE_ERROR = '当前账号触发手机号验证';

// 进程级 inbox 域名黑名单：被 API 拒绝过的域名，本进程内不再传给子进程
// 重启 server 后会清空（管理员若改过 API 配置就会重试）
const INBOX_DOMAIN_BLACKLIST = new Set();

const REGISTRATION_PROGRESS_MARKERS = [
    ['[Step 0] 启动 Stealth 浏览器环境', 3, '正在启动注册浏览器环境...'],
    ['注册从后端获取代理', 7, '正在加载注册代理...'],
    ['[Step 1] 正在访问 OpenAI', 9, '正在访问 OpenAI 注册页...'],
    ['[Info] 正在输入邮箱', 11, '正在填写注册邮箱...'],
    ['[等待] 正在检测下一步流程', 12, '正在等待注册下一步流程...'],
    ['[Step 4.5] 检测到创建密码页面', 14, '正在设置账号密码...'],
    ['[Step 5] 正在从邮箱获取验证码', 16, '正在获取注册验证码...'],
    ['[IMAP] 成功获取验证码', 17, '注册验证码已获取，准备提交...'],
    ['[Step 6] 正在完善个人资料', 18, '正在完善账号资料...'],
    ['[Wait] 正在等待聊天对话框出现', 19, '正在确认账号注册成功...'],
    ['[Step 7] 正在获取 Session 信息', 20, '正在获取 Access Token...'],
    ['成功获取 Access Token', 20, '已获取 Access Token...'],
    ['[Success] 注册流程全部完成', 20, '账号注册完成，准备进入激活阶段...']
];

const ACTIVATION_PROGRESS_MARKERS = [
    ['正在初始化浏览器', 24, '正在初始化激活浏览器...'],
    ['正在检查代理连通性', 26, '正在检查激活代理连通性...'],
    ['代理连接成功! 代理公网 IP', 28, '代理连通成功，准备创建订单...'],
    ['[1] 创建订单', 30, '正在创建 Plus 订单...'],
    ['已创建支付页面，启动无活动监控', 33, '支付页面已创建，准备进入结账流程...'],
    ['[6] PayPal 自动化流程开始', 36, '已进入 PayPal 自动化流程...'],
    ['正在打开 Stripe Hosted Checkout 页面', 38, '正在打开 Stripe Checkout...'],
    ['Checkout 页面已打开，开始检查金额', 40, '正在校验订单金额...'],
    ['当前页面金额', 42, '正在确认订单金额...'],
    ['金额校验通过，确认是 0 元订单', 44, '订单金额校验通过...'],
    ['正在定位 PayPal 支付选项', 46, '正在定位 PayPal 支付选项...'],
    ['PayPal 支付选项已展开', 48, 'PayPal 支付选项已展开...'],
    ['正在填写 Stripe 账单基础信息', 50, '正在填写 Stripe 账单信息...'],
    ['正在填写 Stripe 账单姓名', 51, '正在填写 Stripe 账单姓名...'],
    ['Stripe 账单姓名填写完成', 52, 'Stripe 姓名填写完成...'],
    ['正在填写 Stripe 街道地址', 53, '正在填写 Stripe 街道地址...'],
    ['街道地址填写完成', 54, 'Stripe 街道地址填写完成...'],
    ['地址已由下拉自动填充', 55, '地址补全已完成...'],
    ['正在填写 Stripe 邮编与城市', 56, '正在填写邮编和城市...'],
    ['邮编与城市填写完成', 57, '邮编与城市填写完成...'],
    ['Stripe 账单基础信息填写完成', 58, 'Stripe 账单信息已完成...'],
    ['协议勾选完成', 59, '正在准备提交 Stripe Checkout...'],
    ['正在准备提交 Stripe Checkout', 60, '正在准备提交 Stripe Checkout...'],
    ['正在检查 Stripe 表单完整性', 61, '正在检查 Stripe 表单完整性...'],
    ['Stripe Checkout 已提交，等待 PayPal 页面响应', 63, '已提交 Stripe，等待 PayPal 响应...'],
    ['等待跳转到 PayPal 页面', 65, '正在跳转到 PayPal 页面...'],
    ['正在等待 PayPal 创建账户按钮出现', 67, '正在等待 PayPal 创建账户入口...'],
    ['正在填写 PayPal 登录邮箱', 69, '正在填写 PayPal 登录邮箱...'],
    ['已提交邮箱，进入支付信息填写页', 71, '已提交邮箱，准备填写支付资料...'],
    ['正在以拟人方式填写详细账单信息', 73, '正在填写银行卡和身份信息...'],
    ['正在进行提交前数据完整性校验', 75, '正在校验 PayPal 表单内容...'],
    ['[效验通过] 银行卡号', 76, '银行卡号校验通过...'],
    ['[效验通过] 有效期', 77, '银行卡有效期校验通过...'],
    ['[效验通过] 安全码', 78, '银行卡安全码校验通过...'],
    ['[效验通过] 名字', 79, '名字校验通过...'],
    ['[效验通过] 姓氏', 80, '姓氏校验通过...'],
    ['[效验通过] 邮箱', 81, '邮箱校验通过...'],
    ['[效验通过] 手机号', 82, '手机号校验通过...'],
    ['银行卡与身份信息填写完成', 83, '银行卡与身份信息填写完成...'],
    ['正在输入地址并处理联想', 84, '正在填写账单地址...'],
    ['地址联想已选择', 84, '账单地址已确认...'],
    ['正在填写 PayPal 账户密码', 84, '正在填写 PayPal 密码...'],
    ['PayPal 账户密码填写完成', 84, 'PayPal 密码填写完成...'],
    ['创建账户协议已提交', 84, '已提交创建账户协议...'],
    ['正在检查是否触发短信验证', 84, '正在检查是否需要短信验证...'],
    ['已进入短信验证页面', 84, '已进入短信验证页面...'],
    ['等待短信验证码', 84, '正在等待短信验证码...'],
    ['验证码提取成功', 85, '短信验证码已获取...'],
    ['短信验证码已输入', 85, '短信验证码已输入...'],
    ['当前未触发短信验证，继续后续流程', 85, '未触发短信验证，继续支付确认...'],
    ['正在等待最终确认按钮', 85, '正在等待最终确认按钮...'],
    ['发现最终确认按钮，正在点击', 85, '正在点击最终确认按钮...'],
    ['最终确认已提交，等待支付结果落地', 85, '已提交最终确认，等待支付结果...'],
    ['最终校验：支付成功!', 85, '支付成功，准备提取协议...'],
    ['PAYMENT_SUCCESS', 85, '支付成功，准备提取协议...']
];

const PROTOCOL_PROGRESS_MARKERS = [
    ['[代理检查] 正在验证代理可用性', 86, '正在检查协议提取代理...'],
    ['[代理检查] 代理可用', 88, '协议提取代理可用...'],
    ['[Step 1] 正在处理授权登录', 90, '正在处理协议授权登录...'],
    ['[IMAP] 正在为', 92, '正在获取协议验证码...'],
    ['[IMAP] 成功获取验证码', 94, '协议验证码已获取...'],
    ['[Step 2] 正在确认授权', 96, '正在确认协议授权...'],
    ['[Wait] 正在等待回调跳转', 98, '正在等待授权回调...'],
    ['[Step 3] 正在通过协议换取 Token Bundle', 99, '正在换取协议 Token Bundle...'],
    ['协议数据已按标准格式导出至', 100, '协议文件已导出，准备完成交付...']
];

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateImapKey(email) {
    const normalizedEmail = String(email || '').trim();
    if (!normalizedEmail) {
        throw new Error('生成 IMAP Key 失败：缺少邮箱');
    }

    let response;
    try {
        response = await axios.post(
            IMAP_ADMIN_EMAIL_API,
            { email: normalizedEmail },
            {
                headers: {
                    ...(await getImapAuthHeaders()),
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );
    } catch (error) {
        if (error.response && error.response.status === 401) {
            console.error('[IMAP] 生成 Key 鉴权失败 (401)，正在自动刷新 Token 后重试...');
            await forceRefreshImapToken();
            response = await axios.post(
                IMAP_ADMIN_EMAIL_API,
                { email: normalizedEmail },
                {
                    headers: {
                        ...(await getImapAuthHeaders()),
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000
                }
            );
        } else {
            throw error;
        }
    }

    const generatedKey = String(response?.data?.generatedKey || '').trim();
    if (!generatedKey) {
        throw new Error('生成 IMAP Key 失败：接口未返回 generatedKey');
    }

    return generatedKey;
}

function getStageProgress(markers, text, fallbackProgress = 0, fallbackMessage = '') {
    const normalized = String(text || '');
    let progress = fallbackProgress;
    let message = fallbackMessage;

    for (const [marker, value, label] of markers) {
        if (normalized.includes(marker) && value >= progress) {
            progress = value;
            message = label || message;
        }
    }

    return { progress, message };
}

function createLineEmitter(handler) {
    let buffer = '';

    return (chunk) => {
        const text = String(chunk || '');
        if (!text) {
            return;
        }

        buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
                handler(trimmed);
            }
        }
    };
}

function analyzeProcessOutput(output, timedOut) {
    const normalized = String(output || '');
    const reachedPaypal = normalized.includes('[步骤] 正在填写 PayPal 登录邮箱')
        || normalized.includes('正在填写 PayPal 登录邮箱');
    const success = normalized.includes('PAYMENT_SUCCESS')
        || normalized.includes('最终校验：支付成功')
        || normalized.includes('支付成功')
        || normalized.includes('✅ Plus 激活成功');

    if (success) {
        return {
            status: 'success',
            message: '激活成功',
            reachedPaypal: true,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    const noPermissionKeywords = [
        'Missing PayPal approval URL',
        'Missing PayPal approval URL / ba_token',
        '多次尝试后仍未获取到 PayPal 重定向 URL',
        '获取 PayPal 链接异常',
        '无法获取 PayPal 审批链接',
        '该账号无激活权限',
        '金额校验失败'
    ];
    const isNoPermission = noPermissionKeywords.some((keyword) => normalized.includes(keyword));

    if (isNoPermission) {
        return {
            status: 'failed',
            message: '该账号无激活权限,请更换账号重试',
            reachedPaypal: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('代理认证失败') || normalized.includes('代理响应异常') || normalized.includes('账号余额')) {
        return {
            status: 'failed',
            message: '系统维护中,请联系管理员修复',
            reachedPaypal,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('代理连接失败')) {
        return {
            status: 'maintenance',
            message: '系统维护中,请联系管理员修复',
            reachedPaypal,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    // 注册阶段代理超时（Operation timed out 重复 / 浏览器连接被代理多次关闭）
    // → 当前代理质量差或被该 IP ban，立刻换代理 + 换账号重试
    if (normalized.includes('代理或网络持续超时')
        || normalized.includes('浏览器连接被代理多次关闭')) {
        return {
            status: 'retry',
            message: '当前代理超时严重，已切换代理重试',
            reachedPaypal: false,
            shouldRetry: true,
            deletePhone: false,
            deleteCard: false
        };
    }

    // OpenAI 鉴权服务异常 (auth/error?error=undefined) → 出口 IP 被 OpenAI 风控
    // 立即换 sticky session ID（每次 fork 自动换）+ 换账号重试，不要再傻刷新
    if (normalized.includes('OpenAI 鉴权服务异常')
        || normalized.includes('/auth/error?error=undefined')
        || normalized.includes('chatgpt.com/auth/error')) {
        return {
            status: 'retry',
            message: 'OpenAI 鉴权风控 (auth/error)，换代理 IP 重试',
            reachedPaypal: false,
            shouldRetry: true,
            deletePhone: false,
            deleteCard: false
        };
    }

    // 邮箱池里的邮箱已经被注册过 → 直接换下一个邮箱，不要白等也不要标记为账号失败
    if (normalized.includes('user_already_exists')
        || normalized.includes('该邮箱已被注册')) {
        return {
            status: 'retry',
            message: '邮箱已被注册，自动换下一个邮箱重试',
            reachedPaypal: false,
            shouldRetry: true,
            deletePhone: false,
            deleteCard: false
        };
    }

    // /about-you 资料校验失败（例如生日格式被前端拒）→ 立即换号重试
    if (normalized.includes('个人资料表单校验失败')
        || normalized.includes("doesn't look right")) {
        return {
            status: 'retry',
            message: '注册资料被前端拒绝，立即换号重试',
            reachedPaypal: false,
            shouldRetry: true,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('监测到致命拦截文字')
        || normalized.includes('监测到致命拦截')
        || normalized.includes('You have been blocked')) {
        return {
            status: 'retry',
            message: '监测到致命拦截文字，准备重试',
            reachedPaypal: true,
            shouldRetry: true,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('手机号被拒绝或系统拦截')) {
        return {
            status: 'retry',
            message: '手机号不可用，已禁用该号，准备重试',
            reachedPaypal,
            shouldRetry: true,
            deletePhone: true,   // 手机号被拒 → 永久禁用，不再依赖 reachedPaypal
            deleteCard: false
        };
    }

    if (normalized.includes('短信验证码超时')
        || normalized.includes('该手机号无验证码')
        || normalized.includes('手机号短信验证异常')) {
        return {
            status: 'retry',
            message: '短信异常：手机号不可用，已禁用该号，准备重试',
            reachedPaypal,
            shouldRetry: true,
            deletePhone: true,
            deleteCard: false
        };
    }

    if (normalized.includes('银行卡被拒绝')) {
        return {
            status: 'retry',
            message: '银行卡异常，准备重试',
            reachedPaypal,
            shouldRetry: true,
            deletePhone: false,
            deleteCard: reachedPaypal
        };
    }

    if (normalized.includes('支付结果检测失败')) {
        return {
            status: 'retry',
            message: '支付检测失败，准备重试',
            reachedPaypal: true,
            shouldRetry: true,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('支付失败 (stripe_redirect_failed)')
        || normalized.includes('支付失败 (stripe_redirect_canceled)')
        || normalized.includes('支付失败 (paypal_blocked)')) {
        return {
            status: 'retry',
            message: 'PayPal/Stripe 端驳回支付，准备换号重试',
            reachedPaypal: true,
            shouldRetry: true,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('PayPal 未渲染创建账户表单')) {
        return {
            status: 'retry',
            message: 'PayPal 仅渲染欢迎页，已多次刷新仍无表单，准备同号重试',
            reachedPaypal: false,
            shouldRetry: true,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (!reachedPaypal) {
        // 已进入结账/PayPal 相关流程但未命中「填写 PayPal 登录邮箱」日志时，多为页面慢、iframe、偶发中断——同账号重试往往比直接换号更有效
        const deepCheckoutFlow =
            normalized.includes('Stripe')
            || normalized.includes('pay.openai.com')
            || normalized.includes('Checkout')
            || normalized.includes('[6] PayPal')
            || normalized.includes('PayPal 自动化流程')
            || normalized.includes('触发 PayPal');
        if (deepCheckoutFlow) {
            return {
                status: 'retry',
                message: '已进入支付流程但未检测到 PayPal 登录步骤，准备同账号重试',
                reachedPaypal: false,
                shouldRetry: true,
                deletePhone: false,
                deleteCard: false
            };
        }
        return {
            status: 'failed',
            message: '该账号无激活权限,请更换账号重试',
            reachedPaypal,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (timedOut || normalized.includes('运行时错误')) {
        return {
            status: 'failed',
            message: '激活失败 (超时或运行时错误)',
            reachedPaypal,
            shouldRetry: true,
            deletePhone: false,
            deleteCard: false
        };
    }

    return {
        status: 'retry',
        message: '激活失败 (未知原因)，准备重试',
        reachedPaypal,
        shouldRetry: true,
        deletePhone: false,
        deleteCard: false
    };
}

function isOauthAddPhoneError(result) {
    const combinedText = [
        result?.error,
        result?.output,
        result?.analysis?.message
    ].filter(Boolean).join('\n');

    return combinedText.includes(OAUTH_ADD_PHONE_ERROR)
        || combinedText.includes('/add-phone')
        || combinedText.includes('add-phone');
}

async function runActivationProcess(accessToken, cdk, runtimeAssets, runtimeJobKey = '') {
    return runActivationChild(
        path.join(__dirname, 'index.js'),
        [],
        {
            ...process.env,
            CHATGPT_TOKEN: accessToken,
            CDK_CODE: cdk,
            SMS_API_KEY: runtimeAssets?.phone?.key || '',
            BILLING_PHONE: runtimeAssets?.phone?.phone || '',
            PROXY: runtimeAssets?.proxy || '',
            CARD_NUMBER: runtimeAssets?.card?.number || '',
            CARD_EXPIRY: runtimeAssets?.card?.expiry || '',
            CARD_CVC: runtimeAssets?.card?.cvc || '',
            IS_PRODUCT_FLOW: 'true'
        },
        undefined,
        { runtimeJobKey: String(runtimeJobKey || '') }
    );
}

async function runActivationChild(scriptPath, args, env, onLine, options = {}) {
    return new Promise((resolve, reject) => {
        const runtimeJobKey = String(options.runtimeJobKey || '');
        const child = fork(scriptPath, args, {
            env,
            stdio: ['inherit', 'pipe', 'pipe', 'ipc']
        });
        const childLabel = `${path.basename(scriptPath)}#${child.pid}`;
        console.log(`[Activation Child] Spawned ${childLabel}`);
        runtimeLog.push({
            jobKey: runtimeJobKey,
            level: 'fork',
            source: 'product',
            text: `🚀 [子进程] 启动  ${childLabel}`
        });

        let combinedOutput = '';
        let settled = false;
        let resultPayload = null;
        let childError = null;
        let closeFallbackTimer = null;
        let idleTimer = null;
        let timedOut = false;
        let childExited = false;
        const idleTimeoutMs = Math.max(0, Number(options.idleTimeoutMs) || 0);
        const timeoutErrorMessage = String(options.timeoutErrorMessage || '子进程执行超时');

        const resolveOnce = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            if (closeFallbackTimer) {
                clearTimeout(closeFallbackTimer);
                closeFallbackTimer = null;
            }
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
            resolve(value);
        };

        const rejectOnce = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            if (closeFallbackTimer) {
                clearTimeout(closeFallbackTimer);
                closeFallbackTimer = null;
            }
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
            reject(error);
        };

        const resetIdleTimer = () => {
            if (!idleTimeoutMs || settled) {
                return;
            }
            if (idleTimer) {
                clearTimeout(idleTimer);
            }
            idleTimer = setTimeout(() => {
                if (settled) {
                    return;
                }
                timedOut = true;
                childError = timeoutErrorMessage;
                combinedOutput += `\n[TIMEOUT] ${timeoutErrorMessage}\n`;
                console.warn(`[Activation Child] ${childLabel} idle timeout, killing child`);
                try {
                    child.kill('SIGKILL');
                } catch (_) { }
            }, idleTimeoutMs);
        };

        const scriptTag = path.basename(scriptPath);
        const emitStdoutLines = createLineEmitter((line) => {
            runtimeLog.push({
                jobKey: runtimeJobKey,
                level: 'stdout',
                source: `fork/${scriptTag}`,
                text: line
            });
            if (onLine) {
                onLine(line, 'stdout');
            }
        });
        const emitStderrLines = createLineEmitter((line) => {
            runtimeLog.push({
                jobKey: runtimeJobKey,
                level: 'stderr',
                source: `fork/${scriptTag}`,
                text: line
            });
            if (onLine) {
                onLine(line, 'stderr');
            }
        });

        child.stdout.on('data', (data) => {
            const msg = data.toString();
            combinedOutput += msg;
            console.log(`[Activation] ${msg}`);
            emitStdoutLines(msg);
            resetIdleTimer();
        });

        child.stderr.on('data', (data) => {
            const msg = data.toString();
            combinedOutput += msg;
            console.error(`[Activation Error] ${msg}`);
            emitStderrLines(msg);
            resetIdleTimer();
        });

        child.on('message', (msg) => {
            if (!msg || typeof msg !== 'object') {
                return;
            }
            if (msg.type === 'status' && msg.message && process.send) {
                process.send(msg);
            }
            if (msg.type === 'result') {
                resultPayload = msg.result;
                if (closeFallbackTimer) {
                    clearTimeout(closeFallbackTimer);
                }
                closeFallbackTimer = setTimeout(() => {
                    if (childExited || settled) {
                        return;
                    }
                    console.warn(`[Activation Child] ${childLabel} reported success but did not exit in time, forcing kill`);
                    try {
                        child.kill('SIGKILL');
                    } catch (_) { }
                }, 3000);
            }
            if (msg.type === 'error') {
                childError = msg.message || '子进程执行失败';
            }
            resetIdleTimer();
        });

        child.on('error', (error) => {
            console.error(`[Activation Child] ${childLabel} process error: ${error.message}`);
            rejectOnce(error);
        });

        resetIdleTimer();

        child.on('close', (code, signal) => {
            childExited = true;
            console.log(`[Activation Child] Closed ${childLabel} code=${code} signal=${signal || 'none'}`);
            runtimeLog.push({
                jobKey: runtimeJobKey,
                level: 'fork',
                source: 'product',
                text: `🏁 [子进程] 结束  ${childLabel}  code=${code}  signal=${signal || 'none'}`
            });
            if (settled) {
                return;
            }
            if (resultPayload) {
                resolveOnce({
                    success: true,
                    analysis: {
                        status: 'success',
                        message: '子进程执行成功',
                        reachedPaypal: false,
                        shouldRetry: false,
                        deletePhone: false,
                        deleteCard: false
                    },
                    output: combinedOutput,
                    result: resultPayload,
                    error: null,
                    timedOut: false
                });
                return;
            }
            const analysis = analyzeProcessOutput(combinedOutput, false);
            resolveOnce({
                success: !timedOut && analysis.status === 'success',
                analysis,
                output: combinedOutput,
                result: resultPayload,
                error: childError,
                timedOut
            });
        });
    });
}

async function runRegistrationProcess(onProgress, runtimeJobKey = '') {
    let lastProgress = 5;
    let lastMessage = '正在准备注册账号...';

    let poolSlot = null;
    const ownerKey = `reg:${String(runtimeJobKey || '').trim() || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`}`;

    let emailSource = 'random';
    try {
        emailSource = String(await store.getAppConfigValue('email_source', '')).toLowerCase();
        if (!['random', 'pool', 'inbox'].includes(emailSource)) {
            const legacy = String(await store.getAppConfigValue('pool_email_enabled', '0')) === '1';
            emailSource = legacy ? 'pool' : 'random';
        }
    } catch (_) { /* 用默认 */ }

    try {
        if (emailSource === 'pool') {
            poolSlot = await store.reservePoolEmail(ownerKey);
            if (!poolSlot) {
                throw new Error('邮箱池已无可用邮箱（均已注册），请导入新的 Outlook/Hotmail 邮箱后再试');
            }
        }
    } catch (err) {
        throw new Error(`邮箱池预留失败: ${err.message}`);
    }

    const childEnv = { ...process.env };

    // 邮箱来源标记
    childEnv.EMAIL_SOURCE = emailSource;

    // 自定义随机邮箱域名（注册流程不论是否走 pool 都把它带上，方便子进程后续兼容）
    const randomDomainCfg = String(await store.getAppConfigValue('random_email_domain', 'chiyiyi.cloud'))
        .trim().replace(/^@/, '').toLowerCase() || 'chiyiyi.cloud';
    childEnv.RANDOM_EMAIL_DOMAIN = randomDomainCfg;

    // Inbox 临时邮箱配置（仅 inbox 模式下生效，提前注入避免子进程再查 DB）
    if (emailSource === 'inbox') {
        childEnv.INBOX_API_BASE = String(await store.getAppConfigValue('inbox_api_base', 'https://temp-email-api.jzqkwl.com'))
            .trim().replace(/\/+$/, '') || 'https://temp-email-api.jzqkwl.com';
        childEnv.INBOX_EMAIL_DOMAIN = String(await store.getAppConfigValue('inbox_email_domain', ''))
            .trim().replace(/^@/, '');
        // 多域名：一行一个 / 逗号 / 分号 / 空格分隔，子进程会随机挑一个
        // 过滤掉本进程已知被 API 拒绝的无效域名，避免每次 fork 重复试错
        const inboxDomainsRaw = String(await store.getAppConfigValue('inbox_email_domains', '')).trim();
        if (inboxDomainsRaw) {
            const all = inboxDomainsRaw.split(/[\n,;\s]+/).map((d) => d.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
            const valid = all.filter((d) => !INBOX_DOMAIN_BLACKLIST.has(d));
            if (valid.length > 0) {
                childEnv.INBOX_EMAIL_DOMAINS = valid.join('\n');
                if (valid.length < all.length) {
                    const skipped = all.filter((d) => INBOX_DOMAIN_BLACKLIST.has(d));
                    console.log(`📨 [Inbox] 跳过已黑名单域名: ${skipped.join(', ')}（剩余 ${valid.length} 个）`);
                }
            }
            // 全黑了就不传 INBOX_EMAIL_DOMAINS，子进程会退到单域名 / API 默认
        }
    }

    if (poolSlot && poolSlot.email && (poolSlot.refreshToken || poolSlot.password)) {
        childEnv.POOL_EMAIL_ID = String(poolSlot.id);
        childEnv.POOL_EMAIL = poolSlot.email;
        childEnv.POOL_EMAIL_PASSWORD = poolSlot.password || '';
        childEnv.POOL_EMAIL_CLIENT_ID = poolSlot.clientId || '';
        childEnv.POOL_EMAIL_REFRESH_TOKEN = poolSlot.refreshToken || '';
        childEnv.POOL_EMAIL_IMAP_HOST = String(await store.getAppConfigValue('pool_email_imap_host', 'outlook.office365.com')).trim() || 'outlook.office365.com';
        childEnv.POOL_EMAIL_INCLUDE_JUNK = String(await store.getAppConfigValue('pool_email_include_junk', '1')) === '1' ? '1' : '0';
    } else if (poolSlot?.id) {
        // 命中了一行但没有任何可用凭证：把它释放，避免占着茅坑
        await store.releasePoolEmailReservation(poolSlot.id).catch(() => { });
        poolSlot = null;
    }

    try {
        const result = await runActivationChild(path.join(__dirname, 'register_openai.js'), [], childEnv, (line) => {
            // 捕获子进程打印的"被服务端拒绝，跳过"日志，把无效域名加入进程级黑名单
            // 这样下次 fork 直接不传它，避免每次 fork 重复试错
            const m = String(line || '').match(/\[Inbox\] 域名 @([^\s]+) 被服务端拒绝/);
            if (m && m[1]) {
                const dead = m[1].trim().toLowerCase();
                if (dead && !INBOX_DOMAIN_BLACKLIST.has(dead)) {
                    INBOX_DOMAIN_BLACKLIST.add(dead);
                    console.warn(`🚫 [Inbox] 域名 ${dead} 已加入进程级黑名单，后续 fork 不再尝试`);
                }
            }
            const parsed = getStageProgress(REGISTRATION_PROGRESS_MARKERS, line, lastProgress, lastMessage);
            if (parsed.progress > lastProgress || parsed.message !== lastMessage) {
                lastProgress = parsed.progress;
                lastMessage = parsed.message;
                onProgress({ progress: lastProgress, message: lastMessage });
            }
        }, {
            idleTimeoutMs: CONFIG.CHILD_IDLE_TIMEOUT_MS,
            timeoutErrorMessage: '注册阶段超过 60 秒无打印，已终止并准备重试',
            runtimeJobKey: String(runtimeJobKey || '')
        });

        if (!result.result || !result.result.email || !result.result.accessToken) {
            throw new Error(result.error || '注册流程未返回有效账号信息');
        }

        onProgress({ progress: 20, message: `账号注册成功: ${result.result.email}，准备开始激活...` });
        return result.result;
    } catch (error) {
        if (poolSlot?.id) {
            await store.releasePoolEmailReservation(poolSlot.id).catch(() => { });
        }
        throw error;
    }
}

async function runProtocolProcess(email, onProgress, runtimeJobKey = '', inboxBundle = {}) {
    let lastError = '';

    let randomDomainCfg = 'chiyiyi.cloud';
    try {
        randomDomainCfg = String(await store.getAppConfigValue('random_email_domain', 'chiyiyi.cloud'))
            .trim().replace(/^@/, '').toLowerCase() || 'chiyiyi.cloud';
    } catch (_) { /* 忽略，使用默认 */ }
    const protocolEnv = { ...process.env, RANDOM_EMAIL_DOMAIN: randomDomainCfg };
    // 把注册阶段的邮箱后端凭证透传给 oauth_login，让它用同一个 API 拿 OAuth 验证码
    if (inboxBundle.emailSource) {
        protocolEnv.EMAIL_SOURCE = inboxBundle.emailSource;
    }
    if (inboxBundle.inboxJwt) {
        protocolEnv.INBOX_JWT = inboxBundle.inboxJwt;
    }
    if (inboxBundle.inboxApiBase) {
        protocolEnv.INBOX_API_BASE = inboxBundle.inboxApiBase;
    }

    for (let attempt = 1; attempt <= CONFIG.MAX_PROTOCOL_RETRIES; attempt += 1) {
        let lastProgress = 85;
        let lastMessage = attempt === 1
            ? 'Plus 开通成功，准备提取协议...'
            : `协议提取第 ${attempt} 次重试中...`;

        onProgress({
            progress: 85,
            message: attempt === 1 ? lastMessage : `协议提取超时或失败，正在进行第 ${attempt} 次尝试...`
        });

        const result = await runActivationChild(path.join(__dirname, 'oauth_login.js'), [email], protocolEnv, (line) => {
            const parsed = getStageProgress(PROTOCOL_PROGRESS_MARKERS, line, lastProgress, lastMessage);
            if (parsed.progress > lastProgress || parsed.message !== lastMessage) {
                lastProgress = parsed.progress;
                lastMessage = parsed.message;
                onProgress({ progress: lastProgress, message: lastMessage });
            }
        }, {
            idleTimeoutMs: CONFIG.CHILD_IDLE_TIMEOUT_MS,
            timeoutErrorMessage: '协议提取阶段超过 60 秒无打印，已终止并准备重试',
            runtimeJobKey: String(runtimeJobKey || '')
        });

        if (result.result && result.result.fileName && result.result.filePath) {
            return result.result;
        }

        lastError = result.error || '协议提取未返回有效结果';
        if (isOauthAddPhoneError(result)) {
            throw new Error(`${OAUTH_ADD_PHONE_ERROR}，需要重新注册账号`);
        }

        if (attempt < CONFIG.MAX_PROTOCOL_RETRIES) {
            onProgress({
                progress: 85,
                message: `协议提取失败，正在重试 (${attempt}/${CONFIG.MAX_PROTOCOL_RETRIES})...`
            });
            await sleep(CONFIG.RETRY_DELAY_MS);
        }
    }

    throw new Error(lastError || `协议提取失败，已超过 ${CONFIG.MAX_PROTOCOL_RETRIES} 次重试`);
}

async function startProductCreation(cdk, progressCallback, options = {}) {
    let accountAttempt = 0;
    let topupFailureCount = 0;
    const runtimeJobKey = String(options.jobKey || '');
    const ownerKey = `prod:${cdk || 'admin'}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    runtimeLog.push({
        jobKey: runtimeJobKey,
        level: 'product',
        source: 'product',
        text: `🎬 [成品流程] 开始  CDK = ${cdk || '(后台批量)'}`
    });

    while (accountAttempt < CONFIG.MAX_ACCOUNT_RETRIES) {
        accountAttempt += 1;
        progressCallback({
            progress: 5,
            message: `正在尝试注册第 ${accountAttempt} 个账号...`
        });

        try {
            console.log(`[Product] Attempt ${accountAttempt}: Registering...`);
            const regResult = await runRegistrationProcess((payload) => {
                progressCallback(payload);
            }, runtimeJobKey);
            const { email, accessToken } = regResult;
            // 注册阶段建立的邮箱后端凭证，要带给 oauth_login 用同一套 API 取 OAuth 验证码
            const inboxBundle = {
                emailSource: regResult.emailSource || '',
                inboxJwt: regResult.inboxJwt || '',
                inboxApiBase: regResult.inboxApiBase || ''
            };

            let activationAttempt = 0;

            while (activationAttempt < CONFIG.MAX_ACT_RETRIES_PER_ACCOUNT) {
                activationAttempt += 1;
                // 排队等待真正可用的资产（10s 一轮），最多等 5 分钟
                let runtimeAssets = null;
                const reserveDeadline = Date.now() + 5 * 60 * 1000;
                while (Date.now() < reserveDeadline) {
                    runtimeAssets = await store.reserveRuntimeAssets(`${ownerKey}:${email}:${activationAttempt}`);
                    if (runtimeAssets.phone.phone && runtimeAssets.phone.phone !== '未配置' && runtimeAssets.card.number) {
                        break;
                    }
                    // 没抢到就先把已抢到的退掉，然后等
                    await store.releaseRuntimeAssets({
                        phoneAssetId: runtimeAssets.phoneAssetId,
                        cardAssetId: runtimeAssets.cardAssetId
                    });
                    runtimeAssets = null;
                    progressCallback({
                        progress: 30,
                        message: '资产池暂时被占用，正在排队等待空闲手机号/银行卡...'
                    });
                    await sleep(10000);
                }

                if (!runtimeAssets) {
                    // 不是真的"系统维护"，是手机号/银行卡资产被同时占满
                    throw new Error('资产池枯竭：等待 5 分钟仍无空闲手机号/银行卡，请扩容资产池或降低并发');
                }

                const cardLast4 = runtimeAssets.card.number.slice(-4);
                const cardExpiry = runtimeAssets.card.expiry || '';
                console.log(`[Product] Account ${email} - Activation Attempt ${activationAttempt}/${CONFIG.MAX_ACT_RETRIES_PER_ACCOUNT}...`);
                console.log(
                    `[Product] Account ${email} - Using phone=${runtimeAssets.phone.phone} cardLast4=${cardLast4} expiry=${cardExpiry} proxy=${runtimeAssets.proxy ? 'yes' : 'no'}`
                );

                progressCallback({
                    progress: 34,
                    message: `正在激活账号，手机号 ${runtimeAssets.phone.phone}，银行卡尾号 ${cardLast4}...`,
                    phone: runtimeAssets.phone.phone,
                    cardLast4,
                    cardExpiry
                });

                let activationResult;
                let analysis;
                try {
                let activationProgress = 34;
                let activationMessage = `正在激活账号，手机号 ${runtimeAssets.phone.phone}，银行卡尾号 ${cardLast4}...`;
                activationResult = await runActivationChild(
                    path.join(__dirname, 'index.js'),
                    [],
                    {
                        ...process.env,
                        CHATGPT_TOKEN: accessToken,
                        CDK_CODE: cdk,
                        SMS_API_KEY: runtimeAssets?.phone?.key || '',
                        BILLING_PHONE: runtimeAssets?.phone?.phone || '',
                        PROXY: runtimeAssets?.proxy || '',
                        CARD_NUMBER: runtimeAssets?.card?.number || '',
                        CARD_EXPIRY: runtimeAssets?.card?.expiry || '',
                        CARD_CVC: runtimeAssets?.card?.cvc || '',
                        IS_PRODUCT_FLOW: 'true'
                    },
                    (line) => {
                        const parsed = getStageProgress(ACTIVATION_PROGRESS_MARKERS, line, activationProgress, activationMessage);
                        if (parsed.progress > activationProgress || parsed.message !== activationMessage) {
                            activationProgress = parsed.progress;
                            activationMessage = parsed.message;
                            progressCallback({
                                progress: activationProgress,
                                message: activationMessage,
                                phone: runtimeAssets.phone.phone,
                                cardLast4,
                                cardExpiry
                            });
                        }
                    },
                    { runtimeJobKey }
                );
                analysis = activationResult.analysis;
                } finally {
                    // 无论成功失败都先释放资产，避免占用残留
                    await store.releaseRuntimeAssets({
                        phoneAssetId: runtimeAssets.phoneAssetId,
                        cardAssetId: runtimeAssets.cardAssetId
                    }).catch((err) => console.warn(`[Product] release runtime assets failed: ${err.message}`));
                }

                console.log(`[Product] Account ${email} - Analysis: ${analysis.message}`);

                if (activationResult.success) {
                    // 🆕 PAYMENT_SUCCESS 立即占位入库（status='待协议'），即使后续 oauth 失败也保留可见记录
                    try {
                        await store.upsertPendingProduct(email, accessToken);
                        console.log(`[Product] 💾 Account ${email}: 支付成功已占位入库（status=待协议）`);
                    } catch (insertErr) {
                        console.warn(`[Product] 占位入库失败（不阻塞流程）: ${insertErr.message}`);
                    }

                    progressCallback({
                        progress: 85,
                        message: 'Plus 开通成功！已占位入库，正在提取协议数据...',
                        phone: runtimeAssets.phone.phone,
                        cardLast4,
                        cardExpiry
                    });

                    console.log('[Product] Finalizing: Extracting OAuth tokens...');
                    let oauthResult;
                    try {
                        oauthResult = await runProtocolProcess(email, (payload) => {
                            progressCallback({
                                ...payload,
                                phone: runtimeAssets.phone.phone,
                                cardLast4,
                                cardExpiry
                            });
                        }, runtimeJobKey, inboxBundle);
                    } catch (e) {
                        const msg = e.message || String(e);
                        console.error(
                            `[Product] ⚠️ 协议/OAuth 提取失败，但支付已占位入库（status=待协议，可在后台查看）: ${msg}`
                        );
                        try {
                            progressCallback({
                                progress: 88,
                                message: `支付已成功并占位入库，但协议提取失败（status=待协议）: ${msg}`
                            });
                        } catch (_) {
                            /* ignore */
                        }
                        throw new Error(`支付已成功并占位入库，但协议提取失败(status=待协议): ${msg}`);
                    }

                    progressCallback({
                        progress: 99,
                        message: '协议提取成功，正在绑定邮箱 Key...',
                        phone: runtimeAssets.phone.phone,
                        cardLast4,
                        cardExpiry
                    });

                    const imapKey = await generateImapKey(email);
                    // 协议成功 → 升级 status='正常'，补 file_path 和 imap_key
                    const finalFilePath = oauthResult.sub2apiPath || oauthResult.sub2apiFile || oauthResult.filePath || '';
                    await store.markProductReadyByEmail(email, finalFilePath, imapKey);

                    await store.incrementAssetSuccessCount({
                        phone: runtimeAssets.phone.phone,
                        cardNumber: runtimeAssets.card.number
                    }).catch((err) => console.warn(`[Product] 更新资产成功次数失败: ${err.message}`));

                    progressCallback({
                        progress: 100,
                        message: '成品号创建完成！',
                        result: {
                            email,
                            imapKey,
                            sub2apiFile: oauthResult.sub2apiFile || oauthResult.fileName,
                            sub2apiPath: oauthResult.sub2apiPath || oauthResult.filePath,
                            cpaFile: oauthResult.cpaFile || '',
                            cpaPath: oauthResult.cpaPath || '',
                            phone: runtimeAssets.phone.phone,
                            cardLast4,
                            cardExpiry
                        }
                    });

                    return {
                        success: true,
                        email,
                        imapKey,
                        sub2apiFile: oauthResult.sub2apiFile || oauthResult.fileName,
                        sub2apiPath: oauthResult.sub2apiPath || oauthResult.filePath,
                        cpaFile: oauthResult.cpaFile || '',
                        cpaPath: oauthResult.cpaPath || '',
                        phone: runtimeAssets.phone.phone,
                        cardLast4,
                        cardExpiry
                    };
                }

                topupFailureCount += 1;
                console.warn(
                    `[Product] Account ${email}: 上号失败累计 ${topupFailureCount}/${CONFIG.MAX_TOPUP_FAILURES_BEFORE_STOP}`
                );

                if (topupFailureCount > CONFIG.MAX_TOPUP_FAILURES_BEFORE_STOP) {
                    throw new Error('系统原因导致上号失败次数过多,请稍后重试');
                }

                if (analysis.status === 'maintenance' || analysis.message.includes('系统维护中')) {
                    throw new Error('系统维护中,请联系管理员修复');
                }

                if (analysis.message.includes('无激活权限')) {
                    console.warn(`[Product] Account ${email}: No activation permission. Switching to new account...`);
                    progressCallback({
                        progress: Math.min(20 + accountAttempt * 5, 55),
                        message: '该账号无激活权限，准备更换下一个账号...'
                    });
                    break;
                }

                if (analysis.shouldRetry || analysis.status === 'retry') {
                    if (analysis.deletePhone) {
                        const phoneToBan = runtimeAssets.phone.phone;
                        await store.deletePhoneAsset(phoneToBan);
                        const banMsg = `🚫 [资产] 手机号 ${phoneToBan} 被拒/拦截，已永久禁用 (status='已报废', is_active=0)`;
                        console.warn(banMsg);
                        // 把禁用事件推到前端 runtime log 让用户能看见
                        progressCallback({
                            progress: Math.min(20 + accountAttempt * 5, 60),
                            message: `手机号 ${phoneToBan} 已禁用，准备换号重试...`,
                            phone: phoneToBan,
                            cardLast4,
                            cardExpiry
                        });
                    }
                    if (analysis.deleteCard) {
                        const cardToBan = runtimeAssets.card.number;
                        await store.deleteCardAsset(cardToBan);
                        const banMsg = `🚫 [资产] 银行卡尾号 ${cardToBan.slice(-4)} 被拒，已永久禁用 (status='已报废', is_active=0)`;
                        console.warn(banMsg);
                    }
                    const retryMessage = analysis.message || '开通任务异常，正在重试';
                    console.warn(`[Product] Account ${email}: ${retryMessage}. Retrying same account...`);
                    progressCallback({
                        progress: Math.min(20 + accountAttempt * 5, 60),
                        message: `${retryMessage}，正在同账号重试 (第 ${activationAttempt} 次)...`,
                        phone: runtimeAssets.phone.phone,
                        cardLast4,
                        cardExpiry
                    });
                    await sleep(CONFIG.RETRY_DELAY_MS);
                    continue;
                }

                throw new Error(analysis.message || 'Plus 开通任务异常退出');
            }
        } catch (error) {
            console.error(`[Product] Error in attempt ${accountAttempt}:`, error.message);

            const isFatal = error.message.includes('系统维护中')
                || error.message.includes('系统原因导致上号失败次数过多')
                || error.message.includes('余额不足')
                || error.message.includes('无法获取有效的 Access Token')
                || error.message.includes('页面仍无法正常显示');

            // 🆕 支付已成功但 oauth 协议提取失败：不再注册新账号（避免再扣费 + 浪费手机/卡）
            //   pending 记录已经在 DB 里（status='待协议'），管理员可后续手动触发"补 RT"
            const isPaidButOauthFailed = error.message.includes('支付已成功并占位入库')
                || error.message.includes('协议提取失败');

            if (isPaidButOauthFailed) {
                console.error(`[Product] ⛔ 支付已成功但协议提取失败（${error.message}）→ 终止任务，避免重复扣费。pending 记录已写入 DB，可后台手动补 RT。`);
                throw new Error(`支付已成功但协议提取失败，已占位入库（status=待协议），请到后台查看并补 RT。原因: ${error.message}`);
            }

            if (isFatal) {
                if (error.message.includes('系统原因导致上号失败次数过多')) {
                    throw new Error('系统原因导致上号失败次数过多,请稍后重试');
                }
                throw new Error('系统维护中,请联系管理员修复');
            }

            if (error.message.includes(OAUTH_ADD_PHONE_ERROR)) {
                progressCallback({
                    progress: Math.min(20 + accountAttempt * 5, 60),
                    message: '当前账号在 OAuth 阶段触发手机号验证，准备重新注册下一个账号...'
                });
            }

            if (accountAttempt >= CONFIG.MAX_ACCOUNT_RETRIES) {
                break;
            }

            await sleep(CONFIG.RETRY_DELAY_MS);
        }
    }

    throw new Error('该账号无激活权限,请更换账号重试');
}

// ─── 普号提取：注册 + OAuth RT 提取（跳过支付） ───
async function startFreeTokenExtraction(cdk, progressCallback, options = {}) {
    let accountAttempt = 0;
    const runtimeJobKey = String(options.jobKey || '');
    const ownerKey = `free:${cdk || 'admin'}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    runtimeLog.push({
        jobKey: runtimeJobKey,
        level: 'product',
        source: 'product',
        text: `🎬 [普号提取] 开始（跳过支付，注册 → OAuth RT） CDK = ${cdk || '(后台批量)'}`
    });

    while (accountAttempt < CONFIG.MAX_ACCOUNT_RETRIES) {
        accountAttempt += 1;
        progressCallback({ progress: 5, message: `正在注册第 ${accountAttempt} 个普号...` });

        try {
            const regResult = await runRegistrationProcess((payload) => {
                progressCallback(payload);
            }, runtimeJobKey);
            const { email } = regResult;
            const inboxBundle = {
                emailSource: regResult.emailSource || '',
                inboxJwt: regResult.inboxJwt || '',
                inboxApiBase: regResult.inboxApiBase || ''
            };

            progressCallback({ progress: 80, message: '注册成功，正在提取 RT...' });

            let randomDomainCfg = 'chiyiyi.cloud';
            try {
                randomDomainCfg = String(await store.getAppConfigValue('random_email_domain', 'chiyiyi.cloud'))
                    .trim().replace(/^@/, '').toLowerCase() || 'chiyiyi.cloud';
            } catch (_) { }

            const protocolEnv = { ...process.env, RANDOM_EMAIL_DOMAIN: randomDomainCfg };
            if (inboxBundle.emailSource) protocolEnv.EMAIL_SOURCE = inboxBundle.emailSource;
            if (inboxBundle.inboxJwt) protocolEnv.INBOX_JWT = inboxBundle.inboxJwt;
            if (inboxBundle.inboxApiBase) protocolEnv.INBOX_API_BASE = inboxBundle.inboxApiBase;

            for (let attempt = 1; attempt <= CONFIG.MAX_PROTOCOL_RETRIES; attempt += 1) {
                progressCallback({ progress: 82, message: attempt === 1 ? '正在通过 OAuth 提取 RT...' : `RT 提取第 ${attempt} 次重试...` });

                const result = await runActivationChild(
                    path.join(__dirname, 'oauth_login.js'),
                    [email],
                    protocolEnv,
                    (line) => { /* 静默 */ },
                    {
                        idleTimeoutMs: CONFIG.CHILD_IDLE_TIMEOUT_MS,
                        timeoutErrorMessage: 'RT 提取超时，已终止并准备重试',
                        runtimeJobKey: String(runtimeJobKey || '')
                    }
                );

                if (result.result && result.result.fileName && result.result.filePath) {
                    progressCallback({ progress: 100, message: '✅ 普号 RT 提取成功' });
                    return result.result;
                }

                if (isOauthAddPhoneError(result)) {
                    throw new Error(`${OAUTH_ADD_PHONE_ERROR}，需要重新注册账号`);
                }

                if (attempt < CONFIG.MAX_PROTOCOL_RETRIES) {
                    await sleep(CONFIG.RETRY_DELAY_MS);
                }
            }

            throw new Error('RT 提取未返回有效结果');
        } catch (error) {
            const analysis = await analyzeProcessOutput(error.message || '', runtimeJobKey);
            if (analysis.status === 'fatal') throw error;
            if (accountAttempt >= CONFIG.MAX_ACCOUNT_RETRIES) throw error;
            progressCallback({ progress: 10, message: `注册/提取失败，换号重试 (${accountAttempt}/${CONFIG.MAX_ACCOUNT_RETRIES}): ${analysis.message}` });
            await sleep(CONFIG.RETRY_DELAY_MS);
        }
    }

    throw new Error('普号提取失败，已达最大重试次数');
}

module.exports = { startProductCreation, startFreeTokenExtraction };
