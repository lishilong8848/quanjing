from __future__ import annotations

import json
import zlib
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

import requests

from .config import ReportConfig
from .utils import make_unique_path, sanitize_download_filename


FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"


def request_tenant_token(config: ReportConfig) -> str:
    response = requests.post(
        FEISHU_TOKEN_URL,
        json={"app_id": config.feishu_app_id, "app_secret": config.feishu_app_secret},
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()
    if data.get("code") != 0:
        raise RuntimeError(f"获取飞书 tenant token 失败: {data.get('msg') or data}")
    return str(data["tenant_access_token"])


def build_feishu_session(token: str) -> requests.Session:
    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {token}"})
    return session


def _raise_for_feishu_api_error(result: dict[str, Any], action: str) -> None:
    if result.get("code") != 0:
        raise RuntimeError(f"{action}失败: {result.get('msg') or result}")


def _adler32_checksum(file_path: Path) -> str:
    checksum = 1
    with file_path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            checksum = zlib.adler32(chunk, checksum)
    return str(checksum & 0xFFFFFFFF)


def upload_bitable_file(
    *,
    app_token: str,
    session: Any,
    file_path: Path,
    log: Callable[[str, str], None] | None = None,
    upload_name: str | None = None,
) -> str:
    """上传文件为多维表附件素材，并返回 file_token。"""
    if not file_path.exists():
        raise FileNotFoundError(f"待上传文件不存在: {file_path}")

    file_name = sanitize_download_filename(upload_name or file_path.name, file_path.name)
    if log:
        log(f"上传附件素材: {file_name}", "info")
    with file_path.open("rb") as handle:
        response = session.post(
            "https://open.feishu.cn/open-apis/drive/v1/medias/upload_all",
            data={
                "file_name": file_name,
                "parent_type": "bitable_file",
                "parent_node": app_token,
                "size": str(file_path.stat().st_size),
                "checksum": _adler32_checksum(file_path),
                "extra": json.dumps({"drive_route_token": app_token}, ensure_ascii=False),
            },
            files={
                "file": (
                    file_name,
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
            timeout=120,
        )
    response.raise_for_status()
    result = response.json()
    _raise_for_feishu_api_error(result, "上传附件素材")
    file_token = str(result.get("data", {}).get("file_token", "")).strip()
    if not file_token:
        raise RuntimeError("上传附件素材失败: 响应中没有 file_token")
    if log:
        log("附件素材上传成功", "success")
    return file_token


def find_report_records(
    *,
    app_token: str,
    table_config: dict[str, str],
    session: Any,
    year: str,
    month_number: int,
    report_type_name: str,
    log: Callable[[str, str], None] | None = None,
) -> list[dict[str, Any]]:
    """服务端先按类型和年度过滤，再兼容匹配月份 7/07。"""
    search_url = (
        f"https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}"
        f"/tables/{table_config['table_id']}/records/search"
    )
    payload: dict[str, Any] = {
        "filter": {
            "conjunction": "and",
            "conditions": [
                {
                    "field_name": "月报类型",
                    "operator": "is",
                    "value": [report_type_name],
                },
                {
                    "field_name": "年度",
                    "operator": "is",
                    "value": [str(year)],
                },
            ],
        }
    }
    view_id = str(table_config.get("view_id", "")).strip()
    if view_id:
        payload["view_id"] = view_id

    records: list[dict[str, Any]] = []
    params: dict[str, Any] = {"page_size": 500}
    while True:
        response = session.post(search_url, params=params, json=payload, timeout=60)
        response.raise_for_status()
        result = response.json()
        _raise_for_feishu_api_error(result, "查询目标月报记录")
        data_page = result.get("data", {})
        records.extend(data_page.get("items", []))
        if not data_page.get("has_more"):
            break
        page_token = str(data_page.get("page_token", "")).strip()
        if not page_token:
            raise RuntimeError("查询目标月报记录失败: 分页响应缺少 page_token")
        params["page_token"] = page_token

    expected_months = {str(month_number), f"{month_number:02d}"}
    matching_records = []
    for record in records:
        fields = record.get("fields", {})
        if (
            str(fields.get("月报类型", "")) == report_type_name
            and str(fields.get("年度", "")) == str(year)
            and str(fields.get("月份", "")) in expected_months
        ):
            matching_records.append(record)
    if log:
        if matching_records:
            log(f"目标表已存在 {len(matching_records)} 条同月记录，将覆盖已有记录附件", "warning")
        else:
            log("目标表没有同月记录，将新增月报记录", "info")
    return matching_records


def create_report_record_with_attachment(
    *,
    app_token: str,
    table_config: dict[str, str],
    session: Any,
    file_token: str,
    year: str,
    month_number: int,
    report_type_name: str,
    log: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    if log:
        log(f"新增多维表记录: {report_type_name} {year}年{month_number}月", "info")
    response = session.post(
        (
            f"https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}"
            f"/tables/{table_config['table_id']}/records"
        ),
        json={
            "fields": {
                "月报类型": report_type_name,
                "年度": str(year),
                "月份": str(month_number),
                "上传文件": [{"file_token": file_token}],
            }
        },
        timeout=60,
    )
    response.raise_for_status()
    result = response.json()
    _raise_for_feishu_api_error(result, "新增多维表记录")
    record = result.get("data", {}).get("record", {})
    record_id = str(record.get("record_id", "")).strip()
    if not record_id:
        raise RuntimeError("新增多维表记录失败: 响应中没有 record_id")
    if log:
        log(f"多维表记录新增成功: {record_id}", "success")
    return record


def update_report_record_attachment(
    *,
    app_token: str,
    table_config: dict[str, str],
    session: Any,
    record_id: str,
    file_token: str,
    log: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    normalized_record_id = str(record_id or "").strip()
    if not normalized_record_id:
        raise ValueError("缺少待覆盖的多维表记录 ID")
    if log:
        log(f"覆盖多维表记录附件: {normalized_record_id}", "info")
    response = session.put(
        (
            f"https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}"
            f"/tables/{table_config['table_id']}/records/{normalized_record_id}"
        ),
        json={"fields": {"上传文件": [{"file_token": file_token}]}},
        timeout=60,
    )
    response.raise_for_status()
    result = response.json()
    _raise_for_feishu_api_error(result, "覆盖多维表记录附件")
    record = result.get("data", {}).get("record", {})
    if log:
        log(f"多维表记录附件覆盖成功: {normalized_record_id}", "success")
    return record or {"record_id": normalized_record_id}


def build_bitable_record_url(app_token: str, table_config: dict[str, str], record_id: str) -> str:
    normalized_app_token = str(app_token or "").strip()
    normalized_record_id = str(record_id or "").strip()
    if not normalized_app_token or not normalized_record_id:
        return ""
    query_parts = []
    table_id = str(table_config.get("table_id", "")).strip()
    view_id = str(table_config.get("view_id", "")).strip()
    if table_id:
        query_parts.append(f"table={quote(table_id, safe='')}")
    if view_id:
        query_parts.append(f"view={quote(view_id, safe='')}")
    query_parts.append(f"recordId={quote(normalized_record_id, safe='')}")
    return f"https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE safe='')}?{'&'.join(query_parts)}"


def sync_report_attachment(
    *,
    app_token: str,
    table_config: dict[str, str],
    report_type_name: str,
    session: Any,
    file_path: Path,
    year: str,
    month_number: int,
    log: Callable[[str, str], None] | None = None,
    record_finder: Callable[..., list[dict[str, Any]]] = find_report_records,
    file_uploader: Callable[..., str] = upload_bitable_file,
    record_updater: Callable[..., dict[str, Any]] = update_report_record_attachment,
    record_creator: Callable[..., dict[str, Any]] = create_report_record_with_attachment,
) -> dict[str, Any]:
    """按月报类型、年度和月份覆盖或新增资料管理多维表附件。"""
    existing_records = record_finder(
        app_token=app_token,
        table_config=table_config,
        session=session,
        year=year,
        month_number=month_number,
        report_type_name=report_type_name,
        log=log,
    )
    file_token = file_uploader(
        app_token=app_token,
        session=session,
        file_path=file_path,
        log=log,
    )

    if existing_records:
        updated_records: list[dict[str, Any]] = []
        for existing_record in existing_records:
            target_record_id = str(
                existing_record.get("record_id") or existing_record.get("id") or ""
            ).strip()
            if not target_record_id:
                raise RuntimeError("目标同月记录缺少 record_id，无法覆盖附件")
            updated_record = record_updater(
                app_token=app_token,
                table_config=table_config,
                session=session,
                record_id=target_record_id,
                file_token=file_token,
                log=log,
            )
            updated_record_id = str(updated_record.get("record_id") or target_record_id).strip()
            updated_records.append(
                {
                    "table": table_config["name"],
                    "record_id": updated_record_id,
                    "file_token": file_token,
                    "record_url": build_bitable_record_url(app_token, table_config, updated_record_id),
                    "file_count": 1,
                }
            )
        selected_record = updated_records[0]
        return {
            "action": "generated_and_updated",
            "updated": {
                **selected_record,
                "replaced_existing_count": len(updated_records),
            },
            "updated_records": updated_records,
            "message": f"{report_type_name}已生成并覆盖多维表已有记录: {file_path.name}",
        }

    record = record_creator(
        app_token=app_token,
        table_config=table_config,
        session=session,
        file_token=file_token,
        year=year,
        month_number=month_number,
        report_type_name=report_type_name,
        log=log,
    )
    record_id = str(record.get("record_id", "")).strip()
    if not record_id:
        raise RuntimeError("新增多维表记录失败: 响应中没有 record_id")
    return {
        "action": "generated_and_uploaded",
        "uploaded": {
            "table": table_config["name"],
            "record_id": record_id,
            "file_token": file_token,
            "record_url": build_bitable_record_url(app_token, table_config, record_id),
        },
        "message": f"{report_type_name}已生成并上传: {file_path.name}",
    }


def sync_alarm_report_attachment(
    *,
    config: ReportConfig,
    session: Any,
    file_path: Path,
    year: str,
    month_number: int,
    log: Callable[[str, str], None] | None = None,
    record_finder: Callable[..., list[dict[str, Any]]] = find_report_records,
    file_uploader: Callable[..., str] = upload_bitable_file,
    record_updater: Callable[..., dict[str, Any]] = update_report_record_attachment,
    record_creator: Callable[..., dict[str, Any]] = create_report_record_with_attachment,
) -> dict[str, Any]:
    """把告警分析报告同步到资料管理多维表。"""
    return sync_report_attachment(
        app_token=config.feishu_app_token,
        table_config=config.alarm_report_table_config,
        report_type_name="南通机房告警分析",
        session=session,
        file_path=file_path,
        year=year,
        month_number=month_number,
        log=log,
        record_finder=record_finder,
        file_uploader=file_uploader,
        record_updater=record_updater,
        record_creator=record_creator,
    )


def sync_staff_report_attachment(
    *,
    config: ReportConfig,
    session: Any,
    file_path: Path,
    year: str,
    month_number: int,
    log: Callable[[str, str], None] | None = None,
    record_finder: Callable[..., list[dict[str, Any]]] = find_report_records,
    file_uploader: Callable[..., str] = upload_bitable_file,
    record_updater: Callable[..., dict[str, Any]] = update_report_record_attachment,
    record_creator: Callable[..., dict[str, Any]] = create_report_record_with_attachment,
) -> dict[str, Any]:
    """把人员变动报告同步到资料管理多维表。"""
    return sync_report_attachment(
        app_token=config.feishu_app_token,
        table_config=config.staff_report_table_config,
        report_type_name="南通机房人员变动",
        session=session,
        file_path=file_path,
        year=year,
        month_number=month_number,
        log=log,
        record_finder=record_finder,
        file_uploader=file_uploader,
        record_updater=record_updater,
        record_creator=record_creator,
    )


def fetch_bitable_records(
    config: ReportConfig,
    table_config: dict[str, str],
    token: str,
    log: Callable[[str, str], None] | None = None,
) -> list[dict[str, Any]]:
    records_url = (
        f"https://open.feishu.cn/open-apis/bitable/v1/apps/{config.feishu_app_token}"
        f"/tables/{table_config['table_id']}/records"
    )
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    params: dict[str, Any] = {"view_id": table_config["view_id"], "page_size": 500}
    records: list[dict[str, Any]] = []
    page_token = None

    if log:
        log(f"读取表格记录: {table_config['name']}", "info")
    while True:
        if page_token:
            params["page_token"] = page_token
        response = requests.get(records_url, headers=headers, params=params, timeout=120)
        response.raise_for_status()
        result = response.json()
        if result.get("code") != 0:
            raise RuntimeError(f"获取记录失败: {result.get('msg') or result}")
        data_page = result.get("data", {})
        records.extend(data_page.get("items", []))
        if not data_page.get("has_more"):
            break
        page_token = data_page.get("page_token")

    if log:
        log(f"共获取 {len(records)} 条记录", "success")
    return records


def download_attachment(url: str, save_path: Path, token: str) -> None:
    response = requests.get(url, headers={"Authorization": f"Bearer {token}"}, stream=True, timeout=30)
    if response.status_code != 200:
        raise RuntimeError(f"附件下载失败: HTTP {response.status_code}")
    with save_path.open("wb") as handle:
        for chunk in response.iter_content(chunk_size=8192):
            if chunk:
                handle.write(chunk)


def download_record_attachments(
    records: list[dict[str, Any]],
    token: str,
    download_folder: Path,
    attachment_filter: Callable[[str], bool] | None = None,
    attachment_downloader: Callable[[str, Path, str], None] = download_attachment,
    log: Callable[[str, str], None] | None = None,
) -> tuple[list[dict[str, str]], list[str], list[Path]]:
    downloaded: list[dict[str, str]] = []
    errors: list[str] = []
    paths: list[Path] = []

    for record_index, record in enumerate(records, start=1):
        fields = record.get("fields", {})
        for field_value in fields.values():
            if not isinstance(field_value, list) or not field_value:
                continue
            if not isinstance(field_value[0], dict) or "url" not in field_value[0]:
                continue
            for attachment in field_value:
                file_name = sanitize_download_filename(attachment.get("name", ""), f"attachment_{record_index}")
                if attachment_filter and not attachment_filter(file_name):
                    continue
                url = str(attachment.get("url", "")).strip()
                if not url:
                    errors.append(f"{file_name}: 无下载 URL")
                    continue
                save_path = make_unique_path(download_folder, file_name)
                try:
                    if log:
                        log(f"下载: {save_path.name}", "info")
                    attachment_downloader(url, save_path, token)
                    downloaded.append({"name": save_path.name, "size": f"{save_path.stat().st_size / 1024:.1f}KB"})
                    paths.append(save_path)
                except Exception as exc:
                    errors.append(f"{save_path.name}: {exc}")
    return downloaded, errors, paths
