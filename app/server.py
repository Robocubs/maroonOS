from pathlib import Path
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from config import MODE
from routers import printer
from routers.printer import _printers

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


@app.get("/")
async def dashboard(request: Request):
    printer_ids = sorted(_printers.keys())
    if not printer_ids:
        raise HTTPException(status_code=503, detail="No printers configured. Set DEV_MODE=true or create .env.N files.")
    context: dict = {"mode": MODE, "printer_ids": printer_ids}
    if MODE == "reg":
        context["printer_id"] = printer_ids[0]
    return templates.TemplateResponse(request=request, name=f"{MODE}.html", context=context)


@app.get("/settings")
async def settings():
    return {"status": "connected"}
