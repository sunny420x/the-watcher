(() => {
    const canvas = document.querySelector('.search-hero-grid');
    const hero = canvas?.closest('.search-hero');
    const context = canvas?.getContext('2d');
    if (!canvas || !hero || !context) return;

    const spacing = 22;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pointer = { x: -1000, y: -1000, leftAt: 0, inside: false };
    let width = 0;
    let height = 0;
    let frame = 0;
    let startedAt = performance.now();
    let dotColor = '#76d7d1';

    function resize() {
        cancelAnimationFrame(frame);
        const bounds = hero.getBoundingClientRect();
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        width = bounds.width;
        height = bounds.height;
        dotColor = getComputedStyle(document.documentElement).getPropertyValue('--cyan').trim() || dotColor;
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        canvas.classList.add('is-active');
        draw(performance.now());
    }

    function draw(now) {
        context.clearRect(0, 0, width, height);
        context.fillStyle = dotColor;

        const elapsed = now - startedAt;
        const pullFade = pointer.inside ? 1 : Math.exp(-(now - pointer.leftAt) / 500);

        for (let y = 10; y < height; y += spacing) {
            for (let x = 10; x < width; x += spacing) {
                const baseWave = Math.sin((x + y * 0.4) * 0.022 - elapsed * 0.0012) * 3.5
                    + Math.sin(x * 0.014 - y * 0.018 + elapsed * 0.001) * 2.5;
                const dx = x - pointer.x;
                const dy = y - pointer.y;
                const distance = Math.hypot(dx, dy);
                const pull = Math.exp(-distance / 135) * pullFade * 12;
                const direction = distance ? 1 / distance : 0;
                const dotX = x - dx * direction * pull;
                const dotY = y + baseWave - dy * direction * pull;

                context.globalAlpha = 0.3 + Math.min(0.12, pull * 0.01);
                context.beginPath();
                context.arc(dotX, dotY, 1.15, 0, Math.PI * 2);
                context.fill();
            }
        }
        context.globalAlpha = 1;

        if (!reduceMotion.matches) frame = requestAnimationFrame(draw);
    }

    hero.addEventListener('pointermove', event => {
        if (event.pointerType === 'touch' || reduceMotion.matches) return;
        const bounds = hero.getBoundingClientRect();
        pointer.x = event.clientX - bounds.left;
        pointer.y = event.clientY - bounds.top;
        pointer.inside = true;
    });

    hero.addEventListener('pointerleave', () => {
        pointer.inside = false;
        pointer.leftAt = performance.now();
    });

    reduceMotion.addEventListener('change', () => {
        cancelAnimationFrame(frame);
        startedAt = performance.now();
        draw(performance.now());
    });

    new MutationObserver(resize).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    new ResizeObserver(resize).observe(hero);
    resize();
})();
