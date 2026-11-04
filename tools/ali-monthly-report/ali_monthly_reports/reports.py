from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, urlparse

from .config import ReportConfig
from .feishu import (
    build_bitable_record_url,
    build_feishu_session,
    download_attachment,
    download_record_attachments,
    fetch_bitable_records,
    request_tenant_token,
    sync_alarm_report_attachment,
    sync_staff_report_attachment,
)
from .staff import write_staff_roster_workbook
from .utils import (
    cell_text,
    filter_records_by_year_month,
    generated_file_payload,
    make_unique_path,
    remove_url_query_param,
    require_config_values,
    sanitize_download_filename,
)


LogFunc = Callable[[str, str], None]


def default_log(message: str, level: str = "info") -> None:
    pass


def generate_alarm_analysis_report(
    year: str,
    month_number: int,
    config: ReportConfig,
    *,
    token_provider: Callable[[ReportConfig], str] = request_tenant_token,
    session_builder: Callable[[str], Any] = build_feishu_session,
    generate_alarm_report_func: Callable[..., dict[str, Any]] | None = None,
    alarm_attachment_syncer: Callable[..., dict[str, Any]] = sync_alarm_report_attachment,
    log: LogFunc | None = None,
) -> dict[str, Any]:
    require_config_values(
        config,
        [
            "feishu_app_id",
            "feishu_app_secret",
            "feishu_app_token",
            "ali_alarm_source_url",
            "ali_alarm_template_path",
            "alarm_report_table_id",
        ],
    )
    logger = log or default_log
    download_folder = Path(config.download_folder).expanduser()
    download_folder.mkdir(parents=True, exist_ok=True)
    template_path = Path(config.ali_alarm_template_path).expanduser()
    if not template_path.exists():
        raise FileNotFoundError(f"告警分析模板不存在: {template_path}")

    output_path = make_unique_path(download_folder, f"EA118机房{year}年{month_number}月告警分析表.xlsx")
    logger(f"开始生成月度告警分析: {year}年{month_number}月", "info")
    token = token_provider(config)
    session = session_builder(token)
    if generate_alarm_report_func is None:
        from .alarm_report_generator import generate_alarm_report as generate_alarm_report_func

    result = generate_alarm_report_func(
        template=template_path,
        month=f"{year}-{month_number:02d}",
        out=output_path,
        feishu_url=config.ali_alarm_source_url,
        session=session,
    )
    logger(f"告警分析生成完成: {output_path.name}", "success")
    sync_result = alarm_attachment_syncer(
        config=config,
        session=session,
        file_path=output_path,
        year=year,
        month_number=month_number,
        log=logger,
    )
    return {
        "files": [generated_file_payload(output_path)],
        **result,
        **sync_result,
    }


