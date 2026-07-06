import asyncio
import hashlib
import json
import logging
import time
import uuid
from pathlib import Path
from datetime import datetime
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, UploadFile, File, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import config as cfg

# First logger in the codebase — relies on uvicorn's default logging config
# for output formatting/handlers rather than calling logging.basicConfig().
logger = logging.getLogger("maroonos.config")

# SSE subscribers — each is a Queue that receives playlist mode strings on save
_playlist_subs: list[asyncio.Queue] = []


async def _notify_playlist_changed(mode: str) -> None:
    for q in list(_playlist_subs):
        try:
            q.put_nowait(mode)
        except asyncio.QueueFull:
            pass

router = APIRouter(prefix="/config/api")

STATIC_DIR = cfg.SERVER_DIR / "static"
IMAGES_DIR = STATIC_DIR / "images"
VIDEOS_DIR = STATIC_DIR / "videos"

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
VIDEO_EXTS = {".mp4", ".webm", ".mov"}


# --- Printers ---

class PrinterUpdate(BaseModel):
    name: str
    firmware: str
    ip: str
    api_key: str


class TestRequest(BaseModel):
    ip: str = ""
    api_key: str = ""


@router.get("/printers")
async def list_printers():
    return [
        {"id": k, "name": v.printer_name, "firmware": v.firmware,
         "ip": v.ip, "api_key": v.api_key}
        for k, v in sorted(cfg.get_printers().items())
    ]


@router.put("/printers/{printer_id}")
async def update_printer(printer_id: int, body: PrinterUpdate):
    if printer_id not in (1, 2, 3):
        raise HTTPException(status_code=400, detail="printer_id must be 1, 2, or 3")
    printers = cfg.get_printers()
    printers[printer_id] = cfg.PrinterConfig(
        ip=body.ip,
        api_key=body.api_key,
        printer_name=body.name,
        firmware=body.firmware,
    )
    cfg.save_printers()
    return {"ok": True}


@router.post("/printers/{printer_id}/test")
async def test_printer(printer_id: int, body: TestRequest):
    if printer_id not in (1, 2, 3):
        raise HTTPException(status_code=400, detail="printer_id must be 1, 2, or 3")

    printers = cfg.get_printers()
    stored = printers.get(printer_id)

    ip = body.ip or (stored.ip if stored else "")
    api_key = body.api_key or (stored.api_key if stored else "")

    if not ip:
        return {"success": False, "state": None, "error": "No IP address configured"}

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(
                f"http://{ip}/api/v1/status",
                headers={"X-Api-Key": api_key},
            )
            r.raise_for_status()
            data = r.json()
            state = (data.get("printer") or {}).get("state", "UNKNOWN")
            return {"success": True, "state": state, "error": None}
    except httpx.TimeoutException:
        return {"success": False, "state": None, "error": "Connection timed out"}
    except httpx.HTTPStatusError as e:
        return {"success": False, "state": None, "error": f"HTTP {e.response.status_code}"}
    except Exception as e:
        return {"success": False, "state": None, "error": str(e)}


# --- Media ---

def _media_item(path: Path, media_type: str) -> dict:
    from urllib.parse import quote
    stat = path.stat()
    subdir = "images" if media_type == "image" else "videos"
    url_path = f"/static/{subdir}/{quote(path.name)}"
    return {
        "filename": path.name,
        "type": media_type,
        "path": url_path,
        "size_bytes": stat.st_size,
        "last_modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
    }


@router.get("/media")
async def list_media():
    items = []
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    VIDEOS_DIR.mkdir(parents=True, exist_ok=True)
    for f in sorted(IMAGES_DIR.iterdir()):
        if f.is_file() and f.suffix.lower() in IMAGE_EXTS:
            items.append(_media_item(f, "image"))
    for f in sorted(VIDEOS_DIR.iterdir()):
        if f.is_file() and f.suffix.lower() in VIDEO_EXTS:
            items.append(_media_item(f, "video"))
    return items


def _sanitize_filename(name: str) -> str:
    name = Path(name).name  # strip any path components
    name = name.replace(" ", "_")
    if ".." in name or "/" in name or "\\" in name:
        raise HTTPException(status_code=400, detail="Invalid filename")
    return name


@router.post("/media/upload")
async def upload_media(file: UploadFile = File(...)):
    filename = _sanitize_filename(file.filename or "upload")
    ext = Path(filename).suffix.lower()

    if ext in IMAGE_EXTS:
        dest_dir = IMAGES_DIR
        media_type = "image"
    elif ext in VIDEO_EXTS:
        dest_dir = VIDEOS_DIR
        media_type = "video"
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")

    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / filename
    content = await file.read()
    dest.write_bytes(content)
    return _media_item(dest, media_type)


