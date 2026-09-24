CREATE TABLE IF NOT EXISTS scan_cache (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

    ip_range VARCHAR(15) NOT NULL,

    open_ip JSON NOT NULL,
    open_ssh JSON NOT NULL,
    open_ftp JSON NOT NULL,
    open_rtsp JSON NOT NULL,

    scanned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uk_ip_range (ip_range),

    INDEX idx_scanned_at (scanned_at)
);