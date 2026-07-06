from pathlib import Path
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from config import MODE, get_printers
from routers import printer
from routers import config as config_router

APP_DIR = Path(__file__).parent

app = FastAPI(title="maroonOS")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")

templates = Jinja2Templates(directory=APP_DIR / "templates")

app.include_router(printer.router)
app.include_router(config_router.router)


@app.get("/")
async def dashboard(request: Request):
    printer_ids = sorted(get_printers().keys())
    if not printer_ids:
        raise HTTPException(status_code=503, detail="No printers configured. Visit /config to set up printers.")
    context: dict = {"mode": MODE, "printer_ids": printer_ids}
    if MODE == "reg":
        context["printer_id"] = printer_ids[0]
    return templates.TemplateResponse(request=request, name=f"{MODE}.html", context=context)


@app.get("/config")
async def config_dashboard(request: Request):
    return templates.TemplateResponse(request=request, name="config.html", context={"mode": MODE})


@app.get("/sw.js")
async def service_worker():
    return FileResponse(APP_DIR / "static" / "sw.js", media_type="application/javascript")


@app.get("/settings")
async def settings():
    return {"status": "connected"}