@router.delete("/media/{filename}")
async def delete_media(filename: str):
    filename = _sanitize_filename(filename)
    for directory in (IMAGES_DIR, VIDEOS_DIR):
        target = directory / filename
        if target.exists():
            target.unlink()
            _remove_from_playlists(filename)
            return {"ok": True}
    raise HTTPException(status_code=404, detail="File not found")


def _remove_from_playlists(filename: str) -> None:
    for mode in ("reg", "max"):
        path = _playlist_path(mode)
        if not path.exists():
            continue
        data = json.loads(path.read_text())
        if mode == "reg":
            filtered = [item for item in data if item.get("filename") != filename]
            if len(filtered) != len(data):
                path.write_text(json.dumps(filtered, indent=2))
        else:
            portrait = [i for i in data.get("portrait", []) if i.get("filename") != filename]
            landscape = [i for i in data.get("landscape", []) if i.get("filename") != filename]
            if len(portrait) + len(landscape) != len(data.get("portrait", [])) + len(data.get("landscape", [])):
                path.write_text(json.dumps({"portrait": portrait, "landscape": landscape}, indent=2))


# --- Playlists ---

def _playlist_path(mode: str) -> Path:
    return cfg.CONFIG_DIR / f"playlist_{mode}.json"


def _read_playlist(mode: str):
    path = _playlist_path(mode)
    if not path.exists():
        return [] if mode == "reg" else {"portrait": [], "landscape": []}
    return json.loads(path.read_text())


@router.get("/playlist/events")
async def playlist_events(request: Request):
    queue: asyncio.Queue[str] = asyncio.Queue(maxsize=20)
    _playlist_subs.append(queue)

    async def generate():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    mode = await asyncio.wait_for(queue.get(), timeout=20)
                    yield f"data: {json.dumps({'mode': mode})}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            try:
                _playlist_subs.remove(queue)
            except ValueError:
                pass

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/playlist/{mode}")
async def get_playlist(mode: str):
    if mode not in ("reg", "max"):
        raise HTTPException(status_code=400, detail="mode must be 'reg' or 'max'")
    return _read_playlist(mode)


@router.put("/playlist/{mode}")
async def save_playlist(mode: str, request: Request):
    if mode not in ("reg", "max"):
        raise HTTPException(status_code=400, detail="mode must be 'reg' or 'max'")
    body = await request.json()
    cfg.CONFIG_DIR.mkdir(exist_ok=True)
    _playlist_path(mode).write_text(json.dumps(body, indent=2))
    await _notify_playlist_changed(mode)
    asyncio.create_task(_push_playlist_to_peers(mode, body))
    return {"ok": True}


@router.get("/playlist/{mode}/version")
async def get_playlist_version(mode: str):
    if mode not in ("reg", "max"):
        raise HTTPException(status_code=400, detail="mode must be 'reg' or 'max'")
    path = _playlist_path(mode)
    if not path.exists():
        return {"version": "00000000", "total_items": 0}
    raw = path.read_bytes()
    version = hashlib.sha256(raw).hexdigest()[:8]
    data = json.loads(raw)
    if mode == "reg":
        total_items = len(data)
    else:
        total_items = len(data.get("portrait", [])) + len(data.get("landscape", []))
    return {"version": version, "total_items": total_items}


# --- Network / sync ---

def get_peer_ips() -> list[str]:
    env_ips = cfg.get_env_peer_ips()
    settings = cfg.load_settings()
    return list(dict.fromkeys(env_ips + settings.peer_ips))


async def _push_playlist_to_peers(mode: str, body: Any) -> None:
    settings = cfg.load_settings()
    if not settings.push_playlist_enabled:
        return

    peers = get_peer_ips()
    if not peers:
        return

    payload = body
    if isinstance(payload, dict) and "peer_ips" in payload:
        payload = {k: v for k, v in payload.items() if k != "peer_ips"}

    async def _push_one(ip: str) -> None:
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                r = await client.put(f"http://{ip}:8080/config/api/playlist/{mode}", json=payload)
                r.raise_for_status()
        except Exception as e:
            logger.warning("Peer push to %s failed for playlist/%s: %s", ip, mode, e)

    await asyncio.gather(*(_push_one(ip) for ip in peers), return_exceptions=True)


async def _ffprobe_duration_ms(path: Path, timeout: float = 2.0) -> float | None:
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return float(stdout.decode().strip()) * 1000
    except (FileNotFoundError, asyncio.TimeoutError, ValueError, OSError):
        return None


