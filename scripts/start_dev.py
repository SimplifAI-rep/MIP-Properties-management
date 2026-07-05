#!/usr/bin/env python3
"""
One-command dev startup for SimplifAI.

- Ensures backend venv + dependencies
- Seeds database and imports sample deposits (if empty)
- Ensures frontend dependencies
- Starts API then web UI

Usage (from project root):
    python scripts/start_dev.py
"""

from __future__ import annotations

import os
import platform
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
VENV_DIR = BACKEND / ".venv"
SEED_EXCEL = ROOT / "data" / "seed" / "bank_deposits.xlsx"

API_PORT = 8000
UI_PORT = 5173
API_URL = f"http://127.0.0.1:{API_PORT}/api/v1/health"
UI_URL = f"http://localhost:{UI_PORT}"

PROCESSES: list[subprocess.Popen] = []


def log(message: str) -> None:
    print(f"[start] {message}")


def run(cmd: list[str], *, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    log(f"run: {' '.join(cmd)}")
    return subprocess.run(cmd, cwd=cwd or ROOT, check=check)


def python_exe() -> Path:
    if platform.system() == "Windows":
        venv_python = VENV_DIR / "Scripts" / "python.exe"
    else:
        venv_python = VENV_DIR / "bin" / "python"
    if venv_python.exists():
        return venv_python
    return Path(sys.executable)


def find_bootstrap_python() -> str:
    if platform.system() == "Windows":
        for candidate in ("py -3.14", "py -3.12", "py -3", "python"):
            exe = candidate.split()[0]
            if shutil.which(exe):
                return candidate
    for candidate in ("python3.14", "python3.12", "python3", "python"):
        if shutil.which(candidate):
            return candidate
    raise RuntimeError("Python not found. Install Python 3.12+ and try again.")


def ensure_backend_venv() -> None:
    if VENV_DIR.exists():
        return
    bootstrap = find_bootstrap_python()
    log(f"Creating virtual environment at {VENV_DIR}")
    if bootstrap.startswith("py "):
        run([*bootstrap.split(), "-m", "venv", str(VENV_DIR)])
    else:
        run([bootstrap, "-m", "venv", str(VENV_DIR)])


def reexec_in_venv() -> None:
    """Re-run this script with the venv Python so imports use installed deps."""
    venv_python = python_exe()
    if not venv_python.exists():
        return
    if Path(sys.executable).resolve() == venv_python.resolve():
        return
    log(f"Switching to venv Python: {venv_python}")
    script = str(Path(__file__).resolve())
    args = [str(venv_python), script, *sys.argv[1:]]
    # subprocess handles paths with spaces; os.execv does not on Windows.
    sys.exit(subprocess.call(args))


def ensure_backend_deps() -> None:
    ensure_backend_venv()
    py = python_exe()
    run([str(py), "-m", "pip", "install", "--upgrade", "pip"], cwd=BACKEND)
    run([str(py), "-m", "pip", "install", "-r", "requirements.txt"], cwd=BACKEND)


def npm_exe() -> str:
    npm = shutil.which("npm")
    if not npm:
        raise RuntimeError("npm not found. Install Node.js 18+ and try again.")
    return npm


def ensure_frontend_deps() -> None:
    npm = npm_exe()
    if not (FRONTEND / "node_modules").exists():
        run([npm, "install"], cwd=FRONTEND)
    env_file = FRONTEND / ".env"
    env_example = FRONTEND / ".env.example"
    if not env_file.exists() and env_example.exists():
        shutil.copy(env_example, env_file)
        log(f"Created {env_file.relative_to(ROOT)} from .env.example")


def ensure_seed_excel() -> None:
    if SEED_EXCEL.exists():
        return
    log("Generating sample Excel seed file...")
    py = python_exe()
    run([str(py), str(ROOT / "scripts" / "generate_bank_deposits.py")])


def ensure_database() -> None:
    sys.path.insert(0, str(BACKEND))
    from sqlalchemy import func, select

    from app.core.database import SessionLocal, init_db
    from app.models.deposit import Deposit
    from app.models.owner import Owner
    from app.services.bank_import import BankImportService
    from app.services.seed import seed_reference_data

    init_db()
    db = SessionLocal()
    try:
        owner_count = db.scalar(select(func.count()).select_from(Owner)) or 0
        deposit_count = db.scalar(select(func.count()).select_from(Deposit)) or 0

        if owner_count == 0:
            log("Seeding owners, properties, and bank accounts...")
            seed_reference_data(db)
        else:
            log(f"Database already has {owner_count} owner(s) — skipping seed")

        if deposit_count == 0:
            ensure_seed_excel()
            log("Importing sample bank deposits...")
            result = BankImportService(db).import_deposits(SEED_EXCEL)
            log(
                f"Imported {result.imported_count} deposit(s) "
                f"({result.skipped_count} skipped, {result.error_count} errors)"
            )
        else:
            log(f"Database already has {deposit_count} deposit(s) — skipping import")
    finally:
        db.close()


def can_bind_port(port: int) -> bool:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def find_free_port(start: int, attempts: int = 20) -> int:
    for port in range(start, start + attempts):
        if can_bind_port(port):
            return port
    raise RuntimeError(f"No free port found in range {start}-{start + attempts - 1}")


def resolve_ports() -> None:
    global API_PORT, UI_PORT, API_URL, UI_URL

    if not can_bind_port(API_PORT):
        new_port = find_free_port(API_PORT + 1)
        log(f"Port 8000 is busy — using API port {new_port}")
        API_PORT = new_port

    if not can_bind_port(UI_PORT):
        new_port = find_free_port(UI_PORT + 1)
        log(f"Port 5173 is busy — using UI port {new_port}")
        UI_PORT = new_port

    API_URL = f"http://127.0.0.1:{API_PORT}/api/v1/health"
    UI_URL = f"http://localhost:{UI_PORT}"


def wait_for_api(timeout_seconds: int = 30) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(API_URL, timeout=1) as response:
                if response.status == 200:
                    log("API is ready")
                    return
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.5)
    raise RuntimeError(f"API did not become ready at {API_URL}")


