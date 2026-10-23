CREATE TABLE IF NOT EXISTS scan_cache (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

    ip_range VARCHAR(15) NOT NULL,

    open_ip JSON NULL,
    open_ssh JSON NULL,
    open_ftp JSON NULL,
    open_rtsp JSON NULL,

    scanned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uk_ip_range (ip_range),

    INDEX idx_scanned_at (scanned_at)
);

CREATE TABLE scan_search_index (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    ip_range VARCHAR(15) NOT NULL,
    host VARCHAR(255) NOT NULL,
    ip_address VARCHAR(45) NULL,
    service VARCHAR(16) NOT NULL,
    port SMALLINT UNSIGNED NOT NULL,
    title VARCHAR(512) NULL,
    page_size BIGINT UNSIGNED NULL,
    scanned_at DATETIME NOT NULL,

    PRIMARY KEY (id),
    UNIQUE KEY uq_range_host_service (ip_range, host, service, port),
    KEY idx_ip_address_service (ip_address, service),
    KEY idx_host (host),
    KEY idx_service_port (service, port),
    KEY idx_service_scanned_at (service, scanned_at),
    KEY idx_scanned_at (scanned_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS scan_title_keywords (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    keyword VARCHAR(255) NOT NULL,
    category VARCHAR(80) NOT NULL,
    match_priority SMALLINT UNSIGNED NOT NULL DEFAULT 100,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_scan_title_keyword (keyword),
    KEY idx_scan_title_keyword_category (category, match_priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS scan_queue_jobs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    base_prefix VARCHAR(7) NOT NULL,
    start_octet TINYINT UNSIGNED NOT NULL,
    end_octet TINYINT UNSIGNED NOT NULL,
    start_range VARCHAR(15) NOT NULL,
    end_range VARCHAR(15) NOT NULL,
    current_range VARCHAR(15) NULL,
    status ENUM('queued', 'running', 'completed', 'failed') NOT NULL DEFAULT 'queued',
    total_ranges SMALLINT UNSIGNED NOT NULL,
    completed_ranges SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    error_message TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME NULL,
    finished_at DATETIME NULL,

    PRIMARY KEY (id),
    KEY idx_scan_queue_status_created (status, created_at),
    KEY idx_scan_queue_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS scan_summary_refresh (
    id TINYINT UNSIGNED NOT NULL,
    refreshed_at DATETIME NULL,
    summary_json LONGTEXT NULL,
    summarized_at DATETIME NULL,

    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS app_data_migrations (
    migration_name VARCHAR(128) NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (migration_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
