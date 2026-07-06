import base64
from fastapi import APIRouter, HTTPException
from config import DEV_MODE, SERVER_DIR, PrinterConfig, get_printers
import devData
import prusa

router = APIRouter(prefix="/printer")


def _get_config(printer_id: int) -> PrinterConfig:
    printers = get_printers()
    if printer_id not in printers:
        raise HTTPException(status_code=404, detail=f"Printer {printer_id} not configured")
    return printers[printer_id]


@router.get("/{printer_id}/status")
async def get_status(printer_id: int):
    config = _get_config(printer_id)
    if DEV_MODE:
        return devData.fake_status()
    return await prusa.get_status(config)


@router.get("/{printer_id}/job")
async def get_job(printer_id: int):
    config = _get_config(printer_id)
    if DEV_MODE:
        return devData.fake_job()
    return await prusa.get_job(config)


@router.get("/{printer_id}/info")
async def get_info(printer_id: int):
    config = _get_config(printer_id)
    return {"name": config.printer_name, "firmware": config.firmware}


@router.get("/{printer_id}/machineInfo")
async def get_machine_info(printer_id: int):
    config = _get_config(printer_id)
    if DEV_MODE:
        return devData.fake_machine_info()
    return await prusa.get_machine_info(config)


@router.get("/{printer_id}/thumbnail")
async def get_thumbnail(printer_id: int):
    config = _get_config(printer_id)
    if DEV_MODE:
        with open(SERVER_DIR / "ThumbnailDemo.png", "rb") as f:
            encoded = base64.b64encode(f.read()).decode("utf-8")
        return {"image": encoded}
    try:
        encoded = await prusa.get_thumbnail(config)
    except ValueError:
        raise HTTPException(status_code=404, detail="No thumbnail available")
    return {"image": encoded}
