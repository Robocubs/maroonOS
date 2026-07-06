
class ConfigDashboard {
    constructor() {
        this.mode = document.body.dataset.mode || 'reg';
        this._currentSection = 'printers';
        this._mediaItems = [];
        this._mediaFilter = 'all';
        this._mpFilter = 'all';
        this._activePickerTarget = null; // { panelKey, list }
        this._playlistDebounce = {};
        this._peerDebounce = null;
        this._networkBound = false;

        this._bindNav();
        this._bindMediaUpload();
        this._bindMediaPicker();
        this._showSection('printers');
    }

    // ---- Navigation ----

    _bindNav() {
        document.querySelectorAll('.nav-item').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._showSection(btn.dataset.section);
            });
        });
    }

    _showSection(name) {
        this._currentSection = name;
        document.querySelectorAll('.section').forEach(s => s.classList.add('hidden'));
        document.getElementById(`section-${name}`).classList.remove('hidden');

        if (name === 'printers') this._loadPrinters();
        if (name === 'media') this._loadMedia();
        if (name === 'playlist') this._loadPlaylist();
        if (name === 'network') this._loadNetwork();
    }

    // ---- Printers ----

    async _loadPrinters() {
        const container = document.getElementById('printer-cards');
        container.innerHTML = '<div class="media-empty">Loading...</div>';
        try {
            const printers = await this._fetch('/config/api/printers');
            // In reg mode only show printer 1; in max mode show all configured + unconfigured up to 3
            const ids = this.mode === 'reg' ? [1] : [1, 2, 3];
            const byId = Object.fromEntries(printers.map(p => [p.id, p]));
            container.innerHTML = '';
            ids.forEach(id => {
                const p = byId[id] || { id, name: `Printer ${id}`, firmware: '', ip: '', api_key: '' };
                container.appendChild(this._buildPrinterCard(p));
            });
        } catch (e) {
            container.innerHTML = `<div class="media-empty" style="color:#c0392b">Failed to load printers: ${e.message}</div>`;
        }
    }

    _buildPrinterCard(p) {
        const card = document.createElement('div');
        card.className = 'printer-card';
        card.dataset.printerId = p.id;
        card.innerHTML = `
            <div class="printer-card-header">
                <div class="printer-badge">${p.id}</div>
                <div class="printer-name-display" id="pname-display-${p.id}">${this._esc(p.name)}</div>
                <div class="status-dot" id="status-dot-${p.id}"></div>
            </div>
            <div class="printer-form-grid">
                <div class="form-field">
                    <label class="form-label">Printer Name</label>
                    <input class="form-input" type="text" id="pname-${p.id}" value="${this._esc(p.name)}">
                </div>
                <div class="form-field">
                    <label class="form-label">Firmware</label>
                    <input class="form-input" type="text" id="pfirmware-${p.id}" value="${this._esc(p.firmware)}">
                </div>
                <div class="form-field">
                    <label class="form-label">IP Address</label>
                    <input class="form-input" type="text" id="pip-${p.id}" value="${this._esc(p.ip)}" placeholder="192.168.1.100">
                </div>
                <div class="form-field">
                    <label class="form-label">API Key</label>
                    <div class="input-wrap">
                        <input class="form-input" type="password" id="papikey-${p.id}" value="${this._esc(p.api_key)}" placeholder="••••••••">
                        <button class="toggle-pw" data-target="papikey-${p.id}" title="Show/hide">&#128065;</button>
                    </div>
                </div>
            </div>
            <div class="printer-actions">
                <button class="btn btn-secondary" id="test-btn-${p.id}">Test Connection</button>
                <button class="btn btn-primary" id="save-btn-${p.id}">Save</button>
                <span class="test-result" id="test-result-${p.id}"></span>
            </div>
        `;

        // Sync name display to input
        card.querySelector(`#pname-${p.id}`).addEventListener('input', e => {
            card.querySelector(`#pname-display-${p.id}`).textContent = e.target.value || `Printer ${p.id}`;
        });

        // Show/hide password toggle
        card.querySelector('.toggle-pw').addEventListener('click', e => {
            const input = card.querySelector(`#${e.currentTarget.dataset.target}`);
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        // Test connection
        card.querySelector(`#test-btn-${p.id}`).addEventListener('click', () => {
            this._testPrinter(p.id, card);
        });

        // Save
        card.querySelector(`#save-btn-${p.id}`).addEventListener('click', () => {
            this._savePrinter(p.id, card);
        });

        return card;
    }

    async _testPrinter(id, card) {
        const btn = card.querySelector(`#test-btn-${id}`);
        const result = card.querySelector(`#test-result-${id}`);
        const dot = card.querySelector(`#status-dot-${id}`);

        btn.disabled = true;
        btn.textContent = 'Testing...';
        result.className = 'test-result';
        result.textContent = '';

        try {
            const data = await this._fetch(`/config/api/printers/${id}/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ip: card.querySelector(`#pip-${id}`).value.trim(),
                    api_key: card.querySelector(`#papikey-${id}`).value.trim(),
                }),
            });
            if (data.success) {
                result.className = 'test-result success';
                result.textContent = `✓ Connected — ${data.state}`;
                dot.className = 'status-dot connected';
            } else {
                result.className = 'test-result error';
                result.textContent = `✗ ${data.error}`;
                dot.className = 'status-dot failed';
            }
        } catch (e) {
            result.className = 'test-result error';
            result.textContent = `✗ ${e.message}`;
            dot.className = 'status-dot failed';
        } finally {
            btn.disabled = false;
            btn.textContent = 'Test Connection';
        }
    }

    async _savePrinter(id, card) {
        const btn = card.querySelector(`#save-btn-${id}`);
        btn.disabled = true;
        btn.textContent = 'Saving...';
        try {
            await this._fetch(`/config/api/printers/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: card.querySelector(`#pname-${id}`).value.trim(),
                    firmware: card.querySelector(`#pfirmware-${id}`).value.trim(),
                    ip: card.querySelector(`#pip-${id}`).value.trim(),
                    api_key: card.querySelector(`#papikey-${id}`).value.trim(),
                }),
            });
            btn.textContent = 'Saved ✓';
            setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1800);
        } catch (e) {
            btn.textContent = 'Error — retry';
            btn.disabled = false;
        }
    }

    // ---- Media ----

    async _loadMedia() {
        try {
            this._mediaItems = await this._fetch('/config/api/media');
            this._renderMedia();
        } catch (e) {
            document.getElementById('media-grid').innerHTML =
                `<div class="media-empty" style="color:#c0392b">Failed to load media: ${e.message}</div>`;
        }
    }

    _renderMedia(target = 'media-grid') {
        const grid = document.getElementById(target);
        const filter = target === 'media-grid' ? this._mediaFilter : this._mpFilter;
        const items = this._mediaItems.filter(m => filter === 'all' || m.type === filter);

        if (!items.length) {
            grid.innerHTML = '<div class="media-empty">No media files found.</div>';
            return;
        }

        grid.innerHTML = '';
        items.forEach(m => {
            const card = document.createElement('div');
            card.className = 'media-card';
            card.dataset.filename = m.filename;

            const preview = m.type === 'image'
                ? `<img class="media-preview" src="${m.path}" alt="${this._esc(m.filename)}">`
                : `<video class="media-preview" src="${m.path}" muted preload="metadata"></video>`;

            card.innerHTML = `
                ${preview}
                <div class="media-info">
                    <div class="media-filename">${this._esc(m.filename)}</div>
                    <div class="media-meta">${this._fmtSize(m.size_bytes)}</div>
                </div>
                ${target === 'media-grid' ? `<button class="media-delete" title="Delete">&times;</button>` : ''}
            `;

            if (target === 'media-grid') {
                const deleteBtn = card.querySelector('.media-delete');
                let confirmTimer = null;
                deleteBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    if (deleteBtn.classList.contains('confirming')) {
                        clearTimeout(confirmTimer);
                        this._deleteMedia(m.filename, card);
                    } else {
                        deleteBtn.classList.add('confirming');
                        deleteBtn.textContent = '?';
                        confirmTimer = setTimeout(() => {
                            deleteBtn.classList.remove('confirming');
                            deleteBtn.textContent = '×';
                        }, 3000);
                    }
                });
                // Clicking elsewhere on the card cancels the confirm state
                card.addEventListener('click', () => {
                    if (deleteBtn.classList.contains('confirming')) {
                        clearTimeout(confirmTimer);
                        deleteBtn.classList.remove('confirming');
                        deleteBtn.textContent = '×';
                    }
                });
            } else {
                // In picker mode, clicking adds to playlist
                card.addEventListener('click', () => this._pickerAddItem(m));
            }

            grid.appendChild(card);
        });
    }

    async _deleteMedia(filename, card) {
        // Optimistic removal — instant feedback, restore on error
        this._mediaItems = this._mediaItems.filter(m => m.filename !== filename);
        card.style.opacity = '0.3';
        card.style.pointerEvents = 'none';
        document.querySelectorAll(`.playlist-item[data-filename="${CSS.escape(filename)}"]`).forEach(el => {
            const list = el.parentElement;
            el.remove();
            const countEl = document.getElementById(list.id.replace('list-', 'count-'));
            if (countEl) countEl.textContent = list.children.length;
        });
        try {
            await this._fetch(`/config/api/media/${encodeURIComponent(filename)}`, { method: 'DELETE' });
            card.remove();
        } catch (e) {
            // Restore on failure
            this._renderMedia();
            alert(`Delete failed: ${e.message}`);
        }
    }

    // ---- Upload ----

    _bindMediaUpload() {
        const zone = document.getElementById('upload-zone');
        const input = document.getElementById('file-input');

        zone.addEventListener('click', () => input.click());
        input.addEventListener('change', () => {
            if (input.files.length) this._uploadFiles(Array.from(input.files));
            input.value = '';
        });

        zone.addEventListener('dragover', e => {
            e.preventDefault();
            zone.classList.add('drag-over');
        });
        zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
        zone.addEventListener('drop', e => {
            e.preventDefault();
            zone.classList.remove('drag-over');
            if (e.dataTransfer.files.length) this._uploadFiles(Array.from(e.dataTransfer.files));
        });
    }

    async _uploadFiles(files) {
        const progressWrap = document.getElementById('upload-progress-wrap');
        const fill = document.getElementById('upload-progress-fill');
        const status = document.getElementById('upload-status');

        progressWrap.classList.remove('hidden');
        fill.style.width = '0%';

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            status.textContent = `Uploading ${file.name}...`;
            fill.style.width = `${Math.round(((i) / files.length) * 100)}%`;
            try {
                const form = new FormData();
                form.append('file', file);
                const res = await fetch('/config/api/media/upload', { method: 'POST', body: form });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({ detail: 'Upload failed' }));
                    status.textContent = `✗ ${file.name}: ${err.detail}`;
                    await new Promise(r => setTimeout(r, 1500));
                    continue;
                }
                const newItem = await res.json();
                this._mediaItems.push(newItem);
            } catch (e) {
                status.textContent = `✗ ${file.name}: ${e.message}`;
                await new Promise(r => setTimeout(r, 1500));
            }
        }

        fill.style.width = '100%';
        status.textContent = `Done — ${files.length} file${files.length > 1 ? 's' : ''} processed`;
        this._renderMedia();
        setTimeout(() => {
            progressWrap.classList.add('hidden');
            fill.style.width = '0%';
        }, 2000);
    }

    _bindMediaUploadFilter() {
        document.querySelectorAll('.filter-pills .pill[data-filter]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.filter-pills .pill[data-filter]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._mediaFilter = btn.dataset.filter;
                this._renderMedia();
            });
        });
    }

    // ---- Media picker modal ----

    _bindMediaPicker() {
        document.getElementById('media-picker-close').addEventListener('click', () => this._closePicker());
        document.querySelector('.modal-backdrop').addEventListener('click', () => this._closePicker());

        document.querySelectorAll('.pill[data-mpfilter]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.pill[data-mpfilter]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._mpFilter = btn.dataset.mpfilter;
                this._renderMedia('media-picker-grid');
            });
        });
    }

    _openPicker(target) {
        this._activePickerTarget = target;
        document.getElementById('media-picker-modal').classList.remove('hidden');
        this._renderMedia('media-picker-grid');
    }

    _closePicker() {
        document.getElementById('media-picker-modal').classList.add('hidden');
        this._activePickerTarget = null;
    }

    _pickerAddItem(mediaItem) {
        if (!this._activePickerTarget) return;
        const { onAdd } = this._activePickerTarget;
        onAdd({
            id: this._uuid(),
            filename: mediaItem.filename,
            type: mediaItem.type,
            path: mediaItem.path,
            duration_seconds: mediaItem.type === 'image' ? 10 : null,
        });
        this._closePicker();
    }

    // ---- Playlist ----

    async _loadPlaylist() {
        const container = document.getElementById('playlist-panels');
        container.innerHTML = '';
        try {
            if (this.mode === 'reg') {
                const items = await this._fetch('/config/api/playlist/reg');
                container.appendChild(this._buildPlaylistPanel('reg', 'Screensaver Playlist (Portrait)', items));
            } else {
                const data = await this._fetch('/config/api/playlist/max');
                container.appendChild(this._buildPlaylistPanel('max-portrait', 'Screensaver Playlist (Portrait)', data.portrait || []));
                container.appendChild(this._buildPlaylistPanel('max-landscape', 'Screensaver Playlist (Landscape)', data.landscape || []));
            }
        } catch (e) {
            container.innerHTML = `<div class="media-empty" style="color:#c0392b">Failed to load playlist: ${e.message}</div>`;
        }
    }

    _buildPlaylistPanel(key, title, items) {
        const panel = document.createElement('div');
        panel.className = 'playlist-panel';
        panel.dataset.key = key;

        const countId = `count-${key}`;
        const listId = `list-${key}`;
        const saveStatusId = `save-status-${key}`;

        panel.innerHTML = `
            <div class="playlist-panel-header">
                <div class="playlist-panel-title">${title}</div>
                <div class="playlist-count" id="${countId}">${items.length}</div>
            </div>
            <div class="playlist-list" id="${listId}"></div>
            <div class="playlist-actions">
                <button class="btn btn-secondary btn-sm" id="add-btn-${key}">+ Add from Library</button>
                <button class="btn btn-primary btn-sm" id="save-btn-${key}">Save Playlist</button>
                <span class="save-status" id="${saveStatusId}">Saved ✓</span>
            </div>
        `;

        const list = panel.querySelector(`#${listId}`);
        const count = panel.querySelector(`#${countId}`);

        const updateCount = () => { count.textContent = list.children.length; };

        const rerender = () => {
            list.innerHTML = '';
            this._getListItems(list).forEach(item => {
                // re-add from stored data
            });
        };

        // Render initial items
        items.forEach(item => list.appendChild(this._buildPlaylistItem(item, list, updateCount, key)));
        updateCount();

        // Add from library
        panel.querySelector(`#add-btn-${key}`).addEventListener('click', () => {
            this._openPicker({ onAdd: item => {
                list.appendChild(this._buildPlaylistItem(item, list, updateCount, key));
                updateCount();
                this._scheduleAutoSave(key, list);
            }});
        });

        // Save
        panel.querySelector(`#save-btn-${key}`).addEventListener('click', async () => {
            await this._savePlaylistFromList(key, list);
            const ss = panel.querySelector(`#${saveStatusId}`);
            ss.classList.add('visible');
            setTimeout(() => ss.classList.remove('visible'), 2000);
        });

        return panel;
    }

    _buildPlaylistItem(item, list, updateCount, panelKey) {
        const el = document.createElement('div');
        el.className = 'playlist-item';
        el.dataset.id = item.id;
        el.dataset.filename = item.filename;
        el.dataset.type = item.type;
        el.dataset.path = item.path;
        el.dataset.duration = item.duration_seconds ?? '';

        const thumbSrc = item.type === 'image' ? item.path : item.path;
        const thumbTag = item.type === 'image'
            ? `<img class="playlist-thumb" src="${item.path}" alt="">`
            : `<video class="playlist-thumb" src="${item.path}" muted preload="metadata"></video>`;

        const durationHtml = item.type === 'image'
            ? `<div class="duration-wrap">
                 <input class="duration-input" type="number" min="1" value="${item.duration_seconds ?? 10}">
                 <span>sec</span>
               </div>`
            : `<span style="font-style:italic;color:var(--grey);font-size:0.8rem">&#9654; Full video</span>`;

        el.innerHTML = `
            <div class="drag-handle">&#9776;</div>
            ${thumbTag}
            <div class="playlist-item-info">
                <div class="playlist-item-name">${this._esc(item.filename)}</div>
                <div class="playlist-item-meta">
                    <span class="type-badge ${item.type}">${item.type}</span>
                    ${durationHtml}
                </div>
            </div>
            <button class="playlist-item-remove" title="Remove">&times;</button>
        `;

        // Duration change auto-save
        if (item.type === 'image') {
            const durInput = el.querySelector('.duration-input');
            durInput.addEventListener('change', () => {
                el.dataset.duration = durInput.value;
                this._scheduleAutoSave(panelKey, list);
            });
        }

        // Remove
        el.querySelector('.playlist-item-remove').addEventListener('click', () => {
            el.remove();
            updateCount();
            this._scheduleAutoSave(panelKey, list);
        });

        // Drag and drop
        this._bindDragItem(el, list, () => {
            updateCount();
            this._scheduleAutoSave(panelKey, list);
        });

        return el;
    }

    _bindDragItem(el, list, onReorder) {
        el.setAttribute('draggable', 'true');

        el.addEventListener('dragstart', e => {
            el.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });

        el.addEventListener('dragend', () => {
            el.classList.remove('dragging');
            list.querySelectorAll('.playlist-item').forEach(i => i.classList.remove('drag-over'));
            onReorder();
        });

        el.addEventListener('dragover', e => {
            e.preventDefault();
            const dragging = list.querySelector('.dragging');
            if (!dragging || dragging === el) return;
            list.querySelectorAll('.playlist-item').forEach(i => i.classList.remove('drag-over'));
            el.classList.add('drag-over');
            const rect = el.getBoundingClientRect();
            const mid = rect.top + rect.height / 2;
            if (e.clientY < mid) {
                list.insertBefore(dragging, el);
            } else {
                list.insertBefore(dragging, el.nextSibling);
            }
        });

        el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    }

    _getListItems(list) {
        return Array.from(list.querySelectorAll('.playlist-item')).map(el => ({
            id: el.dataset.id,
            filename: el.dataset.filename,
            type: el.dataset.type,
            path: el.dataset.path,
            duration_seconds: el.dataset.type === 'image'
                ? (parseInt(el.querySelector('.duration-input')?.value) || 10)
                : null,
        }));
    }

    _scheduleAutoSave(key, list) {
        clearTimeout(this._playlistDebounce[key]);
        this._playlistDebounce[key] = setTimeout(() => this._savePlaylistFromList(key, list), 500);
    }

    async _savePlaylistFromList(key, list) {
        const items = this._getListItems(list);
        try {
            if (this.mode === 'reg') {
                await this._fetch('/config/api/playlist/reg', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(items),
                });
            } else {
                const portraitList = document.getElementById('list-max-portrait');
                const landscapeList = document.getElementById('list-max-landscape');
                const portrait = key === 'max-portrait' ? items : this._getListItems(portraitList);
                const landscape = key === 'max-landscape' ? items : this._getListItems(landscapeList);
                await this._fetch('/config/api/playlist/max', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ portrait, landscape }),
                });
            }
        } catch (e) {
            console.error('Playlist auto-save failed:', e);
        }
    }

    // ---- Network ----

    async _loadNetwork() {
        try {
            const settings = await this._fetch('/config/api/settings');
            document.getElementById('sync-enabled-toggle').checked = !!settings.sync_enabled;
            document.getElementById('push-playlist-toggle').checked = !!settings.push_playlist_enabled;
            this._renderPeerList(settings.peer_ips || []);
        } catch (e) {
            document.getElementById('peer-list').innerHTML =
                `<div class="media-empty" style="color:#c0392b">Failed to load settings: ${e.message}</div>`;
        }
        this._updateSyncGroupDisplay();
        this._bindNetworkOnce();
    }

    _updateSyncGroupDisplay() {
        const el = document.getElementById('sync-group-value');
        const key = window.screensaverState?.syncGroupKey;
        el.textContent = key || 'Computed after playback starts';
        el.classList.toggle('sync-group-pending', !key);
    }

    _bindNetworkOnce() {
        if (this._networkBound) return;
        this._networkBound = true;

        document.getElementById('sync-enabled-toggle').addEventListener('change', async () => {
            await this._saveSyncSettings();
            const ss = document.getElementById('sync-toggle-save-status');
            ss.classList.add('visible');
            setTimeout(() => ss.classList.remove('visible'), 2000);
        });

        document.getElementById('sync-group-refresh').addEventListener('click', () => {
            this._updateSyncGroupDisplay();
        });

        document.getElementById('add-peer-btn').addEventListener('click', () => {
            this._addPeerRow('');
        });

        document.getElementById('push-playlist-toggle').addEventListener('change', () => {
            this._scheduleSavePeers();
        });

        document.getElementById('save-peers-btn').addEventListener('click', async () => {
            const btn = document.getElementById('save-peers-btn');
            btn.disabled = true;
            await this._saveSyncSettings();
            btn.disabled = false;
            const ss = document.getElementById('peers-save-status');
            ss.classList.add('visible');
            setTimeout(() => ss.classList.remove('visible'), 2000);
            this._clearSyncTestResults();
        });

        document.getElementById('test-sync-btn').addEventListener('click', () => this._runSyncTest());
    }

    _renderPeerList(ips) {
        const list = document.getElementById('peer-list');
        list.innerHTML = '';
        if (ips.length === 0) {
            this._addPeerRow('');
        } else {
            ips.forEach(ip => this._addPeerRow(ip));
        }
    }

    _addPeerRow(ip) {
        const list = document.getElementById('peer-list');
        const row = document.createElement('div');
        row.className = 'peer-row';
        row.innerHTML = `
            <input class="form-input peer-input" type="text" value="${this._esc(ip)}" placeholder="192.168.1.21">
            <button class="playlist-item-remove" title="Remove">&times;</button>
        `;
        row.querySelector('.peer-input').addEventListener('input', () => this._scheduleSavePeers());
        row.querySelector('.playlist-item-remove').addEventListener('click', () => {
            row.remove();
            this._scheduleSavePeers();
        });
        list.appendChild(row);
    }

    _getPeerIps() {
        return Array.from(document.querySelectorAll('#peer-list .peer-input'))
            .map(i => i.value.trim())
            .filter(Boolean);
    }

    _scheduleSavePeers() {
        clearTimeout(this._peerDebounce);
        this._peerDebounce = setTimeout(() => {
            this._saveSyncSettings();
            this._clearSyncTestResults();
        }, 500);
    }

    async _saveSyncSettings() {
        try {
            return await this._fetch('/config/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sync_enabled: document.getElementById('sync-enabled-toggle').checked,
                    push_playlist_enabled: document.getElementById('push-playlist-toggle').checked,
                    peer_ips: this._getPeerIps(),
                }),
            });
        } catch (e) {
            console.error('Settings auto-save failed:', e);
            return null;
        }
    }

    _clearSyncTestResults() {
        document.getElementById('sync-test-results').innerHTML = '';
        const btn = document.getElementById('test-sync-btn');
        btn.textContent = 'Test Sync';
    }

    async _runSyncTest() {
        const btn = document.getElementById('test-sync-btn');
        const results = document.getElementById('sync-test-results');
        btn.disabled = true;
        btn.textContent = 'Testing…';
        results.innerHTML = '';

        const targets = [{ label: 'This Pi', url: '/config/api/sync/test' }]
            .concat(this._getPeerIps().map(ip => ({ label: ip, url: `http://${ip}:8080/config/api/sync/test` })));

        const settled = await Promise.allSettled(
            targets.map(t => this._fetch(t.url).then(data => ({ ...t, data })))
        );

        const rows = settled.map((r, i) => r.status === 'fulfilled'
            ? r.value
            : { ...targets[i], error: r.reason?.message || 'Unreachable' });

        this._renderSyncResults(rows);

        btn.disabled = false;
        btn.textContent = 'Retest';
    }

    _renderSyncResults(rows) {
        const results = document.getElementById('sync-test-results');
        results.innerHTML = '';

        const thisPi = rows.find(r => r.label === 'This Pi' && r.data);
        const reachable = rows.filter(r => r.data);
        const unreachable = rows.filter(r => r.error);
        const groups = new Set(reachable.map(r => r.data.sync_group));

        rows.forEach(r => {
            const row = document.createElement('div');
            row.className = 'sync-result-row';
            if (r.error) {
                row.innerHTML = `
                    <div class="sync-result-label">${this._esc(r.label)}</div>
                    <span class="sync-badge unreachable">Unreachable</span>
                `;
            } else {
                const pct = Math.min(100, (r.data.position_ms / r.data.total_duration_ms) * 100);
                const sameGroup = thisPi ? r.data.sync_group === thisPi.data.sync_group : false;
                const offsetSec = Math.round(r.data.offset_ms / 1000);
                row.innerHTML = `
                    <div class="sync-result-label">${this._esc(r.label)}</div>
                    <span class="sync-badge ${sameGroup ? 'match' : 'differ'}">${r.data.sync_group}</span>
                    <div class="upload-progress-bar sync-progress-bar">
                        <div class="upload-progress-fill" style="width:${pct}%; background-color:${sameGroup ? 'var(--prusa-orange)' : 'var(--grey)'}"></div>
                    </div>
                    <div class="sync-result-meta">Item ${r.data.item_index} of ${r.data.item_count} · +${offsetSec}s offset</div>
                `;
            }
            results.appendChild(row);
        });

        const summary = document.createElement('div');
        summary.className = 'sync-summary';

        if (unreachable.length && reachable.length <= 1) {
            summary.classList.add('warn');
            summary.textContent = `Could not reach ${unreachable.length} peer(s).`;
        } else if (groups.size > 1) {
            summary.classList.add('neutral');
            summary.textContent = 'Displays are in different sync groups and will play independently.';
        } else {
            const positions = reachable.map(r => r.data.position_ms);
            const spread = positions.length > 1 ? Math.max(...positions) - Math.min(...positions) : 0;
            if (spread <= 500) {
                summary.classList.add('ok');
                summary.textContent = '✓ In sync';
            } else {
                summary.classList.add('warn');
                summary.textContent = `⚠ Same group, drift detected (${Math.round(spread)}ms) — check NTP on each Pi`;
            }
        }
        results.prepend(summary);

        if (unreachable.length) {
            const unreachLine = document.createElement('div');
            unreachLine.className = 'sync-summary warn';
            unreachLine.textContent = `⚠ Could not reach: ${unreachable.map(r => r.label).join(', ')}`;
            results.appendChild(unreachLine);
        }

        if (reachable.some(r => r.data.video_durations_estimated)) {
            const estNote = document.createElement('div');
            estNote.className = 'sync-summary estimate-note';
            estNote.textContent = 'Video durations were estimated — test accuracy may vary.';
            results.appendChild(estNote);
        }
    }

    // ---- Helpers ----

    async _fetch(url, opts = {}) {
        const res = await fetch(url, opts);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        return res.json();
    }

    _esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    _fmtSize(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    _uuid() {
        return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const dash = new ConfigDashboard();
    // Bind filter pills after DOM is ready
    document.querySelectorAll('.filter-pills .pill[data-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-pills .pill[data-filter]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            dash._mediaFilter = btn.dataset.filter;
            dash._renderMedia();
        });
    });
});
