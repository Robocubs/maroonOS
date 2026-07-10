function initMax(printerIds) {
    const overlay = document.getElementById('overlay');
    const panels = document.querySelectorAll('.panel');
    const printing = [false, false, false];

    const overlayPlayer = typeof ScreensaverPlayerMax !== 'undefined'
        ? new ScreensaverPlayerMax(overlay, '/config/api/playlist/max', 'landscape')
        : null;

    // The overlay fully covers #panels when shown, so panel screensavers
    // playing underneath it are invisible — leaving them running wastes a
    // video decode per hidden panel (no hardware decode block on the Pi),
    // which starves the CPU and makes the one visible screensaver (overlay
    // or a still-idle panel) stutter and drift out of clock-anchored sync.
    // Only run a panel's own screensaver when that panel is actually
    // visible: overlay hidden (someone printing) and that panel idle.
    function updateOverlay() {
        const anyPrinting = printing.some(Boolean);
        if (anyPrinting) {
            overlay.style.display = 'none';
            if (overlayPlayer) overlayPlayer.stop();
            dashboards.forEach((d, i) => {
                if (!printing[i] && d.screensaverPlayer) d.screensaverPlayer.start();
            });
        } else {
            overlay.style.display = '';
            if (overlayPlayer) overlayPlayer.start();
            dashboards.forEach(d => { if (d.screensaverPlayer) d.screensaverPlayer.stop(); });
        }
    }

    function applyScale() {
        const { width: pw, height: ph } = panels[0].getBoundingClientRect();
        const scale = Math.min(pw / 1440, ph / 2560);
        panels.forEach(panel => {
            const inner = panel.querySelector('.panel-inner');
            inner.style.transformOrigin = 'top left';
            inner.style.transform = `scale(${scale})`;
        });
    }

    applyScale();
    window.addEventListener('resize', applyScale);

    const dashboards = Array.from(panels).map((panel, i) =>
        new Dashboard(printerIds[i], panel, {
            onStateChange(isPrinting) {
                printing[i] = isPrinting;
                updateOverlay();
            },
            makeScreensaverPlayer: (el) =>
                new ScreensaverPlayerMax(el, '/config/api/playlist/max', 'portrait'),
        })
    );

    updateOverlay();
}
