import os
from pathlib import Path
from pydantic import BaseModel
from dotenv import dotenv_values

SERVER_DIR = Path(__file__).parent

DEV_MODE = os.getenv("DEV_MODE", "false").lower() == "true"
MODE = os.getenv("MODE", "reg")  # "reg" or "max"


class PrinterConfig(BaseModel):
    ip: str
    api_key: str
    printer_name: str
    firmware: str


def _load_printer_config(n: int) -> PrinterConfig:
    vals = dotenv_values(SERVER_DIR / f".env.{n}")
    return PrinterConfig(
        ip=vals.get("IP", ""),
        api_key=vals.get("API_KEY", ""),
        printer_name=vals.get("PRINTER_NAME", f"Printer {n}"),
        firmware=vals.get("FIRMWARE", ""),
    )


def load_printers() -> dict[int, PrinterConfig]:
    if DEV_MODE:
        return {
            1: PrinterConfig(ip="", api_key="", printer_name="Prusa MK3 [A]", firmware="5.1.0"),
            2: PrinterConfig(ip="", api_key="", printer_name="Prusa MK3 [B]", firmware="5.1.0"),
            3: PrinterConfig(ip="", api_key="", printer_name="Prusa MK3 [C]", firmware="5.1.0"),
        }

    printers = {}
    for n in (1, 2, 3):
        if (SERVER_DIR / f".env.{n}").exists():
            printers[n] = _load_printer_config(n)
    return printers
