const net = require('net');
const express = require('express')
const app = express()
const path = require('path')
const bodyParser = require('body-parser')
const { exec } = require('child_process');

app.set('views', path.join(__dirname, 'views'))
app.set('view engine', 'ejs')
app.use(bodyParser.urlencoded({ extended: true }))

const error_page = ['404 Not Found', 'Not Found', 'Unauthorized', '403 Forbidden', 'Access forbidden!', '500 - Internal server error.', 'Service Unavailable', '403 - Forbidden: Access is denied.']
const router_page = ['Login', 'RouterOS', 'F612C', '&#70;&#54;&#56;&#56;']
const cctv_page = ['WEB SERVICE', 'WEB']
const default_webserver_page = ['IIS Windows', 'IIS Windows Server', 'Test Page for the Apache HTTP Server on Fedora Core', 
    'Welcome to nginx!', 'Default Site', 'Test Page for the HTTP Server on AlmaLinux', 'Apache2 Ubuntu Default Page: It works', "Web Server's Default Page", 'Welcome to XAMPP']

let filter = {
    error_page, router_page, cctv_page, default_webserver_page
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
        return {host: `http://${host}`, title:title}
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
        open_ip_promises.push(findWebServer(ip));
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

app.get('/', (req,res) => {
    fetch('https://api.myip.com').then((status) => {
        if(status.ok) {
            return status.json()
        }
    }).then(data => {
        res.redirect('/'+data.ip.split('.')[0]+"."+data.ip.split('.')[1]+"."+data.ip.split('.')[2])
    })
})

app.get('/:range', (req, res) => {
    let ip_range = req.params.range
    if(ip_range.split(".").length == 3) {
        res.render('home.ejs', {
            query: ip_range
        })
    } else {
        res.send("Please enter ip range in this level: 0.0.0 - 255.255.255")
    }
});

app.get('/run/:range', (req, res) => {
    let ip_range = req.params.range
    if(ip_range.split(".").length == 3) {
        scanWebServer(ip_range).then(open_ip => {
            scanSSH(ip_range).then(open_ssh => {
                scanFTP(ip_range).then(open_ftp => {
                    scanRTSP(ip_range).then(open_rtsp => {
                        res.render('components/result.ejs', {
                            open_ip: open_ip,
                            open_ssh: open_ssh,
                            open_ftp: open_ftp,
                            open_rtsp: open_rtsp,
                            filter: filter,
                        })
                    })
                })
            })
        })
    } else {
        res.send("Please enter ip range in this level: 0.0.0 - 255.255.255")
    }
});

app.get('/rtsp/:ip', (req, res) => {
    let ip = req.params.ip

    exec('nmap --script rtsp-url-brute -p 554 '+ip, (err, stdout, stderr) => {
        if (err) {
            res.send(err);
            return;
        }
        res.send(`<pre>${stdout}</pre>`);
    });
})

app.get('/ftp/:ip', (req, res) => {
    let ip = req.params.ip

    exec('nmap --script ftp-brute -p 21 '+ip, (err, stdout, stderr) => {
        if (err) {
            res.send(err);
            return;
        }
        res.send(`<pre>${stdout}</pre>`);
    });
})

app.get('/nmap/:ip', (req, res) => {
    let ip = req.params.ip

    exec('nmap -sV -sC '+ip, (err, stdout, stderr) => {
        if (err) {
            res.send(err);
            return;
        }
        res.send(`<pre>${stdout}</pre>`);
    });
})


app.listen(4002, () => {
    console.log('server listening on port http://localhost:4002')
});