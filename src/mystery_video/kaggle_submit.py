from __future__ import annotations

from dataclasses import dataclass
import json
import time
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class KaggleSubmission:
    owner: str
    slug: str
    version_number: int | None

    @property
    def ref(self) -> str:
        return f"{self.owner}/{self.slug}"


class KaggleClient:
    """Minimal Bot2 Kaggle submitter: submit only, progress comes from Supabase callbacks."""

    def __init__(self, token: str, username: str, timeout: float = 120.0):
        self.token = token.strip()
        self.username = username.strip()
        self.timeout = timeout
        if not self.token:
            raise ValueError("KAGGLE_API_TOKEN is required")
        if not self.username:
            raise ValueError("KAGGLE_USERNAME is required")

    def submit_script(
        self,
        *,
        slug: str,
        title: str,
        source: str,
        enable_gpu: bool,
        kernel_data_sources: list[str] | None = None,
        capacity_attempts: int = 3,
    ) -> KaggleSubmission:
        slug = slug.strip()
        if not slug or "/" in slug:
            raise ValueError("slug must not contain owner")
        payload = {
            "slug": f"{self.username}/{slug}",
            "newTitle": title,
            "text": source,
            "language": "python",
            "kernelType": "script",
            "isPrivate": True,
            "enableGpu": bool(enable_gpu),
            "enableTpu": False,
            "enableInternet": True,
        }
        if kernel_data_sources:
            payload["kernelDataSources"] = list(kernel_data_sources)

        result: dict = {}
        for attempt in range(1, max(1, capacity_attempts) + 1):
            result = self._post(payload)
            error = str(result.get("error") or "")
            if not error:
                break
            capacity = "maximum batch gpu session count" in error.casefold() and "reached" in error.casefold()
            if not capacity or attempt >= capacity_attempts:
                raise RuntimeError("Kaggle rejected submission: " + error)
            time.sleep(20 * attempt)

        version = result.get("versionNumber", result.get("version_number"))
        return KaggleSubmission(
            owner=self.username,
            slug=slug,
            version_number=int(version) if version is not None else None,
        )

    def _post(self, payload: dict) -> dict:
        req = Request(
            "https://www.kaggle.com/api/v1/kernels/push",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "Hidden-Beyond-Bot2/1.0",
            },
        )
        with urlopen(req, timeout=self.timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("Kaggle response must be an object")
        return data
