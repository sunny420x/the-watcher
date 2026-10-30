(() => {
    const tableBody = document.getElementById('redirects-table-body');
    const searchInput = document.getElementById('redirects-search');
    const categoryFilter = document.getElementById('redirects-category-filter');
    const btnRefresh = document.getElementById('btn-refresh');
    const btnRescanPage = document.getElementById('btn-rescan-page');
    const btnRescanAll = document.getElementById('btn-rescan-all');
    const btnStop = document.getElementById('btn-stop');
    const btnPrevPage = document.getElementById('btn-prev-page');
    const btnNextPage = document.getElementById('btn-next-page');
    const pageInfo = document.getElementById('redirects-page-info');

    const progressContainer = document.getElementById('redirects-progress-container');
    const progressLabel = document.getElementById('redirects-progress-label');
    const progressCount = document.getElementById('redirects-progress-count');
    const progressBar = document.getElementById('redirects-progress-bar');

    const statTotal = document.getElementById('stat-total');
    const statResolved = document.getElementById('stat-resolved');
    const statUnchanged = document.getElementById('stat-unchanged');
    const statErrors = document.getElementById('stat-errors');

    let currentPage = 1;
    const limit = 50;
    let totalItems = 0;
    let totalPages = 1;
    let currentRows = [];
    let isScanningQueue = false;
    let shouldStopScanning = false;

    let sessionResolvedCount = 0;
    let sessionUnchangedCount = 0;
    let sessionErrorCount = 0;

    const translate = (en, th, values) => (window.siteTranslate ? window.siteTranslate(en, th, values) : en);

    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);

    function updateStats() {
        if (statResolved) statResolved.textContent = sessionResolvedCount.toLocaleString();
        if (statUnchanged) statUnchanged.textContent = sessionUnchangedCount.toLocaleString();
        if (statErrors) statErrors.textContent = sessionErrorCount.toLocaleString();
    }

    async function fetchRedirects(page = 1) {
        currentPage = page;
        tableBody.innerHTML = `<tr><td colspan="5" class="table-empty">${escapeHtml(translate('Loading redirect list...', 'กำลังโหลดรายการ Redirect...'))}</td></tr>`;

        const queryParams = new URLSearchParams({
            page: String(currentPage),
            limit: String(limit),
            q: searchInput.value.trim(),
            category: categoryFilter.value
        });

        try {
            const res = await fetch(`/api/redirects?${queryParams}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            totalItems = data.total || 0;
            totalPages = Math.max(1, data.totalPages || 1);
            currentRows = data.items || [];

            if (statTotal) statTotal.textContent = totalItems.toLocaleString();

            renderTable(currentRows);
            renderPagination();
        } catch (err) {
            tableBody.innerHTML = `<tr><td colspan="5" class="table-empty" style="color: #ff6b6b;">${escapeHtml(translate('Failed to load data: ' + err.message, 'เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + err.message))}</td></tr>`;
        }
    }

    function renderTable(rows) {
        if (!rows || rows.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="5" class="table-empty">${escapeHtml(translate('No redirect entries found.', 'ไม่พบรายการที่ติด Redirect'))}</td></tr>`;
            return;
        }

        tableBody.innerHTML = rows.map(row => {
            const host = escapeHtml(row.host);
            const ipRange = escapeHtml(row.ip_range);
            const title = escapeHtml(row.title || '—');

            return `
                <tr id="row-${row.id}" data-id="${row.id}" data-host="${host}" data-range="${ipRange}">
                    <td class="col-host">
                        <div class="host-entry">
                            <a href="${host}" target="_blank" rel="noreferrer" class="host-link" title="${host}">${host}</a>
                        </div>
                    </td>
                    <td class="col-range">
                        <a href="/?search=${encodeURIComponent(ipRange)}" class="range-link">${ipRange}</a>
                    </td>
                    <td class="col-current-title">
                        <span class="badge badge-warning" title="${title}">${title}</span>
                    </td>
                    <td class="col-resolved-title" id="resolved-${row.id}">
                        <span class="text-muted">—</span>
                    </td>
                    <td class="col-action" style="text-align: right;">
                        <button type="button" class="btn-rescan-single btn-secondary btn-sm" data-id="${row.id}" data-host="${host}" data-range="${ipRange}">
                            ${escapeHtml(translate('Rescan', 'สแกนใหม่'))}
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

        // Attach event listeners to single rescan buttons
        tableBody.querySelectorAll('.btn-rescan-single').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = btn.getAttribute('data-id');
                const host = btn.getAttribute('data-host');
                const ipRange = btn.getAttribute('data-range');
                await rescanSingle(id, host, ipRange, btn);
            });
        });
    }

    function renderPagination() {
        if (!pageInfo) return;
        pageInfo.textContent = translate(
            `Page ${currentPage} of ${totalPages} (${totalItems.toLocaleString()} total)`,
            `หน้า ${currentPage} จาก ${totalPages} (ทั้งหมด ${totalItems.toLocaleString()} รายการ)`
        );
        btnPrevPage.disabled = currentPage <= 1;
        btnNextPage.disabled = currentPage >= totalPages;
    }

    async function rescanSingle(id, host, ipRange, buttonElement) {
        const row = document.getElementById(`row-${id}`);
        const resolvedCell = document.getElementById(`resolved-${id}`);
        if (!buttonElement && row) {
            buttonElement = row.querySelector('.btn-rescan-single');
        }

        if (buttonElement) {
            buttonElement.disabled = true;
            buttonElement.innerHTML = `<span class="spinner-inline"></span> ${escapeHtml(translate('Scanning...', 'กำลังสแกน...'))}`;
        }
        if (resolvedCell) {
            resolvedCell.innerHTML = `<span class="badge badge-info">${escapeHtml(translate('Resolving...', 'กำลังตาม Redirect...'))}</span>`;
        }

        try {
            const res = await fetch('/api/redirects/rescan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: Number(id), host, ip_range: ipRange })
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const result = await res.json();

            if (result.success) {
                const newTitle = result.newTitle;
                const isStillRedirect = result.isStillRedirect;

                if (newTitle && !isStillRedirect) {
                    sessionResolvedCount++;
                    if (resolvedCell) {
                        resolvedCell.innerHTML = `
                            <span class="badge badge-success" title="${escapeHtml(newTitle)}">
                                ${escapeHtml(newTitle)}
                            </span>
                        `;
                    }
                    if (row) {
                        row.classList.add('row-resolved');
                    }
                } else if (result.changed) {
                    sessionResolvedCount++;
                    if (resolvedCell) {
                        resolvedCell.innerHTML = `
                            <span class="badge badge-success" title="${escapeHtml(newTitle || '—')}">
                                ${escapeHtml(newTitle || '—')}
                            </span>
                        `;
                    }
                } else {
                    sessionUnchangedCount++;
                    if (resolvedCell) {
                        resolvedCell.innerHTML = `
                            <span class="badge badge-warning" title="${escapeHtml(newTitle || 'Still redirect')}">
                                ${escapeHtml(newTitle || translate('Still redirect', 'ยังเป็นหน้า Redirect'))}
                            </span>
                        `;
                    }
                }
            } else {
                sessionErrorCount++;
                if (resolvedCell) {
                    resolvedCell.innerHTML = `<span class="badge badge-danger">${escapeHtml(result.error || translate('Failed', 'ไม่สำเร็จ'))}</span>`;
                }
            }
        } catch (err) {
            sessionErrorCount++;
            if (resolvedCell) {
                resolvedCell.innerHTML = `<span class="badge badge-danger">${escapeHtml(err.message)}</span>`;
            }
        } finally {
            if (buttonElement) {
                buttonElement.disabled = false;
                buttonElement.innerHTML = escapeHtml(translate('Rescan', 'สแกนใหม่'));
            }
            updateStats();
        }
    }

    async function runBatchScan(items) {
        if (!items || items.length === 0) return;
        isScanningQueue = true;
        shouldStopScanning = false;

        btnStop.style.display = 'inline-block';
        btnRescanPage.disabled = true;
        btnRescanAll.disabled = true;
        btnRefresh.disabled = true;
        progressContainer.style.display = 'block';

        const total = items.length;
        let completed = 0;

        const updateProgress = () => {
            const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
            progressBar.style.width = `${percent}%`;
            progressCount.textContent = `${completed} / ${total} (${percent}%)`;
        };
        updateProgress();

        // Process in concurrency of 3 to 4 items at a time
        const CONCURRENCY = 3;
        let index = 0;

        async function worker() {
            while (index < items.length && !shouldStopScanning) {
                const currentItem = items[index++];
                await rescanSingle(currentItem.id, currentItem.host, currentItem.ip_range, null);
                completed++;
                updateProgress();
            }
        }

        const workers = [];
        for (let i = 0; i < Math.min(CONCURRENCY, items.length); i++) {
            workers.push(worker());
        }
        await Promise.all(workers);

        isScanningQueue = false;
        btnStop.style.display = 'none';
        btnRescanPage.disabled = false;
        btnRescanAll.disabled = false;
        btnRefresh.disabled = false;

        if (progressLabel) {
            progressLabel.textContent = shouldStopScanning
                ? translate('Scanning paused.', 'การสแกนหยุดชั่วคราวแล้ว')
                : translate('Batch scan completed.', 'การสแกนชุดนี้เสร็จสิ้นแล้ว');
        }
    }

    // Event listeners
    btnRefresh.addEventListener('click', () => fetchRedirects(currentPage));

    let searchDebounceTimer = null;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            fetchRedirects(1);
        }, 400);
    });

    categoryFilter.addEventListener('change', () => {
        fetchRedirects(1);
    });

    btnPrevPage.addEventListener('click', () => {
        if (currentPage > 1) fetchRedirects(currentPage - 1);
    });

    btnNextPage.addEventListener('click', () => {
        if (currentPage < totalPages) fetchRedirects(currentPage + 1);
    });

    btnRescanPage.addEventListener('click', () => {
        if (isScanningQueue || currentRows.length === 0) return;
        runBatchScan(currentRows);
    });

    btnRescanAll.addEventListener('click', async () => {
        if (isScanningQueue) return;
        const confirmMsg = translate(
            `Fetch all matching redirect entries (up to 500) and rescan them?`,
            `ต้องการดึงรายการ redirect ทั้งหมด (สูงสุด 500 รายการ) มาสแกนใหม่ใช่หรือไม่?`
        );
        if (!confirm(confirmMsg)) return;

        btnRescanAll.disabled = true;
        try {
            const queryParams = new URLSearchParams({
                page: '1',
                limit: '500',
                q: searchInput.value.trim(),
                category: categoryFilter.value
            });
            const res = await fetch(`/api/redirects?${queryParams}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const allItems = data.items || [];
            if (allItems.length === 0) {
                alert(translate('No redirect entries to rescan.', 'ไม่พบรายการที่ต้องสแกนใหม่'));
                btnRescanAll.disabled = false;
                return;
            }
            runBatchScan(allItems);
        } catch (err) {
            alert(err.message);
            btnRescanAll.disabled = false;
        }
    });

    btnStop.addEventListener('click', () => {
        shouldStopScanning = true;
        btnStop.disabled = true;
        btnStop.textContent = translate('Stopping...', 'กำลังหยุด...');
        setTimeout(() => {
            btnStop.disabled = false;
            btnStop.textContent = translate('Pause / Stop', 'หยุดชั่วคราว');
        }, 1500);
    });

    // Initial load
    fetchRedirects(1);
})();

