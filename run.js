const net = require('net');
const { URL } = require('url');
const express = require('express')
const app = express()
const path = require('path');
const bodyParser = require('body-parser')
const { execFile } = require('child_process');
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


async function findWebServer(ip, port = 80, defaultProto = 'http') {
    const host = ip;
    const isOpen = await scanPort(host, port);

    if (isOpen) {
        const page = await getWebServerTitle(host, port, defaultProto);
        const actualProto = (page && page.protocol) ? page.protocol : defaultProto;
        const isStandard = (port === 80 && actualProto === 'http') || (port === 443 && actualProto === 'https');
        const hostUrl = `${actualProto}://${host}${isStandard ? '' : ':' + port}`;
        return {
            host: hostUrl,
            title: page && page.title ? page.title : null,
            page_size: page ? page.page_size : null,
            port
        };
    }
    return 0;
}

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_REDIRECT_HOPS = 4;

function decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return str;
    return str
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#039;|&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&#(\d+);/g, (_, dec) => {
            const num = parseInt(dec, 10);
            return Number.isSafeInteger(num) ? String.fromCharCode(num) : '';
        })
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
            const num = parseInt(hex, 16);
            return Number.isSafeInteger(num) ? String.fromCharCode(num) : '';
        });
}

function isRedirectTitle(title) {
    if (!title || typeof title !== 'string') return false;
    const t = title.trim().toLowerCase();
    if (!t) return false;

    const patterns = [
        /^just a moment(?:\.\.\.|\.)?$/i,
        /^redirecting(?:\.\.\.|\.)?/i,
        /^redirect(?:ed)?(?:\.\.\.|\.)?$/i,
        /^(?:301|302|303|307|308)\s+(?:moved|found|temporary|permanent)/i,
        /^(?:document|object)\s+moved(?:\s+here)?(?:\.\.\.|\.)?$/i,
        /^moved\s+(?:permanently|temporarily)/i,
        /^found(?:\.\.\.|\.)?$/i,
        /^please\s+wait(?:\.\.\.|\.)?$/i,
        /^loading(?:\.\.\.|\.)?$/i,
        /^one\s+moment(?:,\s*please)?(?:\.\.\.|\.)?$/i,
        /^switching\s+protocols/i,
        /^attention required!\s*\|\s*cloudflare/i
    ];
    return patterns.some(pattern => pattern.test(t));
}

