const net = require('net');
const { URL } = require('url');
const express = require('express')
const app = express()
const path = require('path');
const bodyParser = require('body-parser')
const { exec, execFile } = require('child_process');
const mysql = require('mysql2/promise');
const { syncDatabaseSchema } = require('./schema/migrate');

require('dotenv').config();

const db = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'watcher',

    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});
const MAX_SEARCH_TITLE_LENGTH = 512;
const NEGATIVE_SCAN_CACHE_TTL_DAYS = 7;
const HIDDEN_BY_DEFAULT_CATEGORIES = new Set([
    'default', 'default page',
    'cctv', 'cctv page',
    'router', 'router page', 'login page',
    'error', 'error page'
]);

let scanQueueWorkerRunning = false;
let activeScanRange = null;
const pendingScanRanges = new Map();
let scanTaskChain = Promise.resolve();
let scanSummaryCache = null;
let scanSummaryRefreshPromise = null;

function markScanPending(ip_range) {
    pendingScanRanges.set(ip_range, (pendingScanRanges.get(ip_range) || 0) + 1);
}

function unmarkScanPending(ip_range) {
    const count = pendingScanRanges.get(ip_range) || 0;
    if (count <= 1) pendingScanRanges.delete(ip_range);
    else pendingScanRanges.set(ip_range, count - 1);
}


app.set('views', path.join(__dirname, 'views'))
app.set('view engine', 'ejs')
app.use(bodyParser.urlencoded({ extended: true }))
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.enable('trust proxy'); 

