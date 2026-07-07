from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DB_PATH = PROJECT_ROOT / "simplifai.db"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = (
        "sqlite:///" + str(DEFAULT_DB_PATH).replace("\\", "/")
    )
    import_amount_tolerance: float = 0.0
    default_currency: str = "ILS"

    storage_dir: str = str(PROJECT_ROOT / "storage")
    upload_max_bytes: int = 10 * 1024 * 1024

    llm_provider: str = "openai"
    llm_api_key: str = ""
    llm_model: str = "gpt-4o-mini"
    llm_base_url: str = "https://api.openai.com/v1"


@lru_cache
def get_settings() -> Settings:
    return Settings()
