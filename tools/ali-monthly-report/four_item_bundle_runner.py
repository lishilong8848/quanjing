#!/usr/bin/env python3
"""Download the latest four Ali monthly-report attachments and build one ZIP.

This runner intentionally uses only the Python standard library. Generating Excel
reports still uses the existing dependency-managed runners; downloading already
generated Bitable attachments must not be blocked by pandas, Flask, or openpyxl.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen


FEISHU_TOKEN_URL = (
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
)
FEISHU_RECORDS_URL = (
    "https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}"
    "/tables/{table_id}/records"
)
FEISHU_MEDIA_DOWNLOAD_URL = (
    "https://open.feishu.cn/open-apis/drive/v1/medias/{file_token}/download"
)
DEFAULT_HIGH_POWER_TABLE_ID = "tblkh6YCMYtS8nHa"
DEFAULT_HIGH_POWER_VIEW_ID = "vewrHJHl3v"
DEFAULT_ALARM_REPORT_TABLE_ID = "tblAGQeQ7tpV8tWt"
DEFAULT_ALARM_REPORT_VIEW_ID = "vewrHJHl3v"
DEFAULT_STAFF_REPORT_TABLE_ID = "tbl3KED5CdvNSCwT"
DEFAULT_STAFF_REPORT_VIEW_ID = "vewrHJHl3v"
EXPECTED_CATEGORIES = ("超功率", "TOP5", "告警分析", "人员变动")
MAX_FEISHU_FILE_BYTES = 30 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 20
DOWNLOAD_SOCKET_TIMEOUT_SECONDS = 15
MAX_ATTACHMENT_DOWNLOAD_SECONDS = 90
MAX_REQUEST_ATTEMPTS = 2
MAX_DOWNLOAD_ATTEMPTS = 4
STALE_STAGING_SECONDS = 24 * 60 * 60
WINDOWS_INVALID_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
SAFE_FILE_TOKEN = re.compile(r"[A-Za-z0-9._-]{1,256}")
ALLOWED_FEISHU_DOWNLOAD_HOSTS = ("feishu.cn", "larksuite.com")


@dataclass(frozen=True)
class SourceSpec:
    key: str
    app_token: str
    table_id: str
    view_id: str


@dataclass(frozen=True)
class BundleAttachment:
    category: str
    name: str
    file_token: str
    extra: str
    modified_at: int
    record_id: str


def is_allowed_feishu_download_url(value: str) -> bool:
    parsed = urlparse(str(value or ""))
    host = (parsed.hostname or "").lower().rstrip(".")
    return parsed.scheme == "https" and any(
        host == suffix or host.endswith(f".{suffix}")
        for suffix in ALLOWED_FEISHU_DOWNLOAD_HOSTS
    )


class SafeFeishuRedirectHandler(HTTPRedirectHandler):
    """Allow redirects only inside Feishu-controlled HTTPS domains."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not is_allowed_feishu_download_url(newurl):
            raise HTTPError(
                req.full_url,
                code,
                "飞书附件下载被重定向到不受信任域名",
                headers,
                fp,
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


DOWNLOAD_OPENER = build_opener(SafeFeishuRedirectHandler())


def emit_log(logs: list[str], message: str, level: str = "info") -> None:
    logs.append(f"[{level}] {message}")


def require_text(config: Mapping[str, str], key: str, label: str) -> str:
    value = str(config.get(key, "") or "").strip()
    if not value:
        raise ValueError(f"缺少{label}")
    return value


def load_runtime_config(
    environ: Mapping[str, str] | None = None,
) -> dict[str, str]:
    env = environ or os.environ
    config = {
        "download_folder": str(env.get("DOWNLOAD_FOLDER", "")).strip(),
        "feishu_app_id": str(env.get("FEISHU_APP_ID", "")).strip(),
        "feishu_app_secret": str(env.get("FEISHU_APP_SECRET", "")).strip(),
        "feishu_app_token": str(env.get("FEISHU_APP_TOKEN", "")).strip(),
        "high_power_table_id": str(
            env.get("HIGH_POWER_TABLE_ID", DEFAULT_HIGH_POWER_TABLE_ID)
        ).strip()
        or DEFAULT_HIGH_POWER_TABLE_ID,
        "high_power_view_id": str(
            env.get("HIGH_POWER_VIEW_ID", DEFAULT_HIGH_POWER_VIEW_ID)
        ).strip(),
        "alarm_report_table_id": str(
            env.get("ALARM_REPORT_TABLE_ID", DEFAULT_ALARM_REPORT_TABLE_ID)
        ).strip()
        or DEFAULT_ALARM_REPORT_TABLE_ID,
        "alarm_report_view_id": str(
            env.get("ALARM_REPORT_VIEW_ID", DEFAULT_ALARM_REPORT_VIEW_ID)
        ).strip(),
        "staff_report_table_id": str(
            env.get("STAFF_REPORT_TABLE_ID", DEFAULT_STAFF_REPORT_TABLE_ID)
        ).strip()
        or DEFAULT_STAFF_REPORT_TABLE_ID,
        "staff_report_view_id": str(
            env.get("STAFF_REPORT_VIEW_ID", DEFAULT_STAFF_REPORT_VIEW_ID)
        ).strip(),
    }
    require_text(config, "download_folder", "阿里月报输出目录")
    require_text(config, "feishu_app_id", "飞书应用 App ID")
    require_text(config, "feishu_app_secret", "飞书应用 App Secret")
    require_text(config, "feishu_app_token", "资料管理多维表 App Token")
    return config


def source_specs(config: Mapping[str, str]) -> tuple[SourceSpec, ...]:
    app_token = require_text(config, "feishu_app_token", "资料管理多维表 App Token")
    return (
        SourceSpec(
            "power",
            app_token,
            require_text(config, "high_power_table_id", "高功率表 ID"),
            str(config.get("high_power_view_id", "")),
        ),
        SourceSpec(
            "alarm",
            app_token,
            require_text(config, "alarm_report_table_id", "告警分析表 ID"),
            str(config.get("alarm_report_view_id", "")),
        ),
        SourceSpec(
            "staff",
            app_token,
            require_text(config, "staff_report_table_id", "人员变动表 ID"),
            str(config.get("staff_report_view_id", "")),
        ),
    )


def _response_error_message(error: HTTPError) -> str:
    try:
        body = error.read(1024).decode("utf-8", errors="replace")
        payload = json.loads(body)
        detail = str(payload.get("msg", "")).strip()
    except Exception:
        detail = ""
    return f"HTTP {error.code}{f': {detail}' if detail else ''}"


def is_retryable_download_http_error(code: int, message: str) -> bool:
    return (
        code >= 500
        or code in {408, 409, 425, 429}
        or (code == 400 and "data not ready" in message.casefold())
    )


def request_json(
    url: str,
    *,
    method: str = "GET",
    headers: Mapping[str, str] | None = None,
    payload: Mapping[str, Any] | None = None,
    timeout: int = REQUEST_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    body = None
    request_headers = dict(headers or {})
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request_headers.setdefault("Content-Type", "application/json")

    last_error = ""
    for attempt in range(1, MAX_REQUEST_ATTEMPTS + 1):
        request = Request(
            url,
            data=body,
            headers=request_headers,
            method=method,
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
            if not isinstance(result, dict):
                raise ValueError("飞书接口返回格式无效")
            if result.get("code") != 0:
                raise ValueError(
                    f"飞书接口返回失败: {result.get('msg') or result.get('code')}"
                )
            return result
        except HTTPError as exc:
            last_error = _response_error_message(exc)
            if exc.code < 500 or attempt >= MAX_REQUEST_ATTEMPTS:
                break
        except (TimeoutError, URLError, OSError, ValueError, json.JSONDecodeError) as exc:
            last_error = str(exc)
            if attempt >= MAX_REQUEST_ATTEMPTS:
                break
        time.sleep(0.2 * attempt)
    raise ValueError(f"飞书接口请求失败: {last_error or '未知错误'}")


def request_tenant_token(config: Mapping[str, str]) -> str:
    result = request_json(
        FEISHU_TOKEN_URL,
        method="POST",
        payload={
            "app_id": require_text(config, "feishu_app_id", "飞书应用 App ID"),
            "app_secret": require_text(
                config,
                "feishu_app_secret",
                "飞书应用 App Secret",
            ),
        },
    )
    token = str(result.get("tenant_access_token", "") or "").strip()
    if not token:
        token = str(result.get("data", {}).get("tenant_access_token", "") or "").strip()
    if not token:
        raise ValueError("获取飞书 tenant_access_token 失败：响应缺少 token")
    return token


def fetch_source_records(source: SourceSpec, token: str) -> list[dict[str, Any]]:
    base_url = FEISHU_RECORDS_URL.format(
        app_token=source.app_token,
        table_id=source.table_id,
    )
    records: list[dict[str, Any]] = []
    page_token = ""
    while True:
        query: dict[str, str | int] = {
            "page_size": 500,
            "automatic_fields": "true",
        }
        if source.view_id:
            query["view_id"] = source.view_id
        if page_token:
            query["page_token"] = page_token
        result = request_json(
            f"{base_url}?{urlencode(query)}",
            headers={"Authorization": f"Bearer {token}"},
        )
        data = result.get("data", {})
        items = data.get("items", [])
        if not isinstance(items, list):
            raise ValueError(f"{source.key}多维表记录格式无效")
        records.extend(item for item in items if isinstance(item, dict))
        if not data.get("has_more"):
            return records
        page_token = str(data.get("page_token", "") or "").strip()
        if not page_token:
            raise ValueError(f"{source.key}多维表分页缺少 page_token")


def _period_number(value: Any, suffix: str, digits: str) -> int | None:
    match = re.fullmatch(rf"({digits}){suffix}?", str(value or "").strip())
    return int(match.group(1)) if match else None


def record_matches_period(record_value: Mapping[str, Any], year: int, month: int) -> bool:
    fields = record_value.get("fields", {})
    if not isinstance(fields, Mapping):
        return False
    return _period_number(fields.get("年度"), "年", r"\d{4}") == year and _period_number(
        fields.get("月份"),
        "月",
        r"\d{1,2}",
    ) == month


def _record_modified_at(record_value: Mapping[str, Any]) -> int:
    for key in ("last_modified_time", "created_time"):
        try:
            value = int(float(record_value.get(key, 0) or 0))
        except (TypeError, ValueError):
            continue
        if value > 0:
            return value
    return 0


def _is_xlsx(name: str) -> bool:
    return Path(name).suffix.lower() == ".xlsx"


def _matches_category(category: str, name: str) -> bool:
    normalized = str(name or "").strip()
    if not _is_xlsx(normalized):
        return False
    upper_name = normalized.upper()
    if category == "超功率":
        return ("超功率" in normalized or "超功耗" in normalized) and "TOP5" not in upper_name
    if category == "TOP5":
        return "TOP5" in upper_name
    return category in {"告警分析", "人员变动"}


def _attachment_candidates(
    records: Sequence[Mapping[str, Any]],
    category: str,
    year: int,
    month: int,
) -> list[BundleAttachment]:
    candidates: list[BundleAttachment] = []
    for record_value in records:
        if not record_matches_period(record_value, year, month):
            continue
        fields = record_value.get("fields", {})
        if not isinstance(fields, Mapping):
            continue
        attachments = fields.get("上传文件", [])
        if not isinstance(attachments, list):
            continue
        for item in attachments:
            if not isinstance(item, Mapping):
                continue
            name = str(item.get("name", "") or "").strip()
            file_token = str(item.get("file_token", "") or "").strip()
            if not SAFE_FILE_TOKEN.fullmatch(file_token) or not _matches_category(category, name):
                continue
            source_url = str(item.get("url", "") or "").strip()
            extra = ""
            if source_url:
                try:
                    extra = str(parse_qs(urlparse(source_url).query).get("extra", [""])[0])
                except (TypeError, ValueError):
                    extra = ""
            if len(extra) > 4096:
                raise ValueError(f"{category}附件扩展下载参数过长")
            candidates.append(
                BundleAttachment(
                    category=category,
                    name=name,
                    file_token=file_token,
                    extra=extra,
                    modified_at=_record_modified_at(record_value),
                    record_id=str(record_value.get("record_id", "") or ""),
                )
            )
    return candidates


def _select_latest(candidates: Sequence[BundleAttachment], category: str) -> BundleAttachment:
    if not candidates:
        raise ValueError(f"未找到指定年月的{category} XLSX 附件")
    latest_time = max(item.modified_at for item in candidates)
    latest = [item for item in candidates if item.modified_at == latest_time]
    if len(latest) != 1:
        names = "、".join(sorted(item.name for item in latest))
        raise ValueError(f"最新{category}记录包含多个同类附件，无法确定唯一文件: {names}")
    return latest[0]


def select_bundle_attachments(
    source_records: Mapping[str, Sequence[Mapping[str, Any]]],
    year: int,
    month: int,
) -> list[BundleAttachment]:
    category_sources = (
        ("超功率", "power"),
        ("TOP5", "power"),
        ("告警分析", "alarm"),
        ("人员变动", "staff"),
    )
    selected = [
        _select_latest(
            _attachment_candidates(source_records.get(source_key, ()), category, year, month),
            category,
        )
        for category, source_key in category_sources
    ]
    if tuple(item.category for item in selected) != EXPECTED_CATEGORIES:
        raise ValueError("四项月报分类不完整，无法打包")
    return selected


def sanitize_filename(value: str, fallback: str) -> str:
    name = WINDOWS_INVALID_FILENAME.sub("_", Path(str(value or "")).name).strip(" .")
    if not name:
        name = fallback
    suffix = Path(name).suffix
    stem = Path(name).stem[:160]
    return f"{stem}{suffix}" if suffix else stem


def build_attachment_download_url(item: BundleAttachment) -> str:
    if not SAFE_FILE_TOKEN.fullmatch(item.file_token):
        raise ValueError(f"{item.category}附件 file_token 格式无效")
    url = FEISHU_MEDIA_DOWNLOAD_URL.format(
        file_token=quote(item.file_token, safe=""),
    )
    if item.extra:
        url = f"{url}?{urlencode({'extra': item.extra})}"
    if not is_allowed_feishu_download_url(url):
        raise ValueError(f"{item.category}附件下载地址不受信任")
    return url


def download_attachment(
    item: BundleAttachment,
    token: str,
    destination: str | Path,
) -> Path:
    destination_path = Path(destination)
    destination_path.mkdir(parents=True, exist_ok=True)
    file_name = sanitize_filename(item.name, f"{item.category}.xlsx")
    file_path = destination_path / file_name
    part_path = file_path.with_suffix(file_path.suffix + ".part")
    last_error = ""
    started_at = time.monotonic()
    for attempt in range(1, MAX_DOWNLOAD_ATTEMPTS + 1):
        if time.monotonic() - started_at >= MAX_ATTACHMENT_DOWNLOAD_SECONDS:
            last_error = f"总下载时长超过 {MAX_ATTACHMENT_DOWNLOAD_SECONDS} 秒"
            break
        part_path.unlink(missing_ok=True)
        request = Request(
            build_attachment_download_url(item),
            headers={"Authorization": f"Bearer {token}"},
            method="GET",
        )
        try:
            total = 0
            with DOWNLOAD_OPENER.open(
                request,
                timeout=DOWNLOAD_SOCKET_TIMEOUT_SECONDS,
            ) as response, part_path.open("wb") as handle:
                while True:
                    if time.monotonic() - started_at >= MAX_ATTACHMENT_DOWNLOAD_SECONDS:
                        raise TimeoutError(
                            f"总下载时长超过 {MAX_ATTACHMENT_DOWNLOAD_SECONDS} 秒"
                        )
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_FEISHU_FILE_BYTES:
                        raise ValueError(f"{item.category}附件超过 30MB")
                    handle.write(chunk)
            if total <= 0:
                raise ValueError(f"{item.category}附件为空")
            os.replace(part_path, file_path)
            if not zipfile.is_zipfile(file_path):
                raise ValueError(f"{item.category}附件不是有效 XLSX")
            return file_path
        except HTTPError as exc:
            last_error = _response_error_message(exc)
            if not is_retryable_download_http_error(exc.code, last_error):
                break
        except (TimeoutError, URLError, OSError, ValueError) as exc:
            last_error = str(exc)
        finally:
            part_path.unlink(missing_ok=True)
        if attempt < MAX_DOWNLOAD_ATTEMPTS:
            remaining_seconds = (
                MAX_ATTACHMENT_DOWNLOAD_SECONDS - (time.monotonic() - started_at)
            )
            retry_delay = min(float(2 ** (attempt - 1)), remaining_seconds)
            if retry_delay <= 0:
                break
            time.sleep(retry_delay)
    file_path.unlink(missing_ok=True)
    raise ValueError(f"下载{item.category}附件失败: {last_error or '未知错误'}")


def generated_file_payload(file_path: Path) -> dict[str, str]:
    return {
        "name": file_path.name,
        "path": str(file_path.resolve()),
        "size": f"{file_path.stat().st_size / 1024:.1f}KB",
    }


def _bundle_arcname(category: str, file_path: Path, used_names: set[str]) -> str:
    clean_name = sanitize_filename(file_path.name, f"{category}.xlsx")
    candidate = f"{category}_{clean_name}"
    index = 2
    while candidate in used_names:
        candidate = f"{category}_{Path(clean_name).stem}_{index}{Path(clean_name).suffix}"
        index += 1
    used_names.add(candidate)
    return candidate


def build_bundle_zip(
    collected_files: Sequence[tuple[str, Path]],
    download_folder: str | Path,
    year: int,
    month: int,
) -> Path:
    if tuple(category for category, _path in collected_files) != EXPECTED_CATEGORIES:
        raise ValueError("四项月报分类不完整，无法打包")
    resolved_paths: set[str] = set()
    for category, file_path in collected_files:
        path = Path(file_path)
        if not path.is_file() or path.stat().st_size <= 0 or path.suffix.lower() != ".xlsx":
            raise ValueError(f"{category}文件不是有效的非空 XLSX")
        if not zipfile.is_zipfile(path):
            raise ValueError(f"{category}文件不是有效的 XLSX 工作簿")
        resolved_paths.add(str(path.resolve()))
    if len(resolved_paths) != len(EXPECTED_CATEGORIES):
        raise ValueError("四项月报存在重复文件，无法打包")

    output_dir = Path(download_folder)
    output_dir.mkdir(parents=True, exist_ok=True)
    zip_path = output_dir / f"阿里月报{year}年{month}月四项资料_{uuid.uuid4().hex}.zip"
    part_path = zip_path.with_suffix(".part")
    used_names: set[str] = set()
    try:
        with zipfile.ZipFile(part_path, "w", compression=zipfile.ZIP_STORED) as archive:
            for category, file_path in collected_files:
                archive.write(file_path, _bundle_arcname(category, file_path, used_names))
        with zipfile.ZipFile(part_path, "r") as archive:
            if len(archive.infolist()) != 4 or archive.testzip() is not None:
                raise ValueError("四项月报 ZIP 完整性校验失败")
        os.replace(part_path, zip_path)
        if zip_path.stat().st_size <= 0 or zip_path.stat().st_size > MAX_FEISHU_FILE_BYTES:
            raise ValueError("四项月报 ZIP 为空或超过飞书 30MB 上传上限")
        return zip_path
    except Exception:
        part_path.unlink(missing_ok=True)
        zip_path.unlink(missing_ok=True)
        raise


def cleanup_stale_staging(download_folder: Path) -> None:
    staging_parent = download_folder / ".ali-monthly-bundle"
    if not staging_parent.is_dir():
        return
    cutoff = time.time() - STALE_STAGING_SECONDS
    for candidate in staging_parent.iterdir():
        try:
            if candidate.is_dir() and candidate.stat().st_mtime < cutoff:
                shutil.rmtree(candidate, ignore_errors=True)
        except OSError:
            continue
    try:
        staging_parent.rmdir()
    except OSError:
        pass


def create_monthly_bundle(
    year: int,
    month: int,
    config: Mapping[str, str],
    logs: list[str] | None = None,
) -> dict[str, Any]:
    if year < 2000 or year > 2100 or month < 1 or month > 12:
        raise ValueError("年月参数不合法")
    output_logs = logs if logs is not None else []
    download_folder = Path(require_text(config, "download_folder", "阿里月报输出目录"))
    download_folder.mkdir(parents=True, exist_ok=True)
    cleanup_stale_staging(download_folder)
    emit_log(output_logs, f"开始读取 {year}年{month}月四项月报最新附件")
    token = request_tenant_token(config)
    specs = source_specs(config)
    source_records: dict[str, list[dict[str, Any]]] = {}
    with ThreadPoolExecutor(max_workers=3, thread_name_prefix="ali-monthly-records") as executor:
        futures = {spec.key: executor.submit(fetch_source_records, spec, token) for spec in specs}
        for source_key, future in futures.items():
            source_records[source_key] = future.result()
    selected = select_bundle_attachments(source_records, year, month)
    emit_log(output_logs, "已定位四类最新附件，仅下载选中的 4 个文件")

    staging_root = download_folder / ".ali-monthly-bundle" / (
        f"{year}-{month:02d}-{uuid.uuid4().hex[:8]}"
    )
    final_root = download_folder / ".ali-monthly-bundle-files" / staging_root.name
    downloaded: list[tuple[str, Path]] = []
    try:
        with ThreadPoolExecutor(max_workers=4, thread_name_prefix="ali-monthly-download") as executor:
            futures = [
                executor.submit(
                    download_attachment,
                    item,
                    token,
                    staging_root / item.category,
                )
                for item in selected
            ]
            staging_files = [future.result() for future in futures]
        for item, staging_file in zip(selected, staging_files):
            category_dir = final_root / item.category
            category_dir.mkdir(parents=True, exist_ok=False)
            final_path = category_dir / staging_file.name
            os.replace(staging_file, final_path)
            downloaded.append((item.category, final_path))
        zip_path = build_bundle_zip(downloaded, download_folder, year, month)
    except Exception:
        shutil.rmtree(final_root, ignore_errors=True)
        raise
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)
        try:
            staging_root.parent.rmdir()
        except OSError:
            pass

    source_files = [
        {**generated_file_payload(file_path), "category": category}
        for category, file_path in downloaded
    ]
    zip_file = generated_file_payload(zip_path)
    emit_log(output_logs, f"四项月报已并行下载并打包: {zip_path.name}", "success")
    return {
        "action": "four_item_bundle",
        "files": [zip_file],
        "zip_file": zip_file,
        "source_files": source_files,
        "message": f"{year}年{month}月四项月报已打包导出: {zip_path.name}",
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="阿里月报四项资料轻量打包")
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--month", type=int, required=True)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    logs: list[str] = []
    try:
        result = create_monthly_bundle(
            args.year,
            args.month,
            load_runtime_config(),
            logs,
        )
        payload: dict[str, Any] = {"success": True, "result": result, "logs": logs[-200:]}
    except Exception as exc:
        emit_log(logs, str(exc), "error")
        payload = {"success": False, "error": str(exc), "logs": logs[-200:]}
    print(json.dumps(payload, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