// Serve HTTP scan results through this HTTPS origin so browsers can display them in an iframe.
// Only hosts already present in the scanner's cache can be proxied.
app.get('/preview', async (req, res) => {
    try {
        const target = new URL(req.query.url);
        if (target.protocol !== 'http:' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(target.hostname) || (target.port && target.port !== '80')) {
            return res.status(400).send('Only scanned HTTP hosts can be previewed.');
        }

        const [[scannedHost]] = await db.execute(`
            SELECT 1 AS found
            FROM scan_search_index
            WHERE ip_address = ? AND service = 'web'
            LIMIT 1
        `, [target.hostname]);
        const isScannedHost = Boolean(scannedHost);
        if (!isScannedHost) return res.status(403).send('Host has not been found by a scan.');

        const upstream = await fetch(target, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
        if (upstream.status >= 300 && upstream.status < 400) {
            const location = upstream.headers.get('location');
            if (location) {
                const redirectUrl = new URL(location, target);
                if (redirectUrl.hostname === target.hostname && redirectUrl.protocol === 'http:') {
                    return res.redirect(302, `/preview?url=${encodeURIComponent(redirectUrl.href)}`);
                }
            }
        }

        const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
        const body = Buffer.from(await upstream.arrayBuffer());
        if (body.length > 5 * 1024 * 1024) return res.status(413).send('Preview content is too large.');

        let output = body;
        if (contentType.includes('text/html') || contentType.includes('text/css')) {
            const rewrite = value => {
                try {
                    const absolute = new URL(value, target);
                    if (absolute.hostname !== target.hostname || absolute.protocol !== 'http:') return value;
                    return `/preview?url=${encodeURIComponent(absolute.href)}`;
                } catch { return value; }
            };
            let text = body.toString('utf8');
            if (contentType.includes('text/html')) {
                text = text.replace(/\b(href|src|action|poster)=(['"])(.*?)\2/gi, (match, attr, quote, value) => {
                    if (/^(#|data:|javascript:|mailto:|tel:)/i.test(value)) return match;
                    return `${attr}=${quote}${rewrite(value)}${quote}`;
                });
            } else {
                text = text.replace(/url\((['"]?)(.*?)\1\)/gi, (match, quote, value) => `url(${quote}${rewrite(value)}${quote})`);
            }
            output = Buffer.from(text);
        }

        res.status(upstream.status).type(contentType).send(output);
    } catch (error) {
        console.error('Preview proxy error:', error);
        res.status(502).send('Could not load this host preview.');
    }
});

function scanPort(host, port) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        socket.setTimeout(1000); // 1 second timeout

        socket.on('connect', () => {
            socket.destroy();
            resolve(true);
        });

        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });

        socket.on('error', () => {
            socket.destroy();
            resolve(false);
        });
    });
}


async function findWebServer(ip) {
    const host = ip;
    const port = 80;

    const isOpen = await scanPort(host, port);

    if (isOpen) {
        const title = await getWebServerTitle(host);
        if(title) {
            return { host: `http://${host}`, title: title }
        } else {
            return 0;
        }
    }
}

async function getWebServerTitle(ip) {
    return new Promise((resolve) => {
        exec(
            `curl -Ls http://${ip}`,
            { timeout: 5000 },
            (error, stdout) => {
                if (error) {
                    return exec(
                        `curl -Ls https://${ip}`,
                        { timeout: 5000 },
                        (error, stdout) => {
                            if (error) {
                                return resolve(null);
                            }

                            const match = stdout.match(/<title[^>]*>([^<]*)<\/title>/i);
                            resolve(match ? match[1].trim() : null);
                        }
                    );
                }

                const match = stdout.match(/<title[^>]*>([^<]*)<\/title>/i);
                resolve(match ? match[1].trim() : null);
            }
        );
    });
}


async function findSSH(ip) {
    const host = ip;
    const port = 22;

    const isOpen = await scanPort(host, port);

    if (isOpen) {
        return `${host}`
    }
}

async function findFTP(ip) {
    const host = ip;
    const port = 21;

    const isOpen = await scanPort(host, port);

    if (isOpen) {
        return `${host}`
    }
}

async function findRTSP(ip) {
    const host = ip;
    const port = 554;

    const isOpen = await scanPort(host, port);

    if (isOpen) {
        return `${host}`
    }
}

async function scanWebServer(ip_range) {
    const open_ip_promises = [];

    for (let i = 0; i <= 255; i++) {
        const ip = `${ip_range}.${i}`;
        const web_server = findWebServer(ip);
        open_ip_promises.push(web_server);
    }

    const results = await Promise.all(open_ip_promises);
    const open_ip = results.filter(Boolean);
    return open_ip;
}

async function scanSSH(ip_range) {
    const open_ip_promises = [];

    for (let i = 0; i <= 255; i++) {
        const ip = `${ip_range}.${i}`;
        open_ip_promises.push(findSSH(ip));
    }

    const results = await Promise.all(open_ip_promises);
    const open_ip = results.filter(Boolean);
    return open_ip;
}

async function scanFTP(ip_range) {
    const open_ip_promises = [];

    for (let i = 0; i <= 255; i++) {
        const ip = `${ip_range}.${i}`;
        open_ip_promises.push(findFTP(ip));
    }

    const results = await Promise.all(open_ip_promises);
    const open_ip = results.filter(Boolean);
    return open_ip;
}

async function scanRTSP(ip_range) {
    const open_ip_promises = [];

    for (let i = 0; i <= 255; i++) {
        const ip = `${ip_range}.${i}`;
        open_ip_promises.push(findRTSP(ip));
    }

    const results = await Promise.all(open_ip_promises);
    const open_ip = results.filter(Boolean);
    return open_ip;
}

function withExclusiveScan(ip_range, task) {
    markScanPending(ip_range);
    const result = scanTaskChain.then(async () => {
        unmarkScanPending(ip_range);
        activeScanRange = ip_range;
        try {
            return await task();
        } finally {
            activeScanRange = null;
        }
    });
    scanTaskChain = result.catch(() => {});
    return result;
}

async function performScan(ip_range) {
    const open_ip = await scanWebServer(ip_range);
    const open_ssh = await scanSSH(ip_range);
    const open_ftp = await scanFTP(ip_range);
    const open_rtsp = await scanRTSP(ip_range);

    await saveScanCache(ip_range, open_ip, open_ssh, open_ftp, open_rtsp);
    return { open_ip, open_ssh, open_ftp, open_rtsp };
}

function isReusableScanCache(cached) {
    if (!cached) return false;
    const hasFindings = ['open_ip', 'open_ssh', 'open_ftp', 'open_rtsp'].some(service =>
        Array.isArray(cached[service]) && cached[service].length > 0
    );
    return hasFindings || Boolean(cached.negative_cache_valid);
}

async function getScanTitleKeywords() {
    const [rows] = await db.execute(`
        SELECT keyword, category, match_priority
        FROM scan_title_keywords
        WHERE TRIM(keyword) <> '' AND TRIM(category) <> ''
        ORDER BY match_priority, keyword
    `);
    return rows;
}

function classifyWebTitle(title, keywordRows) {
    const normalizedTitle = String(title || '').toLowerCase();
    for (const row of keywordRows) {
        const keyword = String(row.keyword || '').toLowerCase();
        if (keyword && normalizedTitle.includes(keyword)) return row.category;
    }
    return normalizedTitle.trim() ? 'Other Web Page' : 'No Title';
}

function isHiddenByDefaultCategory(category) {
    return HIDDEN_BY_DEFAULT_CATEGORIES.has(String(category || '').trim().toLowerCase());
}

function parseSubnetPrefix(value) {
    if (typeof value !== 'string') return null;
    const octets = value.split('.');
    if (octets.length !== 3 || !octets.every(octet => /^\d{1,3}$/.test(octet))) return null;
    const numbers = octets.map(Number);
    if (numbers.some(octet => octet < 0 || octet > 255)) return null;
    return { basePrefix: `${numbers[0]}.${numbers[1]}`, thirdOctet: numbers[2] };
}

async function getScanQueueStatus() {
    const [rows] = await db.execute(`
        SELECT id, base_prefix, start_range, end_range, current_range, status,
               total_ranges, completed_ranges, error_message, created_at,
               started_at, finished_at
        FROM scan_queue_jobs
        ORDER BY
            CASE WHEN status IN ('running', 'queued') THEN 0 ELSE 1 END,
            CASE WHEN status IN ('running', 'queued') THEN id END ASC,
            id DESC
        LIMIT 25
    `);
    return {
        activeScanRange,
        pendingScanRange: pendingScanRanges.keys().next().value || null,
        jobs: rows.map(row => {
            const totalRanges = Number(row.total_ranges);
            let completedRanges = Math.max(0, Math.min(totalRanges, Number(row.completed_ranges)));
            const current = parseSubnetPrefix(row.current_range);
            if (row.status === 'running' && current && current.basePrefix === row.base_prefix) {
                const rangesBeforeCurrent = Math.max(0, current.thirdOctet - Number(row.start_range.split('.')[2]));
                completedRanges = Math.min(totalRanges, rangesBeforeCurrent);
            }
            return { ...row, total_ranges: totalRanges, completed_ranges: completedRanges };
        })
    };
}

async function recoverInterruptedScanJobs() {
    const [jobs] = await db.execute(`
        SELECT id, base_prefix, start_range, total_ranges, completed_ranges, current_range
        FROM scan_queue_jobs
        WHERE status = 'running'
    `);

    for (const job of jobs) {
        const totalRanges = Number(job.total_ranges);
        let completedRanges = Math.max(0, Math.min(totalRanges, Number(job.completed_ranges)));
        const current = parseSubnetPrefix(job.current_range);
        if (current && current.basePrefix === job.base_prefix) {
            completedRanges = Math.max(0, current.thirdOctet - Number(job.start_range.split('.')[2]));
        }

        await db.execute(`
            UPDATE scan_queue_jobs
            SET status = 'queued', completed_ranges = ?, current_range = NULL, error_message = NULL
            WHERE id = ? AND status = 'running'
        `, [Math.min(totalRanges, completedRanges), job.id]);
    }
}

async function runScanQueueWorker() {
    if (scanQueueWorkerRunning) return;
    scanQueueWorkerRunning = true;
    let lockConnection;
    let workerLockAcquired = false;

    try {
        lockConnection = await db.getConnection();
        const [[lock]] = await lockConnection.query("SELECT GET_LOCK('watcher_scan_queue_worker', 0) AS acquired");
        workerLockAcquired = Number(lock.acquired) === 1;
        if (!workerLockAcquired) return;

        await recoverInterruptedScanJobs();

        while (true) {
            const [jobs] = await db.execute(`
                SELECT id, base_prefix, start_octet, end_octet, completed_ranges
                FROM scan_queue_jobs
                WHERE status = 'queued'
                ORDER BY id ASC
                LIMIT 1
            `);
            if (jobs.length === 0) break;

            const job = jobs[0];
            const [claim] = await db.execute(`
                UPDATE scan_queue_jobs
                SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), error_message = NULL
                WHERE id = ? AND status = 'queued'
            `, [job.id]);
            if (claim.affectedRows !== 1) continue;

            let failed = false;
            for (let octet = Number(job.start_octet) + Number(job.completed_ranges); octet <= Number(job.end_octet); octet++) {
                const ip_range = `${job.base_prefix}.${octet}`;
                try {
                    await db.execute(
                        'UPDATE scan_queue_jobs SET current_range = ? WHERE id = ? AND status = \'running\'',
                        [ip_range, job.id]
                    );
                    const result = await withExclusiveScan(ip_range, async () => {
                        const cached = await getScanCache(ip_range);
                        if (isReusableScanCache(cached)) return { skipped: true };
                        await performScan(ip_range);
                        return { skipped: false };
                    });
                    if (result.skipped) console.log(`[QUEUE CACHE] ${ip_range} reused cached results`);
                    await db.execute(`
                        UPDATE scan_queue_jobs
                        SET completed_ranges = LEAST(completed_ranges + 1, total_ranges),
                            current_range = NULL
                        WHERE id = ? AND status = 'running'
                    `, [job.id]);
                } catch (error) {
                    failed = true;
                    console.error(`Queued scan failed for ${ip_range}:`, error);
                    await db.execute(`
                        UPDATE scan_queue_jobs
                        SET status = 'failed', current_range = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `, [ip_range, String(error.message || error).slice(0, 4000), job.id]);
                    break;
                }
            }

            if (!failed) {
                await db.execute(`
                    UPDATE scan_queue_jobs
                    SET status = 'completed', current_range = NULL, finished_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND status = 'running'
                `, [job.id]);
            }
        }
    } catch (error) {
        console.error('Scan queue worker error:', error);
    } finally {
        if (lockConnection) {
            if (workerLockAcquired) {
                try { await lockConnection.query("SELECT RELEASE_LOCK('watcher_scan_queue_worker')"); } catch (error) {
                    console.error('Could not release scan queue worker lock:', error);
                }
            }
            lockConnection.release();
        }
        scanQueueWorkerRunning = false;
        if (!workerLockAcquired) {
            setTimeout(() => runScanQueueWorker(), 5000);
            return;
        }
        try {
            const [pendingJobs] = await db.execute("SELECT id FROM scan_queue_jobs WHERE status = 'queued' LIMIT 1");
            if (pendingJobs.length > 0) setImmediate(() => runScanQueueWorker());
        } catch (error) {
            console.error('Could not resume pending scan queue jobs:', error);
        }
    }
}

function isValidRangePrefix(ip_range) {
    if (typeof ip_range !== 'string') return false;
    const octets = ip_range.split('.');
    return octets.length === 3 && octets.every(octet =>
        /^\d{1,3}$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255
    );
}

function getClientIPv4(req) {
    const address = typeof req.ip === 'string' ? req.ip.replace(/^::ffff:/i, '') : '';
    return net.isIPv4(address) ? address : '127.0.0.1';
}

async function getScanCache(ip_range) {
    const [rows] = await db.execute(
        `
        SELECT
            ip_range,
            open_ip,
            open_ssh,
            open_ftp,
            open_rtsp,
            scanned_at,
            scanned_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${NEGATIVE_SCAN_CACHE_TTL_DAYS} DAY) AS negative_cache_valid
        FROM scan_cache
        WHERE ip_range = ?
        LIMIT 1
        `,
        [ip_range]
    );

    if (rows.length === 0) {
        return null;
    }

    const row = rows[0];

    return {
        ip_range: row.ip_range,
        open_ip: typeof row.open_ip === 'string'
            ? JSON.parse(row.open_ip)
            : row.open_ip,

        open_ssh: typeof row.open_ssh === 'string'
            ? JSON.parse(row.open_ssh)
            : row.open_ssh,

        open_ftp: typeof row.open_ftp === 'string'
            ? JSON.parse(row.open_ftp)
            : row.open_ftp,

        open_rtsp: typeof row.open_rtsp === 'string'
            ? JSON.parse(row.open_rtsp)
            : row.open_rtsp,

        scanned_at: row.scanned_at,
        negative_cache_valid: Boolean(row.negative_cache_valid)
    };
}

async function saveScanCache(
    ip_range,
    open_ip,
    open_ssh,
    open_ftp,
    open_rtsp
) {
    if (!ip_range || !open_ip || !open_ssh || !open_ftp || !open_rtsp) {
        return;
    }

    const observations = [];

    open_ip.forEach(result => {
        if (!result || typeof result.host !== 'string') return;
        let ip_address = result.host;
        try {
            ip_address = new URL(result.host).hostname;
        } catch { }
        const title = typeof result.title === 'string'
            ? [...result.title].slice(0, MAX_SEARCH_TITLE_LENGTH).join('')
            : null;
        observations.push([
            ip_range,
            result.host,
            ip_address,
            'web',
            80,
            title || null
        ]);
    });

    [
        ['ssh', 22, open_ssh],
        ['ftp', 21, open_ftp],
        ['rtsp', 554, open_rtsp]
    ].forEach(([service, port, hosts]) => {
        hosts.forEach(host => {
            if (typeof host !== 'string' || !host) return;
            observations.push([ip_range, host, host, service, port, null]);
        });
    });

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        await connection.execute(
            `
        INSERT INTO scan_cache
        (
            ip_range,
            open_ip,
            open_ssh,
            open_ftp,
            open_rtsp
        )
        VALUES (?, ?, ?, ?, ?)

        ON DUPLICATE KEY UPDATE
            open_ip = VALUES(open_ip),
            open_ssh = VALUES(open_ssh),
            open_ftp = VALUES(open_ftp),
            open_rtsp = VALUES(open_rtsp),
            scanned_at = CURRENT_TIMESTAMP
        `,
            [
                ip_range,
                open_ip.length > 0 ? JSON.stringify(open_ip) : null,
                open_ssh.length > 0 ? JSON.stringify(open_ssh) : null,
                open_ftp.length > 0 ? JSON.stringify(open_ftp) : null,
                open_rtsp.length > 0 ? JSON.stringify(open_rtsp) : null
            ]
        );

        await connection.execute(
            'DELETE FROM scan_search_index WHERE ip_range = ?',
            [ip_range]
        );

        if (observations.length > 0) {
            const rowPlaceholders = observations.map(() => '(?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').join(', ');
            const values = observations.flat();
            await connection.execute(
                `
                INSERT INTO scan_search_index
                    (ip_range, host, ip_address, service, port, title, scanned_at)
                VALUES ${rowPlaceholders}
                `,
                values
            );
        }

        await connection.commit();
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }
}

async function renderSearchPage(req, res) {
    const services = ['web', 'ssh', 'ftp', 'rtsp'];
    const selectedService = services.includes(req.query.service) ? req.query.service : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
    const pageSize = 50;
    let page = Number.parseInt(req.query.page, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;

    try {
        const conditions = [];
        const params = [];
        if (q) {
            conditions.push('(host LIKE ? OR ip_address LIKE ? OR title LIKE ? OR ip_range LIKE ?)');
            const pattern = `%${q}%`;
            params.push(pattern, pattern, pattern, pattern);
        }
        if (selectedService) {
            conditions.push('service = ?');
            params.push(selectedService);
        }
        let results = [];
        let total = 0;
        if (conditions.length > 0) {
            const where = `WHERE ${conditions.join(' AND ')}`;
            const [[countRow]] = await db.execute(
                `SELECT COUNT(*) AS total FROM scan_search_index ${where}`,
                params
            );
            total = Number(countRow.total);
            const totalPages = Math.max(1, Math.ceil(total / pageSize));
            page = Math.min(page, totalPages);

            const [rows] = await db.execute(
                `
                SELECT ip_range, host, ip_address, service, port, title, scanned_at
                FROM scan_search_index
                ${where}
                ORDER BY scanned_at DESC, ip_range, host
                LIMIT ? OFFSET ?
                `,
                [...params, pageSize, (page - 1) * pageSize]
            );
            results = rows;
        }

        const viewData = {
            q,
            services,
            selectedService,
            results,
            total,
            page,
            pageSize,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            hasSearch: conditions.length > 0
        };
        if (req.get('X-Requested-With') === 'XMLHttpRequest') {
            return res.render('components/search-results.ejs', viewData);
        }
        res.render('search.ejs', viewData);
    } catch (err) {
        console.error('Search page error:', err);
        res.status(500).send('Could not load search results.');
    }
}

async function buildScanSummary() {
        const [[stats]] = await db.execute(`
            SELECT
                COUNT(DISTINCT COALESCE(ip_address, host)) AS total_ips,
                COUNT(DISTINCT ip_range) AS ranges_with_findings,
                COUNT(DISTINCT CASE WHEN service = 'web' THEN COALESCE(ip_address, host) END) AS web_ips,
                COUNT(DISTINCT CASE WHEN service = 'ssh' THEN COALESCE(ip_address, host) END) AS ssh_ips,
                COUNT(DISTINCT CASE WHEN service = 'ftp' THEN COALESCE(ip_address, host) END) AS ftp_ips,
                COUNT(DISTINCT CASE WHEN service = 'rtsp' THEN COALESCE(ip_address, host) END) AS rtsp_ips
            FROM scan_search_index
        `);
        const keywordRows = await getScanTitleKeywords();

        const categoryPriorities = new Map();
        keywordRows.forEach(row => {
            if (!categoryPriorities.has(row.category)) {
                categoryPriorities.set(row.category, Number(row.match_priority));
            }
        });

        const keywordCases = keywordRows.map(() =>
            "WHEN LOCATE(?, LOWER(COALESCE(title, ''))) > 0 THEN ?"
        ).join('\n');
        const noTitleRank = keywordRows.length;
        const otherTitleRank = noTitleRank + 1;
        const classificationCase = `CASE ${keywordCases}
            WHEN title IS NULL OR TRIM(title) = '' THEN ${noTitleRank}
            ELSE ${otherTitleRank}
        END`;
        const keywordParams = keywordRows.flatMap((row, rank) => [
            String(row.keyword).toLowerCase(), rank
        ]);
        const [categoryCountRows] = await db.execute(`
            SELECT classified.category_rank, COUNT(*) AS ip_count
            FROM (
                SELECT
                    COALESCE(ip_address, host) AS ip_address,
                    MIN(${classificationCase}) AS category_rank
                FROM scan_search_index
                WHERE service = 'web'
                GROUP BY COALESCE(ip_address, host)
            ) AS classified
            GROUP BY classified.category_rank
        `, keywordParams);

        const categoryByRank = new Map(keywordRows.map((row, rank) => [rank, row.category]));
        categoryByRank.set(noTitleRank, 'No Title');
        categoryByRank.set(otherTitleRank, 'Other Web Page');
        const countsByCategory = new Map();
        categoryCountRows.forEach(row => {
            const category = categoryByRank.get(Number(row.category_rank));
            if (category) countsByCategory.set(category, (countsByCategory.get(category) || 0) + Number(row.ip_count));
        });
        const categoryRows = [...categoryPriorities.entries()].map(([category, priority]) => ({
            category,
            priority,
            ipCount: countsByCategory.get(category) || 0
        }));
        [
            { category: 'Other Web Page', priority: otherTitleRank },
            { category: 'No Title', priority: noTitleRank }
        ].forEach(({ category, priority }) => {
            const ipCount = countsByCategory.get(category) || 0;
            if (ipCount > 0) categoryRows.push({ category, priority, ipCount });
        });

        categoryRows.sort((left, right) =>
            right.ipCount - left.ipCount || left.priority - right.priority || left.category.localeCompare(right.category)
        );

        return {
            stats: Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Number(value)])),
            categoryRows,
            keywordRows,
            summarizedAt: new Date()
        };
}

