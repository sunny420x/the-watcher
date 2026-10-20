(() => {
    const countdown = document.getElementById('summary-refresh-countdown');
    if (!countdown) return;

    const button = document.querySelector('.summary-refresh-button');
    const availableAt = Number(countdown.dataset.unlockAt);
    if (!button || !Number.isFinite(availableAt)) return;

    function updateCountdown() {
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
