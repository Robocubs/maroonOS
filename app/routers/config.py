import asyncio
import json
import uuid
from pathlib import Path
from datetime import datetime
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, UploadFile, File, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import config as cfg

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
    return {"ok": True}
