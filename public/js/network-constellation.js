(() => {
    const canvas = document.getElementById('myCanvas');
    const viewport = document.getElementById('wrapper');
    const ctx = canvas.getContext('2d');
    const status = document.getElementById('constellation-status');
    const state = {
        nodes: [], range: '', width: 0, height: 0, dpr: 1,
        zoom: 1, panX: 0, panY: 0, pointer: null, hover: null
    };

    const nodeRadius = 19;
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    function resize() {
        const bounds = viewport.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        state.width = bounds.width;
        state.height = bounds.height;
        state.dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(state.width * state.dpr);
        canvas.height = Math.round(state.height * state.dpr);
        canvas.style.width = `${state.width}px`;
        canvas.style.height = `${state.height}px`;
        draw();
    }

    function pointFromEvent(event) {
        const bounds = canvas.getBoundingClientRect();
        const x = event.clientX - bounds.left;
        const y = event.clientY - bounds.top;
        return {
            x: (x - state.width / 2 - state.panX) / state.zoom,
            y: (y - state.height / 2 - state.panY) / state.zoom
        };
    }

    function hitTest(point) {
        for (let index = state.nodes.length - 1; index >= 0; index--) {
            const node = state.nodes[index];
            if (Math.hypot(point.x - node.x, point.y - node.y) <= nodeRadius + 5) return node;
        }
        return null;
    }

    function draw() {
        if (!state.width || !state.height) return;
        ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
        ctx.clearRect(0, 0, state.width, state.height);
        ctx.save();
        ctx.translate(state.width / 2 + state.panX, state.height / 2 + state.panY);
        ctx.scale(state.zoom, state.zoom);

        const gridRadius = Math.max(state.width, state.height) / state.zoom;
        ctx.strokeStyle = 'rgba(157, 190, 169, .055)';
        ctx.lineWidth = 1 / state.zoom;
        for (let radius = 120; radius < gridRadius; radius += 120) {
            ctx.beginPath();
            ctx.arc(0, 0, radius, 0, Math.PI * 2);
            ctx.stroke();
        }

        state.nodes.forEach(node => {
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(node.x, node.y);
            ctx.strokeStyle = node === state.hover ? 'rgba(198, 243, 107, .55)' : 'rgba(120, 197, 177, .2)';
            ctx.lineWidth = (node === state.hover ? 1.7 : 1) / state.zoom;
            ctx.stroke();
        });

        state.nodes.forEach(node => {
            const selected = node === state.hover;
            ctx.beginPath();
            ctx.arc(node.x, node.y, nodeRadius + (selected ? 3 : 0), 0, Math.PI * 2);
            ctx.fillStyle = selected ? 'rgba(198, 243, 107, .23)' : 'rgba(67, 197, 162, .16)';
            ctx.fill();
            ctx.beginPath();
            ctx.arc(node.x, node.y, nodeRadius, 0, Math.PI * 2);
            ctx.fillStyle = selected ? '#c6f36b' : '#42c7a2';
            ctx.fill();
            ctx.strokeStyle = selected ? '#efffb9' : 'rgba(220, 255, 242, .72)';
            ctx.lineWidth = 1.5 / state.zoom;
            ctx.stroke();

            ctx.fillStyle = '#102019';
            ctx.font = `600 ${10 / state.zoom}px "DM Mono", monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(node.label.slice(-3), node.x, node.y);
            ctx.fillStyle = selected ? '#e9f7d9' : '#a9c5b7';
            ctx.font = `${11 / state.zoom}px "DM Mono", monospace`;
            ctx.textAlign = 'left';
            ctx.fillText(node.label, node.x + nodeRadius + 9 / state.zoom, node.y + 4 / state.zoom);
        });

        ctx.beginPath();
        ctx.arc(0, 0, 33, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(198, 243, 107, .13)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 0, 25, 0, Math.PI * 2);
        ctx.fillStyle = '#c6f36b';
        ctx.fill();
        ctx.strokeStyle = 'rgba(239, 255, 185, .9)';
        ctx.lineWidth = 1.5 / state.zoom;
        ctx.stroke();
        ctx.fillStyle = '#182216';
        ctx.font = `600 ${9 / state.zoom}px "DM Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('NET', 0, 0);
        ctx.restore();

        status.textContent = `${state.range} · ${state.nodes.length} web host${state.nodes.length === 1 ? '' : 's'} · ${Math.round(state.zoom * 100)}%`;
    }

    function render(hosts, range) {
        state.range = range;
        const count = hosts.length;
        const baseRadius = Math.max(125, Math.min(state.width, state.height) * 0.25);
        state.nodes = hosts.map((host, index) => {
            const ring = Math.floor(index / 16);
            const ringStart = ring * 16;
            const ringCount = Math.min(16, count - ringStart);
            const angle = ((index - ringStart) / Math.max(ringCount, 1)) * Math.PI * 2 - Math.PI / 2;
            const radius = baseRadius + ring * 92;
            const url = new URL(host.host, window.location.origin);
            return {
                host: url.href,
                label: url.host,
                x: Math.cos(angle) * radius,
                y: Math.sin(angle) * radius
            };
        });
        state.zoom = 1;
        state.panX = 0;
        state.panY = 0;
        resize();
        draw();
    }

    function zoomAt(factor, clientX, clientY) {
        const bounds = canvas.getBoundingClientRect();
        const x = clientX === undefined ? state.width / 2 : clientX - bounds.left;
        const y = clientY === undefined ? state.height / 2 : clientY - bounds.top;
        const worldX = (x - state.width / 2 - state.panX) / state.zoom;
        const worldY = (y - state.height / 2 - state.panY) / state.zoom;
        const nextZoom = clamp(state.zoom * factor, 0.35, 3.5);
        state.panX = x - state.width / 2 - worldX * nextZoom;
        state.panY = y - state.height / 2 - worldY * nextZoom;
        state.zoom = nextZoom;
        draw();
    }

    canvas.addEventListener('pointerdown', event => {
        const point = pointFromEvent(event);
        state.pointer = {
            id: event.pointerId, x: event.clientX, y: event.clientY,
            lastX: event.clientX, lastY: event.clientY,
            node: hitTest(point), moved: false
        };
        canvas.setPointerCapture(event.pointerId);
        canvas.classList.add(state.pointer.node ? 'dragging-node' : 'panning');
    });

    canvas.addEventListener('pointermove', event => {
        const point = pointFromEvent(event);
        if (state.pointer && state.pointer.id === event.pointerId) {
            const dx = event.clientX - state.pointer.lastX;
            const dy = event.clientY - state.pointer.lastY;
            if (Math.hypot(event.clientX - state.pointer.x, event.clientY - state.pointer.y) > 3) state.pointer.moved = true;
            if (state.pointer.node) {
                state.pointer.node.x += dx / state.zoom;
                state.pointer.node.y += dy / state.zoom;
            } else {
                state.panX += dx;
                state.panY += dy;
            }
            state.pointer.lastX = event.clientX;
            state.pointer.lastY = event.clientY;
            draw();
            return;
        }
        state.hover = hitTest(point);
        canvas.style.cursor = state.hover ? 'pointer' : 'grab';
        draw();
    });

    function finishPointer(event) {
        if (!state.pointer || state.pointer.id !== event.pointerId) return;
        const { node, moved } = state.pointer;
        state.pointer = null;
        canvas.classList.remove('dragging-node', 'panning');
        if (node && !moved) window.previewHost(node.host);
        draw();
    }

    canvas.addEventListener('pointerup', finishPointer);
    canvas.addEventListener('pointercancel', finishPointer);
    canvas.addEventListener('wheel', event => {
        event.preventDefault();
        zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX, event.clientY);
    }, { passive: false });

    window.addEventListener('resize', resize);
    new ResizeObserver(resize).observe(viewport);

    window.networkConstellation = {
        render,
        clear() { state.nodes = []; draw(); },
        resize,
        zoomBy(factor) { zoomAt(factor); },
        resetView() { state.zoom = 1; state.panX = 0; state.panY = 0; draw(); }
    };
    resize();
})();
