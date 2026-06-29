function initMax(printerIds) {
    const overlay = document.getElementById('overlay');
    const panels = document.querySelectorAll('.panel');
    const printing = [false, false, false];

    function updateOverlay() {
        const anyPrinting = printing.some(Boolean);
        overlay.style.display = anyPrinting ? 'none' : '';
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
            }
        });
    });

    updateOverlay();
}