def start_backend() -> subprocess.Popen:
    py = python_exe()
    cmd = [
        str(py),
        "-m",
        "uvicorn",
        "app.main:app",
        "--reload",
        "--host",
        "127.0.0.1",
        "--port",
        str(API_PORT),
    ]
    log(f"Starting backend on http://127.0.0.1:{API_PORT}")
    return subprocess.Popen(cmd, cwd=BACKEND)


def start_frontend() -> subprocess.Popen:
    npm = npm_exe()
    env = os.environ.copy()
    env["VITE_API_BASE_URL"] = f"http://127.0.0.1:{API_PORT}/api/v1"
    log(f"Starting frontend on http://localhost:{UI_PORT}")
    return subprocess.Popen(
        [npm, "run", "dev", "--", "--port", str(UI_PORT)],
        cwd=FRONTEND,
        shell=False,
        env=env,
    )


def shutdown_children(*_args) -> None:
    log("Shutting down...")
    for proc in PROCESSES:
        if proc.poll() is None:
            proc.terminate()
    for proc in PROCESSES:
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    sys.exit(0)


def main() -> int:
    os.chdir(ROOT)
    log(f"Project root: {ROOT}")

    try:
        ensure_backend_venv()
        reexec_in_venv()
        ensure_backend_deps()
        ensure_frontend_deps()
        ensure_database()
    except Exception as exc:
        log(f"Setup failed: {exc}")
        return 1

    resolve_ports()

    signal.signal(signal.SIGINT, shutdown_children)
    if platform.system() != "Windows":
        signal.signal(signal.SIGTERM, shutdown_children)

    try:
        backend_proc = start_backend()
        PROCESSES.append(backend_proc)
        wait_for_api()

        frontend_proc = start_frontend()
        PROCESSES.append(frontend_proc)

        print()
        print("=" * 60)
        print("  SimplifAI is running")
        print(f"  Web UI:  {UI_URL}")
        print(f"  API:     http://127.0.0.1:{API_PORT}")
        print(f"  API docs http://127.0.0.1:{API_PORT}/docs")
        print("  Press Ctrl+C to stop both servers")
        print("=" * 60)
        print()

        while True:
            if backend_proc.poll() is not None:
                log("Backend exited unexpectedly")
                return backend_proc.returncode or 1
            if frontend_proc.poll() is not None:
                log("Frontend exited unexpectedly")
                return frontend_proc.returncode or 1
            time.sleep(0.5)
    except KeyboardInterrupt:
        shutdown_children()
    except Exception as exc:
        log(f"Error: {exc}")
        shutdown_children()
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
