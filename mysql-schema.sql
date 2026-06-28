CREATE TABLE IF NOT EXISTS app_config (
    config_key VARCHAR(64) NOT NULL PRIMARY KEY,
    config_value TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS phone_assets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    phone VARCHAR(32) NOT NULL,
    sms_api_key VARCHAR(255) NOT NULL DEFAULT '',
    usage_count INT NOT NULL DEFAULT 0,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    status VARCHAR(32) NOT NULL DEFAULT '正常',
    in_use TINYINT(1) NOT NULL DEFAULT 0,
    locked_at TIMESTAMP NULL DEFAULT NULL,
    locked_by VARCHAR(64) NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_phone_assets_phone (phone),
    KEY idx_phone_assets_sort (sort_order, id),
    KEY idx_phone_assets_pick (is_active, in_use, locked_at, usage_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS card_assets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    card_number VARCHAR(32) NOT NULL,
    card_expiry VARCHAR(16) NOT NULL DEFAULT '',
    card_cvc VARCHAR(16) NOT NULL DEFAULT '',
    usage_count INT NOT NULL DEFAULT 0,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    status VARCHAR(32) NOT NULL DEFAULT '正常',
    in_use TINYINT(1) NOT NULL DEFAULT 0,
    locked_at TIMESTAMP NULL DEFAULT NULL,
    locked_by VARCHAR(64) NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_card_assets_sort (sort_order, id),
    KEY idx_card_assets_pick (is_active, in_use, locked_at, usage_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cdk_codes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    cdk_code VARCHAR(32) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    shipped_at TIMESTAMP NULL DEFAULT NULL,
    used_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    type VARCHAR(16) NOT NULL DEFAULT '自助',
    fail_count INT DEFAULT 0,
    cooldown_until TIMESTAMP NULL DEFAULT NULL,
    UNIQUE KEY uniq_cdk_codes_code (cdk_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS task_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    job_key VARCHAR(64) NOT NULL,
    token_preview VARCHAR(64) NOT NULL,
    cdk_code VARCHAR(32) NULL,
    phone VARCHAR(32) NULL,
    card_last4 VARCHAR(4) NULL,
    status VARCHAR(32) NOT NULL,
    message VARCHAR(255) NULL,
    progress INT NOT NULL DEFAULT 0,
    display_time VARCHAR(64) NOT NULL,
    raw_output MEDIUMTEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_task_logs_job_key (job_key),
    KEY idx_task_logs_created (created_at),
    KEY idx_task_logs_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS activation_attempt_limits (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    scope_type VARCHAR(16) NOT NULL,
    scope_key VARCHAR(128) NOT NULL,
    fail_count INT NOT NULL DEFAULT 0,
    cooldown_until TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_activation_attempt_scope (scope_type, scope_key),
    KEY idx_activation_attempt_cooldown (cooldown_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_assets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    imap_key VARCHAR(64) NULL,
    claimed_cdk VARCHAR(32) NULL,
    password VARCHAR(255) NULL,
    token TEXT NULL,
    file_path VARCHAR(512) NULL,
    status VARCHAR(32) NOT NULL DEFAULT '正常',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    shipped TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_product_assets_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS supply_assets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    imap_key VARCHAR(64) NULL,
    claimed_cdk VARCHAR(32) NULL,
    password VARCHAR(255) NULL,
    token TEXT NULL,
    file_path VARCHAR(512) NULL,
    status VARCHAR(32) NOT NULL DEFAULT '正常',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    shipped TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_supply_assets_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pool_emails (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    password VARCHAR(512) NOT NULL DEFAULT '',
    client_id VARCHAR(128) NOT NULL DEFAULT '',
    refresh_token TEXT NULL,
    registered TINYINT(1) NOT NULL DEFAULT 0,
    registered_at TIMESTAMP NULL DEFAULT NULL,
    in_use TINYINT(1) NOT NULL DEFAULT 0,
    locked_at TIMESTAMP NULL DEFAULT NULL,
    locked_by VARCHAR(64) NULL DEFAULT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_pool_emails_email (email),
    KEY idx_pool_emails_pick (registered, is_active, in_use, locked_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