async function persistScanSummary(summary) {
    await db.execute(`
        INSERT IGNORE INTO scan_summary_refresh (id, refreshed_at)
        VALUES (1, NULL)
    `);
    await db.execute(`
        UPDATE scan_summary_refresh
        SET summary_json = ?, summarized_at = ?
        WHERE id = 1
    `, [JSON.stringify(summary), summary.summarizedAt]);
}

async function buildAndPersistScanSummary() {
    const summary = await buildScanSummary();
    await persistScanSummary(summary);
    scanSummaryCache = summary;
    return summary;
}

async function getScanSummary() {
    if (scanSummaryCache) return scanSummaryCache;
    if (scanSummaryRefreshPromise) return scanSummaryRefreshPromise;

    const summaryPromise = (async () => {
        const [[row]] = await db.execute(`
            SELECT summary_json, summarized_at
            FROM scan_summary_refresh
            WHERE id = 1
        `);
        if (row && row.summary_json) {
            try {
                const summary = typeof row.summary_json === 'string'
                    ? JSON.parse(row.summary_json)
                    : row.summary_json;
                if (summary && summary.stats && Array.isArray(summary.categoryRows)) {
                    summary.summarizedAt = row.summarized_at
                        ? new Date(row.summarized_at)
                        : new Date(summary.summarizedAt);
                    scanSummaryCache = summary;
                    return summary;
                }
            } catch (error) {
                console.error('Could not read the saved scan summary; rebuilding it:', error);
            }
        }
        return buildAndPersistScanSummary();
    })();
    scanSummaryRefreshPromise = summaryPromise;
    try {
        return await summaryPromise;
    } finally {
        if (scanSummaryRefreshPromise === summaryPromise) scanSummaryRefreshPromise = null;
    }
}

