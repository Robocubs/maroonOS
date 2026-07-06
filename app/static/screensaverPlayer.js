const FILL = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;';
const MEDIA_CACHE = 'maroonos-media-v1';

// filename -> duration_ms, shared across every player instance/panel on the
// page so a video referenced by multiple playlists (e.g. portrait + overlay
// in max mode) only has its duration resolved once.
const durationCache = new Map();

// Read by the config dashboard's Network section to display the current
// sync group. Initialized here so it exists even before any schedule is
// built (config.html doesn't load this script at all, so it'll never be
// set there — the dashboard falls back to "Computed after playback starts").
window.screensaverState = window.screensaverState || { syncGroupKey: null };

// Singleton SSE connection shared across all player instances on the page.
let _playlistEventSource = null;
const _playlistChangeListeners = new Set();

function _subscribePlaylistChanges(listener) {
    _playlistChangeListeners.add(listener);
    if (!_playlistEventSource && typeof EventSource !== 'undefined') {
        try {
            _playlistEventSource = new EventSource('/config/api/playlist/events');
            _playlistEventSource.onmessage = (e) => {
                for (const fn of _playlistChangeListeners) fn(e);
            };
        } catch (_) {}
    }
    return () => _playlistChangeListeners.delete(listener);
}

class ScreensaverPlayer {
    constructor(container, playlistUrl) {
        this.container = container;
        this.playlistUrl = playlistUrl;

        this._playlist = null;
        this._schedule = null;
        this._syncEnabled = false;
        this._index = 0;
        this._timer = null;
        this._active = false;
        this._currentEl = null;
        this._failStreak = 0;

        // Only set position if the element is static — don't override a CSS
        // position: fixed/absolute already set on the container (e.g. #overlay).
        if (getComputedStyle(this.container).position === 'static') {
            this.container.style.position = 'relative';
        }
        this.container.style.overflow = 'hidden';

        // Fetch playlist and warm the SW cache immediately on construction so
        // images are available offline regardless of current printer state.
        this._fetchPlaylist().then(() => this._prefetchMedia());

        // Rebuild the schedule in place when the server notifies us of a
        // playlist change, rather than reloading the page. checkForUpdate()
        // re-fetches, detects the change, and re-anchors/re-sequences without
        // a navigation — this is also the same method Dashboard's idle loop
        // calls every 2s, so there's a single code path for both triggers.
        this._unsubPlaylist = _subscribePlaylistChanges((e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.mode && !this.playlistUrl.endsWith(data.mode)) return;
            } catch (_) {}
            this.checkForUpdate();
        });
    }

    async start() {
        if (this._active) return;
        this._active = true;
        this._index = 0;
        this._failStreak = 0;

        // sync_enabled is re-checked on every start() so toggling it in the
        // config dashboard takes effect the next time the screensaver
        // activates, with no need for the player to react in real time.
        this._syncEnabled = await this._fetchSyncEnabled();

        await this._fetchPlaylist();

        if (!this._playlist || this._playlist.length === 0) {
            this._active = false;
            return;
        }

        this._prefetchMedia();
        await this._buildSchedule();

        if (!this._schedule) {
            this._active = false;
            return;
        }

        if (this._syncEnabled) this._playAnchored();
        else this._playSequential(0);
    }

    // Re-fetch the playlist (and sync setting) on each idle check / SSE
    // notification. If the playlist changed, rebuild the schedule in place
    // and resume playback — anchored to the clock if sync is on, from the
    // current index otherwise — instead of reloading the page.
    async checkForUpdate() {
        if (!this._playlist) return;
        const prevRaw = JSON.stringify(this._playlist);
        await this._fetchPlaylist();
        if (!this._playlist || JSON.stringify(this._playlist) === prevRaw) return;

        this._syncEnabled = await this._fetchSyncEnabled();
        this._prefetchMedia();
        await this._buildSchedule();

        if (!this._active) return;
        if (!this._schedule) {
            this.stop();
            return;
        }

        clearTimeout(this._timer);
        if (this._syncEnabled) this._playAnchored();
        else this._playSequential(this._index);
    }

    async _fetchSyncEnabled() {
        try {
            const s = await fetch('/config/api/settings', { cache: 'no-store' }).then(r => r.json());
            return !!s.sync_enabled;
        } catch (_) {
            // Never sync against unknown state.
            return false;
        }
    }

    // Resolve a single item's duration in ms. Images use their configured
    // duration_seconds; videos are resolved server-side via ffprobe first,
    // falling back to a client-side HTMLVideoElement metadata probe, and
    // finally to a 60s placeholder if neither works within budget.
    async _resolveDuration(item) {
        if (item.type === 'image') return (item.duration_seconds ?? 10) * 1000;

        if (durationCache.has(item.filename)) return durationCache.get(item.filename);

        try {
            const data = await fetch(
                `/config/api/media/${encodeURIComponent(item.filename)}/duration`,
                { cache: 'no-store' },
            ).then(r => r.json());
            if (data.duration_ms) {
                durationCache.set(item.filename, data.duration_ms);
                return data.duration_ms;
            }
        } catch (_) {}

        const ms = await new Promise((resolve) => {
            const v = document.createElement('video');
            v.preload = 'metadata';
            v.muted = true;
            let done = false;
            const finish = (val) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                v.removeAttribute('src');
                v.load();
                resolve(val);
            };
            const timer = setTimeout(() => finish(60000), 10000);
            v.addEventListener('loadedmetadata', () => {
                const d = (v.duration && isFinite(v.duration)) ? v.duration * 1000 : 60000;
                finish(d);
            }, { once: true });
            v.addEventListener('error', () => finish(60000), { once: true });
            v.src = item.path;
        });
        durationCache.set(item.filename, ms);
        return ms;
    }

    // Build both playback timelines from the current playlist:
    //   - sequentialEntries: original playlist order (non-sync playback,
    //     identical to the pre-existing sequential behavior)
    //   - anchorEntries: duration-sorted order with cumulative_start_ms, used
    //     only when sync is enabled
    //
    // Sorting by duration (not preserving playlist order) for the anchor
    // timeline is required for cross-Pi lockstep to actually hold: two Pis
    // with the same *set* of durations but different playlist order would
    // otherwise land on different-length slots at the same wall-clock
    // instant. Sorting makes "same step = same duration" true regardless of
    // authoring order, matching what the sync group key represents.
    async _buildSchedule() {
        if (!this._playlist || this._playlist.length === 0) {
            this._schedule = null;
            return;
        }

        const durations = await Promise.all(this._playlist.map(item => this._resolveDuration(item)));

        const sequentialEntries = this._playlist.map((item, i) => ({
            item,
            duration_ms: durations[i],
        }));

        // Array.prototype.sort is stable in all modern engines, so entries
        // with equal durations keep their relative (original-index) order.
        const sortedByDuration = sequentialEntries
            .slice()
            .sort((a, b) => a.duration_ms - b.duration_ms);

        let cum = 0;
        const anchorEntries = sortedByDuration.map((e) => {
            const entry = { item: e.item, duration_ms: e.duration_ms, cumulative_start_ms: cum };
            cum += e.duration_ms;
            return entry;
        });
        const total_duration_ms = cum || 1;
        const syncGroupKey = await this._computeSyncGroupKey(sortedByDuration.map(e => e.duration_ms));

        this._schedule = { anchorEntries, sequentialEntries, total_duration_ms, syncGroupKey };
        window.screensaverState.syncGroupKey = syncGroupKey;
    }

    async _computeSyncGroupKey(sortedDurations) {
        const raw = JSON.stringify(sortedDurations);

        if (window.crypto?.subtle?.digest) {
            try {
                const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
                return Array.from(new Uint8Array(buf))
                    .slice(0, 4)
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join('');
            } catch (_) {
                // fall through to the non-crypto hash below
            }
        }

        // Web Crypto requires a secure context (HTTPS or localhost) and this
        // dashboard is typically served over plain HTTP on the local
        // network, so crypto.subtle may be unavailable. This is a grouping
        // key, not a security boundary, so a simple deterministic hash
        // (FNV-1a) is an acceptable fallback.
        let h = 0x811c9dc5;
        for (let i = 0; i < raw.length; i++) {
            h ^= raw.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8);
    }

    _currentScheduleIndex(nowMs) {
        const { anchorEntries, total_duration_ms } = this._schedule;
        const position_ms = nowMs % total_duration_ms;
        for (const e of anchorEntries) {
            if (position_ms >= e.cumulative_start_ms && position_ms < e.cumulative_start_ms + e.duration_ms) {
                return { entry: e, msIntoItem: position_ms - e.cumulative_start_ms };
            }
        }
        return { entry: anchorEntries[anchorEntries.length - 1], msIntoItem: 0 };
    }

    // Sync-mode playback: re-anchors to the wall clock on every call, so it
    // self-corrects any drift at every item boundary rather than relying on
    // setTimeout accuracy accumulating correctly over time.
    _playAnchored() {
        if (!this._active || !this._schedule) return;

        if (this._failStreak >= this._schedule.anchorEntries.length) {
            this._clearCurrent();
            this._timer = setTimeout(() => {
                if (this._active) { this._failStreak = 0; this._playAnchored(); }
            }, 30000);
            return;
        }

        const { entry, msIntoItem } = this._currentScheduleIndex(Date.now());
        const remaining = entry.duration_ms - msIntoItem;
        this._renderItem(entry.item, remaining, () => this._playAnchored(), /* videoSafetyNet */ true);
    }

    // Non-sync playback: identical to the pre-existing sequential behavior —
    // original playlist order, index+1 modulo-wrap, videos advance only on
    // their native 'ended' event with no duration-based cutoff.
    _playSequential(index) {
        if (!this._active || !this._schedule) return;
        const entries = this._schedule.sequentialEntries;

        if (this._failStreak >= entries.length) {
            this._clearCurrent();
            this._timer = setTimeout(() => {
                if (this._active) { this._failStreak = 0; this._playSequential(0); }
            }, 30000);
            return;
        }

        const i = index % entries.length;
        this._index = i;
        const entry = entries[i];
        this._renderItem(entry.item, entry.duration_ms, () => this._playSequential(i + 1), /* videoSafetyNet */ false);
    }

    // Fire-and-forget: let the SW intercept these fetches so it can cache the
    // responses. Subsequent offline loads read from that SW cache via blob URLs.
    _prefetchMedia() {
        if (!this._playlist) return;
        for (const item of this._playlist) {
            if (item.type === 'image') fetch(item.path).catch(() => {});
        }
    }

    // Subclasses can override to avoid localStorage key collisions when multiple
    // players share the same playlistUrl but extract different playlist modes.
    get _storageKey() { return this.playlistUrl; }

    async _fetchPlaylist() {
        try {
            const data = await fetch(this.playlistUrl, {cache: 'no-store'}).then(r => r.json());
            const playlist = this._extractPlaylist(data);
            if (playlist && playlist.length > 0) {
                this._playlist = playlist;
                try { localStorage.setItem(this._storageKey, JSON.stringify(playlist)); } catch (_) {}
            } else {
                this._playlist = null;
                try { localStorage.removeItem(this._storageKey); } catch (_) {}
            }
        } catch (_) {
            try {
                const cached = localStorage.getItem(this._storageKey);
                this._playlist = cached ? JSON.parse(cached) : null;
            } catch (_) {
                this._playlist = null;
            }
        }
    }

    _extractPlaylist(data) {
        return Array.isArray(data) ? data : null;
    }

    stop() {
        this._active = false;
        clearTimeout(this._timer);
        this._timer = null;
        this.container.querySelectorAll('img, video').forEach(el => this._removeEl(el));
        this._currentEl = null;
    }

    // Read an image directly from the SW Cache API and return a blob URL.
    // This works offline without any SW fetch routing — page and SW share
    // the same Cache Storage, so we can read what the SW cached.
    async _blobUrlForImage(path) {
        if (!('caches' in window)) return null;
        try {
            const cache = await caches.open(MEDIA_CACHE);
            const key = decodeURI(new URL(path, location.origin).href);
            const cached = await cache.match(key);
            if (cached) return URL.createObjectURL(await cached.blob());
        } catch (_) {}
        return null;
    }

    // Shared element-creation/crossfade/fail-streak core used by both the
    // anchored and sequential playback engines. budgetMs is the time until
    // the next scheduled advance (full duration in sequential mode, time
    // remaining-in-slot in anchored mode). videoSafetyNet installs a
    // forced-advance timer for videos so a rebuild/re-anchor can't get stuck
    // waiting on 'ended' forever; sequential mode omits it to keep today's
    // exact video behavior (advance on 'ended' only).
    _renderItem(item, budgetMs, onAdvance, videoSafetyNet) {
        if (!this._active) return;
        const prevEl = this._currentEl;

        if (item.type === 'image') {
            const img = document.createElement('img');
            img.style.cssText = FILL;
            this.container.appendChild(img);
            this._currentEl = img;

            this._timer = setTimeout(() => {
                if (this._active && this._currentEl === img) {
                    this._failStreak = 0;
                    onAdvance();
                }
            }, Math.max(0, budgetMs));

            img.addEventListener('load', () => {
                this._failStreak = 0;
                this._removeEl(prevEl);
            }, { once: true });

            img.addEventListener('error', () => {
                if (this._active && this._currentEl === img) {
                    clearTimeout(this._timer);
                    if (img._blobUrl) URL.revokeObjectURL(img._blobUrl);
                    img.remove();
                    this._currentEl = prevEl;
                    this._failStreak++;
                    onAdvance();
                }
            }, { once: true });

            // Try the Cache API first (works offline). Fall back to the network
            // path so online playback still works before images are cached.
            this._blobUrlForImage(item.path).then(blobUrl => {
                if (!this._active || this._currentEl !== img) return;
                if (blobUrl) {
                    img._blobUrl = blobUrl;
                    img.src = blobUrl;
                } else {
                    img.src = item.path;
                }
            });
        } else {
            const video = document.createElement('video');
            video.src = item.path;
            video.autoplay = true;
            video.muted = true;
            video.playsInline = true;
            video.style.cssText = FILL;
            this.container.appendChild(video);
            this._currentEl = video;

            let advanced = false;
            const doAdvance = () => {
                if (advanced) return;
                advanced = true;
                clearTimeout(this._timer);
                this._failStreak = 0;
                onAdvance();
            };

            video.addEventListener('canplay', () => {
                this._failStreak = 0;
                this._removeEl(prevEl);
            }, { once: true });

            video.addEventListener('ended', () => {
                if (this._active && this._currentEl === video) doAdvance();
            }, { once: true });

            if (videoSafetyNet) {
                this._timer = setTimeout(() => {
                    if (this._active && this._currentEl === video) doAdvance();
                }, Math.max(0, budgetMs) + 2000);
            }

            const onFail = () => {
                if (this._active && this._currentEl === video) {
                    clearTimeout(this._timer);
                    video.pause();
                    video.src = '';
                    video.remove();
                    this._currentEl = prevEl;
                    this._failStreak++;
                    onAdvance();
                }
            };
            video.addEventListener('error', onFail, { once: true });
            video.play().catch(onFail);
        }
    }

    _removeEl(el) {
        if (!el) return;
        if (el.tagName === 'VIDEO') { el.pause(); el.src = ''; }
        if (el._blobUrl) URL.revokeObjectURL(el._blobUrl);
        el.remove();
    }

    _clearCurrent() {
        this._removeEl(this._currentEl);
        this._currentEl = null;
    }
}

class ScreensaverPlayerMax extends ScreensaverPlayer {
    constructor(container, playlistUrl, mode) {
        super(container, playlistUrl);
        this._playlistMode = mode;
    }

    get _storageKey() { return `${this.playlistUrl}:${this._playlistMode}`; }

    _extractPlaylist(data) {
        const arr = data[this._playlistMode];
        return Array.isArray(arr) && arr.length > 0 ? arr : null;
    }
}
