from __future__ import annotations

import hashlib
from pathlib import Path

DATA = Path(__file__).resolve().parents[2] / "data"


def validate_vault(vault_path: str) -> Path:
    path = Path(vault_path).expanduser().resolve()

    if not path.is_dir():
        raise ValueError(f"Vault directory does not exist: {path}")

    return path


def get_vault_db(vault_path: str) -> Path:
    vault = validate_vault(vault_path)

    key = hashlib.sha256(str(vault).encode("utf-8")).hexdigest()[:20]
    db_dir = DATA / "vaults"
    db_dir.mkdir(parents=True, exist_ok=True)

    return db_dir / f"{key}.sqlite3"
