import base64
import httpx
from config import PrinterConfig


async def get_status(config: PrinterConfig) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"http://{config.ip}/api/v1/status",
            headers={"X-Api-Key": config.api_key},
        )
        r.raise_for_status()
        return r.json()


async def get_job(config: PrinterConfig) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"http://{config.ip}/api/v1/job",
            headers={"X-Api-Key": config.api_key},
        )
        r.raise_for_status()
        return r.json()


async def get_machine_info(config: PrinterConfig) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"http://{config.ip}/api/v1/info",
            headers={"X-Api-Key": config.api_key},
        )
        r.raise_for_status()
        return r.json()


async def get_thumbnail(config: PrinterConfig) -> str:
    async with httpx.AsyncClient() as client:
        job_r = await client.get(
            f"http://{config.ip}/api/v1/job",
            headers={"X-Api-Key": config.api_key},
        )
        job_r.raise_for_status()
        job_data = job_r.json()
        image_path = (job_data.get("file") or {}).get("refs", {}).get("thumbnail")
        if not image_path:
            raise ValueError("No thumbnail in job response")

        img_r = await client.get(
            f"http://{config.ip}{image_path}",
            headers={"X-Api-Key": config.api_key},
        )
        img_r.raise_for_status()

        return base64.b64encode(img_r.content).decode("utf-8")