def generate_over_power_report(
    year: str,
    month_number: int,
    config: ReportConfig,
    *,
    token_provider: Callable[[ReportConfig], str] = request_tenant_token,
    table_records_fetcher: Callable[[ReportConfig, dict[str, str], str, LogFunc | None], list[dict[str, Any]]] = fetch_bitable_records,
    attachment_downloader: Callable[[str, Path, str], None] | None = None,
    log: LogFunc | None = None,
) -> dict[str, Any]:
    require_config_values(config, ["feishu_app_id", "feishu_app_secret", "feishu_app_token"])
    logger = log or default_log
    token = token_provider(config)
    records = table_records_fetcher(config, config.high_power_table_config, token, logger)

    # Reuse requires an explicit, exact source period; an absent year is not this year.
    def period_number(value: Any, suffix: str, digits: str) -> int | None:
        match = re.fullmatch(rf"({digits}){suffix}?", cell_text(value))
        return int(match.group(1)) if match else None

    target_year = int(year)
    filtered_records = []
    for record in records:
        fields = record.get("fields", {})
        if (period_number(fields.get("年度"), "年", r"\d{4}") == target_year
                and period_number(fields.get("月份"), "月", r"\d{1,2}") == month_number):
            filtered_records.append(record)
    if not filtered_records:
        raise ValueError(f"没有找到 {year}年{month_number}月 的超功率记录")

    def attachment_matches(file_name: str) -> bool:
        return (
            Path(file_name).suffix.lower() == ".xlsx"
            and ("超功耗" in file_name or "超功率" in file_name)
            and "TOP5" not in file_name.upper()
        )

    download_folder = Path(config.download_folder).expanduser()
    download_folder.mkdir(parents=True, exist_ok=True)
    downloaded: list[dict[str, str]] = []
    failed_downloads = 0
    paths: list[Path] = []
    reused_records: list[dict[str, str]] = []
    seen_attachments: set[str] = set()
    seen_records: set[str] = set()

    def download_existing(file_name: str, url: str) -> tuple[Path, int]:
        initial_path = make_unique_path(download_folder, file_name)
        save_path = initial_path
        collision = 2
        # Reserve only a new file. Distinct attachments can share a filename and timestamp.
        while True:
            try:
                with save_path.open("xb"):
                    pass
                break
            except FileExistsError:
                save_path = initial_path.with_name(f"{initial_path.stem}_{collision}{initial_path.suffix}")
                collision += 1
        try:
            logger(f"下载: {save_path.name}", "info")
            (attachment_downloader or download_attachment)(url, save_path, token)
            size = save_path.stat().st_size
            if size == 0:
                raise ValueError("附件为空或未下载完成")
            return save_path, size
        except Exception:
            save_path.unlink(missing_ok=True)
            raise

    for record in filtered_records:
        selected: list[tuple[str, str]] = []
        for value in record.get("fields", {}).values():
            if not isinstance(value, list):
                continue
            for attachment in value:
                if not isinstance(attachment, dict):
                    continue
                file_name = sanitize_download_filename(str(attachment.get("name") or ""), "attachment.xlsx")
                if not attachment_matches(file_name):
                    continue
                identity = str(attachment.get("file_token") or attachment.get("fileToken") or "").strip()
                if not identity:
                    raise ValueError("月度超功耗附件缺少 file_token，未执行生成或上传")
                url = str(attachment.get("url") or "").strip() or (
                    "https://open.feishu.cn/open-apis/drive/v1/medias/" + quote(identity, safe="") + "/download"
                )
                parsed = urlparse(url)
                host = (parsed.hostname or "").lower().rstrip(".")
                if (parsed.scheme != "https" or parsed.username is not None or parsed.password is not None or not any(
                    host == domain or host.endswith("." + domain) for domain in ("feishu.cn", "larksuite.com")
                )):
                    raise ValueError("月度超功耗附件下载地址不受信任，未执行生成或上传")
                if identity in seen_attachments:
                    continue
                seen_attachments.add(identity)
                selected.append((file_name, url))
        if not selected:
            continue
        record_id = str(record.get("record_id") or record.get("id") or "").strip()
        if not record_id:
            raise ValueError("月度超功耗附件缺少原多维表记录 ID，未执行生成或上传")
        record_downloaded = False
        for file_name, url in selected:
            try:
                save_path, size = download_existing(file_name, url)
            except Exception:
                failed_downloads += 1
                continue
            downloaded.append({"name": save_path.name, "size": f"{size / 1024:.1f}KB"})
            paths.append(save_path)
            record_downloaded = True
        if record_downloaded and record_id not in seen_records:
            seen_records.add(record_id)
            reused_records.append({"record_id": record_id, "record_url": build_bitable_record_url(
                config.feishu_app_token, config.high_power_table_config, record_id,
            )})
    if failed_downloads:
        raise ValueError(f"月度超功耗附件读取失败（{failed_downloads} 个），请重试；未执行生成或上传")
    if not paths:
        raise ValueError(f"未找到 {year}年{month_number}月 已有的超功耗 XLSX 附件，未执行生成或上传")
    return {
        "action": "downloaded_existing_attachment",
        "files": [generated_file_payload(path) for path in paths],
        "downloaded": downloaded,
        "errors": [],
        "reused_records": reused_records,
        "message": "月度超功率已获取完成",
    }


