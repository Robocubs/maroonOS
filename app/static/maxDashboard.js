function initMax(printerIds) {
    const overlay = document.getElementById('overlay');
    const panels = document.querySelectorAll('.panel');
    const printing = [false, false, false];

    const overlayPlayer = typeof ScreensaverPlayerMax !== 'undefined'
        ? new ScreensaverPlayerMax(overlay, '/config/api/playlist/max', 'landscape')
        : null;

    function updateOverlay() {
        const anyPrinting = printing.some(Boolean);
        if (anyPrinting) {
            overlay.style.display = 'none';
            if (overlayPlayer) overlayPlayer.stop();
        } else {
            overlay.style.display = '';
            if (overlayPlayer) overlayPlayer.start();
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

    panels.forEach((panel, i) => {
        new Dashboard(printerIds[i], panel, {
            onStateChange(isPrinting) {
                printing[i] = isPrinting;
                updateOverlay();
            },
            makeScreensaverPlayer: (el) =>
                new ScreensaverPlayerMax(el, '/config/api/playlist/max', 'portrait'),
        });
    });

    updateOverlay();
}
