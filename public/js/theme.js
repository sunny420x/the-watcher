(() => {
    const themeStorageKey = 'the-watcher-theme';
    let savedTheme = 'dark';

    try {
        const storedTheme = localStorage.getItem(themeStorageKey);
        if (storedTheme === 'light' || storedTheme === 'dark') {
            savedTheme = storedTheme;
        }
    } catch (error) {
        console.warn('Unable to read the saved theme preference:', error);
    }

    function updateTheme(theme) {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.colorScheme = theme;

        const themeColor = document.querySelector('meta[name="theme-color"]');
        if (themeColor) {
            themeColor.content = theme === 'light' ? '#f4f7f1' : '#0b100e';
        }

        const toggle = document.querySelector('.theme-toggle');
        if (toggle) {
            const nextTheme = theme === 'light' ? 'dark' : 'light';
            const sunIcon = toggle.querySelector('.theme-icon-sun');
            const moonIcon = toggle.querySelector('.theme-icon-moon');
            if (sunIcon) sunIcon.hidden = nextTheme !== 'light';
            if (moonIcon) moonIcon.hidden = nextTheme !== 'dark';
            toggle.setAttribute('aria-label', `Switch to ${nextTheme} theme`);
            toggle.setAttribute('aria-pressed', String(theme === 'light'));
        }
    }

    updateTheme(savedTheme);
    document.addEventListener('DOMContentLoaded', () => updateTheme(savedTheme));
    document.addEventListener('click', event => {
        const toggle = event.target.closest('.theme-toggle');
        if (!toggle) return;

        const nextTheme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
        updateTheme(nextTheme);

        try {
            localStorage.setItem(themeStorageKey, nextTheme);
        } catch (error) {
            console.warn('Unable to save the theme preference:', error);
        }
    });
})();