def generate_high_power_top5_report(
    year: str,
    month_number: int,
    config: ReportConfig,
    *,
    token_provider: Callable[[ReportConfig], str] = request_tenant_token,
    table_records_fetcher: Callable[[ReportConfig, dict[str, str], str, LogFunc | None], list[dict[str, Any]]] = fetch_bitable_records,
    attachment_downloader: Callable[[str, Path, str], None] | None = None,
    log: LogFunc | None = None,
) -> dict[str, Any]:
    require_config_values(config, ["feishu_app_id", "feishu_app_secret", "feishu_app_token"])
    logger = log or default_log
    token = token_provider(config)
    records = table_records_fetcher(config, config.high_power_table_config, token, logger)
    filtered_records = filter_records_by_year_month(records, year, month_number)
    if not filtered_records:
        raise ValueError(f"没有找到 {year}年{month_number}月 的高功率 TOP5 记录")

    def attachment_matches(file_name: str) -> bool:
        return "TOP5" in file_name.upper()

    download_folder = Path(config.download_folder).expanduser()
    download_folder.mkdir(parents=True, exist_ok=True)
    kwargs: dict[str, Any] = {}
    if attachment_downloader is not None:
        kwargs["attachment_downloader"] = attachment_downloader
    downloaded, errors, paths = download_record_attachments(
        filtered_records,
        token,
        download_folder,
        attachment_filter=attachment_matches,
        log=logger,
        **kwargs,
    )
    if not paths:
        raise ValueError("未匹配到月度高功率 TOP5 附件")
    return {
        "action": "downloaded_existing_attachment",
        "files": [generated_file_payload(path) for path in paths],
        "downloaded": downloaded,
        "errors": errors,
        "message": "月度高功率 TOP5 已获取完成",
    }


def generate_staff_roster_report(
    year: str,
    month_number: int,
    config: ReportConfig,
    *,
    token_provider: Callable[[ReportConfig], str] = request_tenant_token,
    session_builder: Callable[[str], Any] = build_feishu_session,
    fetch_records: Callable[[str, Any], list[dict[str, Any]]] | None = None,
    staff_attachment_syncer: Callable[..., dict[str, Any]] = sync_staff_report_attachment,
    log: LogFunc | None = None,
) -> dict[str, Any]:
    require_config_values(
        config,
        [
            "feishu_app_id",
            "feishu_app_secret",
            "feishu_app_token",
            "ali_staff_source_url",
            "staff_report_table_id",
        ],
    )
    logger = log or default_log
    token = token_provider(config)
    session = session_builder(token)
    if fetch_records is None:
        from .alarm_report_generator import fetch_feishu_records as fetch_records

    active_records = fetch_records(config.ali_staff_source_url, session=session)
    all_records = fetch_records(remove_url_query_param(config.ali_staff_source_url, "view"), session=session)
    download_folder = Path(config.download_folder).expanduser()
    download_folder.mkdir(parents=True, exist_ok=True)
    output_path = make_unique_path(download_folder, f"南通机房{year}年{month_number}月在职人员导出.xlsx")
    counts = write_staff_roster_workbook(active_records, all_records, f"{year}-{month_number:02d}", output_path)
    logger(f"在职人员导出完成: {output_path.name}", "success")
    sync_result = staff_attachment_syncer(
        config=config,
        session=session,
        file_path=output_path,
        year=year,
        month_number=month_number,
        log=logger,
    )
    return {
        "files": [generated_file_payload(output_path)],
        "record_count": len(all_records),
        **counts,
        **sync_result,
    }


def generate_monthly_report(report_type: str, year: str, month_number: int, config: ReportConfig, **kwargs: Any) -> dict[str, Any]:
    if report_type == "alarm_analysis":
        return generate_alarm_analysis_report(year, month_number, config, **kwargs)
    if report_type == "over_power":
        return generate_over_power_report(year, month_number, config, **kwargs)
    if report_type == "high_power_top5":
        return generate_high_power_top5_report(year, month_number, config, **kwargs)
    if report_type == "staff_roster":
        return generate_staff_roster_report(year, month_number, config, **kwargs)
    raise ValueError(f"不支持的月报类型: {report_type}")
