const net = require('net');
const { URL } = require('url');
const express = require('express')
const app = express()
const path = require('path');
const bodyParser = require('body-parser')
const { exec, execFile } = require('child_process');
const mysql = require('mysql2/promise');

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

        const [rows] = await db.execute('SELECT open_ip FROM scan_cache');
        const isScannedHost = rows.some(row => {
            const hosts = typeof row.open_ip === 'string' ? JSON.parse(row.open_ip) : row.open_ip;
            return Array.isArray(hosts) && hosts.some(host => {
                try { return new URL(host.host).hostname === target.hostname; } catch { return false; }
            });
        });
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

const error_page = ['404 Not Found', 'Not Found', 'Unauthorized', '403 Forbidden', 'Access forbidden!', '500 - Internal server error.', 'Service Unavailable', '403 - Forbidden: Access is denied.']
const router_page = ['Login', 'RouterOS', 'F612C', '&#70;&#54;&#56;&#56;']
const cctv_page = ['WEB SERVICE', 'WEB']
const directory_listing = ['Index of', '/']
const error = ['error', 'not found', 'unauthorized', 'forbidden']
const nsfw = ['adult', 'porn', 'xxx', 'sex', 'nsfw']
const default_webserver_page = ['IIS Windows', 'IIS Windows Server', 'Test Page for the Apache HTTP Server on Fedora Core', 'Success!',
    'Welcome to nginx!', 'Default Site', 'Test Page for the HTTP Server on AlmaLinux', 'Apache2 Ubuntu Default Page: It works', "Web Server's Default Page", 'Welcome to XAMPP', 'Apache HTTP']

let filter = {
    error_page, router_page, cctv_page, directory_listing, default_webserver_page, error, nsfw
}

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

    for (let i = 0; i < 255; i++) {
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

    for (let i = 0; i < 255; i++) {
        const ip = `${ip_range}.${i}`;
        open_ip_promises.push(findSSH(ip));
    }

    const results = await Promise.all(open_ip_promises);
    const open_ip = results.filter(Boolean);
    return open_ip;
}

async function scanFTP(ip_range) {
    const open_ip_promises = [];

    for (let i = 0; i < 255; i++) {
        const ip = `${ip_range}.${i}`;
        open_ip_promises.push(findFTP(ip));
    }

    const results = await Promise.all(open_ip_promises);
    const open_ip = results.filter(Boolean);
    return open_ip;
}

async function scanRTSP(ip_range) {
    const open_ip_promises = [];

    for (let i = 0; i < 255; i++) {
        const ip = `${ip_range}.${i}`;
        open_ip_promises.push(findRTSP(ip));
    }

    const results = await Promise.all(open_ip_promises);
    const open_ip = results.filter(Boolean);
    return open_ip;
}

function isValidRangePrefix(ip_range) {
    if (typeof ip_range !== 'string') return false;
    const octets = ip_range.split('.');
    return octets.length === 3 && octets.every(octet =>
        /^\d{1,3}$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255
    );
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
            scanned_at
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

        scanned_at: row.scanned_at
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

    if ([open_ip, open_ssh, open_ftp, open_rtsp].every(
        results => results.length === 0
    )) {
        return;
    }

    const observations = [];

    open_ip.forEach(result => {
        if (!result || typeof result.host !== 'string') return;
        let ip_address = result.host;
        try {
            ip_address = new URL(result.host).hostname;
        } catch { }
        observations.push([
            ip_range,
            result.host,
            ip_address,
            'web',
            80,
            result.title || null
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

app.get('/', (req, res) => {
    const parts = req.ip.split('.');
    res.redirect(`/${parts[0]}.${parts[1]}.${parts[2]}`);
});

app.get('/search', async (req, res) => {
    const services = ['web', 'ssh', 'ftp', 'rtsp'];
    const selectedService = services.includes(req.query.service) ? req.query.service : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
    let selectedRange = typeof req.query.ip_range === 'string' ? req.query.ip_range : '';
    const pageSize = 50;
    let page = Number.parseInt(req.query.page, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;

    try {
        const [rangeRows] = await db.execute(
            'SELECT DISTINCT ip_range FROM scan_search_index ORDER BY ip_range'
        );
        const ranges = rangeRows.map(row => row.ip_range);
        if (!ranges.includes(selectedRange)) selectedRange = '';

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
        if (selectedRange) {
            conditions.push('ip_range = ?');
            params.push(selectedRange);
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

        res.render('search.ejs', {
            q,
            services,
            selectedService,
            ranges,
            selectedRange,
            results,
            total,
            page,
            pageSize,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            hasSearch: conditions.length > 0
        });
    } catch (err) {
        console.error('Search page error:', err);
        res.status(500).send('Could not load search results.');
    }
});

app.get('/:range', (req, res) => {
    const ip_range = req.params.range;
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
        const cached = await getScanCache(ip_range);

        if (cached) {

            console.log(`[CACHE] ${ip_range}`);

            return res.render(
                'components/result.ejs',
                {
                    open_ip: cached.open_ip,
                    open_ssh: cached.open_ssh,
                    open_ftp: cached.open_ftp,
                    open_rtsp: cached.open_rtsp,
                    filter,

                    cached: true,
                    scanned_at: cached.scanned_at
                },
                (err, html) => {

                    if (err) {
                        return res.status(500).json({
                            error: err.message
                        });
                    }

                    res.json({
                        html: html,

                        data: {
                            open_ip: cached.open_ip,
                            open_ssh: cached.open_ssh,
                            open_ftp: cached.open_ftp,
                            open_rtsp: cached.open_rtsp,
                            filter,

                            cached: true,
                            scanned_at: cached.scanned_at
                        }
                    });
                }
            );
        }

        console.log(`[SCAN] ${ip_range}`);

        const open_ip = await scanWebServer(ip_range);
        const open_ssh = await scanSSH(ip_range);
        const open_ftp = await scanFTP(ip_range);
        const open_rtsp = await scanRTSP(ip_range);

        await saveScanCache(
            ip_range,
            open_ip,
            open_ssh,
            open_ftp,
            open_rtsp
        );

        res.render(
            'components/result.ejs',
            {
                open_ip,
                open_ssh,
                open_ftp,
                open_rtsp,
                filter,

                cached: false,
                scanned_at: new Date()
            },
            (err, html) => {

                if (err) {
                    return res.status(500).json({
                        error: err.message
                    });
                }

                res.json({
                    html: html,

                    data: {
                        open_ip,
                        open_ssh,
                        open_ftp,
                        open_rtsp,
                        filter,

                        cached: false,
                        scanned_at: new Date()
                    }
                });
            }
        );

    } catch (err) {
        console.error(err);
        res.status(500).json({
            error: err.message
        });
    }
});

app.get('/rtsp/:ip', (req, res) => {
    let ip = req.params.ip

    exec('nmap --script rtsp-url-brute -p 554 ' + ip, (err, stdout, stderr) => {
        if (err) {
            res.send(err);
            return;
        }
        res.json({stdout});
    });
})

app.get('/ftp/:ip', (req, res) => {
    let ip = req.params.ip

    exec('nmap --script ftp-brute -p 21 ' + ip, (err, stdout, stderr) => {
        if (err) {
            res.send(err);
            return;
        }
        res.json({stdout});
    });
})

app.get('/nmap/:ip', (req, res) => {
    let ip = req.params.ip

    exec('nmap -sV -sC ' + ip, (err, stdout, stderr) => {
        if (err) {
            res.send(err);
            return;
        }
        res.json({stdout});
    });
})

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

app.listen(4004, () => {
    console.log('[+] The Watcher is listening on port http://localhost:4004')
});