function extractRedirectUrl(html) {
    if (!html || typeof html !== 'string') return null;

    // 1. Meta refresh: <meta http-equiv="refresh" content="0;url=/target">
    const metaMatches = html.matchAll(/<meta\b[^>]*>/gi);
    for (const match of metaMatches) {
        const tag = match[0];
        if (/http-equiv\s*=\s*["']?refresh["']?/i.test(tag)) {
            const contentMatch = tag.match(/content\s*=\s*["']?[^"'>]*?url\s*=\s*['"]?([^"'\s;>]+)/i);
            if (contentMatch && contentMatch[1]) {
                const target = contentMatch[1].replace(/^['"]|['"]$/g, '').trim();
                if (target) return target;
            }
        }
    }

    // 2. JavaScript location redirection
    const jsPatterns = [
        /(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i,
        /(?:window\.)?location\.replace\s*\(\s*['"]([^'"]+)['"]\s*\)/i,
        /(?:window\.)?location\.assign\s*\(\s*['"]([^'"]+)['"]\s*\)/i,
        /self\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i,
        /top\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i
    ];
    for (const pattern of jsPatterns) {
        const jsMatch = html.match(pattern);
        if (jsMatch && jsMatch[1]) {
            const target = jsMatch[1].trim();
            if (target && !target.toLowerCase().startsWith('javascript:')) {
                return target;
            }
        }
    }

    // 3. Fallback links inside redirect notice pages
    const linkMatch = html.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(?:click here|here|redirect|continue|proceed|go)/i)
        || html.match(/<a\b[^>]*href=["']([^"']+)["']/i);
    if (linkMatch && linkMatch[1]) {
        const target = linkMatch[1].trim();
        if (target && !target.startsWith('#') && !target.toLowerCase().startsWith('javascript:')) {
            return target;
        }
    }

    return null;
}

function resolveSafeRedirectUrl(target, baseUrl) {
    try {
        const resolved = new URL(target, baseUrl);
        if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
            return resolved.href;
        }
    } catch { }
    return null;
}

function fetchPageOnce(targetUrl) {
    return new Promise((resolve, reject) => {
        const sizeMarker = '\n__WATCHER_PAGE_SIZE__\n';
        execFile('curl', [
            '-Ls',
            '-k',
            '-A', BROWSER_USER_AGENT,
            '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            '-H', 'Accept-Language: en-US,en;q=0.9',
            '--max-redirs', '5',
            '--max-time', '5',
            '--write-out', `${sizeMarker}%{size_download}\n%{url_effective}`,
            targetUrl
        ], { timeout: 6000, maxBuffer: 5 * 1024 * 1024 }, (error, stdout) => {
            if (error) return reject(error);
            const markerIndex = stdout.lastIndexOf(sizeMarker);
            if (markerIndex < 0) return reject(new Error('The response size was not returned.'));

            const body = stdout.slice(0, markerIndex);
            const metaInfo = stdout.slice(markerIndex + sizeMarker.length).trim().split('\n');
            const pageSizeRaw = Number(metaInfo[0] ? metaInfo[0].trim() : NaN);
            const effectiveUrl = metaInfo[1] ? metaInfo[1].trim() : targetUrl;

            const match = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            const rawTitle = match ? match[1].replace(/\s+/g, ' ').trim() : null;
            const title = rawTitle ? decodeHtmlEntities(rawTitle) : null;

            resolve({
                body,
                title,
                page_size: Number.isSafeInteger(pageSizeRaw) && pageSizeRaw >= 0 ? pageSizeRaw : null,
                effectiveUrl
            });
        });
    });
}

async function fetchPageWithRedirectResolution(initialUrl) {
    let currentUrl = initialUrl;
    const visited = new Set();
    let bestResult = null;

    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
        if (!currentUrl || visited.has(currentUrl)) break;
        visited.add(currentUrl);

        try {
            const result = await fetchPageOnce(currentUrl);
            bestResult = result;

            if (result.title && !isRedirectTitle(result.title)) {
                return {
                    title: result.title,
                    page_size: result.page_size
                };
            }

            const redirectTarget = extractRedirectUrl(result.body);
            if (!redirectTarget) {
                break;
            }

            const nextUrl = resolveSafeRedirectUrl(redirectTarget, result.effectiveUrl || currentUrl);
            if (!nextUrl || visited.has(nextUrl)) {
                break;
            }

            currentUrl = nextUrl;
        } catch {
            break;
        }
    }

    if (bestResult) {
        return {
            title: bestResult.title,
            page_size: bestResult.page_size
        };
    }
    return null;
}

async function resolveWebTitleRedirect(target) {
    if (!target) return null;
    let url = target;
    if (!/^https?:\/\//i.test(url)) {
        url = `http://${url}`;
    }
    try {
        return await fetchPageWithRedirectResolution(url);
    } catch {
        return null;
    }
}

async function getWebServerTitle(ip, port = 80, defaultProto = 'http') {
    const isStandard = (port === 80 && defaultProto === 'http') || (port === 443 && defaultProto === 'https');
    const portSuffix = isStandard ? '' : `:${port}`;
    const primaryUrl = `${defaultProto}://${ip}${portSuffix}`;
    const fallbackProto = defaultProto === 'https' ? 'http' : 'https';
    const fallbackUrl = `${fallbackProto}://${ip}${portSuffix}`;

    try {
        const page = await fetchPageWithRedirectResolution(primaryUrl);
        if (page && (page.title || page.page_size !== null)) {
            return { ...page, protocol: defaultProto };
        }
    } catch { }

    try {
        const fallbackPage = await fetchPageWithRedirectResolution(fallbackUrl);
        if (fallbackPage && (fallbackPage.title || fallbackPage.page_size !== null)) {
            return { ...fallbackPage, protocol: fallbackProto };
        }
    } catch { }

    return null;
}

async function findSSH(ip) {
    const host = ip;
    const port = 22;

    const isOpen = await scanPort(host, port);
    if (isOpen) {
        return `${host}`;
    }
}

async function findFTP(ip) {
    const host = ip;
    const port = 21;

    const isOpen = await scanPort(host, port);
    if (isOpen) {
        return `${host}`;
    }
}

async function findRTSP(ip) {
    const host = ip;
    const port = 554;

    const isOpen = await scanPort(host, port);
    if (isOpen) {
        return `${host}`;
    }
}

async function findMySQL(ip) {
    const host = ip;
    const port = 3306;

    const isOpen = await scanPort(host, port);
    if (isOpen) {
        return `${host}`;
    }
}

async function scanWebServer(ip_range) {
    const tasks = [];
    for (let i = 0; i <= 255; i++) {
        const ip = `${ip_range}.${i}`;
        tasks.push(() => findWebServer(ip, 80, 'http'));
        tasks.push(() => findWebServer(ip, 443, 'https'));
        tasks.push(() => findWebServer(ip, 8080, 'http'));
        tasks.push(() => findWebServer(ip, 8443, 'https'));
    }

    const results = [];
    const CONCURRENCY = 128;
    let index = 0;
    const workers = new Array(Math.min(CONCURRENCY, tasks.length)).fill(0).map(async () => {
        while (index < tasks.length) {
            const current = index++;
            const res = await tasks[current]();
            if (res) results.push(res);
        }
    });
    await Promise.all(workers);
    return results;
}

async function scanSSH(ip_range) {
    const open_ip_promises = [];
    for (let i = 0; i <= 255; i++) {
        const ip = `${ip_range}.${i}`;
        open_ip_promises.push(findSSH(ip));
    }
    const results = await Promise.all(open_ip_promises);
    return results.filter(Boolean);
}

async function scanFTP(ip_range) {
    const open_ip_promises = [];
    for (let i = 0; i <= 255; i++) {
        const ip = `${ip_range}.${i}`;
        open_ip_promises.push(findFTP(ip));
    }
    const results = await Promise.all(open_ip_promises);
    return results.filter(Boolean);
}

async function scanRTSP(ip_range) {
    const open_ip_promises = [];
    for (let i = 0; i <= 255; i++) {
        const ip = `${ip_range}.${i}`;
        open_ip_promises.push(findRTSP(ip));
    }
    const results = await Promise.all(open_ip_promises);
    return results.filter(Boolean);
}

async function scanMySQL(ip_range) {
    const open_ip_promises = [];
    for (let i = 0; i <= 255; i++) {
        const ip = `${ip_range}.${i}`;
        open_ip_promises.push(findMySQL(ip));
    }
    const results = await Promise.all(open_ip_promises);
    return results.filter(Boolean);
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
    const open_mysql = await scanMySQL(ip_range);

    await saveScanCache(ip_range, open_ip, open_ssh, open_ftp, open_rtsp, open_mysql);
    return { open_ip, open_ssh, open_ftp, open_rtsp, open_mysql };
}

function isReusableScanCache(cached) {
    if (!cached) return false;
    const hasFindings = ['open_ip', 'open_ssh', 'open_ftp', 'open_rtsp', 'open_mysql'].some(service =>
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

async function cleanupDuplicateQueueJobs() {
    try {
        await db.execute(`
            DELETE j1 FROM scan_queue_jobs j1
            INNER JOIN scan_queue_jobs j2 
            WHERE j1.id < j2.id 
              AND j1.start_range = j2.start_range 
              AND j1.end_range = j2.end_range
              AND j1.status = 'completed'
              AND j2.status = 'completed'
        `);
    } catch (e) {
        console.error('Error cleaning up duplicate queue jobs:', e);
    }
}

async function getScanQueueStatus() {
    await cleanupDuplicateQueueJobs();

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

    // ดึงรายการ Subnets ที่เคยสแกนไว้จริงจาก scan_cache
    const [scannedSubnetRows] = await db.execute(`
        SELECT ip_range, scanned_at,
               COALESCE(JSON_LENGTH(open_ip), 0) AS web_count,
               COALESCE(JSON_LENGTH(open_ssh), 0) AS ssh_count,
               COALESCE(JSON_LENGTH(open_ftp), 0) AS ftp_count,
               COALESCE(JSON_LENGTH(open_rtsp), 0) AS rtsp_count
        FROM scan_cache
        ORDER BY scanned_at DESC
        LIMIT 500
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
        }),
        scanned_subnets: scannedSubnetRows.map(r => ({
            ip_range: r.ip_range,
            scanned_at: new Date(r.scanned_at).toISOString(),
            web_count: Number(r.web_count) || 0,
            ssh_count: Number(r.ssh_count) || 0,
            ftp_count: Number(r.ftp_count) || 0,
            rtsp_count: Number(r.rtsp_count) || 0,
            total_findings: (Number(r.web_count) || 0) + (Number(r.ssh_count) || 0) + (Number(r.ftp_count) || 0) + (Number(r.rtsp_count) || 0)
        }))
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
                SELECT id, base_prefix, start_octet, end_octet, start_range, end_range, completed_ranges
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

            const isSingleRescan = (job.start_range === job.end_range);

            let failed = false;
            for (let octet = Number(job.start_octet) + Number(job.completed_ranges); octet <= Number(job.end_octet); octet++) {
                const ip_range = `${job.base_prefix}.${octet}`;
                try {
                    await db.execute(
                        'UPDATE scan_queue_jobs SET current_range = ? WHERE id = ? AND status = \'running\'',
                        [ip_range, job.id]
                    );
                    const result = await withExclusiveScan(ip_range, async () => {
                        // หากเป็นการสั่งสแกน Subnet เจาะจง ให้ทำการสแกนใหม่จริง (Bypass Cache)
                        if (isSingleRescan) {
                            await performScan(ip_range);
                            return { skipped: false };
                        }
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

function formatPageSize(value) {
    if (value === null || value === undefined) return '—';
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${bytes} B`;

    const units = ['KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = -1;
    do {
        size /= 1024;
        unitIndex += 1;
    } while (size >= 1024 && unitIndex < units.length - 1);
    return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
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
    open_rtsp,
    open_mysql = []
) {
    if (!ip_range || !open_ip || !open_ssh || !open_ftp || !open_rtsp) {
        return;
    }

    if (Array.isArray(open_ip)) {
        await Promise.all(
            open_ip.map(async (result) => {
                if (result && result.title && isRedirectTitle(result.title)) {
                    try {
                        const resolved = await resolveWebTitleRedirect(result.host);
                        if (resolved && resolved.title && !isRedirectTitle(resolved.title)) {
                            result.title = resolved.title;
                            if (resolved.page_size !== null && resolved.page_size !== undefined) {
                                result.page_size = resolved.page_size;
                            }
                        }
                    } catch { }
                }
            })
        );
    }

    const observations = [];

    open_ip.forEach(result => {
        if (!result || typeof result.host !== 'string') return;
        let ip_address = result.host;
        let port = Number(result.port);
        try {
            const parsedUrl = new URL(result.host);
            ip_address = parsedUrl.hostname;
            if (!Number.isInteger(port) || port <= 0) {
                if (parsedUrl.port) port = Number(parsedUrl.port);
                else if (parsedUrl.protocol === 'https:') port = 443;
                else port = 80;
            }
        } catch { }
        if (!Number.isInteger(port) || port <= 0) port = 80;

        const title = typeof result.title === 'string'
            ? [...result.title].slice(0, MAX_SEARCH_TITLE_LENGTH).join('')
            : null;
        observations.push([
            ip_range,
            result.host,
            ip_address,
            'web',
            port,
            title || null,
            result.page_size !== null && result.page_size !== undefined
                && Number.isSafeInteger(Number(result.page_size)) && Number(result.page_size) >= 0
                ? Number(result.page_size)
                : null
        ]);
    });

    [
        ['ssh', 22, open_ssh],
        ['ftp', 21, open_ftp],
        ['rtsp', 554, open_rtsp],
        ['mysql', 3306, open_mysql]
    ].forEach(([service, port, hosts]) => {
        if (Array.isArray(hosts)) {
            hosts.forEach(host => {
                if (typeof host !== 'string' || !host) return;
                observations.push([ip_range, host, host, service, port, null, null]);
            });
        }
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
            const rowPlaceholders = observations.map(() => '(?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').join(', ');
            const values = observations.flat();
            await connection.execute(
                `
                INSERT INTO scan_search_index
                    (ip_range, host, ip_address, service, port, title, page_size, scanned_at)
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

function parseAdvancedSearchQuery(rawQuery) {
    if (!rawQuery || typeof rawQuery !== 'string') {
        return { filters: {}, freeTerms: [] };
    }

    const filters = {};
    const freeTerms = [];

    const regex = /(?:(\b[a-zA-Z_-]+):(?:"([^"]+)"|([^\s]+)))|(?:"([^"]+)"|([^\s]+))/g;
    let match;

    while ((match = regex.exec(rawQuery)) !== null) {
        const key = match[1] ? match[1].toLowerCase() : null;
        const val = match[2] || match[3] || match[4] || match[5];

        if (!val) continue;

        if (key) {
            if (key === 'port') {
                const p = parseInt(val, 10);
                if (Number.isInteger(p) && p > 0 && p <= 65535) filters.port = p;
            } else if (key === 'service') {
                filters.service = val.toLowerCase();
            } else if (key === 'title') {
                filters.title = val;
            } else if (key === 'ip' || key === 'host') {
                filters.host = val;
            } else if (key === 'range' || key === 'subnet') {
                filters.ip_range = val;
            } else if (key === 'has') {
                if (val.toLowerCase() === 'title') filters.hasTitle = true;
                if (val.toLowerCase() === 'notitle') filters.hasTitle = false;
            } else {
                freeTerms.push(`${key}:${val}`);
            }
        } else {
            freeTerms.push(val);
        }
    }

    return { filters, freeTerms };
}

function buildSearchConditions(q, explicitService) {
    const conditions = [];
    const params = [];

    const { filters, freeTerms } = parseAdvancedSearchQuery(q);

    const service = filters.service || explicitService;
    if (service) {
        conditions.push('service = ?');
        params.push(service);
    }

    if (filters.port) {
        conditions.push('port = ?');
        params.push(filters.port);
    }

    if (filters.title) {
        conditions.push('title LIKE ?');
        params.push(`%${filters.title}%`);
    }

    if (filters.host) {
        conditions.push('(host LIKE ? OR ip_address LIKE ?)');
        params.push(`%${filters.host}%`, `%${filters.host}%`);
    }

    if (filters.ip_range) {
        conditions.push('ip_range LIKE ?');
        params.push(`%${filters.ip_range}%`);
    }

    if (filters.hasTitle === true) {
        conditions.push("title IS NOT NULL AND TRIM(title) <> ''");
    } else if (filters.hasTitle === false) {
        conditions.push("(title IS NULL OR TRIM(title) = '')");
    }

    for (const term of freeTerms) {
        const pattern = `%${term}%`;
        conditions.push('(host LIKE ? OR ip_address LIKE ? OR title LIKE ? OR ip_range LIKE ?)');
        params.push(pattern, pattern, pattern, pattern);
    }

    return { conditions, params, filters, freeTerms };
}

async function renderSearchPage(req, res) {
    const services = ['web', 'ssh', 'ftp', 'rtsp', 'mysql'];
    const selectedService = services.includes(req.query.service) ? req.query.service : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 300) : '';
    const pageSize = 50;
    let page = Number.parseInt(req.query.page, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;

    try {
        const { conditions, params } = buildSearchConditions(q, selectedService);
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
                SELECT ip_range, host, ip_address, service, port, title, page_size, scanned_at
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
            hasSearch: conditions.length > 0,
            formatPageSize,
            showWelcomeSplash: req.path === '/'
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

app.get('/api', (req, res) => {
    res.render('api.ejs');
});

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

app.get('/redirects', (req, res) => {
    res.render('redirects.ejs');
});

app.get('/docs', (req, res) => {
    res.render('docs.ejs');
});

app.options('/api/search', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.status(204).end();
});

app.get('/api/search', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');

    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    if (!search) return res.status(400).json({ error: 'The search parameter is required.' });
    if (search.length > 300) return res.status(400).json({ error: 'The search parameter must be 300 characters or fewer.' });

    const services = ['web', 'ssh', 'ftp', 'rtsp', 'mysql'];
    const service = typeof req.query.service === 'string' ? req.query.service.toLowerCase() : '';
    if (service && !services.includes(service)) {
        return res.status(400).json({ error: `The service parameter must be one of: ${services.join(', ')}.` });
    }

    const parseInteger = (value, fallback) => {
        if (value === undefined) return fallback;
        if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : null;
    };
    const requestedPage = parseInteger(req.query.page, 1);
    const pageSize = parseInteger(req.query.limit, 50);
    if (!requestedPage || requestedPage > 10000) {
        return res.status(400).json({ error: 'The page parameter must be between 1 and 10000.' });
    }
    if (!pageSize || pageSize > 100) {
        return res.status(400).json({ error: 'The limit parameter must be between 1 and 100.' });
    }

    try {
        const { conditions, params } = buildSearchConditions(search, service);
        if (conditions.length === 0) {
            conditions.push('1=1');
        }
        const where = `WHERE ${conditions.join(' AND ')}`;
        const [[countRow]] = await db.execute(
            `SELECT COUNT(*) AS total FROM scan_search_index ${where}`,
            params
        );
        const total = Number(countRow.total);
        const totalPages = Math.ceil(total / pageSize) || 1;
        const page = Math.min(requestedPage, totalPages);
        const [rows] = await db.execute(`
            SELECT ip_range, host, ip_address, service, port, title, page_size, scanned_at
            FROM scan_search_index
            ${where}
            ORDER BY scanned_at DESC, ip_range, host
            LIMIT ? OFFSET ?
        `, [...params, pageSize, (page - 1) * pageSize]);

        res.json({
            query: { search, service: service || null, page, limit: pageSize },
            total,
            totalPages,
            results: rows.map(row => ({
                ip_range: row.ip_range,
                host: row.host,
                ip_address: row.ip_address,
                service: row.service,
                port: Number(row.port),
                page_size: row.page_size === null ? null : Number(row.page_size),
                title: row.title,
                scanned_at: new Date(row.scanned_at).toISOString()
            }))
        });
    } catch (error) {
        console.error('Public search API error:', error);
        res.status(500).json({ error: 'Could not search the network index.' });
    }
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

        // ตรวจสอบว่ามี job เดียวกันที่ queued หรือ running อยู่แล้วหรือไม่ ป้องกันการ enqueue ซ้ำ
        const [existing] = await connection.execute(`
            SELECT id FROM scan_queue_jobs
            WHERE start_range = ? AND end_range = ? AND status IN ('queued', 'running')
            LIMIT 1
        `, [startRange, endRange]);

        if (existing.length > 0) {
            return res.status(200).json({ id: existing[0].id, message: 'This range is already queued or scanning.' });
        }

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

app.get('/api/redirects', async (req, res) => {
    try {
        const parseInteger = (value, fallback) => {
            if (value === undefined) return fallback;
            if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
            const parsed = Number(value);
            return Number.isSafeInteger(parsed) ? parsed : null;
        };
        const requestedPage = parseInteger(req.query.page, 1);
        const pageSize = parseInteger(req.query.limit, 50);
        if (!requestedPage || requestedPage > 10000) {
            return res.status(400).json({ error: 'The page parameter must be between 1 and 10000.' });
        }
        if (!pageSize || pageSize > 500) {
            return res.status(400).json({ error: 'The limit parameter must be between 1 and 500.' });
        }

        const category = typeof req.query.category === 'string' ? req.query.category.trim().toLowerCase() : 'all';
        const search = typeof req.query.q === 'string' ? req.query.q.trim() : '';

        const conditions = ["service = 'web'", "title IS NOT NULL", "TRIM(title) <> ''"];
        const params = [];

        if (category === 'just_a_moment') {
            conditions.push("(LOWER(title) LIKE '%just a moment%' OR LOWER(title) LIKE '%attention required%')");
        } else if (category === 'redirecting') {
            conditions.push("(LOWER(title) LIKE '%redirecting%' OR LOWER(title) LIKE '%redirect%')");
        } else if (category === 'moved') {
            conditions.push("(LOWER(title) LIKE '%moved%' OR LOWER(title) LIKE '%found%')");
        } else if (category === 'wait') {
            conditions.push("(LOWER(title) LIKE '%please wait%' OR LOWER(title) LIKE '%loading%')");
        } else {
            // all redirect types
            conditions.push(`(
                LOWER(title) LIKE '%just a moment%'
                OR LOWER(title) LIKE '%redirecting%'
                OR LOWER(title) LIKE '%redirect%'
                OR LOWER(title) LIKE '%301 moved%'
                OR LOWER(title) LIKE '%302 found%'
                OR LOWER(title) LIKE '%302 moved%'
                OR LOWER(title) LIKE '%307 temporary%'
                OR LOWER(title) LIKE '%308 permanent%'
                OR LOWER(title) LIKE '%document moved%'
                OR LOWER(title) LIKE '%object moved%'
                OR LOWER(title) LIKE '%moved temporarily%'
                OR LOWER(title) LIKE '%moved permanently%'
                OR LOWER(title) LIKE '%please wait%'
                OR LOWER(title) LIKE '%loading%'
                OR LOWER(title) LIKE '%one moment, please%'
                OR LOWER(title) LIKE '%attention required%'
            )`);
        }

        if (search) {
            const pattern = `%${search}%`;
            conditions.push('(host LIKE ? OR ip_address LIKE ? OR ip_range LIKE ? OR title LIKE ?)');
            params.push(pattern, pattern, pattern, pattern);
        }

        const where = `WHERE ${conditions.join(' AND ')}`;
        const [[countRow]] = await db.execute(
            `SELECT COUNT(*) AS total FROM scan_search_index ${where}`,
            params
        );
        const total = Number(countRow.total);
        const totalPages = Math.ceil(total / pageSize) || 1;
        const page = Math.min(requestedPage, totalPages);
        const offset = Math.max(0, (page - 1) * pageSize);

        const [rows] = await db.execute(`
            SELECT id, ip_range, host, ip_address, service, port, title, page_size, scanned_at
            FROM scan_search_index
            ${where}
            ORDER BY scanned_at DESC, id DESC
            LIMIT ? OFFSET ?
        `, [...params, pageSize, offset]);

        res.json({
            page,
            limit: pageSize,
            total,
            totalPages,
            items: rows.map(r => ({
                id: Number(r.id),
                ip_range: r.ip_range,
                host: r.host,
                ip_address: r.ip_address,
                title: r.title,
                page_size: r.page_size === null ? null : Number(r.page_size),
                scanned_at: new Date(r.scanned_at).toISOString()
            }))
        });
    } catch (error) {
        console.error('Could not list redirect entries:', error);
        res.status(500).json({ error: 'Could not load redirect list.' });
    }
});

app.post('/api/redirects/rescan', async (req, res) => {
    const id = req.body?.id;
    let host = typeof req.body?.host === 'string' ? req.body.host.trim() : '';
    let ipRange = typeof req.body?.ip_range === 'string' ? req.body.ip_range.trim() : '';

    if (!id && !host) {
        return res.status(400).json({ error: 'Either id or host is required.' });
    }

    try {
        let currentTitle = null;
        let rowId = id;

        if (id) {
            const [rows] = await db.execute('SELECT id, host, ip_range, title, page_size FROM scan_search_index WHERE id = ?', [id]);
            if (rows.length > 0) {
                currentTitle = rows[0].title;
                if (!host) host = rows[0].host;
                if (!ipRange) ipRange = rows[0].ip_range;
            }
        } else if (host) {
            const [rows] = await db.execute('SELECT id, host, ip_range, title, page_size FROM scan_search_index WHERE host = ? AND service = "web" LIMIT 1', [host]);
            if (rows.length > 0) {
                rowId = rows[0].id;
                currentTitle = rows[0].title;
                if (!ipRange) ipRange = rows[0].ip_range;
            }
        }

        const resolved = await resolveWebTitleRedirect(host);
        if (!resolved) {
            return res.json({
                success: false,
                id: rowId,
                host,
                error: 'Could not resolve destination title'
            });
        }

        const newTitle = resolved.title
            ? [...resolved.title].slice(0, MAX_SEARCH_TITLE_LENGTH).join('')
            : null;
        const newPageSize = resolved.page_size !== null && Number.isSafeInteger(Number(resolved.page_size))
            ? Number(resolved.page_size)
            : null;

        // 1. Update scan_search_index
        if (rowId) {
            await db.execute(`
                UPDATE scan_search_index
                SET title = ?, page_size = ?, scanned_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [newTitle, newPageSize, rowId]);
        } else {
            await db.execute(`
                UPDATE scan_search_index
                SET title = ?, page_size = ?, scanned_at = CURRENT_TIMESTAMP
                WHERE host = ? AND service = 'web'
            `, [newTitle, newPageSize, host]);
        }

        // 2. Update scan_cache (JSON open_ip)
        if (ipRange) {
            try {
                const [cacheRows] = await db.execute('SELECT open_ip FROM scan_cache WHERE ip_range = ?', [ipRange]);
                if (cacheRows.length > 0 && cacheRows[0].open_ip) {
                    let openIp = typeof cacheRows[0].open_ip === 'string'
                        ? JSON.parse(cacheRows[0].open_ip)
                        : cacheRows[0].open_ip;
                    if (Array.isArray(openIp)) {
                        let cacheChanged = false;
                        openIp = openIp.map(item => {
                            if (item && item.host === host) {
                                cacheChanged = true;
                                return { ...item, title: newTitle, page_size: newPageSize };
                            }
                            return item;
                        });
                        if (cacheChanged) {
                            await db.execute(
                                'UPDATE scan_cache SET open_ip = ?, scanned_at = CURRENT_TIMESTAMP WHERE ip_range = ?',
                                [JSON.stringify(openIp), ipRange]
                            );
                        }
                    }
                }
            } catch (cacheErr) {
                console.error('Error updating scan_cache for redirect rescan:', cacheErr);
            }
        }

        const isStill = isRedirectTitle(newTitle);
        res.json({
            success: true,
            id: rowId,
            host,
            oldTitle: currentTitle,
            newTitle,
            pageSize: newPageSize,
            isStillRedirect: isStill,
            changed: currentTitle !== newTitle
        });
    } catch (err) {
        console.error('Error in rescan endpoint:', err);
        res.status(500).json({ error: 'Internal error during rescan: ' + err.message });
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