async function getScanSummaryRefreshAvailableAt() {
    await db.execute(`
        INSERT IGNORE INTO scan_summary_refresh (id, refreshed_at)
        VALUES (1, NULL)
    `);
    const [[row]] = await db.execute(`
        SELECT
            UNIX_TIMESTAMP(DATE_ADD(refreshed_at, INTERVAL 1 DAY)) * 1000 AS available_at_ms,
            DATE_ADD(refreshed_at, INTERVAL 1 DAY) > CURRENT_TIMESTAMP AS is_locked
        FROM scan_summary_refresh
        WHERE id = 1
    `);
    if (row.available_at_ms === null || row.available_at_ms === undefined) return null;
    const availableAt = new Date(Number(row.available_at_ms));
    return Boolean(row.is_locked) ? availableAt : null;
}

async function renderScanSummary(req, res) {
    try {
        const [summary, refreshAvailableAt] = await Promise.all([
            getScanSummary(),
            getScanSummaryRefreshAvailableAt()
        ]);
        res.render('summary.ejs', { ...summary, refreshAvailableAt });
    } catch (error) {
        console.error('Scan summary page error:', error);
        res.status(500).send('Could not load the scan summary.');
    }
}

app.get('/', renderSearchPage);
app.get('/search', renderSearchPage);

