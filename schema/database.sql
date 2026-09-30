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
    scanned_at DATETIME NOT NULL,

    PRIMARY KEY (id),
    UNIQUE KEY uq_range_host_service (ip_range, host, service, port),
    KEY idx_ip_address (ip_address),
    KEY idx_host (host),
    KEY idx_service_port (service, port),
    KEY idx_scanned_at (scanned_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;