@router.get("/media/{filename}/duration")
async def get_media_duration(filename: str):
    filename = _sanitize_filename(filename)
    path = VIDEOS_DIR / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    duration_ms = await _ffprobe_duration_ms(path)
    if duration_ms is None:
        return {"duration_ms": None, "source": "unavailable"}
    return {"duration_ms": duration_ms, "source": "ffprobe"}


class SettingsUpdate(BaseModel):
    peer_ips: list[str] = []
    sync_enabled: bool = True
    push_playlist_enabled: bool = False


@router.get("/settings")
async def get_settings():
    return cfg.load_settings().model_dump()


@router.put("/settings")
async def update_settings(body: SettingsUpdate):
    for ip in body.peer_ips:
        if not ip.strip() or any(c.isspace() for c in ip):
            raise HTTPException(status_code=400, detail=f"Invalid peer IP: {ip!r}")
    settings = cfg.SyncSettings(
        peer_ips=body.peer_ips,
        sync_enabled=body.sync_enabled,
        push_playlist_enabled=body.push_playlist_enabled,
    )
    cfg.save_settings(settings)
    return settings.model_dump()


@router.get("/sync/test")
async def sync_test():
    """
    Snapshot-based sync diagnostic: computes this Pi's screensaver schedule
    at the instant this request is handled. Because position_ms is derived
    from time.time() % total_duration_ms, the result is only accurate at
    the moment of computation — by the time a client reads the response
    there has already been a few ms to tens of ms of network latency drift.
    This endpoint is a diagnostic snapshot for the config dashboard's
    "Test Sync" button, NOT a live synchronization channel.

    In max mode, only the shared "landscape" overlay playlist participates
    in cross-Pi sync (per-panel "portrait" playlists stay local), so that's
    the schedule read here.

    Duration ordering: durations are sorted ascending (not left in playlist
    order) before computing total_duration_ms's contribution to sync_group.
    This matches the client's schedule builder — two Pis with the same
    *set* of durations but different playlist order must still be
    considered the same sync group, which only holds if both sides build
    their timelines from a canonical (sorted) order rather than raw
    playlist order.
    """
    if cfg.MODE == "max":
        items = _read_playlist("max").get("landscape", [])
    else:
        items = _read_playlist("reg")

    video_durations_estimated = False
    video_indices = [i for i, item in enumerate(items) if item.get("type") == "video"]

    async def _resolve(i: int) -> tuple[int, float | None]:
        path = VIDEOS_DIR / items[i]["filename"]
        d = await _ffprobe_duration_ms(path, timeout=2.0)
        return i, d

    resolved: dict[int, float] = {}
    if video_indices:
        try:
            results = await asyncio.wait_for(
                asyncio.gather(*(_resolve(i) for i in video_indices), return_exceptions=True),
                timeout=2.2,
            )
            for r in results:
                if isinstance(r, Exception):
                    continue
                i, d = r
                if d is not None:
                    resolved[i] = d
        except asyncio.TimeoutError:
            pass

    durations_ms: list[float] = []
    for i, item in enumerate(items):
        if item.get("type") == "video":
            d = resolved.get(i)
            if d is None:
                d = 60000
                video_durations_estimated = True
            durations_ms.append(d)
        else:
            durations_ms.append((item.get("duration_seconds") or 10) * 1000)

    sorted_durations = sorted(durations_ms)
    total_duration_ms = sum(sorted_durations) or 1
    position_ms = (time.time() * 1000) % total_duration_ms
    sync_group = hashlib.sha256(
        json.dumps(sorted_durations, separators=(",", ":")).encode()
    ).hexdigest()[:8]

    # Which sorted-duration slot position_ms currently falls in, and how far
    # into that slot — this is what the config dashboard's "Test Sync" panel
    # displays as "Item X of Y · +Zs offset". Slot boundaries come from the
    # same sorted order the sync_group hash is computed over, not playlist
    # order (see the ordering note above).
    item_index = len(sorted_durations)
    offset_ms = 0
    cum = 0
    for idx, d in enumerate(sorted_durations):
        if cum <= position_ms < cum + d:
            item_index = idx + 1  # 1-based for display
            offset_ms = position_ms - cum
            break
        cum += d

    return {
        "position_ms": position_ms,
        "total_duration_ms": total_duration_ms,
        "sync_group": sync_group,
        "mode": cfg.MODE,
        "item_count": len(items),
        "item_index": item_index,
        "offset_ms": offset_ms,
        "video_durations_estimated": video_durations_estimated,
    }
