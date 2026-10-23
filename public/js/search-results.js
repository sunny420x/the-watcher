(() => {
    const form = document.getElementById('index-search-form');
    const results = document.getElementById('index-results');
    if (!form || !results) return;

    let activeRequest = null;
    let lastRequestedUrl = window.location.href;

    function loadingMarkup() {
        return `
            <div class="search-loading" role="status">
                <span class="search-loader-orbit" aria-hidden="true"><i></i></span>
                <span class="search-loading-label" data-en-text="Searching the index…" data-th-text="กำลังค้นหาข้อมูล…">Searching the index…</span>
                <span class="search-loading-track" aria-hidden="true"><i></i></span>
            </div>
        `;
    }

    async function loadResults(url, { pushHistory = false } = {}) {
        activeRequest?.abort();
        const controller = new AbortController();
        activeRequest = controller;
        const requestedUrl = new URL(url, window.location.href);
        lastRequestedUrl = requestedUrl.href;
        results.setAttribute('aria-busy', 'true');
        results.innerHTML = loadingMarkup();
        window.applySiteLanguage?.(results);

        try {
            const response = await fetch(requestedUrl, {
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`Search request failed with status ${response.status}`);
            const html = await response.text();
            if (controller.signal.aborted) return;

            results.innerHTML = html;
            results.setAttribute('aria-busy', 'false');
            window.applySiteLanguage?.(results);
            if (pushHistory) window.history.pushState({}, '', requestedUrl);
        } catch (error) {
            if (error.name === 'AbortError') return;
            const message = window.siteTranslate
                ? window.siteTranslate('Could not load search results.', 'ไม่สามารถโหลดผลการค้นหาได้')
                : 'Could not load search results.';
            results.innerHTML = `
                <div class="search-load-error" role="alert">
                    <span>${message}</span>
                    <button type="button" data-search-retry>${window.siteTranslate ? window.siteTranslate('Try again', 'ลองอีกครั้ง') : 'Try again'}</button>
                </div>
            `;
            results.setAttribute('aria-busy', 'false');
        } finally {
            if (activeRequest === controller) activeRequest = null;
        }
    }

    form.addEventListener('submit', event => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        const query = form.querySelector('input[name="q"]');
        if (query) query.value = query.value.trim();
        const url = new URL(form.action, window.location.href);
        new FormData(form).forEach((value, key) => url.searchParams.set(key, String(value)));
        url.searchParams.delete('page');
        loadResults(url, { pushHistory: true });
    });

    form.querySelector('a[href="/"]')?.addEventListener('click', event => {
        event.preventDefault();
        form.reset();
        loadResults('/', { pushHistory: true });
    });

    results.addEventListener('click', event => {
        const retry = event.target.closest('[data-search-retry]');
        if (retry) {
            loadResults(lastRequestedUrl);
            return;
        }
        const link = event.target.closest('.index-pagination a');
        if (!link || link.origin !== window.location.origin) return;
        event.preventDefault();
        loadResults(link.href, { pushHistory: true });
    });

    window.addEventListener('popstate', () => {
        if (window.location.pathname !== '/' && window.location.pathname !== '/search') return;
        const params = new URLSearchParams(window.location.search);
        form.elements.q.value = params.get('q') || '';
        form.elements.service.value = params.get('service') || '';
        loadResults(window.location.href);
    });
})();