app.get('/summary', renderScanSummary);

app.post('/summary/refresh', async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();
        await connection.execute(`
            INSERT IGNORE INTO scan_summary_refresh (id, refreshed_at)
            VALUES (1, NULL)
        `);
        const [[row]] = await connection.execute(`
            SELECT
                UNIX_TIMESTAMP(DATE_ADD(refreshed_at, INTERVAL 1 DAY)) * 1000 AS available_at_ms,
                DATE_ADD(refreshed_at, INTERVAL 1 DAY) > CURRENT_TIMESTAMP AS is_locked
            FROM scan_summary_refresh
            WHERE id = 1
            FOR UPDATE
        `);
        if (row.is_locked) {
            await connection.rollback();
            return res.redirect(303, '/summary');
        }
        const summary = await buildScanSummary();
        await connection.execute(`
            UPDATE scan_summary_refresh
            SET refreshed_at = CURRENT_TIMESTAMP,
                summary_json = ?,
                summarized_at = ?
            WHERE id = 1
        `, [JSON.stringify(summary), summary.summarizedAt]);
        await connection.commit();
        scanSummaryCache = summary;
        res.redirect(303, '/summary');
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        console.error('Could not refresh the scan summary:', error);
        res.status(500).send('Could not refresh the scan summary.');
    } finally {
        if (connection) connection.release();
    }
});

