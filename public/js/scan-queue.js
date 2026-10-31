(() => {
    const form = document.getElementById('queue-form');
    const submit = document.getElementById('queue-submit');
    const message = document.getElementById('queue-message');
    const activeContainer = document.getElementById('queue-active');
    const historyContainer = document.getElementById('queue-history');
    const subnetsContainer = document.getElementById('queue-subnets');
    const subnetsCount = document.getElementById('queue-subnets-count');
    const filterSubnetsInput = document.getElementById('filter-subnets-input');
    const refreshStatus = document.getElementById('queue-refresh-status');
    let requestPending = false;
    let refreshTimer = null;
    let refreshInProgress = false;
    let refreshQueued = false;
    let activeWork = false;
    let cachedSubnets = [];
    let currentSubnetFilter = '';
    const ACTIVE_REFRESH_INTERVAL_MS = 3000;
    const IDLE_REFRESH_INTERVAL_MS = 10000;
    const ERROR_REFRESH_INTERVAL_MS = 5000;
    const translate = (english, thai, values) => window.siteTranslate(english, thai, values);
    const currentLocale = () => window.siteLanguage() === 'th' ? 'th-TH' : 'en-US';

    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);

    function formatDate(value) {
        if (!value) return '—';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '—';
        return new Intl.DateTimeFormat(currentLocale(), {
            dateStyle: 'medium', timeStyle: 'short'
        }).format(date);
    }

    function statusLabel(status) {
        const labels = {
            queued: ['Queued', 'รอคิว'],
            running: ['Scanning', 'กำลังสแกน'],
            completed: ['Completed', 'เสร็จสิ้น'],
            failed: ['Failed', 'ล้มเหลว']
        };
        const label = labels[status];
        return label ? translate(label[0], label[1]) : status;
    }

    function completedCount(job, total) {
        let completed = Math.max(0, Math.min(total, Number(job.completed_ranges) || 0));
        if (job.status === 'running' && job.current_range) {
            const startOctet = Number(String(job.start_range).split('.')[2]);
            const startParts = String(job.start_range).split('.');
            const currentParts = String(job.current_range).split('.');
            const currentOctet = Number(currentParts[2]);
            if (currentParts.length === 3 && currentParts[0] === startParts[0] && currentParts[1] === startParts[1] && Number.isInteger(startOctet) && Number.isInteger(currentOctet)) {
                completed = Math.min(total, Math.max(0, currentOctet - startOctet));
            }
        }
        return completed;
    }

    function renderActive(data) {
        const activeJob = data.jobs.find(job => ['queued', 'running'].includes(job.status));
        const currentlyScanning = data.activeScanRange || data.pendingScanRange;
        if (!activeJob && !currentlyScanning) {
            activeContainer.innerHTML = `<div class="queue-empty-state">${translate('No active scan job.', 'ไม่มีงานสแกนที่กำลังทำงาน')}</div>`;
            return;
        }

        if (!activeJob) {
            const isSubnet = String(currentlyScanning).split('.').length === 3;
            const target = isSubnet ? `${currentlyScanning}.0/24` : currentlyScanning;
            const label = data.activeScanRange
                ? translate('Scanning from the main scanner', 'กำลังสแกนจากตัวสแกนหลัก')
                : translate('A scan is starting', 'กำลังเริ่มการสแกน');
            activeContainer.innerHTML = `<div class="queue-current-scan"><span class="queue-pulse"></span><div><span class="queue-label">${label}</span><strong>${escapeHtml(target)}</strong></div></div>`;
            return;
        }

        const total = Number(activeJob.total_ranges) || 0;
        const completed = completedCount(activeJob, total);
        const isRunning = activeJob.status === 'running';
        const percent = total ? Math.min(isRunning ? 99 : 100, Math.round(completed / total * 100)) : 0;
        const current = activeJob.current_range || currentlyScanning;
        activeContainer.innerHTML = `
            <div class="queue-job-summary">
                <span class="queue-status-badge status-${escapeHtml(activeJob.status)}">${escapeHtml(statusLabel(activeJob.status))}</span>
                <strong>${escapeHtml(activeJob.start_range)} – ${escapeHtml(activeJob.end_range)}</strong>
                <span>${translate('{completed} / {total} subnet(s)', '{completed} / {total} ช่วง Subnet', { completed, total })}</span>
            </div>
            <div class="queue-progress" role="progressbar" aria-label="${translate('Scan progress', 'ความคืบหน้าการสแกน')}" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${completed}"><span style="width:${percent}%"></span></div>
            <div class="queue-progress-meta"><span>${translate('{percent}% complete', '{percent}% แล้ว', { percent })}</span><span>${isRunning && current
                ? translate('Scanning {range}.0/24', 'กำลังสแกน {range}.0/24', { range: escapeHtml(current) })
                : translate('Preparing to start', 'กำลังเตรียมเริ่มสแกน')}</span></div>`;
    }

    function renderSubnets(subnets) {
        if (!subnetsContainer) return;
        const filtered = subnets.filter(s => !currentSubnetFilter || s.ip_range.toLowerCase().includes(currentSubnetFilter));

        if (subnetsCount) {
            subnetsCount.textContent = translate('{count} SUBNETS', '{count} ช่วง', { count: filtered.length });
        }

        if (!subnets.length) {
            subnetsContainer.innerHTML = `<div class="queue-empty-state">${translate('No scanned subnets yet.', 'ยังไม่มีประวัติ Subnet ที่สแกน')}</div>`;
            return;
        }

        if (!filtered.length) {
            subnetsContainer.innerHTML = `<div class="queue-empty-state">${translate('No subnets match the search filter.', 'ไม่พบ Subnet ที่ตรงกับคำค้นหา')}</div>`;
            return;
        }

        subnetsContainer.innerHTML = filtered.map(subnet => {
            return `<article class="queue-history-row">
                <div class="queue-history-main">
                    <strong>${escapeHtml(subnet.ip_range)}.0/24</strong>
                    <span class="subnet-tag tag-web">Web: ${subnet.web_count}</span>
                    ${subnet.ssh_count > 0 ? `<span class="subnet-tag tag-ssh">SSH: ${subnet.ssh_count}</span>` : ''}
                    ${subnet.ftp_count > 0 ? `<span class="subnet-tag tag-ftp">FTP: ${subnet.ftp_count}</span>` : ''}
                    ${subnet.rtsp_count > 0 ? `<span class="subnet-tag tag-rtsp">RTSP: ${subnet.rtsp_count}</span>` : ''}
                    <span>${translate('{total} finding(s)', 'พบ {total} รายการ', { total: subnet.total_findings })}</span>
                </div>
                <div class="queue-history-side" style="display: flex; align-items: center; gap: 10px;">
                    <time>${escapeHtml(formatDate(subnet.scanned_at))}</time>
                    <button type="button" class="btn-rescan-single-subnet btn-secondary btn-sm" data-subnet="${escapeHtml(subnet.ip_range)}">
                        ${escapeHtml(translate('Rescan Subnet', 'สแกนซ้ำ'))}
                    </button>
                </div>
            </article>`;
        }).join('');

        subnetsContainer.querySelectorAll('.btn-rescan-single-subnet').forEach(btn => {
            btn.addEventListener('click', async () => {
                const subnet = btn.getAttribute('data-subnet');
                if (!subnet) return;

                btn.disabled = true;
                const originalText = btn.innerHTML;
                btn.innerHTML = `<span class="spinner-inline"></span> ${escapeHtml(translate('Adding...', 'กำลังเพิ่ม...'))}`;

                try {
                    const res = await fetch('/api/scan-queue', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ start_range: subnet, end_range: subnet })
                    });
                    const result = await res.json();
                    if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);

                    message.textContent = translate(
                        `Added subnet ${subnet}.0/24 to scan queue for fresh rescan!`,
                        `เพิ่ม Subnet ${subnet}.0/24 เข้าคิวเพื่อสแกนใหม่เรียบร้อยแล้ว!`
                    );
                    message.classList.remove('is-error');
                    message.classList.add('is-busy');

                    refresh();
                } catch (err) {
                    message.textContent = translate('Could not rescan: ' + err.message, 'ไม่สามารถสแกนซ้ำได้: ' + err.message);
                    message.classList.add('is-error');
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = originalText;
                }
            });
        });
    }

    function renderHistory(jobs) {
        if (!historyContainer) return;
        // Deduplicate completed jobs with identical range
        const seen = new Set();
        const uniqueJobs = [];
        for (const job of jobs) {
            const key = `${job.status}:${job.start_range}:${job.end_range}`;
            if (job.status === 'completed') {
                if (seen.has(key)) continue;
                seen.add(key);
            }
            uniqueJobs.push(job);
        }

        if (!uniqueJobs.length) {
            historyContainer.innerHTML = `<div class="queue-empty-state">${translate('No scan history yet.', 'ยังไม่มีประวัติการสแกน')}</div>`;
            return;
        }

        historyContainer.innerHTML = uniqueJobs.map(job => {
            const total = Number(job.total_ranges) || 0;
            const completed = completedCount(job, total);
            const error = job.error_message ? `<p class="queue-job-error">${escapeHtml(window.siteLocalizeMessage(job.error_message))}</p>` : '';
            const isSingle = job.start_range === job.end_range;
            const buttonLabel = isSingle
                ? translate('Rescan Subnet', 'สแกนซ้ำ')
                : translate('Rescan Range', 'สแกนช่วงซ้ำ');

            return `<article class="queue-history-row">
                <div class="queue-history-main">
                    <span class="queue-status-badge status-${escapeHtml(job.status)}">${escapeHtml(statusLabel(job.status))}</span>
                    <strong>${escapeHtml(job.start_range)}${isSingle ? '.0/24' : ` – ${escapeHtml(job.end_range)}`}</strong>
                    <span>${translate('{completed} / {total} subnet(s)', '{completed} / {total} ช่วง Subnet', { completed, total })}</span>
                </div>
                <div class="queue-history-side" style="display: flex; align-items: center; gap: 10px;">
                    <time>${escapeHtml(formatDate(job.created_at))}</time>
                    <button type="button" class="btn-rescan-subnet btn-secondary btn-sm" data-start="${escapeHtml(job.start_range)}" data-end="${escapeHtml(job.end_range)}">
                        ${escapeHtml(buttonLabel)}
                    </button>
                </div>
                ${error}
            </article>`;
        }).join('');

        historyContainer.querySelectorAll('.btn-rescan-subnet').forEach(btn => {
            btn.addEventListener('click', async () => {
                const startRange = btn.getAttribute('data-start');
                const endRange = btn.getAttribute('data-end');
                if (!startRange || !endRange) return;

                btn.disabled = true;
                const originalText = btn.innerHTML;
                btn.innerHTML = `<span class="spinner-inline"></span> ${escapeHtml(translate('Adding...', 'กำลังเพิ่ม...'))}`;

                try {
                    const res = await fetch('/api/scan-queue', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ start_range: startRange, end_range: endRange })
                    });
                    const result = await res.json();
                    if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);

                    message.textContent = translate(
                        `Added ${startRange === endRange ? 'subnet ' + startRange : 'range ' + startRange + ' – ' + endRange} to scan queue!`,
                        `เพิ่ม ${startRange === endRange ? 'Subnet ' + startRange : 'ช่วง ' + startRange + ' – ' + endRange} เข้าคิวสแกนเรียบร้อยแล้ว!`
                    );
                    message.classList.remove('is-error');
                    message.classList.add('is-busy');

                    refresh();
                } catch (err) {
                    message.textContent = translate('Could not rescan: ' + err.message, 'ไม่สามารถสแกนซ้ำได้: ' + err.message);
                    message.classList.add('is-error');
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = originalText;
                }
            });
        });
    }

    function updateForm(data) {
        const hasActiveJob = data.jobs.some(job => ['queued', 'running'].includes(job.status));
        const scanInProgress = hasActiveJob || Boolean(data.activeScanRange || data.pendingScanRange);
        submit.disabled = requestPending;
        form.querySelectorAll('input').forEach(input => { input.disabled = requestPending; });
        if (scanInProgress) {
            message.textContent = translate(
                'A scan is in progress. New ranges will be added to the queue and scanned in order.',
                'กำลังสแกนอยู่ ช่วงใหม่จะถูกเพิ่มในคิวและสแกนตามลำดับ'
            );
            message.classList.add('is-busy');
        } else {
            message.textContent = translate(
                'Enter subnet prefixes with the same first two octets. You can add multiple ranges to the queue.',
                'กรอก subnet prefix ที่มี 2 octet แรกเหมือนกัน และเพิ่มหลายช่วงเข้าคิวได้'
            );
            message.classList.remove('is-busy');
        }
    }

    function scheduleRefresh(delay) {
        if (refreshTimer) window.clearTimeout(refreshTimer);
        refreshTimer = null;
        if (!document.hidden) {
            refreshTimer = window.setTimeout(() => {
                refreshTimer = null;
                refresh();
            }, delay);
        }
    }

    async function refresh() {
        if (refreshTimer) window.clearTimeout(refreshTimer);
        refreshTimer = null;
        if (document.hidden) return;
        if (refreshInProgress) {
            refreshQueued = true;
            return;
        }

        refreshInProgress = true;
        let nextDelay = ERROR_REFRESH_INTERVAL_MS;
        try {
            const response = await fetch('/api/scan-queue', { cache: 'no-store' });
            if (!response.ok) throw new Error('Could not load scan status.');
            const data = await response.json();
            renderActive(data);
            renderHistory(data.jobs);
            cachedSubnets = data.scanned_subnets || [];
            renderSubnets(cachedSubnets);
            updateForm(data);
            activeWork = data.jobs.some(job => ['queued', 'running'].includes(job.status)) ||
                Boolean(data.activeScanRange || data.pendingScanRange);
            nextDelay = activeWork ? ACTIVE_REFRESH_INTERVAL_MS : IDLE_REFRESH_INTERVAL_MS;
            const time = new Intl.DateTimeFormat(currentLocale(), { timeStyle: 'medium' }).format(new Date());
            refreshStatus.textContent = translate('Updated {time}', 'อัปเดต {time}', { time });
            refreshStatus.classList.remove('is-error');
        } catch (error) {
            refreshStatus.textContent = window.siteLocalizeMessage('Could not connect to scan status.');
            refreshStatus.classList.add('is-error');
            activeWork = true;
        } finally {
            refreshInProgress = false;
            if (!document.hidden) {
                scheduleRefresh(refreshQueued ? 0 : nextDelay);
            }
            refreshQueued = false;
        }
    }

    form.addEventListener('submit', async event => {
        event.preventDefault();
        const values = new FormData(form);
        requestPending = true;
        submit.disabled = true;
        message.textContent = translate('Adding scan job…', 'กำลังเพิ่มงานสแกน…');
        message.classList.remove('is-error');
        try {
            const response = await fetch('/api/scan-queue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    start_range: values.get('start_range').trim(),
                    end_range: values.get('end_range').trim()
                })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Could not add scan range.');
            form.reset();
            message.textContent = translate(
                'Scan range added to the queue (job #{id}).',
                'เพิ่มช่วงสแกนเข้าคิวแล้ว (งาน #{id})',
                { id: data.id }
            );
        } catch (error) {
            message.textContent = window.siteLocalizeMessage(error.message);
            message.classList.add('is-error');
        } finally {
            requestPending = false;
            await refresh();
        }
    });

    if (filterSubnetsInput) {
        filterSubnetsInput.addEventListener('input', () => {
            currentSubnetFilter = filterSubnetsInput.value.trim().toLowerCase();
            renderSubnets(cachedSubnets);
        });
    }

    refresh();
    document.addEventListener('site-language-change', () => {
        if (cachedSubnets.length) renderSubnets(cachedSubnets);
        refresh();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (refreshTimer) window.clearTimeout(refreshTimer);
            refreshTimer = null;
        } else {
            refresh();
        }
    });
})();
