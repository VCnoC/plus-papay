const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_NAME = process.env.DB_NAME || 'gpt';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';

const SCHEMA_PATH = path.join(__dirname, 'mysql-schema.sql');
const DEFAULT_ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || 'admin');

let pool = null;

function getPool() {
    if (!pool) {
        pool = mysql.createPool({
            host: DB_HOST,
            port: DB_PORT,
            user: DB_USER,
            password: DB_PASSWORD,
            database: DB_NAME,
            charset: 'utf8mb4',
            waitForConnections: true,
            // 10 并发任务 × 每任务最多 3 个子流程同时操作 DB + 后台/前台请求，保守预留 60
            connectionLimit: Number(process.env.DB_POOL_LIMIT || 60),
            queueLimit: 0,
            namedPlaceholders: false,
            multipleStatements: true,
            enableKeepAlive: true,
            keepAliveInitialDelay: 10000
        });
    }

    return pool;
}

// 资产占用最长保留时间（ms），超过这个时长仍未释放视为崩溃，自动回收
const ASSET_LOCK_STALE_MS = Number(process.env.ASSET_LOCK_STALE_MS || 15 * 60 * 1000);

function createPasswordHash(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

async function runQuery(sql, params = [], options = {}) {
    const executor = options.connection || getPool();

    try {
        const [rows] = await executor.query(sql, params);
        return rows;
    } catch (error) {
        const detail = error && error.message ? error.message : String(error);
        throw new Error(`MySQL 执行失败: ${detail}`);
    }
}

async function runExecute(sql, params = [], options = {}) {
    const executor = options.connection || getPool();

    try {
        const [result] = await executor.execute(sql, params);
        return result;
    } catch (error) {
        const detail = error && error.message ? error.message : String(error);
        throw new Error(`MySQL 执行失败: ${detail}`);
    }
}

async function withTransaction(callback) {
    const connection = await getPool().getConnection();
    try {
        await connection.beginTransaction();
        const result = await callback(connection);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

function normalizePhonePool(phonePool) {
    return (phonePool || [])
        .filter((item) => item && item.phone)
        .map((item, index) => [
            String(item.phone),
            String(item.key || ''),
            index,
            item.is_active === 0 || item.status === 'invalid' ? 0 : 1
        ]);
}

function normalizeCardPool(cardPool) {
    return (cardPool || [])
        .filter((item) => item && item.number)
        .map((item, index) => [
            String(item.number),
            String(item.expiry || ''),
            String(item.cvc || ''),
            index,
            item.is_active === 0 || item.status === 'invalid' ? 0 : 1
        ]);
}

function normalizeCdks(cdks) {
    return [...new Set((cdks || []).filter(Boolean).map((item) => String(item).trim()))];
}

async function initializeBaseData() {
    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)
         ON DUPLICATE KEY UPDATE config_value = app_config.config_value;`,
        [
            'proxy', '',
            'admin_password_hash', createPasswordHash(DEFAULT_ADMIN_PASSWORD),
            'admin_password_version', '1',
            'max_concurrent_activations', '1',
            'max_background_concurrent', '1',
            'maintenance_mode', '0',
            'maintenance_mode_drain', '0',
            'pool_email_enabled', '0',
            'pool_email_imap_host', 'outlook.office365.com',
            'pool_email_include_junk', '1',
            'random_email_domain', 'chiyiyi.cloud',
            'email_source', 'random',
            'inbox_api_base', 'https://temp-email-api.jzqkwl.com',
            'inbox_email_domain', '',
            'inbox_email_domains', ''
        ]
    );
}

async function hasColumn(tableName, columnName) {
    const rows = await runQuery(
        `SELECT COUNT(*) AS count
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ?
           AND TABLE_NAME = ?
           AND COLUMN_NAME = ?`,
        [DB_NAME, tableName, columnName]
    );

    return Number(rows[0]?.count || 0) > 0;
}

async function ensureColumn(tableName, columnName, columnDefinition) {
    if (await hasColumn(tableName, columnName)) {
        return;
    }

    await runQuery(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${columnDefinition}`);
}

async function ensureLegacyColumns() {
    await ensureColumn('app_config', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('app_config', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    await ensureColumn('phone_assets', 'sms_api_key', "VARCHAR(255) NOT NULL DEFAULT ''");
    await ensureColumn('phone_assets', 'usage_count', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('phone_assets', 'sort_order', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('phone_assets', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1');
    await ensureColumn('phone_assets', 'status', "VARCHAR(32) NOT NULL DEFAULT '正常'");
    await ensureColumn('phone_assets', 'in_use', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumn('phone_assets', 'locked_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('phone_assets', 'locked_by', 'VARCHAR(64) NULL DEFAULT NULL');
    await ensureColumn('phone_assets', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('phone_assets', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    await ensureColumn('card_assets', 'card_expiry', "VARCHAR(16) NOT NULL DEFAULT ''");
    await ensureColumn('card_assets', 'card_cvc', "VARCHAR(16) NOT NULL DEFAULT ''");
    await ensureColumn('card_assets', 'usage_count', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('card_assets', 'sort_order', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('card_assets', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1');
    await ensureColumn('card_assets', 'status', "VARCHAR(32) NOT NULL DEFAULT '正常'");
    await ensureColumn('card_assets', 'in_use', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumn('card_assets', 'locked_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('card_assets', 'locked_by', 'VARCHAR(64) NULL DEFAULT NULL');
    await ensureColumn('card_assets', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('card_assets', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    await ensureColumn('cdk_codes', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1');
    await ensureColumn('cdk_codes', 'shipped_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('cdk_codes', 'used_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('cdk_codes', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('cdk_codes', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
    await ensureColumn('cdk_codes', 'type', "VARCHAR(16) NOT NULL DEFAULT '自助'");

    await ensureColumn('task_logs', 'token_preview', "VARCHAR(64) NOT NULL DEFAULT ''");
    await ensureColumn('task_logs', 'phone', 'VARCHAR(32) NULL');
    await ensureColumn('task_logs', 'cdk_code', 'VARCHAR(32) NULL');
    await ensureColumn('task_logs', 'card_last4', 'VARCHAR(4) NULL');
    await ensureColumn('task_logs', 'status', "VARCHAR(32) NOT NULL DEFAULT 'running'");
    await ensureColumn('task_logs', 'message', 'VARCHAR(255) NULL');
    await ensureColumn('task_logs', 'progress', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('task_logs', 'display_time', "VARCHAR(64) NOT NULL DEFAULT ''");
    await ensureColumn('task_logs', 'raw_output', 'MEDIUMTEXT NULL');
    await ensureColumn('task_logs', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('task_logs', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    await ensureColumn('product_assets', 'password', 'VARCHAR(255) NULL');
    await ensureColumn('pool_emails', 'client_id', "VARCHAR(128) NOT NULL DEFAULT ''");
    await ensureColumn('pool_emails', 'refresh_token', 'TEXT NULL');

    await ensureColumn('product_assets', 'imap_key', 'VARCHAR(64) NULL');
    await ensureColumn('product_assets', 'claimed_cdk', 'VARCHAR(32) NULL');
    await ensureColumn('product_assets', 'token', 'TEXT NULL');
    await ensureColumn('product_assets', 'file_path', 'VARCHAR(512) NULL');
    await ensureColumn('product_assets', 'status', "VARCHAR(32) NOT NULL DEFAULT '正常'");
    await ensureColumn('product_assets', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1');
    await ensureColumn('product_assets', 'shipped', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumn('product_assets', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('product_assets', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
}

async function ensureReady() {
    const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    await runQuery(schemaSql);
    await ensureLegacyColumns();
    await initializeBaseData();
}

function parseAdminProductGenerationTask(row) {
    const cdkCode = String(row?.cdk_code || '');
    let payload = null;

    try {
        payload = row?.raw_output ? JSON.parse(row.raw_output) : null;
    } catch (_) { }

    let targetCount = 0;
    let completedCount = 0;
    let successCount = 0;
    let failedCount = 0;
    let workerCount = 0;
    let aborted = false;
    let lastError = '';

    if (payload && payload.kind === 'admin_product_generation') {
        targetCount = Math.max(0, Number(payload.targetCount) || 0);
        completedCount = Math.max(0, Number(payload.completedCount) || 0);
        successCount = Math.max(0, Number(payload.successCount) || 0);
        failedCount = Math.max(0, Number(payload.failedCount) || 0);
        workerCount = Math.max(0, Number(payload.workerCount) || 0);
        aborted = Boolean(payload.aborted);
        lastError = String(payload.lastError || '').trim();
    }

    if (!targetCount) {
        const match = cdkCode.match(/^ADMIN_PRODUCT_GEN:(\d+)$/);
        targetCount = match ? Math.max(0, Number(match[1]) || 0) : 0;
    }

    completedCount = Math.min(targetCount, completedCount);
    const remainingCount = Math.max(0, targetCount - completedCount);

    return {
        jobKey: String(row?.job_key || ''),
        cdkCode,
        status: String(row?.status || ''),
        targetCount,
        completedCount,
        remainingCount,
        successCount,
        failedCount,
        workerCount,
        aborted,
        lastError
    };
}

function isResumableProductGenerationTask(task) {
    if (!task || task.remainingCount <= 0 || !task.aborted) {
        return false;
    }

    const message = String(task.lastError || '');
    return message.includes('系统维护中')
        || message.includes('余额不足')
        || message.includes('代理')
        || message.includes('无法获取有效的 Access Token')
        || message.includes('页面仍无法正常显示');
}

async function getResumableAdminProductGeneration() {
    const runningRows = await runQuery(
        `SELECT job_key, cdk_code, raw_output, status
         FROM task_logs
         WHERE status = 'running'
           AND cdk_code LIKE 'ADMIN_PRODUCT_GEN:%'
         ORDER BY created_at DESC, id DESC`
    );

    if (runningRows.length > 0) {
        return null;
    }

    const failedRows = await runQuery(
        `SELECT job_key, cdk_code, raw_output, status
         FROM task_logs
         WHERE status = 'failed'
           AND cdk_code LIKE 'ADMIN_PRODUCT_GEN:%'
         ORDER BY created_at DESC, id DESC
         LIMIT 20`
    );

    for (const row of failedRows) {
        const task = parseAdminProductGenerationTask(row);
        if (isResumableProductGenerationTask(task)) {
            return task;
        }
    }

    return null;
}

async function getAdminData() {
    const [configRows, phoneRows, cardRows, logRows, statsRows, cdkStatsRows] = await Promise.all([
        runQuery(
            `SELECT config_key, config_value
             FROM app_config
             WHERE config_key IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                'proxy',
                'max_concurrent_activations',
                'max_background_concurrent',
                'maintenance_mode',
                'maintenance_mode_drain',
                'pool_email_enabled',
                'pool_email_imap_host',
                'pool_email_include_junk',
                'random_email_domain',
                'email_source',
                'inbox_api_base',
                'inbox_email_domain',
                'inbox_email_domains'
            ]
        ),
        runQuery(
            `SELECT phone, sms_api_key, usage_count, is_active, status
             FROM phone_assets
             ORDER BY sort_order ASC, id ASC`
        ),
        runQuery(
            `SELECT card_number, card_expiry, card_cvc, usage_count, is_active, status
             FROM card_assets
             ORDER BY sort_order ASC, id ASC`
        ),
        runQuery(
            `SELECT l.job_key, l.display_time, l.token_preview, l.cdk_code, l.phone, l.card_last4, l.status, l.message, l.progress, c.type AS cdk_type
             FROM task_logs l
             LEFT JOIN cdk_codes c ON l.cdk_code = c.cdk_code
             ORDER BY l.created_at DESC, l.id DESC
             LIMIT 200`
        ),
        runQuery(
            `SELECT
                COUNT(*) AS total,
                COALESCE(SUM(status = 'success'), 0) AS success,
                COALESCE(SUM(status IN ('failed', 'card_invalid')), 0) AS failed
             FROM task_logs`
        ),
        runQuery(
            `SELECT
                COUNT(*) AS total,
                COALESCE(SUM(used_at IS NOT NULL), 0) AS used_count,
                COALESCE(SUM(used_at IS NULL), 0) AS unused_count
             FROM cdk_codes
             WHERE is_active = 1`
        )
    ]);

    const stats = statsRows[0] || {};
    const cdkStats = cdkStatsRows[0] || {};
    const configMap = Object.fromEntries(configRows.map((row) => [row.config_key, row.config_value]));
    const productPendingRows = await runQuery(
        `SELECT cdk_code, raw_output
         FROM task_logs
         WHERE status = 'running'
           AND cdk_code LIKE 'ADMIN_PRODUCT_GEN:%'`
    );

    const productPendingTotal = productPendingRows.reduce((sum, row) => {
        const task = parseAdminProductGenerationTask(row);
        return sum + task.remainingCount;
    }, 0);
    const resumableTask = await getResumableAdminProductGeneration();

    return {
        config: {
            proxy: configMap.proxy || '',
            max_concurrent_activations: Math.max(1, Number(configMap.max_concurrent_activations || 1)),
            max_background_concurrent: Math.max(1, Number(configMap.max_background_concurrent || 1)),
            maintenance_mode: String(configMap.maintenance_mode || '0') === '1',
            maintenance_mode_drain: String(configMap.maintenance_mode_drain || '0') === '1',
            email_source: ['random', 'pool', 'inbox'].includes(String(configMap.email_source || ''))
                ? String(configMap.email_source)
                : (String(configMap.pool_email_enabled || '0') === '1' ? 'pool' : 'random'),
            pool_email_enabled: String(configMap.pool_email_enabled || '0') === '1',
            pool_email_imap_host: String(configMap.pool_email_imap_host || 'outlook.office365.com').trim() || 'outlook.office365.com',
            pool_email_include_junk: String(configMap.pool_email_include_junk || '1') === '1',
            random_email_domain: String(configMap.random_email_domain || 'chiyiyi.cloud').trim().replace(/^@/, '') || 'chiyiyi.cloud',
            inbox_api_base: String(configMap.inbox_api_base || 'https://temp-email-api.jzqkwl.com').trim().replace(/\/+$/, '') || 'https://temp-email-api.jzqkwl.com',
            inbox_email_domain: String(configMap.inbox_email_domain || '').trim().replace(/^@/, ''),
            inbox_email_domains: String(configMap.inbox_email_domains || '').split(/[\n,;\s]+/).map((d) => d.trim().replace(/^@/, '')).filter(Boolean),
            phone_pool: phoneRows.map((row) => ({
                phone: row.phone,
                key: row.sms_api_key,
                usage_count: Number(row.usage_count || 0),
                is_active: Number(row.is_active || 0),
                status: Number(row.is_active || 0) === 1
                    ? 'normal'
                    : String(row.status || 'invalid').trim() || 'invalid'
            })),
            card_pool: cardRows.map((row) => ({
                number: row.card_number,
                expiry: row.card_expiry,
                cvc: row.card_cvc,
                usage_count: Number(row.usage_count || 0),
                is_active: Number(row.is_active || 0),
                status: Number(row.is_active || 0) === 1
                    ? 'normal'
                    : String(row.status || 'invalid').trim() || 'invalid'
            }))
        },
        stats: {
            total: Number(stats.total || 0),
            success: Number(stats.success || 0),
            failed: Number(stats.failed || 0),
            cdk_total: Number(cdkStats.total || 0),
            cdk_used: Number(cdkStats.used_count || 0),
            cdk_unused: Number(cdkStats.unused_count || 0),
            product_total: (await runQuery(`SELECT COUNT(*) AS count FROM product_assets`))[0]?.count || 0,
            product_disabled: (await runQuery(`SELECT COUNT(*) AS count FROM product_assets WHERE status = '封禁'`))[0]?.count || 0,
            product_pending: productPendingTotal,
            product_resume_available: Boolean(resumableTask),
            product_resume_count: Number(resumableTask?.remainingCount || 0),
            product_resume_message: resumableTask
                ? `系统错误中断，剩余 ${resumableTask.remainingCount} 个待继续生产`
                : '',
            product_resume_job_key: resumableTask?.jobKey || ''
        },
        logs: logRows.map((row) => {
            const isAdminProductGeneration = String(row.cdk_code || '').startsWith('ADMIN_PRODUCT_GEN:');
            return {
                id: row.job_key,
                time: row.display_time,
                token: isAdminProductGeneration ? '系统生成' : row.token_preview,
                cdk: isAdminProductGeneration ? '系统生成' : (row.cdk_code || ''),
                type: isAdminProductGeneration ? '成品生产' : (row.cdk_type || '自助'),
                phone: row.phone,
                message: row.message || '',
                cardLast4: row.card_last4 || '',
                status: row.status,
                progress: Number(row.progress || 0)
            };
        })
    };
}

async function saveConfig(config) {
    const proxy = String(config?.proxy || '');
    const maxConcurrentActivations = Math.max(1, Number(config?.max_concurrent_activations || 1));
    const maxBackgroundConcurrent = Math.max(1, Number(config?.max_background_concurrent || 1));
    const maintenanceMode = config?.maintenance_mode ? '1' : '0';
    const maintenanceModeDrain = config?.maintenance_mode_drain ? '1' : '0';
    const emailSource = ['random', 'pool', 'inbox'].includes(String(config?.email_source))
        ? String(config.email_source)
        : (config?.pool_email_enabled ? 'pool' : 'random');
    // 兼容旧字段：email_source 是真相，pool_email_enabled 由它派生
    const poolEmailEnabled = emailSource === 'pool' ? '1' : '0';
    const poolEmailImapHost = String(config?.pool_email_imap_host || 'outlook.office365.com').trim() || 'outlook.office365.com';
    const poolEmailIncludeJunk = config?.pool_email_include_junk === false || String(config?.pool_email_include_junk || '1') === '0'
        ? '0'
        : '1';
    const randomEmailDomain = String(config?.random_email_domain || 'chiyiyi.cloud')
        .trim()
        .replace(/^@/, '')
        .toLowerCase()
        || 'chiyiyi.cloud';
    const inboxApiBase = String(config?.inbox_api_base || 'https://temp-email-api.jzqkwl.com')
        .trim().replace(/\/+$/, '') || 'https://temp-email-api.jzqkwl.com';
    const inboxEmailDomain = String(config?.inbox_email_domain || '').trim().replace(/^@/, '').toLowerCase();
    // 多域名（一行一个 / 逗号 / 空格分隔）
    const inboxEmailDomainsList = (() => {
        const raw = config?.inbox_email_domains;
        if (Array.isArray(raw)) {
            return raw.map((d) => String(d || '').trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
        }
        return String(raw || '')
            .split(/[\n,;\s]+/)
            .map((d) => d.trim().replace(/^@/, '').toLowerCase())
            .filter(Boolean);
    })();
    const inboxEmailDomainsRaw = inboxEmailDomainsList.join('\n');
    const phonePool = normalizePhonePool(Array.isArray(config?.phone_pool) ? config.phone_pool : []);
    const cardPool = normalizeCardPool(Array.isArray(config?.card_pool) ? config.card_pool : []);

    await withTransaction(async (connection) => {
        await runExecute(
            `INSERT INTO app_config (config_key, config_value)
             VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)
             ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
            [
                'proxy', proxy,
                'max_concurrent_activations', String(maxConcurrentActivations),
                'max_background_concurrent', String(maxBackgroundConcurrent),
                'maintenance_mode', maintenanceMode,
                'maintenance_mode_drain', maintenanceModeDrain,
                'pool_email_enabled', poolEmailEnabled,
                'pool_email_imap_host', poolEmailImapHost,
                'pool_email_include_junk', poolEmailIncludeJunk,
                'random_email_domain', randomEmailDomain,
                'email_source', emailSource,
                'inbox_api_base', inboxApiBase,
                'inbox_email_domain', inboxEmailDomain,
                'inbox_email_domains', inboxEmailDomainsRaw
            ],
            { connection }
        );

        if (phonePool.length > 0) {
            const phones = phonePool.map((item) => item[0]);
            const phonePlaceholders = phones.map(() => '?').join(', ');
            await runExecute(
                `DELETE FROM phone_assets
                 WHERE phone NOT IN (${phonePlaceholders})`,
                phones,
                { connection }
            );
            await connection.query(
                `INSERT INTO phone_assets (phone, sms_api_key, sort_order, is_active) VALUES ?
                 ON DUPLICATE KEY UPDATE
                    sms_api_key = VALUES(sms_api_key),
                    sort_order = VALUES(sort_order),
                    is_active = VALUES(is_active)`,
                [phonePool]
            );
        } else {
            await runExecute(`DELETE FROM phone_assets`, [], { connection });
        }

        if (cardPool.length > 0) {
            const cardNumbers = cardPool.map((item) => item[0]);
            const cardPlaceholders = cardNumbers.map(() => '?').join(', ');
            await runExecute(
                `DELETE FROM card_assets
                 WHERE card_number NOT IN (${cardPlaceholders})`,
                cardNumbers,
                { connection }
            );
            for (const card of cardPool) {
                const result = await runExecute(
                    `UPDATE card_assets
                     SET card_expiry = ?,
                         card_cvc = ?,
                         sort_order = ?,
                         is_active = ?
                     WHERE card_number = ?`,
                    [card[1], card[2], card[3], card[4], card[0]],
                    { connection }
                );
                if (result.affectedRows === 0) {
                    await runExecute(
                        `INSERT INTO card_assets (card_number, card_expiry, card_cvc, sort_order, is_active)
                         VALUES (?, ?, ?, ?, ?)`,
                        card,
                        { connection }
                    );
                }
            }
        } else {
            await runExecute(`DELETE FROM card_assets`, [], { connection });
        }
    });
}

async function listCdks() {
    const rows = await runQuery(
        `SELECT cdk_code, shipped_at, used_at, type
         FROM cdk_codes
         WHERE is_active = 1
         ORDER BY created_at DESC, id DESC`
    );

    const runningRows = await runQuery(
        `SELECT cdk_code, MAX(updated_at) AS updated_at
         FROM task_logs
         WHERE status = 'running'
           AND cdk_code IS NOT NULL
         GROUP BY cdk_code`
    );
    const runningSet = new Set(runningRows.map((row) => String(row.cdk_code || '').trim()).filter(Boolean));

    return rows.map((row) => ({
        code: row.cdk_code,
        status: runningSet.has(String(row.cdk_code || '').trim())
            ? 'processing'
            : (row.used_at ? 'used' : 'unused'),
        type: row.type || '自助',
        shipped: Boolean(row.shipped_at),
        shipped_at: row.shipped_at
            ? new Date(row.shipped_at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
            : null,
        used_at: row.used_at
            ? new Date(row.used_at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
            : null
    }));
}

async function markCdkShipped(cdk) {
    const result = await runExecute(
        `UPDATE cdk_codes
         SET shipped_at = COALESCE(shipped_at, CURRENT_TIMESTAMP)
         WHERE cdk_code = ?
           AND is_active = 1`,
        [String(cdk)]
    );
    return result.affectedRows > 0;
}
async function insertCdks(cdks, options = {}) {
    const normalized = normalizeCdks(cdks);
    if (normalized.length === 0) {
        return {
            insertedCount: 0,
            duplicateCount: 0,
            totalCount: 0
        };
    }

    const values = normalized.map((cdk) => [cdk, 1, options.type || '自助']);
    console.log(`正在插入 ${values.length} 个 CDK, 类型: ${options.type || '自助'}`);

    const [result] = await getPool().query(
        `INSERT INTO cdk_codes (cdk_code, is_active, type) VALUES ?`,
        [values]
    );

    const insertedCount = Number(result?.affectedRows || 0);
    console.log(`插入完成, 影响行数: ${insertedCount}`);

    return {
        insertedCount,
        duplicateCount: Math.max(0, normalized.length - insertedCount),
        totalCount: normalized.length
    };
}

async function deleteCdk(cdk) {
    await runExecute(`DELETE FROM cdk_codes WHERE cdk_code = ?`, [String(cdk)]);
}

async function verifyCdk(cdk) {
    const rows = await runQuery(
        `SELECT COUNT(*) AS count
         FROM cdk_codes
         WHERE cdk_code = ?
           AND is_active = 1
           AND used_at IS NULL`,
        [String(cdk)]
    );

    return Number(rows[0]?.count || 0) > 0;
}

async function verifyCdkDetails(cdk) {
    const rows = await runQuery(
        `SELECT * FROM cdk_codes
         WHERE cdk_code = ?
           AND is_active = 1`,
        [String(cdk)]
    );
    return rows[0] || null;
}

async function recordCdkFailure(cdk) {
    // 增加失败次数
    await runExecute(
        `UPDATE cdk_codes 
         SET fail_count = fail_count + 1 
         WHERE cdk_code = ?`,
        [String(cdk)]
    );

    // 检查是否达到 3 次
    const cdkDetails = await verifyCdkDetails(cdk);
    if (cdkDetails && cdkDetails.fail_count >= 3) {
        // 达到 3 次，设置 10 分钟冷却，并重置失败次数
        await runExecute(
            `UPDATE cdk_codes 
             SET cooldown_until = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE),
                 fail_count = 0
             WHERE cdk_code = ?`,
            [String(cdk)]
        );
        return true; // 触发了冷却
    }
    return false;
}

async function resetCdkFailure(cdk) {
    await runExecute(
        `UPDATE cdk_codes 
         SET fail_count = 0, cooldown_until = NULL 
         WHERE cdk_code = ?`,
        [String(cdk)]
    );
}

async function getActivationAttemptLimit(scopeType, scopeKey) {
    const rows = await runQuery(
        `SELECT scope_type, scope_key, fail_count, cooldown_until
         FROM activation_attempt_limits
         WHERE scope_type = ?
           AND scope_key = ?
         LIMIT 1`,
        [String(scopeType), String(scopeKey)]
    );
    return rows[0] || null;
}

async function recordActivationAttemptFailure(scopeType, scopeKey) {
    await runExecute(
        `INSERT INTO activation_attempt_limits (scope_type, scope_key, fail_count, cooldown_until)
         VALUES (?, ?, 1, NULL)
         ON DUPLICATE KEY UPDATE fail_count = fail_count + 1`,
        [String(scopeType), String(scopeKey)]
    );

    const limit = await getActivationAttemptLimit(scopeType, scopeKey);
    if (limit && Number(limit.fail_count || 0) >= 3) {
        await runExecute(
            `UPDATE activation_attempt_limits
             SET cooldown_until = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE),
                 fail_count = 0
             WHERE scope_type = ?
               AND scope_key = ?`,
            [String(scopeType), String(scopeKey)]
        );
        return true;
    }
    return false;
}

async function resetActivationAttemptFailure(scopeType, scopeKey) {
    await runExecute(
        `DELETE FROM activation_attempt_limits
         WHERE scope_type = ?
           AND scope_key = ?`,
        [String(scopeType), String(scopeKey)]
    );
}

async function markCdkUsed(cdk) {
    const result = await runExecute(
        `UPDATE cdk_codes
         SET used_at = CURRENT_TIMESTAMP
         WHERE cdk_code = ?
           AND is_active = 1
           AND used_at IS NULL`,
        [String(cdk)]
    );
    return result.affectedRows > 0;
}

async function markCdkUnused(cdk) {
    await runExecute(
        `UPDATE cdk_codes
         SET used_at = NULL
         WHERE cdk_code = ?
           AND is_active = 1`,
        [String(cdk)]
    );
}

async function deletePhoneAsset(phone) {
    if (!phone) {
        return;
    }

    await runExecute(
        `UPDATE phone_assets
         SET is_active = 0,
             status = '已报废'
         WHERE phone = ?`,
        [String(phone)]
    );
}

async function deleteCardAsset(cardNumber) {
    if (!cardNumber) {
        return;
    }

    await runExecute(
        `UPDATE card_assets
         SET is_active = 0,
             status = '已报废'
         WHERE card_number = ?`,
        [String(cardNumber)]
    );
}

// 在事务里挑一个未占用资产并立即标记 in_use；无可用资产时返回 null 而不是阻塞。
// 用 FOR UPDATE SKIP LOCKED 避免两个并发任务同时抢同一行。
async function reserveAssetRow(connection, table, columns, ownerKey) {
    const staleThreshold = new Date(Date.now() - ASSET_LOCK_STALE_MS);
    const colList = ['id', ...columns].join(', ');
    const [rows] = await connection.query(
        `SELECT ${colList}
         FROM ${table}
         WHERE is_active = 1
           AND (in_use = 0 OR locked_at IS NULL OR locked_at < ?)
         ORDER BY usage_count ASC, COALESCE(locked_at, '1970-01-01') ASC, id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [staleThreshold]
    );

    if (!rows.length) {
        return null;
    }

    const row = rows[0];
    await connection.query(
        `UPDATE ${table}
         SET in_use = 1,
             locked_at = CURRENT_TIMESTAMP,
             locked_by = ?
         WHERE id = ?`,
        [String(ownerKey || '').slice(0, 64) || null, row.id]
    );

    return row;
}

async function reserveRuntimeAssets(ownerKey = '') {
    return withTransaction(async (connection) => {
        const [phoneRow, cardRow, proxyRows] = await Promise.all([
            reserveAssetRow(connection, 'phone_assets', ['phone', 'sms_api_key', 'usage_count'], ownerKey),
            reserveAssetRow(connection, 'card_assets', ['card_number', 'card_expiry', 'card_cvc', 'usage_count'], ownerKey),
            connection.query(`SELECT config_value FROM app_config WHERE config_key = ? LIMIT 1`, ['proxy']).then(r => r[0])
        ]);

        const proxyList = String(proxyRows[0]?.config_value || '')
            .split(/\r?\n/)
            .map(p => p.trim())
            .filter(p => p.length > 0);

        return {
            phoneAssetId: phoneRow?.id || null,
            cardAssetId: cardRow?.id || null,
            phone: phoneRow
                ? {
                    phone: phoneRow.phone,
                    key: phoneRow.sms_api_key,
                    usage_count: Number(phoneRow.usage_count || 0)
                }
                : { phone: '未配置', key: '', usage_count: 0 },
            card: cardRow
                ? {
                    number: cardRow.card_number,
                    expiry: cardRow.card_expiry,
                    cvc: cardRow.card_cvc,
                    usage_count: Number(cardRow.usage_count || 0)
                }
                : { number: '', expiry: '', cvc: '', usage_count: 0 },
            proxy: proxyList.length ? substituteProxySession(proxyList[Math.floor(Math.random() * proxyList.length)]) : ''
        };
    });
}

async function releaseAssetById(table, id) {
    if (!id) {
        return;
    }
    await runExecute(
        `UPDATE ${table}
         SET in_use = 0,
             locked_at = NULL,
             locked_by = NULL
         WHERE id = ?`,
        [Number(id)]
    );
}

async function releaseRuntimeAssets({ phoneAssetId, cardAssetId } = {}) {
    const tasks = [];
    if (phoneAssetId) tasks.push(releaseAssetById('phone_assets', phoneAssetId));
    if (cardAssetId) tasks.push(releaseAssetById('card_assets', cardAssetId));
    if (tasks.length) {
        await Promise.all(tasks);
    }
}

// 兜底：把超过 ASSET_LOCK_STALE_MS 仍未释放的锁强制清理（任务进程崩溃后回收用）
async function releaseStaleAssetLocks() {
    const staleThreshold = new Date(Date.now() - ASSET_LOCK_STALE_MS);
    const [phoneResult, cardResult, poolResult] = await Promise.all([
        runExecute(
            `UPDATE phone_assets
             SET in_use = 0, locked_at = NULL, locked_by = NULL
             WHERE in_use = 1 AND (locked_at IS NULL OR locked_at < ?)`,
            [staleThreshold]
        ),
        runExecute(
            `UPDATE card_assets
             SET in_use = 0, locked_at = NULL, locked_by = NULL
             WHERE in_use = 1 AND (locked_at IS NULL OR locked_at < ?)`,
            [staleThreshold]
        ),
        runExecute(
            `UPDATE pool_emails
             SET in_use = 0, locked_at = NULL, locked_by = NULL
             WHERE registered = 0
               AND in_use = 1
               AND (locked_at IS NULL OR locked_at < ?)`,
            [staleThreshold]
        )
    ]);

    return {
        phoneReleased: Number(phoneResult?.affectedRows || 0),
        cardReleased: Number(cardResult?.affectedRows || 0),
        poolReleased: Number(poolResult?.affectedRows || 0)
    };
}

// 启动时先把所有 in_use 标记彻底重置（崩溃重启场景）
async function resetAllAssetLocks() {
    await Promise.all([
        runExecute(`UPDATE phone_assets SET in_use = 0, locked_at = NULL, locked_by = NULL WHERE in_use = 1`),
        runExecute(`UPDATE card_assets SET in_use = 0, locked_at = NULL, locked_by = NULL WHERE in_use = 1`),
        runExecute(`UPDATE pool_emails SET in_use = 0, locked_at = NULL, locked_by = NULL WHERE registered = 0 AND in_use = 1`)
    ]);
}

// 支持两种格式：
//   1) Outlook/MS OAuth2:  email----password----client_id----refresh_token
//   2) 简单密码:            email\tpassword   或   email password
function parseMailTxtImport(text) {
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    let skipped = 0;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        let email = '';
        let password = '';
        let clientId = '';
        let refreshToken = '';

        if (line.includes('----')) {
            const segs = line.split('----').map((s) => s.trim());
            if (segs.length >= 4 && segs[0].includes('@')) {
                email = segs[0].toLowerCase();
                password = segs[1] || '';
                clientId = segs[2] || '';
                refreshToken = segs.slice(3).join('----').trim();
            } else if (segs.length >= 2 && segs[0].includes('@')) {
                email = segs[0].toLowerCase();
                password = segs.slice(1).join('----').trim();
            } else {
                skipped += 1;
                continue;
            }
        } else {
            let parts = line.split('\t').map((s) => s.trim()).filter(Boolean);
            if (parts.length < 2) {
                parts = line.split(/\s+/).filter(Boolean);
            }
            if (parts.length < 2 || !parts[0].includes('@')) {
                skipped += 1;
                continue;
            }
            email = parts[0].toLowerCase();
            password = parts.slice(1).join(' ').trim();
        }

        if (!email || (!password && !refreshToken)) {
            skipped += 1;
            continue;
        }

        out.push({ email, password, clientId, refreshToken });
    }

    return { rows: out, skipped };
}

async function bulkImportPoolEmails(text) {
    const { rows, skipped } = parseMailTxtImport(text);
    let applied = 0;
    let oauthCount = 0;

    await withTransaction(async (connection) => {
        for (let i = 0; i < rows.length; i++) {
            const { email, password, clientId, refreshToken } = rows[i];
            if (refreshToken) {
                oauthCount += 1;
            }
            await connection.execute(
                `INSERT INTO pool_emails (email, password, client_id, refresh_token, sort_order, is_active)
                 VALUES (?, ?, ?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE
                    password = VALUES(password),
                    client_id = CASE WHEN VALUES(client_id) <> '' THEN VALUES(client_id) ELSE pool_emails.client_id END,
                    refresh_token = CASE WHEN VALUES(refresh_token) IS NOT NULL AND VALUES(refresh_token) <> ''
                                         THEN VALUES(refresh_token)
                                         ELSE pool_emails.refresh_token END,
                    is_active = 1`,
                [email, password, clientId || '', refreshToken || null, i]
            );
            applied += 1;
        }
    });

    return { applied, parsed: rows.length, skipped, oauthCount };
}

async function listPoolEmails() {
    const rows = await runQuery(
        `SELECT id, email,
                CASE WHEN LENGTH(TRIM(password)) > 0 THEN 1 ELSE 0 END AS has_password,
                CASE WHEN refresh_token IS NOT NULL AND LENGTH(TRIM(refresh_token)) > 0 THEN 1 ELSE 0 END AS has_oauth,
                registered, registered_at, in_use, locked_at, is_active, created_at
         FROM pool_emails
         WHERE is_active = 1
         ORDER BY id ASC`
    );

    return rows.map((row) => ({
        id: row.id,
        email: row.email,
        has_password: Number(row.has_password || 0) === 1,
        has_oauth: Number(row.has_oauth || 0) === 1,
        registered: Number(row.registered || 0) === 1,
        registered_at: row.registered_at,
        in_use: Number(row.in_use || 0) === 1,
        locked_at: row.locked_at,
        created_at: row.created_at
    }));
}

async function getPoolEmailCredentials(id) {
    const rows = await runQuery(
        `SELECT id, email, password, client_id, refresh_token, registered, is_active
         FROM pool_emails
         WHERE id = ?
         LIMIT 1`,
        [Number(id)]
    );

    const row = rows[0];
    if (!row || Number(row.is_active || 0) !== 1) {
        return null;
    }

    return {
        id: row.id,
        email: row.email,
        password: row.password || '',
        clientId: row.client_id || '',
        refreshToken: row.refresh_token || '',
        registered: Number(row.registered || 0) === 1
    };
}

async function getPoolEmailByAddress(email) {
    const rows = await runQuery(
        `SELECT id, email, password, client_id, refresh_token, registered, is_active
         FROM pool_emails
         WHERE email = ?
         LIMIT 1`,
        [String(email || '').trim().toLowerCase()]
    );
    const row = rows[0];
    if (!row || Number(row.is_active || 0) !== 1) return null;
    return {
        id: row.id,
        email: row.email,
        password: row.password || '',
        clientId: row.client_id || '',
        refreshToken: row.refresh_token || '',
        registered: Number(row.registered || 0) === 1
    };
}

async function deletePoolEmail(id) {
    await runExecute(`DELETE FROM pool_emails WHERE id = ?`, [Number(id)]);
}

async function reservePoolEmail(ownerKey = '') {
    return withTransaction(async (connection) => {
        const staleThreshold = new Date(Date.now() - ASSET_LOCK_STALE_MS);
        const [rows] = await connection.query(
            `SELECT id, email, password, client_id, refresh_token
             FROM pool_emails
             WHERE is_active = 1
               AND registered = 0
               AND (in_use = 0 OR locked_at IS NULL OR locked_at < ?)
             ORDER BY id ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED`,
            [staleThreshold]
        );

        if (!rows.length) {
            return null;
        }

        const row = rows[0];
        await connection.query(
            `UPDATE pool_emails
             SET in_use = 1, locked_at = CURRENT_TIMESTAMP, locked_by = ?
             WHERE id = ?`,
            [String(ownerKey || '').slice(0, 64) || null, row.id]
        );

        return {
            id: row.id,
            email: row.email,
            password: row.password || '',
            clientId: row.client_id || '',
            refreshToken: row.refresh_token || ''
        };
    });
}

async function releasePoolEmailReservation(id) {
    if (!id) {
        return;
    }

    await runExecute(
        `UPDATE pool_emails
         SET in_use = 0, locked_at = NULL, locked_by = NULL
         WHERE id = ?
           AND registered = 0`,
        [Number(id)]
    );
}

async function markPoolEmailRegistered(id) {
    if (!id) {
        return;
    }

    await runExecute(
        `UPDATE pool_emails
         SET registered = 1,
             registered_at = CURRENT_TIMESTAMP,
             in_use = 0,
             locked_at = NULL,
             locked_by = NULL
         WHERE id = ?`,
        [Number(id)]
    );
}

// ─────────────────────────────────────────────────────────────────
// 🆕 [free_token 模式 C] 从已注册池子取号 / 释放
// 与 reservePoolEmail 的区别：仅取 registered = 1 的邮箱（模式 C 复用老号拿 RT）
// ─────────────────────────────────────────────────────────────────
async function reserveRegisteredPoolEmail(ownerKey = '') {
    return withTransaction(async (connection) => {
        const staleThreshold = new Date(Date.now() - ASSET_LOCK_STALE_MS);
        const [rows] = await connection.query(
            `SELECT id, email, password, client_id, refresh_token
             FROM pool_emails
             WHERE is_active = 1
               AND registered = 1
               AND (in_use = 0 OR locked_at IS NULL OR locked_at < ?)
             ORDER BY id ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED`,
            [staleThreshold]
        );

        if (!rows.length) {
            return null;
        }

        const row = rows[0];
        await connection.query(
            `UPDATE pool_emails
             SET in_use = 1, locked_at = CURRENT_TIMESTAMP, locked_by = ?
             WHERE id = ?`,
            [String(ownerKey || '').slice(0, 64) || null, row.id]
        );

        return {
            id: row.id,
            email: row.email,
            password: row.password || '',
            clientId: row.client_id || '',
            refreshToken: row.refresh_token || ''
        };
    });
}

async function releaseRegisteredPoolEmailReservation(id) {
    if (!id) {
        return;
    }

    // 注意 WHERE 条件用 registered = 1，避免误释放还没注册的号
    await runExecute(
        `UPDATE pool_emails
         SET in_use = 0, locked_at = NULL, locked_by = NULL
         WHERE id = ?
           AND registered = 1`,
        [Number(id)]
    );
}

async function countRegisteredAvailablePoolEmails() {
    const rows = await runQuery(
        `SELECT COUNT(*) AS cnt
         FROM pool_emails
         WHERE is_active = 1
           AND registered = 1
           AND in_use = 0`
    );
    return Number(rows?.[0]?.cnt || 0);
}

// 把 {session} 占位符替换成随机字符串，便于 Kookeey/Brightdata 等住宅代理走 sticky session
function substituteProxySession(rawProxy) {
    if (!rawProxy) {
        return rawProxy;
    }
    if (!/\{session\}/i.test(rawProxy)) {
        return rawProxy;
    }
    const sid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return rawProxy.replace(/\{session\}/gi, sid);
}

// 只取代理，不占用手机/卡资产；适合注册/协议提取这种只用代理的子流程
// 支持 {session} 占位符；每次调用替换为新的随机 sticky session ID
async function getActiveProxy() {
    const rows = await runQuery(
        `SELECT config_value FROM app_config WHERE config_key = ? LIMIT 1`,
        ['proxy']
    );
    const proxyList = String(rows[0]?.config_value || '')
        .split(/\r?\n/)
        .map(p => p.trim())
        .filter(p => p.length > 0);
    if (!proxyList.length) {
        return '';
    }
    const picked = proxyList[Math.floor(Math.random() * proxyList.length)];
    return substituteProxySession(picked);
}

// 兼容旧调用：仅返回代理 + 资源快照，不再锁定（防止误用阻塞资产池）
async function getRuntimeAssets() {
    const [phoneRows, cardRows, proxy] = await Promise.all([
        runQuery(
            `SELECT phone, sms_api_key, usage_count
             FROM phone_assets
             WHERE is_active = 1
             ORDER BY usage_count ASC, id ASC
             LIMIT 1`
        ),
        runQuery(
            `SELECT card_number, card_expiry, card_cvc, usage_count
             FROM card_assets
             WHERE is_active = 1
             ORDER BY usage_count ASC, id ASC
             LIMIT 1`
        ),
        getActiveProxy()
    ]);

    const phoneRow = phoneRows[0];
    const cardRow = cardRows[0];
    return {
        phone: phoneRow
            ? { phone: phoneRow.phone, key: phoneRow.sms_api_key, usage_count: Number(phoneRow.usage_count || 0) }
            : { phone: '未配置', key: '', usage_count: 0 },
        card: cardRow
            ? { number: cardRow.card_number, expiry: cardRow.card_expiry, cvc: cardRow.card_cvc, usage_count: Number(cardRow.usage_count || 0) }
            : { number: '', expiry: '', cvc: '', usage_count: 0 },
        proxy
    };
}

async function incrementAssetSuccessCount({ phone, cardNumber }) {
    const tasks = [];

    if (phone) {
        tasks.push(
            runExecute(
                `UPDATE phone_assets
                 SET usage_count = usage_count + 1
                 WHERE phone = ? AND is_active = 1`,
                [String(phone)]
            )
        );
    }

    if (cardNumber) {
        tasks.push(
            runExecute(
                `UPDATE card_assets
                 SET usage_count = usage_count + 1
                 WHERE card_number = ? AND is_active = 1`,
                [String(cardNumber)]
            )
        );
    }

    if (tasks.length > 0) {
        await Promise.all(tasks);
    }
}

async function getAppConfigValue(configKey, fallbackValue = '') {
    const rows = await runQuery(
        `SELECT config_value
         FROM app_config
         WHERE config_key = ?
         LIMIT 1`,
        [String(configKey)]
    );
    return rows[0]?.config_value ?? fallbackValue;
}

async function setAppConfigValue(configKey, configValue) {
    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        [String(configKey), String(configValue ?? '')]
    );
}

async function getMaxConcurrentActivations() {
    const config = await getAdminData();
    return config.config.max_concurrent_activations;
}

async function getMaxBackgroundConcurrent() {
    const config = await getAdminData();
    return config.config.max_background_concurrent;
}

async function getMaintenanceModeState() {
    const rows = await runQuery(
        `SELECT config_key, config_value
         FROM app_config
         WHERE config_key IN (?, ?)`,
        ['maintenance_mode', 'maintenance_mode_drain']
    );
    const configMap = Object.fromEntries(rows.map((row) => [row.config_key, row.config_value]));
    return {
        enabled: String(configMap.maintenance_mode || '0') === '1',
        drain: String(configMap.maintenance_mode_drain || '0') === '1'
    };
}

async function setMaintenanceModeState(enabled, drain = false) {
    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES (?, ?), (?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        [
            'maintenance_mode', enabled ? '1' : '0',
            'maintenance_mode_drain', drain ? '1' : '0'
        ]
    );
}

async function getAdminAuthConfig() {
    const rows = await runQuery(
        `SELECT config_key, config_value
         FROM app_config
         WHERE config_key IN (?, ?)`,
        ['admin_password_hash', 'admin_password_version']
    );

    const map = Object.fromEntries(rows.map((item) => [item.config_key, item.config_value]));

    return {
        passwordHash: String(map.admin_password_hash || ''),
        passwordVersion: Math.max(1, Number(map.admin_password_version || 1))
    };
}

async function updateAdminPassword(password) {
    const nextHash = createPasswordHash(password);
    const authConfig = await getAdminAuthConfig();
    const nextVersion = Math.max(1, Number(authConfig.passwordVersion || 1)) + 1;

    await withTransaction(async (connection) => {
        await runExecute(
            `INSERT INTO app_config (config_key, config_value)
             VALUES (?, ?), (?, ?)
             ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
            [
                'admin_password_hash', nextHash,
                'admin_password_version', String(nextVersion)
            ],
            { connection }
        );
    });

    return {
        passwordHash: nextHash,
        passwordVersion: nextVersion
    };
}

async function createTaskLog({ tokenPreview, cdkCode, phone, cardLast4, status, progress = 0 }) {
    const now = new Date();
    const displayTime = now.toLocaleString('zh-CN', { hour12: false });
    const jobKey = `${now.getTime()}-${Math.random().toString(36).slice(2, 10)}`;
    const message = String(status) === 'running' ? '正在开通中' : null;

    await runExecute(
        `INSERT INTO task_logs (job_key, token_preview, cdk_code, phone, card_last4, status, message, progress, display_time, raw_output)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
            jobKey,
            String(tokenPreview),
            cdkCode || null,
            phone || null,
            cardLast4 || null,
            String(status),
            message,
            Number(progress || 0),
            displayTime
        ]
    );

    return { jobKey, displayTime };
}

async function getTaskStatus(jobKey) {
    const rows = await runQuery(
        `SELECT status, message, progress, raw_output, cdk_code, phone, card_last4
         FROM task_logs
         WHERE job_key = ?
         LIMIT 1`,
        [String(jobKey)]
    );
    return rows[0] || null;
}

async function getRunningTaskByCdk(cdk) {
    const rows = await runQuery(
        `SELECT job_key, status, message, progress, updated_at
         FROM task_logs
         WHERE cdk_code = ?
           AND status = 'running'
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
        [String(cdk)]
    );
    return rows[0] || null;
}

async function deleteTaskLogByJobKey(jobKey) {
    const key = String(jobKey || '').trim();
    if (!key) {
        return { deleted: 0 };
    }
    const result = await runExecute('DELETE FROM task_logs WHERE job_key = ? LIMIT 1', [key]);
    return { deleted: Number(result.affectedRows || 0) };
}

async function updateTaskLog(jobKey, { status, message, rawOutput, cdkCode, phone, cardLast4, progress }) {
    await runExecute(
        `UPDATE task_logs
         SET status = ?,
             message = COALESCE(?, message),
             raw_output = COALESCE(?, raw_output),
             progress = GREATEST(progress, COALESCE(?, progress)),
             cdk_code = COALESCE(?, cdk_code),
             phone = COALESCE(?, phone),
             card_last4 = COALESCE(?, card_last4)
         WHERE job_key = ?`,
        [
            String(status),
            message || null,
            rawOutput || null,
            progress == null ? null : Number(progress),
            cdkCode || null,
            phone || null,
            cardLast4 || null,
            String(jobKey)
        ]
    );
}

async function listProducts() {
    const rows = await runQuery(
        `SELECT p.id,
                p.email,
                p.imap_key,
                COALESCE(
                    p.claimed_cdk,
                    (
                        SELECT l.cdk_code
                        FROM task_logs l
                        WHERE l.status = 'success'
                          AND l.cdk_code IS NOT NULL
                          AND l.cdk_code <> ''
                          AND l.message LIKE CONCAT('%', p.email, '%')
                        ORDER BY l.created_at DESC, l.id DESC
                        LIMIT 1
                    )
                ) AS claimed_cdk,
                p.file_path,
                p.status,
                p.shipped,
                p.created_at
         FROM product_assets p
         ORDER BY p.id DESC`
    );
    return rows.map(row => ({
        ...row,
        time: new Date(row.created_at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
    }));
}

async function addProduct(email, filePath, password = null, token = null, imapKey = null) {
    await runExecute(
        `INSERT INTO product_assets (email, file_path, password, token, imap_key) 
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE file_path = VALUES(file_path), password = VALUES(password), token = VALUES(token), imap_key = COALESCE(VALUES(imap_key), imap_key)`,
        [email, filePath, password, token, imapKey]
    );
}

// 支付成功立即入库（占位）：file_path 留空，status='待协议'
// 后续 oauth_login 拿到 RT 后再调用 markProductReadyByEmail() 升级为 '正常'
async function upsertPendingProduct(email, accessToken = null) {
    if (!email) return;
    await runExecute(
        `INSERT INTO product_assets (email, token, status)
         VALUES (?, ?, '待协议')
         ON DUPLICATE KEY UPDATE token = COALESCE(VALUES(token), token)`,
        [String(email), accessToken ? String(accessToken) : null]
    );
}

// 协议提取成功后调用：补 file_path / imap_key，并把状态翻成 '正常'，使其可被 CDK 兑换
async function markProductReadyByEmail(email, filePath = '', imapKey = null) {
    if (!email) return;
    await runExecute(
        `UPDATE product_assets
         SET file_path = CASE WHEN ? <> '' THEN ? ELSE file_path END,
             imap_key = COALESCE(?, imap_key),
             status = '正常'
         WHERE email = ?`,
        [String(filePath || ''), String(filePath || ''), imapKey ? String(imapKey) : null, String(email)]
    );
}

async function updateProductImapKeyByEmail(email, imapKey) {
    await runExecute(
        `UPDATE product_assets SET imap_key = ? WHERE email = ?`,
        [imapKey ? String(imapKey) : null, String(email)]
    );
}

async function updateProductClaimedCdkByEmail(email, claimedCdk) {
    await runExecute(
        `UPDATE product_assets SET claimed_cdk = ? WHERE email = ?`,
        [claimedCdk ? String(claimedCdk) : null, String(email)]
    );
}

async function deleteProduct(id) {
    await runExecute(`DELETE FROM product_assets WHERE id = ?`, [id]);
}

async function updateProductStatus(id, status) {
    await runExecute(`UPDATE product_assets SET status = ? WHERE id = ?`, [status, id]);
}

async function claimProductAccount(cdk) {
    return withTransaction(async (connection) => {
        // 1. 验证 CDK
        const [cdkRows] = await connection.query(
            `SELECT * FROM cdk_codes WHERE cdk_code = ? AND is_active = 1 AND used_at IS NULL AND type = '成品' FOR UPDATE`,
            [cdk]
        );
        const cdkData = cdkRows[0];
        if (!cdkData) {
            throw new Error('CDK 无效、已使用或非成品激活码');
        }

        // 2. 查找可用成品账号
        const [productRows] = await connection.query(
            `SELECT * FROM product_assets WHERE shipped = 0 AND status = '正常' ORDER BY id ASC LIMIT 1 FOR UPDATE`
        );
        const product = productRows[0];
        if (!product) {
            throw new Error('当前成品号库暂时缺货，请联系客服补充');
        }

        // 3. 标记 CDK 已使用
        await connection.query(
            `UPDATE cdk_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [cdkData.id]
        );

        // 4. 标记成品号已出库
        await connection.query(
            `UPDATE product_assets SET shipped = 1, claimed_cdk = ? WHERE id = ?`,
            [String(cdk), product.id]
        );

        // 5. 创建成功日志
        const jobKey = `PROD-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        await connection.query(
            `INSERT INTO task_logs (job_key, token_preview, cdk_code, status, message, progress, display_time)
             VALUES (?, ?, ?, 'success', ?, 100, ?)`,
            [
                jobKey,
                'PRODUCT_CLAIM',
                cdk,
                `成品号兑换成功: ${product.email}`,
                new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
            ]
        );

        return {
            email: product.email,
            password: product.password,
            token: product.token,
            imapKey: product.imap_key || '',
            jobKey
        };
    });
}

async function updateProductStatusByEmail(email, status) {
    await runExecute(`UPDATE product_assets SET status = ? WHERE email = ?`, [status, email]);
}

async function updateProductStatusByEmails(emails, status) {
    const normalizedEmails = [...new Set(
        (Array.isArray(emails) ? emails : [])
            .map((item) => String(item || '').trim().toLowerCase())
            .filter(Boolean)
    )];

    if (normalizedEmails.length === 0) {
        return 0;
    }

    const placeholders = normalizedEmails.map(() => '?').join(', ');
    const result = await runExecute(
        `UPDATE product_assets SET status = ? WHERE LOWER(email) IN (${placeholders})`,
        [status, ...normalizedEmails]
    );
    return Number(result?.affectedRows || 0);
}

async function markProductShipped(id, shipped = 1) {
    await runExecute(`UPDATE product_assets SET shipped = ? WHERE id = ?`, [shipped, id]);
}

async function markProductShippedByEmail(email, shipped = 1) {
    await runExecute(`UPDATE product_assets SET shipped = ? WHERE email = ?`, [shipped, email]);
}

async function getClaimedProductDownloadInfo(cdk) {
    const logRows = await runQuery(
        `SELECT message, raw_output
         FROM task_logs
         WHERE cdk_code = ?
           AND status = 'success'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [String(cdk)]
    );

    const logRow = logRows[0] || null;
    if (!logRow) {
        return null;
    }

    const message = String(logRow.message || '');
    let email = '';
    let filePath = '';
    let imapKey = '';

    const messageMatch = message.match(/成品号(?:兑换|创建)成功:\s*(.+)$/);
    if (messageMatch) {
        email = String(messageMatch[1] || '').trim();
    }

    try {
        const parsed = logRow.raw_output ? JSON.parse(logRow.raw_output) : null;
        if (!email) {
            email = String(parsed?.email || '').trim();
        }
        filePath = String(parsed?.sub2apiPath || parsed?.filePath || '').trim();
        imapKey = String(parsed?.imapKey || '').trim();
    } catch (_) { }

    if (filePath && imapKey) {
        return {
            email,
            filePath,
            imapKey
        };
    }

    if (!email) {
        const claimedRows = await runQuery(
            `SELECT email, imap_key, file_path
             FROM product_assets
             WHERE claimed_cdk = ?
             ORDER BY id DESC
             LIMIT 1`,
            [String(cdk)]
        );
        const claimedProduct = claimedRows[0];
        if (!claimedProduct || !claimedProduct.file_path) {
            return null;
        }
        return {
            email: claimedProduct.email,
            filePath: filePath || claimedProduct.file_path,
            imapKey: imapKey || claimedProduct.imap_key || ''
        };
    }

    const productRows = await runQuery(
        `SELECT email, imap_key, file_path, status, shipped
         FROM product_assets
         WHERE email = ?
         ORDER BY id DESC
         LIMIT 1`,
        [email]
    );
    const product = productRows[0];
    if (!product || !product.file_path) {
        return null;
    }

    return {
        email: product.email,
        filePath: filePath || product.file_path,
        imapKey: imapKey || product.imap_key || ''
    };
}

module.exports = {
    ensureReady,
    getAdminData,
    getResumableAdminProductGeneration,
    saveConfig,
    getAdminAuthConfig,
    updateAdminPassword,
    listCdks,
    markCdkShipped,
    insertCdks,
    deleteCdk,
    verifyCdk,
    verifyCdkDetails,
    markCdkUsed,
    markCdkUnused,
    recordCdkFailure,
    resetCdkFailure,
    getActivationAttemptLimit,
    recordActivationAttemptFailure,
    resetActivationAttemptFailure,
    deletePhoneAsset,
    deleteCardAsset,
    bulkImportPoolEmails,
    listPoolEmails,
    getPoolEmailCredentials,
    getPoolEmailByAddress,
    deletePoolEmail,
    reservePoolEmail,
    releasePoolEmailReservation,
    markPoolEmailRegistered,
    reserveRegisteredPoolEmail,
    releaseRegisteredPoolEmailReservation,
    countRegisteredAvailablePoolEmails,
    getRuntimeAssets,
    reserveRuntimeAssets,
    releaseRuntimeAssets,
    releaseStaleAssetLocks,
    resetAllAssetLocks,
    getActiveProxy,
    incrementAssetSuccessCount,
    getAppConfigValue,
    setAppConfigValue,
    getMaxConcurrentActivations,
    getMaxBackgroundConcurrent,
    getMaintenanceModeState,
    setMaintenanceModeState,
    createTaskLog,
    deleteTaskLogByJobKey,
    getTaskStatus,
    getRunningTaskByCdk,
    updateTaskLog,
    listProducts,
    addProduct,
    upsertPendingProduct,
    markProductReadyByEmail,
    updateProductImapKeyByEmail,
    updateProductClaimedCdkByEmail,
    deleteProduct,
    updateProductStatus,
    updateProductStatusByEmail,
    updateProductStatusByEmails,
    markProductShipped,
    markProductShippedByEmail,
    claimProductAccount,
    getClaimedProductDownloadInfo,
    connectionInfo: {
        host: DB_HOST,
        port: DB_PORT,
        database: DB_NAME,
        user: DB_USER
    }
};