app.get('/take-a-walk', (req, res) => {
    const parts = getClientIPv4(req).split('.');
    res.render('home.ejs', {
        query: `${parts[0]}.${parts[1]}.${parts[2]}`
    });
});

app.get('/scan-queue', (req, res) => {
    res.render('scan-queue.ejs');
});

app.get('/api/scan-queue', async (req, res) => {
    try {
        res.json(await getScanQueueStatus());
    } catch (error) {
        console.error('Could not load scan queue:', error);
        res.status(500).json({ error: 'Could not load the scan queue.' });
    }
});

app.post('/api/scan-queue', async (req, res) => {
    const start = parseSubnetPrefix(req.body?.start_range);
    const end = parseSubnetPrefix(req.body?.end_range);
    if (!start || !end) {
        return res.status(400).json({ error: 'Enter valid subnet prefixes, for example 192.168.0.' });
    }
    if (start.basePrefix !== end.basePrefix) {
        return res.status(400).json({ error: 'Start and end must share the same first two octets.' });
    }
    if (end.thirdOctet < start.thirdOctet) {
        return res.status(400).json({ error: 'The end subnet must be the same as or after the start subnet.' });
    }

    let connection;
    let lockAcquired = false;
    try {
        connection = await db.getConnection();
        const [[lock]] = await connection.query("SELECT GET_LOCK('watcher_scan_queue_enqueue', 5) AS acquired");
        lockAcquired = Number(lock.acquired) === 1;
        if (!lockAcquired) {
            return res.status(503).json({ error: 'The scan queue is busy. Please try again shortly.' });
        }

        const startRange = `${start.basePrefix}.${start.thirdOctet}`;
        const endRange = `${end.basePrefix}.${end.thirdOctet}`;
        const totalRanges = end.thirdOctet - start.thirdOctet + 1;
        const [insert] = await connection.execute(`
            INSERT INTO scan_queue_jobs
                (base_prefix, start_octet, end_octet, start_range, end_range, total_ranges)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [start.basePrefix, start.thirdOctet, end.thirdOctet, startRange, endRange, totalRanges]);

        res.status(202).json({ id: insert.insertId, message: 'Scan range added.' });
        setImmediate(() => runScanQueueWorker());
    } catch (error) {
        console.error('Could not add scan range:', error);
        if (!res.headersSent) res.status(500).json({ error: 'Could not add the scan range.' });
    } finally {
        if (connection) {
            if (lockAcquired) {
                try { await connection.query("SELECT RELEASE_LOCK('watcher_scan_queue_enqueue')"); } catch (error) {
                    console.error('Could not release scan queue lock:', error);
                }
            }
            connection.release();
        }
    }
});

app.get(/^\/(\d{1,3}\.\d{1,3}\.\d{1,3})$/, (req, res) => {
    const ip_range = req.params[0];
    if (isValidRangePrefix(ip_range)) {
        res.render('home.ejs', {
            query: ip_range
        })
    } else {
        res.status(403).render('error.ejs');
    }
});

app.get('/run/:range', async (req, res) => {
    const ip_range = req.params.range;

    if (!isValidRangePrefix(ip_range)) {
        return res.status(403).render('error.ejs');
    }

    try {
        const payload = await withExclusiveScan(ip_range, async () => {
            const cached = await getScanCache(ip_range);
            if (isReusableScanCache(cached)) {
                console.log(`[CACHE] ${ip_range}`);
                return {
                    data: {
                        open_ip: cached.open_ip,
                        open_ssh: cached.open_ssh,
                        open_ftp: cached.open_ftp,
                        open_rtsp: cached.open_rtsp,
                        cached: true,
                        scanned_at: cached.scanned_at
                    }
                };
            }

            console.log(`[SCAN] ${ip_range}`);
            const results = await performScan(ip_range);
            return { data: { ...results, cached: false, scanned_at: new Date() } };
        });

        const titleKeywords = await getScanTitleKeywords();
        payload.data.open_ip = (payload.data.open_ip || []).map(host => {
            const type = classifyWebTitle(host.title, titleKeywords);
            return { ...host, type, hidden_by_default: isHiddenByDefaultCategory(type) };
        });

        const html = await new Promise((resolve, reject) => {
            res.render('components/result.ejs', { ...payload.data }, (error, output) => {
                if (error) reject(error);
                else resolve(output);
            });
        });
        res.json({ html, data: payload.data });

    } catch (err) {
        console.error(err);
        res.status(500).json({
            error: err.message
        });
    }
});

function runNmap(ip, args) {
    return withExclusiveScan(ip, () => new Promise((resolve, reject) => {
        execFile('nmap', [...args, ip], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) return reject(new Error(stderr || error.message));
            resolve(stdout);
        });
    }));
}

async function handleNmapRequest(req, res, args) {
    const ip = req.params.ip;
    if (net.isIP(ip) !== 4) {
        return res.status(400).json({ error: 'A valid IPv4 address is required.' });
    }
    try {
        res.json({ stdout: await runNmap(ip, args) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

app.get('/rtsp/:ip', (req, res) => handleNmapRequest(req, res, ['--script', 'rtsp-url-brute', '-p', '554']));
app.get('/ftp/:ip', (req, res) => handleNmapRequest(req, res, ['--script', 'ftp-brute', '-p', '21']));
app.get('/nmap/:ip', (req, res) => handleNmapRequest(req, res, ['-sV', '-sC']));

app.get('/whois/:ip', (req, res) => {
    const ip = req.params.ip;

    if (!net.isIP(ip)) {
        return res.status(400).json({ error: 'A valid IP address is required.' });
    }

    execFile('whois', [ip], { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
            return res.status(500).json({ error: stderr || err.message });
        }
        res.json({ stdout });
    });
});

async function startServer() {
    try {
        await syncDatabaseSchema(db, path.join(__dirname, 'schema/database.sql'));
    } catch (error) {
        console.error('Could not migrate the database:', error);
        await db.end();
        process.exitCode = 1;
        return;
    }

    app.listen(4004, () => {
        console.log('[+] The Watcher is listening on port http://localhost:4004');
        runScanQueueWorker();
    });
}

startServer();
