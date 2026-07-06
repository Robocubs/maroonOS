const FILL = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;';
const MEDIA_CACHE = 'maroonos-media-v1';

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

        // Reload the page when the server notifies us of a playlist change.
        // A reload is simpler than diffing and re-caching, and it guarantees
        // the new playlist and images are loaded fresh from the server.
        this._unsubPlaylist = _subscribePlaylistChanges((e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.mode && !this.playlistUrl.endsWith(data.mode)) return;
            } catch (_) {}
            this._reloadOrDeferOffline();
        });
    }

    // Reload now if online; otherwise defer until the browser reports
    // connectivity again, so a reload attempted while offline never strands
    // the page on the browser's own offline interstitial.
    _reloadOrDeferOffline() {
        if (navigator.onLine === false) {
            this._scheduleReloadWhenOnline();
            return;
        }
        location.reload();
    }

    _scheduleReloadWhenOnline() {
        if (this._reloadPending) return;
        this._reloadPending = true;
        window.addEventListener('online', () => location.reload(), { once: true });
    }

    async start() {
        if (this._active) return;
        this._active = true;
        this._index = 0;
        this._failStreak = 0;

        await this._fetchPlaylist();

        if (!this._playlist || this._playlist.length === 0) {
            this._active = false;
            return;
        }

        this._prefetchMedia();
        this._playItem(0);
    }

    // Re-fetch the playlist on each idle check. If it changed (e.g. the server
    // was unreachable before but is now up), reload so the new content is used.
    async checkForUpdate() {
        if (!this._playlist) return;
        const prev = JSON.stringify(this._playlist);
        await this._fetchPlaylist();
        if (JSON.stringify(this._playlist) !== prev) this._reloadOrDeferOffline();
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

    _playItem(index) {
        if (!this._active) return;

        if (this._failStreak >= this._playlist.length) {
            this._clearCurrent();
            this._timer = setTimeout(() => {
                if (this._active) { this._failStreak = 0; this._playItem(0); }
            }, 30000);
            return;
        }

        const i = index % this._playlist.length;
        this._index = i;
        const item = this._playlist[i];
        const prevEl = this._currentEl;

        if (item.type === 'image') {
            const img = document.createElement('img');
            img.style.cssText = FILL;
            this.container.appendChild(img);
            this._currentEl = img;

            const duration = (item.duration_seconds ?? 10) * 1000;
            this._timer = setTimeout(() => {
                if (this._active && this._currentEl === img) {
                    this._failStreak = 0;
                    this._playItem(i + 1);
                }
            }, duration);

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
                    this._playItem(i + 1);
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

            video.addEventListener('canplay', () => {
                this._failStreak = 0;
                this._removeEl(prevEl);
            }, { once: true });

            video.addEventListener('ended', () => {
                if (this._active && this._currentEl === video) {
                    this._failStreak = 0;
                    this._playItem(i + 1);
                }
            }, { once: true });

            const onFail = () => {
                if (this._active && this._currentEl === video) {
                    video.pause();
                    video.src = '';
                    video.remove();
                    this._currentEl = prevEl;
                    this._failStreak++;
                    this._playItem(i + 1);
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
