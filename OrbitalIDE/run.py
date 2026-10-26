#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OrbitalIDE — 3D-файловый менеджер с редактором кода.

Запуск:
    python3 run.py

Скрипт спросит, где создать рабочую папку проекта, создаст её и запустит
локальный сервер. Все файлы и папки, созданные в 3D-интерфейсе, реально
появляются на диске. Редактор читает и сохраняет настоящие файлы.

Для автоматического запуска без вопросов:
    python3 run.py --workspace ~/Desktop/MyProject
    python3 run.py --workspace . --port 9000 --no-browser

Зависимостей нет — только стандартная библиотека Python 3.9+.
"""

from __future__ import annotations

import argparse
import contextlib
import http.server
import json
import os
import shutil
import socket
import stat
import sys
import tempfile
import threading
import traceback
import webbrowser
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TREE_ENTRIES = 6000
MAX_TREE_DEPTH = 24
JSON_BODY_LIMIT = 6 * 1024 * 1024

IGNORED_NAMES = {
    ".git", ".hg", ".svn",
    "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache",
    ".venv", "venv", "env",
    "dist", "build", "target", ".next", ".nuxt", ".cache",
}

INVALID_NAME_CHARS = set('/\\:*?"<>|')
CONTROL_CHARS = set(chr(code) for code in range(32))


class ApiError(Exception):
    """Ошибка API, которую можно безопасно показать пользователю."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def validate_name(name: object) -> str:
    if not isinstance(name, str):
        raise ApiError("Имя должно быть строкой.")
    name = name.strip()
    if not name:
        raise ApiError("Имя не может быть пустым.")
    if name in (".", ".."):
        raise ApiError("Такое имя использовать нельзя.")
    if len(name) > 120:
        raise ApiError("Слишком длинное имя (максимум 120 символов).")
    if any(char in INVALID_NAME_CHARS for char in name) or any(char in CONTROL_CHARS for char in name):
        raise ApiError('Имя не должно содержать \\ / : * ? " < > | и управляющие символы.')
    return name


def workspace_writable(path: Path) -> bool:
    probe = path / ".orbital-write-test"
    try:
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return True
    except OSError:
        with contextlib.suppress(OSError):
            probe.unlink()
        return False


