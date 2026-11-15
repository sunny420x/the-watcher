(() => {
    const form = document.querySelector('.summary-refresh-form');
    const button = document.querySelector('.summary-refresh-button');
    const statusLabel = document.getElementById('summary-refresh-status');
    const countdown = document.getElementById('summary-refresh-countdown');

    let pollTimer = null;

    function setRefreshingState(active) {
        if (!button) return;
        button.dataset.refreshing = active ? 'true' : 'false';
        button.disabled = active;
        button.setAttribute('data-en-text', active ? 'Summarizing…' : 'Re-summarize');
        button.setAttribute('data-th-text', active ? 'กำลังสรุปผล…' : 'สรุปใหม่');
        button.textContent = window.siteTranslate
            ? window.siteTranslate(active ? 'Summarizing…' : 'Re-summarize', active ? 'กำลังสรุปผล…' : 'สรุปใหม่')
            : (active ? 'Summarizing…' : 'Re-summarize');
        if (statusLabel) {
            statusLabel.hidden = !active;
        }
        if (active && countdown) {
            countdown.hidden = true;
        }
    }

    function startPollingStatus() {
        if (pollTimer) return;
        pollTimer = window.setInterval(async () => {
            try {
                const response = await fetch('/api/summary/status', {
                    headers: { 'Accept': 'application/json' }
                });
                if (!response.ok) return;
                const data = await response.json();
                if (!data.isRefreshing) {
                    window.clearInterval(pollTimer);
                    pollTimer = null;
                    window.location.reload();
                }
            } catch {
                // Keep polling until the background worker finishes.
            }
        }, 2500);
    }

    if (button && button.dataset.refreshing === 'true') {
        setRefreshingState(true);
        startPollingStatus();
    }

    if (form && button) {
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (button.disabled || button.dataset.refreshing === 'true') return;

            setRefreshingState(true);
            try {
                const response = await fetch(form.action, {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'X-Requested-With': 'XMLHttpRequest'
                    }
                });
                if (response.status === 429) {
                    window.location.reload();
                    return;
                }
                if (!response.ok) {
                    throw new Error(`Summary refresh failed (${response.status})`);
                }
                startPollingStatus();
            } catch (error) {
                console.error('Could not start summary refresh:', error);
                setRefreshingState(false);
            }
        });
    }

    if (!countdown || !button) return;

    const availableAt = Number(countdown.dataset.unlockAt);
    if (!Number.isFinite(availableAt)) return;

    function updateCountdown() {
        if (button.dataset.refreshing === 'true') return;
        const remaining = availableAt - Date.now();
        if (remaining <= 0) {
            button.disabled = false;
            countdown.remove();
            return;
        }

        const totalMinutes = Math.ceil(remaining / 60000);
        const days = Math.floor(totalMinutes / 1440);
        const hours = Math.floor((totalMinutes % 1440) / 60);
        const minutes = totalMinutes % 60;
        const time = window.siteLanguage() === 'th'
            ? [days ? `${days} วัน` : '', hours ? `${hours} ชม.` : '', minutes || (!days && !hours) ? `${minutes} นาที` : ''].filter(Boolean).join(' ')
            : [days ? `${days}d` : '', hours ? `${hours}h` : '', minutes || (!days && !hours) ? `${minutes}m` : ''].filter(Boolean).join(' ');
        const template = countdown.getAttribute(window.siteLanguage() === 'th' ? 'data-th-template' : 'data-en-template');
        countdown.textContent = template.replace('{time}', time);
        button.disabled = true;
    }

    updateCountdown();
    window.setInterval(updateCountdown, 1000);
    document.addEventListener('site-language-change', updateCountdown);
})();
