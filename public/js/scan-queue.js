(() => {
    const form = document.getElementById('queue-form');
    const submit = document.getElementById('queue-submit');
    const message = document.getElementById('queue-message');
    const activeContainer = document.getElementById('queue-active');
    const historyContainer = document.getElementById('queue-history');
    const refreshStatus = document.getElementById('queue-refresh-status');
    let requestPending = false;
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

    function renderHistory(jobs) {
        if (!jobs.length) {
            historyContainer.innerHTML = `<div class="queue-empty-state">${translate('No scan history yet.', 'ยังไม่มีประวัติการสแกน')}</div>`;
            return;
        }
        historyContainer.innerHTML = jobs.map(job => {
            const total = Number(job.total_ranges) || 0;
            const completed = completedCount(job, total);
            const error = job.error_message ? `<p class="queue-job-error">${escapeHtml(window.siteLocalizeMessage(job.error_message))}</p>` : '';
            return `<article class="queue-history-row">
                <div class="queue-history-main">
                    <span class="queue-status-badge status-${escapeHtml(job.status)}">${escapeHtml(statusLabel(job.status))}</span>
                    <strong>${escapeHtml(job.start_range)} – ${escapeHtml(job.end_range)}</strong>
                <span>${translate('{completed} / {total} subnet(s)', '{completed} / {total} ช่วง Subnet', { completed, total })}</span>
                </div>
                <time>${escapeHtml(formatDate(job.created_at))}</time>
                ${error}
            </article>`;
        }).join('');
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

    async function refresh() {
        try {
            const response = await fetch('/api/scan-queue', { cache: 'no-store' });
            if (!response.ok) throw new Error('Could not load scan status.');
            const data = await response.json();
            renderActive(data);
            renderHistory(data.jobs);
            updateForm(data);
            const time = new Intl.DateTimeFormat(currentLocale(), { timeStyle: 'medium' }).format(new Date());
            refreshStatus.textContent = translate('Updated {time}', 'อัปเดต {time}', { time });
            refreshStatus.classList.remove('is-error');
        } catch (error) {
            refreshStatus.textContent = window.siteLocalizeMessage('Could not connect to scan status.');
            refreshStatus.classList.add('is-error');
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

    refresh();
    window.setInterval(refresh, 1500);
    document.addEventListener('site-language-change', refresh);
})();
