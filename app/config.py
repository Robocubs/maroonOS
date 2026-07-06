import json
import os
from pathlib import Path
from pydantic import BaseModel
from dotenv import dotenv_values

SERVER_DIR = Path(__file__).parent
CONFIG_DIR = SERVER_DIR / "config"
PRINTERS_JSON = CONFIG_DIR / "printers.json"

DEV_MODE = os.getenv("DEV_MODE", "false").lower() == "true"
MODE = os.getenv("MODE", "reg")  # "reg" or "max"


class PrinterConfig(BaseModel):
    ip: str
    api_key: str
    printer_name: str
    firmware: str


_printers: dict[int, PrinterConfig] = {}


def get_printers() -> dict[int, PrinterConfig]:
    return _printers


def save_printers() -> None:
    CONFIG_DIR.mkdir(exist_ok=True)
    data = {str(k): v.model_dump() for k, v in _printers.items()}
    PRINTERS_JSON.write_text(json.dumps(data, indent=2))


def _load_from_json() -> dict[int, PrinterConfig]:
    data = json.loads(PRINTERS_JSON.read_text())
    return {int(k): PrinterConfig(**v) for k, v in data.items()}


def _migrate_from_env() -> dict[int, PrinterConfig]:
    printers: dict[int, PrinterConfig] = {}
    for n in (1, 2, 3):
        env_file = SERVER_DIR / f".env.{n}"
        if env_file.exists():
            vals = dotenv_values(env_file)
            printers[n] = PrinterConfig(
                ip=vals.get("IP", ""),
                api_key=vals.get("API_KEY", ""),
                printer_name=vals.get("PRINTER_NAME", f"Printer {n}"),
                firmware=vals.get("FIRMWARE", ""),
            )
    return printers


def init_printers() -> None:
    global _printers
    CONFIG_DIR.mkdir(exist_ok=True)

    if PRINTERS_JSON.exists():
        _printers = _load_from_json()
        return

    if DEV_MODE:
        # Don't persist dev printers — ephemeral placeholder data
        _printers = {
            1: PrinterConfig(ip="", api_key="", printer_name="Prusa MK3 [A]", firmware="5.1.0"),
            2: PrinterConfig(ip="", api_key="", printer_name="Prusa MK3 [B]", firmware="5.1.0"),
            3: PrinterConfig(ip="", api_key="", printer_name="Prusa MK3 [C]", firmware="5.1.0"),
        }
        return

    # First boot: migrate from .env.N files and persist to JSON
    _printers = _migrate_from_env()
    if _printers:
        save_printers()


# Run on import so all routers share the same loaded state
init_printers()


# Legacy alias used by server.py
def load_printers() -> dict[int, PrinterConfig]:
    return _printers
