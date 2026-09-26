const net = require('net');
const { URL } = require('url');
const express = require('express')
const app = express()
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser')
const { exec } = require('child_process');
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
    await db.execute(
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
            JSON.stringify(open_ip),
            JSON.stringify(open_ssh),
            JSON.stringify(open_ftp),
            JSON.stringify(open_rtsp)
        ]
    );
}

app.get('/', (req, res) => {
    const parts = req.ip.split('.');
    res.redirect(`/${parts[0]}.${parts[1]}.${parts[2]}`);
});

app.get('/:range', (req, res) => {
    let ip_range = req.params.range
    if (ip_range.split(".").length == 3) {
        res.render('home.ejs', {
            query: ip_range
        })
    } else {
        res.send("Please enter ip range in this level: 0.0.0 - 255.255.255")
    }
});

app.get('/run/:range', async (req, res) => {
    const ip_range = req.params.range;

    if (ip_range.split(".").length !== 3) {
        return res.send(
            "Please enter ip range in this level: 0.0.0 - 255.255.255"
        );
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

app.get('/hosts/must-see', (req, res) => {
    const filePath = path.join(__dirname, 'must-see.txt');
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            res.send(err);
            return;
        }
        const lines = data.split('\n').filter(line => line.trim() !== '');
        res.json({ mustSee: lines });
    });
})

app.post('/hosts/must-see', (req, res) => {
    const filePath = path.join(__dirname, 'must-see.txt');
    const newLine = req.body.line;
    if (!newLine) {
        return res.status(400).json({ error: 'Line is required' });
    }

    const isUrl = /^https?:\/\//i.test(newLine);
    const isIPv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(newLine);

    //create must-see.txt file if it doesn't exist
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '');
    }
    
    //if read all line in destination and match the new line, then skip appending
    const existingLines = fs.readFileSync(filePath, 'utf8').split('\n').filter(line => line.trim() !== '');
    if (existingLines.includes(newLine)) {
        return res.status(400).json({ error: 'Line already exists' });
    }

    if (!isUrl && !isIPv4) {
        return res.status(400).json({
            error: 'Line must be a valid link or IP address'
        });
    }

    fs.appendFile(filePath, newLine + '\n', (err) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true });
    });
});

app.listen(4004, () => {
    console.log('[+] The Watcher is listening on port http://localhost:4004')
});