class OrbitalHandler(http.server.SimpleHTTPRequestHandler):
    workspace: Path = ROOT.resolve()
    server_version = "OrbitalIDE/0.2"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # ---------- заголовки / статика ----------

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def list_directory(self, path):  # noqa: A002 - подпись из stdlib
        self.send_error(404, "Directory listing is disabled")
        return None

    def log_message(self, fmt: str, *args) -> None:
        if args and isinstance(args[0], str) and args[0].startswith(("4", "5")):
            super().log_message(fmt, *args)

    # ---------- маршрутизация ----------

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.run_api(lambda: self.api_get(parsed))
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self.send_error(404)
            return
        self.run_api(lambda: self.api_post(parsed))

    def do_PUT(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self.send_error(404)
            return
        self.run_api(lambda: self.api_put(parsed))

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self.send_error(404)
            return
        self.run_api(lambda: self.api_delete(parsed))

    # ---------- инфраструктура API ----------

    def run_api(self, function) -> None:
        try:
            payload = function()
            self.send_json(200, payload if payload is not None else {"ok": True})
        except ApiError as error:
            self.send_json(error.status, {"error": str(error)})
        except OSError as error:
            self.log_error("OS error: %s", error)
            self.send_json(500, {"error": f"Ошибка файловой системы: {error.strerror or error}"})
        except Exception as error:  # noqa: BLE001
            self.log_error("API error: %s", error)
            traceback.print_exc()
            self.send_json(500, {"error": "Внутренняя ошибка сервера."})

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            self.wfile.write(body)

    def read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError as error:
            raise ApiError("Некорректный Content-Length.") from error
        if length <= 0:
            raise ApiError("Пустой запрос.")
        if length > JSON_BODY_LIMIT:
            raise ApiError("Слишком большой запрос.", 413)
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ApiError("Некорректный JSON.") from error
        if not isinstance(data, dict):
            raise ApiError("Ожидался JSON-объект.")
        return data

    def resolve_path(self, relative: object) -> Path:
        """Превращает относительный путь в безопасный путь внутри workspace."""
        if relative is None:
            relative = ""
        if not isinstance(relative, str):
            raise ApiError("Некорректный путь.")
        relative = relative.strip().strip("/")
        if not relative:
            return self.workspace

        if any(part in ("..", ".") or "\\" in part or part == "" for part in PurePosixPath(relative).parts):
            raise ApiError("Недопустимый путь.", 403)

        current = self.workspace
        for part in PurePosixPath(relative).parts:
            current = current / part
            if current.is_symlink():
                raise ApiError("Символические ссылки не поддерживаются.", 403)

        resolved = current.resolve(strict=False)
        if resolved != self.workspace and self.workspace not in resolved.parents:
            raise ApiError("Путь находится вне рабочей папки.", 403)

        return current

    def relative_from(self, path: Path) -> str:
        return path.relative_to(self.workspace).as_posix()

    # ---------- GET ----------

    def api_get(self, parsed) -> dict:
        if parsed.path == "/api/info":
            return {
                "name": self.workspace.name or str(self.workspace),
                "path": str(self.workspace),
                "maxFileBytes": MAX_FILE_BYTES,
                "version": 1,
            }
        if parsed.path == "/api/tree":
            return self.api_tree()
        if parsed.path == "/api/read":
            query = parse_qs(parsed.query)
            return self.api_read((query.get("path") or [""])[0])
        raise ApiError("Неизвестный API-метод.", 404)

    def api_tree(self) -> dict:
        if not self.workspace.is_dir():
            raise ApiError("Рабочая папка недоступна.", 500)

        counter = [0]
        truncated = [False]

        def build(path: Path, relative: str, depth: int) -> dict:
            node = {
                "id": relative or ".",
                "type": "folder",
                "name": path.name or str(path),
                "children": [],
            }
            if depth >= MAX_TREE_DEPTH:
                node["truncated"] = True
                truncated[0] = True
                return node

            try:
                entries = list(path.iterdir())
            except OSError:
                node["unreadable"] = True
                return node

            def sort_key(entry: Path):
                try:
                    is_dir = entry.is_dir() and not entry.is_symlink()
                except OSError:
                    is_dir = False
                return (0 if is_dir else 1, entry.name.casefold())

            for entry in sorted(entries, key=sort_key):
                if counter[0] >= MAX_TREE_ENTRIES:
                    truncated[0] = True
                    break
                if entry.name in IGNORED_NAMES or entry.name.startswith(".orbital-") or entry.is_symlink():
                    continue

                child_relative = f"{relative}/{entry.name}" if relative else entry.name
                try:
                    if entry.is_dir():
                        counter[0] += 1
                        node["children"].append(build(entry, child_relative, depth + 1))
                    elif entry.is_file():
                        counter[0] += 1
                        node["children"].append({
                            "id": child_relative,
                            "type": "file",
                            "name": entry.name,
                            "size": entry.stat().st_size,
                        })
                except OSError:
                    continue

            return node

        tree = build(self.workspace, "", 0)
        tree["truncated"] = truncated[0]
        return tree

    def api_read(self, relative: str) -> dict:
        path = self.resolve_path(relative)
        if not path.exists():
            raise ApiError("Файл не найден.", 404)
        if not path.is_file():
            raise ApiError("Это не файл.", 400)

        size = path.stat().st_size
        if size > MAX_FILE_BYTES:
            raise ApiError(
                f"Файл больше {MAX_FILE_BYTES // (1024 * 1024)} МБ — редактор не откроет его.",
                413,
            )

        raw = path.read_bytes()
        if b"\x00" in raw[:8192]:
            return {"binary": True, "size": size, "content": None, "path": relative}

        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            return {"binary": True, "size": size, "content": None, "path": relative}

        return {
            "binary": False,
            "size": size,
            "content": content,
            "path": relative,
            "name": path.name,
        }

    # ---------- POST ----------

    def api_post(self, parsed) -> dict:
        if parsed.path == "/api/create":
            return self.api_create(self.read_json())
        if parsed.path == "/api/rename":
            return self.api_rename(self.read_json())
        if parsed.path == "/api/write":
            # POST нужен для navigator.sendBeacon при закрытии вкладки.
            return self.api_write(self.read_json())
        raise ApiError("Неизвестный API-метод.", 404)

    def api_create(self, data: dict) -> dict:
        parent_relative = data.get("parent", "")
        if parent_relative is None:
            parent_relative = ""
        if not isinstance(parent_relative, str):
            raise ApiError("Некорректный путь родительской папки.")

        kind = data.get("type")
        name = validate_name(data.get("name"))
        content = data.get("content", "")
        if not isinstance(content, str):
            raise ApiError("Содержимое файла должно быть строкой.")

        parent = self.resolve_path(parent_relative)
        if not parent.is_dir():
            raise ApiError("Родительская папка не найдена.", 404)

        target = parent / name
        if target.exists() or target.is_symlink():
            raise ApiError("Элемент с таким именем уже существует.", 409)

        if kind == "folder":
            try:
                target.mkdir()
            except FileExistsError as error:
                raise ApiError("Элемент с таким именем уже существует.", 409) from error
        elif kind == "file":
            encoded = content.encode("utf-8")
            if len(encoded) > MAX_FILE_BYTES:
                raise ApiError("Файл слишком большой.", 413)
            try:
                with open(target, "xb") as handle:
                    handle.write(encoded)
            except FileExistsError as error:
                raise ApiError("Элемент с таким именем уже существует.", 409) from error
        else:
            raise ApiError("Неизвестный тип элемента.")

        return {
            "id": self.relative_from(target),
            "name": target.name,
            "type": kind,
        }

    def api_rename(self, data: dict) -> dict:
        relative = data.get("path", "")
        if not relative:
            raise ApiError("Нельзя переименовать корневую папку.", 403)

        new_name = validate_name(data.get("name"))
        source = self.resolve_path(relative)
        if not source.exists():
            raise ApiError("Элемент не найден.", 404)
        if source == self.workspace:
            raise ApiError("Нельзя переименовать корневую папку.", 403)
        if source.name == new_name:
            raise ApiError("Имя не изменилось.")

        target = source.with_name(new_name)
        if target.exists() or target.is_symlink():
            raise ApiError("Элемент с таким именем уже существует.", 409)

        source.rename(target)
        return {
            "id": self.relative_from(target),
            "name": target.name,
            "type": "folder" if target.is_dir() else "file",
        }

    # ---------- PUT ----------

    def api_put(self, parsed) -> dict:
        if parsed.path != "/api/write":
            raise ApiError("Неизвестный API-метод.", 404)
        return self.api_write(self.read_json())

    def api_write(self, data: dict) -> dict:
        relative = data.get("path", "")
        content = data.get("content")

        if not isinstance(relative, str) or not relative:
            raise ApiError("Не указан путь файла.")
        if not isinstance(content, str):
            raise ApiError("Содержимое файла должно быть строкой.")

        encoded = content.encode("utf-8")
        if len(encoded) > MAX_FILE_BYTES:
            raise ApiError("Файл слишком большой для сохранения.", 413)

        path = self.resolve_path(relative)
        if not path.exists():
            raise ApiError("Файл не найден.", 404)
        if not path.is_file():
            raise ApiError("Нельзя сохранить содержимое в папку.", 400)

        mode = None
        try:
            mode = stat.S_IMODE(path.stat().st_mode)
        except OSError:
            pass

        descriptor, temporary_name = tempfile.mkstemp(prefix=".orbital-", dir=str(path.parent))
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(encoded)
            if mode is not None:
                with contextlib.suppress(OSError):
                    os.chmod(temporary_name, mode)
            os.replace(temporary_name, path)
        finally:
            with contextlib.suppress(OSError):
                os.unlink(temporary_name)

        return {"ok": True, "path": relative, "size": len(encoded)}

    # ---------- DELETE ----------

    def api_delete(self, parsed) -> dict:
        if parsed.path != "/api/delete":
            raise ApiError("Неизвестный API-метод.", 404)

        data = self.read_json()
        relative = data.get("path", "")
        if not relative:
            raise ApiError("Нельзя удалить корневую папку.", 403)

        target = self.resolve_path(relative)
        if not target.exists():
            raise ApiError("Элемент не найден.", 404)
        if target == self.workspace:
            raise ApiError("Нельзя удалить корневую папку.", 403)

        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()

        return {"ok": True}


class OrbitalServer(http.server.ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def find_free_port(preferred: int, attempts: int = 50) -> int:
    for port in range(preferred, preferred + attempts):
        with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError(
        f"Не удалось найти свободный порт в диапазоне {preferred}–{preferred + attempts - 1}"
    )


def ask_workspace() -> Path:
    """Интерактивно спрашивает, где создать рабочую папку проекта."""
    desktop = Path.home() / "Desktop"
    default_parent = desktop if desktop.is_dir() else Path.home()

    print()
    print("  Где создать папку проекта?")
    print("  Файлы, которые вы создадите в 3D-сцене, появятся именно там.")
    print()

    while True:
        try:
            raw_parent = input(f"  Родительская папка [{default_parent}]: ").strip()
        except EOFError:
            raw_parent = ""
        raw_parent = raw_parent.strip("\"'")
        parent = Path(raw_parent).expanduser() if raw_parent else default_parent
        if not parent.is_absolute():
            parent = (Path.cwd() / parent).resolve()
        if parent.exists() and not parent.is_dir():
            print(f"  ! Это файл, а не папка: {parent}")
            continue
        try:
            parent.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            print(f"  ! Не удалось создать родительскую папку: {error}")
            continue
        if not os.access(parent, os.W_OK):
            print(f"  ! Нет прав на запись: {parent}")
            continue
        break

    while True:
        try:
            raw_name = input("  Имя папки проекта [OrbitalProject]: ").strip()
        except EOFError:
            raw_name = ""
        try:
            name = validate_name(raw_name or "OrbitalProject")
        except ApiError as error:
            print(f"  ! {error}")
            continue

        target = parent / name
        if target.exists():
            if not target.is_dir():
                print(f"  ! По этому пути уже есть файл: {target}")
                continue
            try:
                non_empty = any(target.iterdir())
            except OSError:
                non_empty = True
            if non_empty:
                try:
                    answer = input(
                        f"  Папка {target} уже существует и не пуста. Использовать её? [Y/n]: "
                    ).strip().lower()
                except EOFError:
                    answer = "y"
                if answer in {"n", "no", "н", "нет"}:
                    continue
                print("  Использую существующую папку.")
            else:
                print("  Использую существующую пустую папку.")
        else:
            try:
                target.mkdir(parents=True)
            except OSError as error:
                print(f"  ! Не удалось создать папку: {error}")
                continue
            print(f"  ✓ Создана папка: {target}")

        target = target.resolve()
        if not workspace_writable(target):
            print(f"  ! В папку нельзя записывать файлы: {target}")
            print("    Выберите другое имя или другую родительскую папку.")
            continue
        return target


def workspace_from_argument(value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = (Path.cwd() / path).resolve()
    else:
        path = path.resolve()

    if path.exists() and not path.is_dir():
        raise SystemExit(f"Ошибка: путь указывает на файл, а не на папку:\n  {path}")
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise SystemExit(f"Ошибка создания рабочей папки: {error}") from error
    if not workspace_writable(path):
        raise SystemExit(f"Ошибка: нет прав на запись в папку:\n  {path}")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description="OrbitalIDE — 3D-файловый менеджер")
    parser.add_argument("--port", type=int, default=8000, help="стартовый порт (по умолчанию 8000)")
    parser.add_argument("--no-browser", action="store_true", help="не открывать браузер автоматически")
    parser.add_argument(
        "--workspace",
        metavar="PATH",
        help="рабочая папка проекта (без интерактивных вопросов; создаётся при необходимости)",
    )
    args = parser.parse_args()

    if not (ROOT / "index.html").is_file():
        print("Ошибка: рядом с run.py не найден index.html", file=sys.stderr)
        return 1

    if args.workspace:
        workspace = workspace_from_argument(args.workspace)
    else:
        try:
            workspace = ask_workspace()
        except KeyboardInterrupt:
            print("\n  Отменено.\n")
            return 1

    OrbitalHandler.workspace = workspace

    try:
        port = find_free_port(args.port)
        server = OrbitalServer(("127.0.0.1", port), OrbitalHandler)
    except OSError as error:
        print(f"Ошибка запуска сервера: {error}", file=sys.stderr)
        return 1

    url = f"http://127.0.0.1:{port}/"
    print()
    print("  ╭────────────────────────────────────────────────────╮")
    print("  │                 OrbitalIDE  ·  3D                  │")
    print("  ╰────────────────────────────────────────────────────╯")
    print(f"  Рабочая папка : {workspace}")
    print(f"  Адрес         : {url}")
    print("  Остановка     : Ctrl+C")
    print()

    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Сервер остановлен. До связи! 🚀\n")
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
