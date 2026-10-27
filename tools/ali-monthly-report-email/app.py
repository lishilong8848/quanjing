#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
阿里月度报告邮件自动化同步工具 - Web版本
Flask 后端服务
"""

from __future__ import annotations

import json
import os
import re
import shutil
import smtplib
import subprocess
import sys
import time
import traceback
import uuid
import zipfile
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from email import encoders
from email.mime.base import MIMEBase
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from itertools import zip_longest
from io import BytesIO
from pathlib import Path
from threading import Lock
from typing import Any, Callable, Mapping
from urllib.parse import parse_qsl, quote, urlencode, urlparse, urlunparse

import pandas as pd
import requests
from flask import Flask, jsonify, render_template, request

import ali_alarm_report_generator
import ali_over_power_report_generator


BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
RUNTIME_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
CONFIG_FILE = RUNTIME_DIR / "config.json"
TEMP_DIR = RUNTIME_DIR / "temp"
DOWNLOAD_DIR = RUNTIME_DIR / "downloads"
RESOURCE_DIR = BUNDLE_DIR / "resources"


def read_env_int(name: str, default: int) -> int:
    """Read an integer environment variable with a safe fallback."""
    raw_value = os.getenv(name, "").strip()
    if not raw_value:
        return default
    try:
        return int(raw_value)
    except ValueError:
        return default


def discover_power_alert_config_path() -> str:
    """Locate the local power-alert table config without exposing its contents."""
    env_value = os.getenv("POWER_ALERT_CONFIG", "").strip()
    if env_value:
        return env_value
    candidates = [
        RUNTIME_DIR / "config" / "power-alert-sync.config.json",
        RUNTIME_DIR.parent / "config" / "power-alert-sync.config.json",
    ]
    candidates.extend(RUNTIME_DIR.parent.glob("*/config/power-alert-sync.config.json"))
    for candidate in candidates:
        try:
            if candidate.exists():
                return str(candidate)
        except OSError:
            continue
    return ""


def resolve_runtime_path(path_text: str) -> Path:
    """Resolve a user/config path relative to the runtime directory."""
    path = Path(str(path_text or "").strip()).expanduser()
    if not path.is_absolute():
        runtime_candidate = (RUNTIME_DIR / path).resolve()
        bundle_candidate = (BUNDLE_DIR / path).resolve()
        path = runtime_candidate if runtime_candidate.exists() else bundle_candidate
    if not path.exists():
        raise ValueError(f"文件不存在: {path}")
    return path


APP_HOST = os.getenv("APP_HOST", "127.0.0.1").strip() or "127.0.0.1"
APP_PORT = read_env_int("APP_PORT", 5011)
ALLOWED_UPLOAD_EXTENSIONS = {".xlsx", ".xls"}
MASKED_VALUE = "***"
DEFAULT_TARGET_CHAT_IDS = ["oc_9961bb057de8bd715447559c5e63c4f2"]
DEFAULT_RECIPIENT = "ma.jinyu@vnet.com; liu.xiaoxing2-wb@sne.vnet.com"
VISIBLE_ONLY_EMAIL_RECIPIENT = "mei.bingbing@vnet.com"
ALI_RECORD_NOTIFY_USER_NAME = "马进宇"
ALI_RECORD_NOTIFY_USER_EMAIL = "ma.jinyu@vnet.com"
MONTHLY_REPORT_TRIGGER_KEYWORD = "月报生成"
AUTO_DOWNLOAD_TABLE_NAME = "高功率TOP5报表"
ALARM_REPORT_TABLE_NAME = "告警分析报告"
STAFF_REPORT_TABLE_NAME = "人员变动报告"
DEFAULT_ALI_ALARM_SOURCE_URL = (
    "https://vnet.feishu.cn/wiki/SOwsw315aiBJjgkl48ccoxIPntc?table=tblD7hi70s6U6rlU&view=vewG7OKFEg"
)
DEFAULT_ALI_STAFF_SOURCE_URL = (
    "https://vnet.feishu.cn/wiki/AdQmwOqwei6Xr4kag3pcp1Flnmg?table=tblOu75UtJTDNHIM&view=vewrQcypV4"
)
DEFAULT_ALI_ALARM_TEMPLATE_PATH = str(RESOURCE_DIR / "EA118机房2026年3月告警分析表.xlsx")
DEFAULT_ALI_POWER_TEMPLATE_PATH = str(DOWNLOAD_DIR / "EA118机柜超功耗告警统计表3月份 .xlsx")
VNET_LOGO_PATH = RESOURCE_DIR / "vnet_logo.png"
VNET_LOGO_CID = "vnet_logo"
USE_NATIVE_EXCEL_SCREENSHOT = os.getenv("USE_NATIVE_EXCEL_SCREENSHOT", "1").strip().lower() not in {"0", "false", "no"}
FEISHU_MESSAGE_FILE_MAX_BYTES = 30 * 1024 * 1024

TEMP_DIR.mkdir(parents=True, exist_ok=True)
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(
    __name__,
    template_folder=str(BUNDLE_DIR / "templates"),
    static_folder=str(BUNDLE_DIR / "static"),
)

BITABLE_CONFIGS = [
    {
        "name": "高功率TOP5报表",
        "table_id": os.getenv("HIGH_POWER_TABLE_ID", "tblkh6YCMYtS8nHa").strip() or "tblkh6YCMYtS8nHa",
        "view_id": os.getenv("HIGH_POWER_VIEW_ID", "vewrHJHl3v").strip() or "vewrHJHl3v",
    },
    {
        "name": ALARM_REPORT_TABLE_NAME,
        "table_id": os.getenv("ALARM_REPORT_TABLE_ID", "tblAGQeQ7tpV8tWt").strip() or "tblAGQeQ7tpV8tWt",
        "view_id": os.getenv("ALARM_REPORT_VIEW_ID", "vewrHJHl3v").strip() or "vewrHJHl3v",
    },
    {
        "name": STAFF_REPORT_TABLE_NAME,
        "table_id": os.getenv("STAFF_REPORT_TABLE_ID", "tbl3KED5CdvNSCwT").strip() or "tbl3KED5CdvNSCwT",
        "view_id": os.getenv("STAFF_REPORT_VIEW_ID", "vewrHJHl3v").strip() or "vewrHJHl3v",
    },
]

ALI_REPORT_TYPES = [
    {
        "key": "alarm_analysis",
        "name": "月度告警分析",
        "description": "从告警源多维表生成 Excel，并上传到告警分析报告表。",
    },
    {
        "key": "over_power",
        "name": "月度超功耗",
        "description": "从超功率多维表生成 Excel，并上传到高功率月报表。",
    },
    {
        "key": "high_power_top5",
        "name": "月度高功率TOP5",
        "description": "从高功率月报表自动获取对应月份的 TOP5 附件。",
    },
    {
        "key": "staff_roster",
        "name": "在职人员导出",
        "description": "从人员管理多维表导出在职人员基础信息和本月人员变动。",
    },
    {
        "key": "batch_without_top5",
        "name": "一键生成三项月报（不含TOP5）",
        "description": "依次生成月度告警分析、月度超功耗和在职人员导出，不处理 TOP5。",
    },
]
ALI_REPORT_TYPE_MAP = {item["key"]: item for item in ALI_REPORT_TYPES}
ALI_REPORT_BATCH_WITHOUT_TOP5_TYPES = ("alarm_analysis", "over_power", "staff_roster")

SHEET_CONFIGS = [
    {
        "sheet_name": "机列超215功率统计",
        "key_col": "序号",
        "label": "机列超215KW",
        "image_id": "img_jilie",
        "image_title": "EA118机列超功率告警统计表",
    },
    {
        "sheet_name": "列头柜超107.5功率统计",
        "key_col": "序号",
        "label": "列头柜超107.5KW",
        "image_id": "img_liegui",
        "image_title": "EA118列头柜超功率告警统计表",
    },
    {
        "sheet_name": "机柜超18KW统计",
        "key_col": "机柜号",
        "label": "机柜超18KW",
        "image_id": "img_jigui",
        "image_title": "EA118机柜超功率告警统计表",
        "rename_columns": {"Unnamed: 1": "数据时间"},
    },
    {
        "sheet_name": "单支路超6.25KW功率",
        "key_col": "序号",
        "label": "单支路超6.25KW",
        "image_id": "img_zhilu",
        "image_title": "EA118单支路超功率告警统计表",
    },
]

DEFAULT_CONFIG = {
    "qq_email": os.getenv("QQ_EMAIL_ACCOUNT", "").strip(),
    "auth_code": os.getenv("QQ_EMAIL_AUTH_CODE", "").strip(),
    "recipient": os.getenv("DEFAULT_RECIPIENT", DEFAULT_RECIPIENT).strip(),
    "download_folder": os.getenv("DOWNLOAD_FOLDER", str(DOWNLOAD_DIR)).strip(),
    "feishu_app_id": os.getenv("FEISHU_APP_ID", "").strip(),
    "feishu_app_secret": os.getenv("FEISHU_APP_SECRET", "").strip(),
    "feishu_app_token": os.getenv("FEISHU_APP_TOKEN", "").strip(),
    "feishu_verification_token": os.getenv("FEISHU_VERIFICATION_TOKEN", "").strip(),
    "feishu_encrypt_key": os.getenv("FEISHU_ENCRYPT_KEY", "").strip(),
    "ali_alarm_source_url": os.getenv("ALI_ALARM_SOURCE_URL", DEFAULT_ALI_ALARM_SOURCE_URL).strip(),
    "ali_staff_source_url": os.getenv("ALI_STAFF_SOURCE_URL", DEFAULT_ALI_STAFF_SOURCE_URL).strip(),
    "ali_alarm_template_path": os.getenv("ALI_ALARM_TEMPLATE_PATH", DEFAULT_ALI_ALARM_TEMPLATE_PATH).strip(),
    "ali_power_alert_config_path": os.getenv("ALI_POWER_ALERT_CONFIG_PATH", discover_power_alert_config_path()).strip(),
    "listener_target_chat_ids": [
        item
        for item in (
            value.strip() for value in os.getenv("LISTENER_TARGET_CHAT_IDS", ",".join(DEFAULT_TARGET_CHAT_IDS)).split(",")
        )
        if item
    ],
}

log_cache: list[dict[str, str]] = []
auto_report_lock = Lock()
auto_report_running_keys: set[str] = set()
excel_image_export_lock = Lock()
cache_cleanup_lock = Lock()
CONFIG_LABELS = {
    "qq_email": "QQ邮箱",
    "auth_code": "QQ邮箱授权码",
    "recipient": "默认收件人",
    "download_folder": "下载目录",
    "feishu_app_id": "飞书 App ID",
    "feishu_app_secret": "飞书 App Secret",
    "feishu_app_token": "飞书 App Token",
    "feishu_verification_token": "飞书 Verification Token",
    "feishu_encrypt_key": "飞书 Encrypt Key",
    "ali_alarm_source_url": "阿里告警源多维表 URL",
    "ali_staff_source_url": "阿里在职人员多维表 URL",
    "ali_alarm_template_path": "阿里告警分析模板路径",
    "ali_power_alert_config_path": "阿里超功率多维表配置路径",
}


def load_config() -> dict[str, Any]:
    """加载本地配置，并使用环境变量默认值兜底。"""
    config = DEFAULT_CONFIG.copy()
    config["listener_target_chat_ids"] = list(DEFAULT_CONFIG["listener_target_chat_ids"])

    if CONFIG_FILE.exists():
        try:
            saved = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            if isinstance(saved, dict):
                config.update(saved)
        except (OSError, json.JSONDecodeError):
            pass

    config["download_folder"] = str(Path(config.get("download_folder") or DOWNLOAD_DIR).expanduser())
    config["recipient"] = merge_default_recipients(str(config.get("recipient", "")))
    config["listener_target_chat_ids"] = normalize_chat_ids(config.get("listener_target_chat_ids"))
    return config


def save_config(config: dict[str, Any]) -> None:
    """保存配置到本地文件。"""
    payload = {
        "qq_email": str(config.get("qq_email", "")).strip(),
        "auth_code": str(config.get("auth_code", "")).strip(),
        "recipient": str(config.get("recipient", "")).strip(),
        "download_folder": str(config.get("download_folder", "")).strip(),
        "feishu_app_id": str(config.get("feishu_app_id", "")).strip(),
        "feishu_app_secret": str(config.get("feishu_app_secret", "")).strip(),
        "feishu_app_token": str(config.get("feishu_app_token", "")).strip(),
        "feishu_verification_token": str(config.get("feishu_verification_token", "")).strip(),
        "feishu_encrypt_key": str(config.get("feishu_encrypt_key", "")).strip(),
        "ali_alarm_source_url": str(config.get("ali_alarm_source_url", "")).strip(),
        "ali_staff_source_url": str(config.get("ali_staff_source_url", "")).strip(),
        "ali_alarm_template_path": str(config.get("ali_alarm_template_path", "")).strip(),
        "ali_power_alert_config_path": str(config.get("ali_power_alert_config_path", "")).strip(),
        "listener_target_chat_ids": normalize_chat_ids(config.get("listener_target_chat_ids")),
    }
    CONFIG_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def normalize_chat_ids(value: Any) -> list[str]:
    """标准化飞书会话 ID 列表。"""
    if isinstance(value, str):
        raw_items = value.split(",")
    elif isinstance(value, list):
        raw_items = value
    else:
        raw_items = []

    chat_ids: list[str] = []
    for item in raw_items:
        text = str(item).strip()
        if text and text not in chat_ids:
            chat_ids.append(text)

    return chat_ids or list(DEFAULT_TARGET_CHAT_IDS)


def add_log(message: str, level: str = "info") -> None:
    """添加一条日志到内存缓存。"""
    timestamp = datetime.now().strftime("%H:%M:%S")
    log_cache.append({"time": timestamp, "message": message, "level": level})
    if len(log_cache) > 200:
        log_cache.pop(0)


def emit_log(message: str, level: str = "info", external_log: Callable[[str, str], None] | None = None) -> None:
    """同时写入页面日志和外部日志。"""
    add_log(message, level)
    if external_log is not None:
        external_log(message, level)


def mask_secret(value: str) -> str:
    """掩码敏感字段。"""
    return MASKED_VALUE if str(value or "").strip() else ""


def require_config_values(config: dict[str, Any], keys: list[str]) -> None:
    """校验关键配置是否已填写。"""
    missing = [key for key in keys if not str(config.get(key, "")).strip()]
    if missing:
        labels = [CONFIG_LABELS.get(key, key) for key in missing]
        raise ValueError(f"请先在“配置”中填写：{', '.join(labels)}")


def get_missing_config_labels(config: dict[str, Any], keys: list[str]) -> list[str]:
    """返回缺失配置的中文标签。"""
    return [CONFIG_LABELS.get(key, key) for key in keys if not str(config.get(key, "")).strip()]


def parse_recipients(value: str) -> list[str]:
    """解析并校验多个收件人邮箱。"""
    normalized = re.sub(r"[；，]", ",", value or "")
    normalized = normalized.replace(";", ",").replace("\r", "\n")
    candidates = [item.strip().strip("<>").strip() for item in re.split(r"[\n,]+", normalized) if item.strip()]

    recipients: list[str] = []
    seen: set[str] = set()
    invalid: list[str] = []
    for email in candidates:
        normalized_email = email.lower()
        if normalized_email == VISIBLE_ONLY_EMAIL_RECIPIENT:
            continue
        if not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", email):
            invalid.append(email)
            continue
        if normalized_email not in seen:
            recipients.append(email)
            seen.add(normalized_email)

    if invalid:
        raise ValueError(f"以下邮箱格式无效: {', '.join(invalid)}")
    if not recipients:
        raise ValueError("请填写至少一个有效的收件人邮箱")
    return recipients


def merge_default_recipients(value: str) -> str:
    """合并默认投递人，并排除仅用于正文展示的邮箱。"""
    return "; ".join(parse_recipients(f"{value or ''};{DEFAULT_RECIPIENT}"))


def parse_year_month(data: dict[str, Any]) -> tuple[str, int, str]:
    """解析请求中的年份和月份。"""
    year = str(data.get("year", "")).strip()
    month = str(data.get("month", "")).strip()
    subject = str(data.get("subject", "")).strip()

    if (not year or not month) and subject:
        match = re.search(r"(20\d{2})年(\d{1,2})月", subject)
        if match:
            year = year or match.group(1)
            month = month or match.group(2)

    if not re.fullmatch(r"20\d{2}", year):
        raise ValueError("请选择正确的年份")

    month_match = re.search(r"(\d{1,2})", month)
    if not month_match:
        raise ValueError("请选择正确的月份")

    month_number = int(month_match.group(1))
    if month_number < 1 or month_number > 12:
        raise ValueError("月份必须在 1-12 之间")

    return year, month_number, f"{month_number}月"


def build_email_subject(year: str, month_number: int) -> str:
    """构造默认邮件主题。"""
    return f"机柜容量及列头柜容量超电风险【{year}年{month_number}月】"


def build_alarm_analysis_email_subject(year: str, month_number: int) -> str:
    """构造告警分析邮件主题。"""
    return f"EA118机房告警分析报告【{year}年{month_number}月】"


def get_previous_year_month(reference_time: datetime | None = None) -> tuple[str, int, str]:
    """基于触发时间计算上个月。"""
    current = reference_time or datetime.now().astimezone()
    year = current.year
    month = current.month - 1
    if month == 0:
        month = 12
        year -= 1
    return str(year), month, f"{month}月"


def build_month_filter(year: str, month_number: int) -> str:
    """构造 Excel 里的月份过滤片段。"""
    return f"{year}/{month_number}"


def is_path_within(path: Path, directory: Path) -> bool:
    """判断路径是否位于指定目录内。"""
    try:
        path.resolve().relative_to(directory.resolve())
        return True
    except ValueError:
        return False


def is_path_within_safe(path: Path, directory: Path) -> bool:
    """判断路径是否位于指定目录内。"""
    try:
        path.resolve().relative_to(directory.resolve())
        return True
    except ValueError:
        return False


def ensure_temp_file(file_path: str) -> Path:
    """只允许操作 temp 目录中的文件。"""
    path = Path(file_path).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"文件不存在：{file_path}")
    if not is_path_within_safe(path, TEMP_DIR):
        raise ValueError("文件路径无效，请重新上传文件")
    return path


def sanitize_uploaded_filename(filename: str) -> str:
    """清理上传文件名并生成服务器端安全文件名。"""
    raw_name = Path(filename).name.strip()
    if not raw_name:
        raise ValueError("文件名不能为空")

    safe_name = "".join("_" if ord(char) < 32 or char in '<>:"/\\|?*' else char for char in raw_name).strip(" .")
    if not safe_name:
        raise ValueError("文件名无效")

    suffix = Path(safe_name).suffix.lower()
    if suffix not in ALLOWED_UPLOAD_EXTENSIONS:
        raise ValueError("仅支持上传 Excel 文件（.xlsx/.xls）")

    stem = Path(safe_name).stem or "report"
    token = uuid.uuid4().hex[:8]
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{stem}_{timestamp}_{token}{suffix}"


def sanitize_download_filename(filename: str, fallback_name: str) -> str:
    """清理下载附件文件名。"""
    raw_name = Path(filename).name.strip() or fallback_name
    safe_name = "".join("_" if ord(char) < 32 or char in '<>:"/\\|?*' else char for char in raw_name).strip(" .")
    return safe_name or fallback_name


def make_unique_path(directory: Path, filename: str) -> Path:
    """为文件生成不会冲突的落盘路径。"""
    candidate = directory / filename
    if not candidate.exists():
        return candidate

    stem = candidate.stem
    suffix = candidate.suffix
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return directory / f"{stem}_{timestamp}{suffix}"


def import_file_to_temp(source_path: Path) -> Path:
    """把本地选中的 Excel 文件复制到 temp 目录。"""
    safe_filename = sanitize_uploaded_filename(source_path.name)
    target_path = (TEMP_DIR / safe_filename).resolve()
    if not is_path_within_safe(target_path, TEMP_DIR):
        raise ValueError("文件路径无效")

    shutil.copy2(source_path, target_path)
    return target_path


def cleanup_runtime_cache(
    preserve_paths: list[Path] | None = None,
    external_log: Callable[[str, str], None] | None = None,
) -> None:
    """清理运行缓存，保留 downloads 里的最终报表。"""
    import gc

    gc.collect()
    preserved: set[Path] = set()
    for path in preserve_paths or []:
        try:
            preserved.add(path.expanduser().resolve())
        except OSError:
            continue

    cleaned_count = 0
    errors: list[str] = []
    with cache_cleanup_lock:
        TEMP_DIR.mkdir(parents=True, exist_ok=True)
        for child in list(TEMP_DIR.iterdir()):
            try:
                resolved = child.resolve()
                if any(resolved == preserved_path or resolved in preserved_path.parents for preserved_path in preserved):
                    continue
                if not is_path_within_safe(resolved, TEMP_DIR):
                    continue
                if child.is_dir():
                    shutil.rmtree(child)
                else:
                    child.unlink()
                cleaned_count += 1
            except Exception as exc:
                errors.append(f"{child.name}: {exc}")

        pycache_dir = RUNTIME_DIR / "__pycache__"
        if pycache_dir.exists():
            try:
                shutil.rmtree(pycache_dir)
                cleaned_count += 1
            except Exception as exc:
                errors.append(f"{pycache_dir.name}: {exc}")

    if errors:
        emit_log(f"缓存清理完成，但有 {len(errors)} 项失败: {'; '.join(errors[:3])}", "warning", external_log)
    else:
        emit_log(f"缓存清理完成，共清理 {cleaned_count} 项", "info", external_log)


def clean_dataframe(dataframe: pd.DataFrame) -> pd.DataFrame:
    """移除无意义列，并处理重复列名。"""
    df = dataframe.loc[:, ~dataframe.columns.astype(str).str.contains("Unnamed", case=False, na=False)].copy()
    columns: list[str] = []
    seen: dict[str, int] = {}

    for column in df.columns:
        name = str(column).strip()
        if name in seen:
            seen[name] += 1
            columns.append(f"{name}_{seen[name]}")
        else:
            seen[name] = 0
            columns.append(name)

    df.columns = columns
    return df


def get_visible_data_row_mask(file_path: Path, sheet_name: str, row_count: int, data_start_row: int = 3) -> list[bool]:
    """Return a mask that excludes rows hidden in the source Excel sheet."""
    if row_count <= 0:
        return []

    try:
        import openpyxl

        workbook = openpyxl.load_workbook(file_path, read_only=False, data_only=True)
        try:
            worksheet = workbook[sheet_name]
            hidden_rows = {
                row_index
                for row_index, dimension in worksheet.row_dimensions.items()
                if dimension.hidden
            }
        finally:
            workbook.close()
    except Exception as exc:
        add_log(f"读取 {sheet_name} 隐藏行信息失败，已按全部行处理: {exc}", "warning")
        return [True] * row_count

    return [(data_start_row + index) not in hidden_rows for index in range(row_count)]


def filter_hidden_excel_rows(file_path: Path, sheet_name: str, dataframe: pd.DataFrame) -> pd.DataFrame:
    """Filter out rows hidden in Excel so mail text and screenshots match the workbook view."""
    if dataframe.empty:
        return dataframe

    visible_mask = get_visible_data_row_mask(file_path, sheet_name, len(dataframe))
    if len(visible_mask) != len(dataframe) or all(visible_mask):
        return dataframe
    return dataframe.loc[visible_mask].copy()


def value_matches_month(value: Any, month_filter: str) -> bool:
    """Match Excel date/range cells against the selected month."""
    if pd.isna(value):
        return False

    try:
        year_text, month_text = str(month_filter).split("/", 1)
        year = int(year_text)
        month = int(month_text)
    except ValueError:
        return str(month_filter) in str(value)

    if isinstance(value, datetime):
        return value.year == year and value.month == month

    text = str(value).strip()
    if not text:
        return False

    month_patterns = {
        f"{year}/{month}",
        f"{year}/{month:02d}",
        f"{year}-{month}",
        f"{year}-{month:02d}",
    }
    if any(pattern in text for pattern in month_patterns):
        return True

    for date_text in re.findall(r"\d{4}[/-]\d{1,2}[/-]\d{1,2}", text):
        parsed = pd.to_datetime(date_text, errors="coerce")
        if pd.notna(parsed) and parsed.year == year and parsed.month == month:
            return True

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        parsed = pd.to_datetime(value, unit="D", origin="1899-12-30", errors="coerce")
        return bool(pd.notna(parsed) and parsed.year == year and parsed.month == month)

    parsed = pd.to_datetime(text, errors="coerce")
    return bool(pd.notna(parsed) and parsed.year == year and parsed.month == month)


def get_sheet_snapshot_layout(file_path: Path, sheet_name: str, month_filter: str) -> tuple[list[int], int]:
    """Return visible source row numbers and the last used column for the email snapshot."""
    import openpyxl

    workbook = openpyxl.load_workbook(file_path, read_only=False, data_only=True)
    try:
        worksheet = workbook[sheet_name]

        def row_is_visible(row_index: int) -> bool:
            return not worksheet.row_dimensions[row_index].hidden

        base_rows: list[int] = []
        for row_index in range(3, worksheet.max_row + 1):
            if not row_is_visible(row_index):
                continue
            if value_matches_month(worksheet.cell(row_index, 2).value, month_filter):
                base_rows.append(row_index)

        included_rows = set(base_rows)
        for row_index in base_rows:
            for merged_range in worksheet.merged_cells.ranges:
                if merged_range.min_row <= row_index <= merged_range.max_row:
                    for merged_row in range(merged_range.min_row, merged_range.max_row + 1):
                        if row_is_visible(merged_row):
                            included_rows.add(merged_row)

        last_column = 1
        rows_to_scan = [1, 2, *sorted(included_rows)]
        for column_index in range(1, worksheet.max_column + 1):
            if any(worksheet.cell(row_index, column_index).value not in (None, "") for row_index in rows_to_scan):
                last_column = column_index

        return sorted(included_rows), last_column
    finally:
        workbook.close()


def get_sheet_snapshot_range(file_path: Path, sheet_name: str, month_filter: str) -> str:
    """Find the visible Excel range that should be embedded in the email."""
    from openpyxl.utils import get_column_letter

    included_rows, last_column = get_sheet_snapshot_layout(file_path, sheet_name, month_filter)
    last_row = max(included_rows) if included_rows else 2
    return f"A1:{get_column_letter(last_column)}{last_row}"


def load_sheet_snapshot_dataframe(file_path: Path, sheet_name: str, month_filter: str) -> tuple[str, pd.DataFrame]:
    """Load visible snapshot rows from the workbook without collapsing merged child rows."""
    import openpyxl

    included_rows, last_column = get_sheet_snapshot_layout(file_path, sheet_name, month_filter)
    workbook = openpyxl.load_workbook(file_path, read_only=False, data_only=True)
    try:
        worksheet = workbook[sheet_name]
        title = str(worksheet.cell(1, 1).value or sheet_name).strip()
        headers: list[str] = []
        seen_headers: dict[str, int] = {}
        for column_index in range(1, last_column + 1):
            raw_header = str(worksheet.cell(2, column_index).value or "").strip()
            if not raw_header and column_index == 2:
                raw_header = "数据时间"
            header = raw_header or f"列{column_index}"
            if header in seen_headers:
                seen_headers[header] += 1
                header = f"{header}.{seen_headers[header]}"
            else:
                seen_headers[header] = 0
            headers.append(header)

        rows: list[list[Any]] = []
        for row_index in included_rows:
            rows.append([worksheet.cell(row_index, column_index).value for column_index in range(1, last_column + 1)])

        return title, pd.DataFrame(rows, columns=headers)
    finally:
        workbook.close()


def get_rgb_from_excel_color(color: Any, default: tuple[int, int, int] = (255, 255, 255)) -> tuple[int, int, int]:
    """Convert a simple openpyxl color object to RGB."""
    rgb = getattr(color, "rgb", None)
    if isinstance(rgb, str):
        rgb = rgb[-6:]
        try:
            return tuple(int(rgb[index : index + 2], 16) for index in (0, 2, 4))  # type: ignore[return-value]
        except ValueError:
            return default
    return default


def format_excel_cell_value(value: Any) -> str:
    """Format Excel values for image rendering without pandas-style decimals."""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def get_windows_font(size: int, bold: bool = False) -> Any:
    """Load a Chinese-capable Windows font for PIL rendering."""
    from PIL import ImageFont

    candidates = [
        Path("C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc"),
        Path("C:/Windows/Fonts/simhei.ttf"),
        Path("C:/Windows/Fonts/simsun.ttc"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def get_snapshot_min_row_height_pixels(row_index: int) -> int:
    """Minimum rendered row height used when Excel screenshots need a readable fallback."""
    if row_index == 1:
        return 76
    if row_index == 2:
        return 44
    return 42


def get_snapshot_min_row_height_points(row_index: int) -> float:
    """Minimum Excel row height before CopyPicture, in points."""
    if row_index == 1:
        return 36.0
    if row_index == 2:
        return 24.0
    return 24.0


def get_snapshot_column_width_units(header: str, values: list[Any]) -> float:
    """Choose a temporary Excel column width so snapshot text is not clipped."""
    header_text = str(header or "").strip()
    value_texts = [format_excel_cell_value(value).strip() for value in values if format_excel_cell_value(value).strip()]
    raw_width = max(
        [get_display_text_width(header_text), *[get_display_text_width(value) for value in value_texts]],
        default=8,
    )
    desired_width = raw_width * 1.08 + 1.8

    if "序号" in header_text:
        return min(max(desired_width, 6.0), 8.0)
    if "数据时间" in header_text or ("时间" in header_text and "时长" not in header_text):
        return min(max(desired_width, 17.0), 21.0)
    if "楼栋" in header_text:
        return min(max(desired_width, 7.0), 9.0)
    if "房间" in header_text:
        return min(max(desired_width, 10.0), 18.0)
    if "机房" in header_text or "机柜" in header_text or "机列" in header_text:
        return min(max(desired_width, 10.0), 20.0)
    if "对侧" in header_text or "PDU编号" in header_text or "支路号" in header_text:
        return min(max(desired_width, 11.0), 24.0)
    if "功率" in header_text:
        return min(max(desired_width, 9.0), 16.0)
    if "次数" in header_text or "时长" in header_text:
        return min(max(desired_width, 7.0), 10.0)
    if "备注" in header_text or "说明" in header_text:
        return min(max(desired_width, 12.0), 30.0)
    return min(max(desired_width, 8.0), 20.0)


def wrap_text_for_pixel_width(draw: Any, text: str, font: Any, max_width: int) -> list[str]:
    """Wrap text based on rendered pixel width."""
    if not text:
        return [""]

    lines: list[str] = []
    for raw_line in str(text).replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        current = ""
        for character in raw_line:
            candidate = current + character
            bbox = draw.textbbox((0, 0), candidate, font=font)
            if current and bbox[2] - bbox[0] > max_width:
                lines.append(current)
                current = character
            else:
                current = candidate
        lines.append(current)
    return lines or [""]


def render_text_in_box(draw: Any, box: tuple[int, int, int, int], text: str, font: Any, fill: tuple[int, int, int]) -> None:
    """Draw centered, wrapped text inside a cell-like rectangle."""
    left, top, right, bottom = box
    padding = 4
    max_width = max(right - left - padding * 2, 1)
    lines = wrap_text_for_pixel_width(draw, text, font, max_width)
    line_heights = []
    line_widths = []
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font)
        line_widths.append(bbox[2] - bbox[0])
        line_heights.append(bbox[3] - bbox[1] or font.size)

    total_height = sum(line_heights) + max(len(lines) - 1, 0) * 3
    y = top + max((bottom - top - total_height) // 2, padding)
    for line, line_width, line_height in zip(lines, line_widths, line_heights):
        x = left + max((right - left - line_width) // 2, padding)
        draw.text((x, y), line, font=font, fill=fill)
        y += line_height + 3


def worksheet_snapshot_to_image(file_path: Path, sheet_name: str, month_filter: str) -> bytes:
    """Render the source worksheet range with Excel-like widths, fills, borders, and merged cells."""
    import openpyxl
    from openpyxl.utils import get_column_letter
    from PIL import Image, ImageDraw

    included_rows, last_column = get_sheet_snapshot_layout(file_path, sheet_name, month_filter)
    rows = [1, 2, *included_rows]
    workbook = openpyxl.load_workbook(file_path, read_only=False, data_only=True)
    try:
        worksheet = workbook[sheet_name]
        column_widths: list[int] = []
        for column_index in range(1, last_column + 1):
            letter = get_column_letter(column_index)
            source_width = worksheet.column_dimensions[letter].width or 8.43
            header = worksheet.cell(2, column_index).value
            values = [worksheet.cell(row_index, column_index).value for row_index in included_rows]
            width = max(float(source_width), get_snapshot_column_width_units(str(header or ""), values))
            column_widths.append(max(int(float(width) * 14.0), 48))

        row_heights: list[int] = []
        for row_index in rows:
            height = worksheet.row_dimensions[row_index].height or 15
            row_heights.append(max(int(float(height) * 2.05), get_snapshot_min_row_height_pixels(row_index)))

        x_edges = [0]
        for width in column_widths:
            x_edges.append(x_edges[-1] + width)
        y_edges = [0]
        for height in row_heights:
            y_edges.append(y_edges[-1] + height)

        image = Image.new("RGB", (x_edges[-1] + 1, y_edges[-1] + 1), "white")
        draw = ImageDraw.Draw(image)
        row_position = {row_index: index for index, row_index in enumerate(rows)}

        merged_lookup: dict[tuple[int, int], tuple[int, int, int, int]] = {}
        merged_top_left: set[tuple[int, int]] = set()
        for merged_range in worksheet.merged_cells.ranges:
            visible_rows = [row_index for row_index in range(merged_range.min_row, merged_range.max_row + 1) if row_index in row_position]
            if not visible_rows:
                continue
            min_row = min(visible_rows)
            max_row = max(visible_rows)
            min_col = max(merged_range.min_col, 1)
            max_col = min(merged_range.max_col, last_column)
            if min_col > last_column:
                continue
            span = (min_row, min_col, max_row, max_col)
            merged_top_left.add((min_row, min_col))
            for row_index in visible_rows:
                for column_index in range(min_col, max_col + 1):
                    merged_lookup[(row_index, column_index)] = span

        for row_index in rows:
            for column_index in range(1, last_column + 1):
                span = merged_lookup.get((row_index, column_index))
                if span and (row_index, column_index) not in merged_top_left:
                    continue

                if span:
                    min_row, min_col, max_row, max_col = span
                else:
                    min_row = max_row = row_index
                    min_col = max_col = column_index

                output_min_row = row_position[min_row]
                output_max_row = row_position[max_row]
                left = x_edges[min_col - 1]
                right = x_edges[max_col]
                top = y_edges[output_min_row]
                bottom = y_edges[output_max_row + 1]
                cell = worksheet.cell(min_row, min_col)

                fill_color = get_rgb_from_excel_color(cell.fill.fgColor)
                if getattr(cell.fill, "fill_type", None) is None:
                    fill_color = (255, 255, 255)
                draw.rectangle((left, top, right, bottom), fill=fill_color, outline=(0, 0, 0), width=2 if row_index == 1 else 1)

                text = format_excel_cell_value(cell.value)
                if text:
                    font_size = int(float(cell.font.sz or 11) * 2.0)
                    font = get_windows_font(max(font_size, 16), bold=bool(cell.font.bold))
                    font_color = get_rgb_from_excel_color(cell.font.color, default=(0, 0, 0))
                    render_text_in_box(draw, (left, top, right, bottom), text, font, font_color)

        buffer = BytesIO()
        image.save(buffer, format="PNG")
        return buffer.getvalue()
    finally:
        workbook.close()


def worksheet_range_to_image(file_path: Path, sheet_name: str, range_address: str) -> bytes:
    """Export an Excel range as a PNG using Excel's own rendering."""
    import time
    import pythoncom
    import win32com.client as win32
    from PIL import ImageGrab

    output_path = TEMP_DIR / f"excel_range_{uuid.uuid4().hex}.png"
    pythoncom.CoInitialize()
    try:
        return _worksheet_range_to_image_with_com(file_path, sheet_name, range_address, output_path)
    finally:
        pythoncom.CoUninitialize()


def apply_snapshot_column_widths_for_excel(worksheet: Any, cell_range: Any) -> None:
    """Temporarily widen columns before Excel CopyPicture to avoid clipped text."""
    first_row = int(cell_range.Row)
    first_column = int(cell_range.Column)
    row_count = int(cell_range.Rows.Count)
    column_count = int(cell_range.Columns.Count)
    last_row = first_row + row_count - 1

    for offset in range(column_count):
        column_number = first_column + offset
        try:
            header = worksheet.Cells(2, column_number).Value if first_row <= 2 <= last_row else ""
        except Exception:
            header = ""

        values: list[Any] = []
        for row_number in range(first_row, last_row + 1):
            if row_number == 1:
                continue
            try:
                if bool(worksheet.Rows(row_number).Hidden):
                    continue
                values.append(worksheet.Cells(row_number, column_number).Value)
            except Exception:
                continue

        try:
            column = worksheet.Columns(column_number)
            current_width = float(column.ColumnWidth or 8.43)
            target_width = get_snapshot_column_width_units(str(header or ""), values)
            column.ColumnWidth = max(current_width, target_width)
        except Exception:
            continue


def _worksheet_range_to_image_with_com(file_path: Path, sheet_name: str, range_address: str, output_path: Path) -> bytes:
    import gc
    import subprocess
    import time
    import win32com.client as win32
    from PIL import ImageGrab

    workbook = None
    worksheet = None
    cell_range = None
    excel = None
    excel_pid = None
    with excel_image_export_lock:
        excel = win32.DispatchEx("Excel.Application")
        try:
            import win32process

            excel_pid = win32process.GetWindowThreadProcessId(excel.Hwnd)[1]
        except Exception:
            excel_pid = None
        excel.Visible = True
        excel.DisplayAlerts = False
        try:
            workbook = excel.Workbooks.Open(str(file_path.resolve()))
            try:
                worksheet = workbook.Worksheets(sheet_name)
                worksheet.Activate()
                excel.ActiveWindow.DisplayGridlines = False
                cell_range = worksheet.Range(range_address)
                first_row = int(cell_range.Row)
                row_count = int(cell_range.Rows.Count)
                for offset in range(row_count):
                    row_number = first_row + offset
                    row = worksheet.Rows(row_number)
                    if not row.Hidden:
                        row.RowHeight = max(float(row.RowHeight), get_snapshot_min_row_height_points(row_number))
                apply_snapshot_column_widths_for_excel(worksheet, cell_range)
                cell_range.Select()
                time.sleep(0.2)
                cell_range.CopyPicture(Appearance=1, Format=2)
                time.sleep(0.5)
                image = ImageGrab.grabclipboard()
                if image is None:
                    raise ValueError("Excel 未返回截图到剪贴板")
                image.save(output_path)
                return output_path.read_bytes()
            finally:
                if workbook is not None:
                    workbook.Close(False)
        finally:
            try:
                if excel is not None:
                    excel.CutCopyMode = False
            except Exception:
                pass
            if excel is not None:
                excel.Quit()
            cell_range = None
            worksheet = None
            workbook = None
            excel = None
            gc.collect()
            if excel_pid:
                subprocess.run(
                    ["taskkill", "/PID", str(excel_pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5,
                    check=False,
                )
            try:
                output_path.unlink(missing_ok=True)
            except OSError:
                pass


def sheet_config_to_image(
    file_path: Path,
    sheet_config: dict[str, Any],
    month_filter: str,
    fallback_dataframe: pd.DataFrame,
    external_log: Callable[[str, str], None] | None = None,
) -> bytes:
    """Render the source worksheet for email, falling back to DataFrame rendering when Excel export is unavailable."""
    if USE_NATIVE_EXCEL_SCREENSHOT:
        try:
            range_address = get_sheet_snapshot_range(file_path, sheet_config["sheet_name"], month_filter)
            return worksheet_range_to_image(file_path, sheet_config["sheet_name"], range_address)
        except Exception as exc:
            emit_log(f"{sheet_config['sheet_name']} 原表截图生成失败，改用原表样式渲染: {exc}", "warning", external_log)

    try:
        return worksheet_snapshot_to_image(file_path, sheet_config["sheet_name"], month_filter)
    except Exception as fallback_exc:
        emit_log(f"{sheet_config['sheet_name']} 原表样式渲染失败，改用统计表渲染: {fallback_exc}", "warning", external_log)
        return dataframe_to_image(fallback_dataframe, sheet_config["image_title"])


def load_sheet_dataframe(file_path: Path, sheet_config: dict[str, Any], month_filter: str) -> pd.DataFrame:
    """读取单个工作表，并按月份过滤。"""
    df = pd.read_excel(file_path, sheet_name=sheet_config["sheet_name"], skiprows=1)
    df = filter_hidden_excel_rows(file_path, sheet_config["sheet_name"], df)
    rename_columns = sheet_config.get("rename_columns") or {}
    if rename_columns:
        df = df.rename(columns=rename_columns)

    df = clean_dataframe(df)

    key_col = sheet_config["key_col"]
    if key_col in df.columns:
        df = df.dropna(subset=[key_col])

    if "数据时间" in df.columns:
        df = df[df["数据时间"].apply(lambda value: value_matches_month(value, month_filter))]

    df["序号"] = range(1, len(df) + 1)
    return df


def load_alarm_data(file_path: Path, year: str, month_number: int) -> dict[str, pd.DataFrame]:
    """读取全部告警表。"""
    month_filter = build_month_filter(year, month_number)
    dataframes: dict[str, pd.DataFrame] = {}
    for sheet_config in SHEET_CONFIGS:
        dataframe = load_sheet_dataframe(file_path, sheet_config, month_filter)
        dataframes[sheet_config["image_id"]] = dataframe
    return dataframes


def preview_alarm_data(file_path: Path, year: str, month_number: int) -> dict[str, Any]:
    """预览全部工作表的统计结果。"""
    month_filter = build_month_filter(year, month_number)
    stats: dict[str, Any] = {}

    for sheet_config in SHEET_CONFIGS:
        label = sheet_config["label"]
        try:
            dataframe = load_sheet_dataframe(file_path, sheet_config, month_filter)
            stats[label] = len(dataframe)
            add_log(f"{label}: {len(dataframe)} 条", "success")
        except Exception as exc:
            stats[label] = f"读取失败: {exc}"
            add_log(f"读取 {sheet_config['sheet_name']} 失败: {exc}", "error")

    return stats


def compute_max_power(dataframe: pd.DataFrame) -> int:
    """计算最大功率值。"""
    if dataframe.empty or "功率" not in dataframe.columns:
        return 224

    try:
        values = (
            dataframe["功率"]
            .astype(str)
            .str.replace("KW", "", regex=False)
            .str.replace("kw", "", regex=False)
            .str.replace(",", "", regex=False)
            .str.extract(r"([0-9]+(?:\.[0-9]+)?)")[0]
            .dropna()
            .astype(float)
        )
        if values.empty:
            return 224
        return int(values.max())
    except Exception:
        return 224


def build_email_attachment_filename(file_path: Path, month_number: int) -> str:
    """Build the user-facing attachment name without download/import suffixes."""
    suffix = file_path.suffix or ".xlsx"
    stem = file_path.stem.strip()
    month_markers = [
        f"{month_number}月份",
        f"{month_number:02d}月份",
        f"{month_number}月",
        f"{month_number:02d}月",
    ]
    for marker in month_markers:
        marker_index = stem.find(marker)
        if marker_index >= 0:
            return f"{stem[:marker_index + len(marker)].rstrip(' _-')}{suffix}"

    cleaned_stem = re.sub(r"(?:_\d{8}_\d{6})+(?:_[0-9A-Za-z]{6,})?$", "", stem).strip(" _-")
    return f"{cleaned_stem or file_path.stem}{suffix}"


def load_vnet_logo_image(external_log: Callable[[str, str], None] | None = None) -> bytes | None:
    """Load the official VNET logo used in the email signature."""
    try:
        if VNET_LOGO_PATH.exists():
            return VNET_LOGO_PATH.read_bytes()
    except Exception as exc:
        emit_log(f"读取 VNET LOGO 失败，已跳过内嵌 LOGO: {exc}", "warning", external_log)
    return None


def stringify_table_value(value: Any) -> str:
    """Convert table values to display-safe strings."""
    if pd.isna(value):
        return ""

    text = str(value).strip()
    if text.lower() == "nan":
        return ""
    return text


def get_display_text_width(text: str) -> int:
    """Estimate text width with wide CJK characters counted more heavily."""
    import unicodedata

    width = 0
    for character in str(text):
        if character == "\n":
            continue
        width += 2 if unicodedata.east_asian_width(character) in {"W", "F"} else 1
    return max(width, 1)


def wrap_text_to_cell(text: str, max_width: int) -> str:
    """Wrap text to fit inside a table cell without truncating."""
    normalized = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return ""

    wrapped_lines: list[str] = []
    for raw_line in normalized.split("\n"):
        line = raw_line.strip()
        if not line:
            wrapped_lines.append("")
            continue

        current = ""
        current_width = 0
        for character in line:
            character_width = get_display_text_width(character)
            if current and current_width + character_width > max_width:
                wrapped_lines.append(current.rstrip())
                current = character
                current_width = character_width
            else:
                current += character
                current_width += character_width

        if current:
            wrapped_lines.append(current.rstrip())

    return "\n".join(wrapped_lines)


def get_column_char_limit(column_name: str, values: list[str]) -> int:
    """Choose a character budget per column to balance readability and wrapping."""
    raw_width = max([get_display_text_width(column_name)] + [get_display_text_width(value) for value in values], default=8)

    if "序号" in column_name:
        return 5
    if "数据时间" in column_name or ("时间" in column_name and "时长" not in column_name):
        return min(max(raw_width, 14), 18)
    if "备注" in column_name or "说明" in column_name:
        return min(max(raw_width, 10), 14)
    if "对侧" in column_name or "PDU编号" in column_name or "支路号" in column_name:
        return min(max(raw_width, 10), 14)
    if "房间" in column_name or "机柜" in column_name or "机列" in column_name:
        return min(max(raw_width, 8), 12)
    if "功率" in column_name:
        return min(max(raw_width, 8), 11)
    if "时长" in column_name or "次数" in column_name:
        return min(max(raw_width, 6), 8)
    return min(max(raw_width, 7), 12)


def dataframe_to_image(dataframe: pd.DataFrame, title: str) -> bytes:
    """将 DataFrame 渲染为 PNG 图片。"""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    matplotlib.rcParams["font.sans-serif"] = ["SimHei", "Microsoft YaHei", "Arial Unicode MS"]
    matplotlib.rcParams["axes.unicode_minus"] = False

    display_df = dataframe.copy()
    for column in display_df.columns:
        display_df[column] = display_df[column].apply(stringify_table_value)

    column_limits = {
        column: get_column_char_limit(column, display_df[column].astype(str).tolist())
        for column in display_df.columns
    }
    wrapped_headers = [wrap_text_to_cell(column, column_limits[column]) for column in display_df.columns]
    wrapped_rows = [
        [wrap_text_to_cell(display_df.iloc[row_index, column_index], column_limits[display_df.columns[column_index]]) for column_index in range(len(display_df.columns))]
        for row_index in range(len(display_df))
    ]

    header_line_count = max((header.count("\n") + 1 for header in wrapped_headers), default=1)
    row_line_counts = [
        max((cell.count("\n") + 1 for cell in row), default=1)
        for row in wrapped_rows
    ]

    column_count = max(len(display_df.columns), 1)
    total_column_units = sum(column_limits.values()) or 1
    column_widths = [limit / total_column_units for limit in column_limits.values()]

    if column_count <= 8:
        body_font_size = 12.5
    elif column_count <= 10:
        body_font_size = 11.8
    elif column_count <= 12:
        body_font_size = 11.0
    else:
        body_font_size = 10.4
    header_font_size = body_font_size + 1.4

    font_scale = max(body_font_size / 10.0, 1.0)
    fig_width = min(max(total_column_units * 0.17, 14), 20)
    header_height_units = max(header_line_count, 1) * (1.45 * font_scale)
    body_height_units = [max(line_count, 1) * (1.2 * font_scale) for line_count in row_line_counts]
    total_row_units = header_height_units + sum(body_height_units)
    fig_height = min(max(2.8 + total_row_units * 0.62, 4.8), 30)

    fig = plt.figure(figsize=(fig_width, fig_height))
    grid = fig.add_gridspec(2, 1, height_ratios=[1.15, max(total_row_units, 1.0)], hspace=0.02)
    ax_title = fig.add_subplot(grid[0])
    ax_table = fig.add_subplot(grid[1])
    ax_title.axis("off")
    ax_table.axis("off")

    title_box = plt.Rectangle((0.01, 0.18), 0.98, 0.64, facecolor="#FFFF00", edgecolor="black", linewidth=2)
    ax_title.add_patch(title_box)

    title_font_size = 16 if len(title) <= 12 else 14 if len(title) <= 18 else 12
    ax_title.text(
        0.5,
        0.5,
        title,
        ha="center",
        va="center",
        fontsize=title_font_size,
        weight="bold",
        transform=ax_title.transAxes,
    )

    table = ax_table.table(
        cellText=wrapped_rows,
        colLabels=wrapped_headers,
        cellLoc="center",
        loc="upper center",
        colWidths=column_widths,
        bbox=[0.0, 0.0, 1.0, 1.0],
        colColours=["#FF8C00"] * len(display_df.columns),
    )

    table.auto_set_font_size(False)
    table.set_fontsize(body_font_size)

    for (row_index, column_index), cell in table.get_celld().items():
        cell.PAD = 0.045
        cell.set_edgecolor("black")
        cell.set_linewidth(1.0 if row_index else 1.5)
        text = cell.get_text()
        text.set_wrap(True)
        text.set_ha("center")
        text.set_va("center")

        if row_index == 0:
            cell.set_facecolor("#FF8C00")
            text.set_color("black")
            text.set_weight("bold")
            text.set_fontsize(header_font_size)
        else:
            cell.set_facecolor("white")
            text.set_color("black")
            text.set_fontsize(body_font_size)

    total_height_units = header_height_units + sum(body_height_units) or 1.0

    header_height = header_height_units / total_height_units
    for column_index in range(len(display_df.columns)):
        table[(0, column_index)].set_height(header_height)

    for row_index, row_height_unit in enumerate(body_height_units, start=1):
        row_height = row_height_unit / total_height_units
        for column_index in range(len(display_df.columns)):
            table[(row_index, column_index)].set_height(row_height)

    fig.subplots_adjust(left=0.015, right=0.985, top=0.98, bottom=0.02)

    image_buffer = BytesIO()
    plt.savefig(
        image_buffer,
        format="png",
        dpi=220,
        bbox_inches="tight",
        facecolor="white",
        edgecolor="none",
        pad_inches=0.05,
    )
    plt.close(fig)
    image_buffer.seek(0)
    return image_buffer.getvalue()


def build_email_body(month_display: str, max_power: int, counts: dict[str, int]) -> str:
    """构造 HTML 邮件正文。"""
    return f"""<html>
<body style="font-family: Microsoft YaHei, SimHei, sans-serif; font-size: 11pt; line-height: 1.6;">
<div style="font-family: Microsoft YaHei, SimHei, sans-serif;">
{build_email_opening_html()}

<p style="margin: 0 0 10px 0; text-indent: 2em;">经统计{month_display}超功率情况如下：其中列头柜总功率超过215KW有<span style="color: red; font-weight: bold;">{counts['机列超215KW']}</span>个，最高功率达到<span style="color: red; font-weight: bold;">{max_power}KW</span>，超过列头柜柜设计功率，存在极高运行风险；</p>

<p style="margin: 0 0 6px 22px;">• 列头柜总功率超过215KW机柜<span style="color: red; font-weight: bold;">{counts['机列超215KW']}</span>个；</p>
<p style="margin: 0 0 6px 22px;">• 列头柜功率超过107.5KW的机柜<span style="color: red; font-weight: bold;">{counts['列头柜超107.5KW']}</span>个；</p>
<p style="margin: 0 0 6px 22px;">• 机柜功率超过18KW的机柜<span style="color: red; font-weight: bold;">{counts['机柜超18KW']}</span>个；</p>
<p style="margin: 0 0 10px 22px;">• 机柜单支路PDU功率超过6.25KW的支路<span style="color: red; font-weight: bold;">{counts['单支路超6.25KW']}</span>个；</p>

<p style="margin: 0 0 14px 0;"><b>此状态长期运行存在风险，请知悉并协调阿里业务侧尽快进行业务调整，谢谢！</b></p>

<br><p><b>1、机列超功率情况：</b></p>
</div>
<div style="text-align: center; margin: 10px 0;">
<img src="cid:img_jilie" style="max-width: 100%; height: auto; border: 1px solid #ddd;">
</div>

<div style="font-family: Microsoft YaHei, SimHei, sans-serif;">
<br><p><b>2、列头柜超功率情况：</b></p>
</div>
<div style="text-align: center; margin: 10px 0;">
<img src="cid:img_liegui" style="max-width: 100%; height: auto; border: 1px solid #ddd;">
</div>

<div style="font-family: Microsoft YaHei, SimHei, sans-serif;">
<br><p><b>3、机柜超功率情况：</b></p>
</div>
<div style="text-align: center; margin: 10px 0;">
<img src="cid:img_jigui" style="max-width: 100%; height: auto; border: 1px solid #ddd;">
</div>

<div style="font-family: Microsoft YaHei, SimHei, sans-serif;">
<br><p><b>4、单支路超功率情况：</b></p>
</div>
<div style="text-align: center; margin: 10px 0;">
<img src="cid:img_zhilu" style="max-width: 100%; height: auto; border: 1px solid #ddd;">
</div>

<br><br>
<div style="font-family: Arial, sans-serif; margin-bottom: 15px;">
<img src="cid:{VNET_LOGO_CID}" alt="VNET 世纪互联" style="width: 150px; height: auto; display: block; border: 0;">
</div>
<p style="font-family: Microsoft YaHei, SimHei, sans-serif; font-size: 10pt; color: #666; line-height: 1.5;">
马进宇 共享业务中台 | DC运维事业部 | 华东1部<br>
Tel: +86 18115823710<br>
Add: 南通市经济开发区中央路108号阿里巴巴南通保税A区数据中心<br>
PRC: 226000
</p>
</body>
</html>"""


def build_email_opening_html() -> str:
    """构造邮件正文开头的可见收件人信息和称呼。"""
    return """<p style="margin: 0 0 6px 0;">收件人: chenchaoyang.ccy@alibaba-inc.com; 'yuanzhuo.lyz@alibaba-inc.com' &lt;yuanzhuo.lyz@alibaba-inc.com&gt;; 'keone.mzy@alibaba-inc.com' &lt;keone.mzy@alibaba-inc.com&gt;</p>
<p style="margin: 0 0 10px 0;">抄送: '王晓明(相尧)' &lt;xiangyao.wxm@alibaba-inc.com&gt;; 'wb-ghp895452@alibaba-inc.com' &lt;wb-ghp895452@alibaba-inc.com&gt;; 'sjr01538561@alibaba-inc.com' &lt;sjr01538561@alibaba-inc.com&gt;; 'yxw02356095@alibaba-inc.com' &lt;yxw02356095@alibaba-inc.com&gt;; 陶必亮 &lt;tao.biliang@vnet.com&gt;; 施小东 &lt;shi.xiaodong@vnet.com&gt;; 陈继猛 &lt;chen.jimeng@vnet.com&gt;; 孙婷婷 &lt;sun.tingting@vnet.com&gt;; 陈凯 &lt;chen.kai3@vnet.com&gt;; 周海祥 &lt;zhou.haixiang@vnet.com&gt;; '刘小杏' &lt;liu.xiaoxing2-wb@sne.vnet.com&gt;; 梅冰冰 &lt;mei.bingbing@vnet.com&gt;</p>
<p style="margin: 0 0 10px 0;">绪晨总、刹捺总&远卓总，三位好！</p>"""


def build_alarm_analysis_email_body(month_display: str) -> str:
    """构造告警分析附件邮件正文。"""
    return f"""<html>
<body style="font-family: Microsoft YaHei, SimHei, sans-serif; font-size: 11pt; line-height: 1.6;">
<div style="font-family: Microsoft YaHei, SimHei, sans-serif;">
{build_email_opening_html()}
<p style="margin: 0 0 14px 0; text-indent: 2em;">请查收{month_display}EA118机房告警分析报告，详见附件。</p>
<p style="margin: 0 0 14px 0;">谢谢！</p>
</div>
<br><br>
<div style="font-family: Arial, sans-serif; margin-bottom: 15px;">
<img src="cid:{VNET_LOGO_CID}" alt="VNET 世纪互联" style="width: 150px; height: auto; display: block; border: 0;">
</div>
<p style="font-family: Microsoft YaHei, SimHei, sans-serif; font-size: 10pt; color: #666; line-height: 1.5;">
马进宇 共享业务中台 | DC运维事业部 | 华东1部<br>
Tel: +86 18115823710<br>
Add: 南通市经济开发区中央路108号阿里巴巴南通保税A区数据中心<br>
PRC: 226000
</p>
</body>
</html>"""


def get_table_config(table_name: str) -> dict[str, str]:
    """按名称获取多维表配置。"""
    selected_config = next((item for item in BITABLE_CONFIGS if item["name"] == table_name), None)
    if not selected_config:
        raise ValueError("未找到表格配置")
    return selected_config


def request_feishu_tenant_token(config: dict[str, Any], external_log: Callable[[str, str], None] | None = None) -> str:
    """获取飞书 tenant_access_token。"""
    emit_log("获取飞书访问令牌...", "info", external_log)
    response = requests.post(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        headers={"Content-Type": "application/json"},
        json={"app_id": config["feishu_app_id"], "app_secret": config["feishu_app_secret"]},
        timeout=30,
    )
    response.raise_for_status()
    result = response.json()
    if result.get("code") != 0:
        raise ValueError(f"获取 token 失败: {result.get('msg')}")

    emit_log("令牌获取成功", "success", external_log)
    return result["tenant_access_token"]


def send_feishu_chat_text(
    chat_id: str,
    text: str,
    config: dict[str, Any] | None = None,
    external_log: Callable[[str, str], None] | None = None,
) -> str:
    """向指定飞书群发送文本反馈。"""
    normalized_chat_id = str(chat_id or "").strip()
    message_text = str(text or "").strip()
    if not normalized_chat_id:
        raise ValueError("缺少飞书群 chat_id，无法发送反馈")
    if not message_text:
        raise ValueError("反馈内容不能为空")

    current_config = config or load_config()
    require_config_values(current_config, ["feishu_app_id", "feishu_app_secret"])
    token = request_feishu_tenant_token(current_config, external_log)

    response = requests.post(
        "https://open.feishu.cn/open-apis/im/v1/messages",
        params={"receive_id_type": "chat_id"},
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={
            "receive_id": normalized_chat_id,
            "msg_type": "text",
            "content": json.dumps({"text": message_text}, ensure_ascii=False),
        },
        timeout=30,
    )
    response.raise_for_status()
    result = response.json()
    if result.get("code") != 0:
        raise ValueError(f"发送飞书反馈失败: {result.get('msg')}")

    message_id = str(result.get("data", {}).get("message_id", "")).strip()
    emit_log(f"已向飞书群发送反馈: {normalized_chat_id}", "success", external_log)
    return message_id


def try_send_feishu_feedback(
    chat_id: str | None,
    text: str,
    config: dict[str, Any] | None = None,
    external_log: Callable[[str, str], None] | None = None,
) -> None:
    """尽力发送飞书反馈，失败时仅记录日志。"""
    if not str(chat_id or "").strip():
        return

    try:
        send_feishu_chat_text(str(chat_id), text, config=config, external_log=external_log)
    except Exception as exc:
        emit_log(f"发送飞书群反馈失败: {exc}", "error", external_log)


def fetch_bitable_records(
    config: dict[str, Any],
    table_config: dict[str, str],
    token: str,
    external_log: Callable[[str, str], None] | None = None,
) -> list[dict[str, Any]]:
    """拉取指定多维表视图下的全部记录。"""
    records_url = (
        f"https://open.feishu.cn/open-apis/bitable/v1/apps/{config['feishu_app_token']}"
        f"/tables/{table_config['table_id']}/records"
    )
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    params = {"view_id": table_config["view_id"], "page_size": 500}

    all_records: list[dict[str, Any]] = []
    has_more = True
    page_token = None

    emit_log("读取表格记录...", "info", external_log)
    while has_more:
        if page_token:
            params["page_token"] = page_token
        response = requests.get(records_url, headers=headers, params=params, timeout=120)
        response.raise_for_status()
        result = response.json()
        if result.get("code") != 0:
            raise ValueError(f"获取记录失败: {result.get('msg')}")

        data_page = result.get("data", {})
        all_records.extend(data_page.get("items", []))
        has_more = data_page.get("has_more", False)
        page_token = data_page.get("page_token")

    emit_log(f"共获取 {len(all_records)} 条记录", "success", external_log)
    return all_records


def load_power_alert_config(config: dict[str, Any]) -> dict[str, Any]:
    """读取超功率日统计多维表配置。"""
    config_path_text = str(config.get("ali_power_alert_config_path", "")).strip()
    if not config_path_text:
        raise ValueError("缺少阿里超功率多维表配置路径")

    config_path = Path(config_path_text).expanduser()
    if not config_path.is_absolute():
        runtime_candidate = (RUNTIME_DIR / config_path).resolve()
        config_path = runtime_candidate if runtime_candidate.exists() else (RUNTIME_DIR.parent / config_path).resolve()
    if not config_path.exists():
        raise ValueError(f"阿里超功率多维表配置不存在: {config_path}")

    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"阿里超功率多维表配置不是有效 JSON: {exc}") from exc

    base_token = str(os.getenv("FEISHU_BASE_TOKEN", "") or raw.get("baseToken") or raw.get("base_token") or "").strip()
    if not base_token:
        raise ValueError("阿里超功率多维表配置缺少 baseToken")

    tables = raw.get("tables") if isinstance(raw.get("tables"), dict) else {}
    key_map = {
        "branch": "branch",
        "cabinet": "cabinet",
        "line_head": "lineHead",
        "row_line": "rowLine",
    }
    normalized_tables: dict[str, dict[str, str]] = {}
    for output_key, source_key in key_map.items():
        table = tables.get(source_key) or tables.get(output_key) or {}
        table_id = str(table.get("tableId") or table.get("table_id") or "").strip()
        if not table_id:
            raise ValueError(f"阿里超功率多维表配置缺少 tables.{source_key}.tableId")
        normalized_tables[output_key] = {
            "name": str(table.get("name") or source_key).strip(),
            "table_id": table_id,
            "view_id": str(table.get("viewId") or table.get("view_id") or "").strip(),
        }

    return {
        "base_token": base_token,
        "data_center": str(raw.get("dataCenterName") or raw.get("data_center") or "EA118").strip() or "EA118",
        "template_path": str(raw.get("templatePath") or raw.get("template_path") or DEFAULT_ALI_POWER_TEMPLATE_PATH).strip(),
        "tables": normalized_tables,
    }


def format_feishu_response_error(response: requests.Response) -> str:
    """格式化飞书错误响应，避免只暴露 requests 的 URL 错误。"""
    try:
        payload = response.json()
    except ValueError:
        body = str(response.text or "").strip()
        if len(body) > 300:
            body = body[:300] + "..."
        return f"HTTP {response.status_code}: {body or '空响应'}"

    code = payload.get("code")
    msg = payload.get("msg")
    parts = [f"HTTP {response.status_code}"]
    if code is not None:
        parts.append(f"code={code}")
    if msg:
        parts.append(f"msg={msg}")
    return ", ".join(parts)


def fetch_power_alert_records(
    base_token: str,
    table_config: dict[str, str],
    token: str,
    external_log: Callable[[str, str], None] | None = None,
) -> list[dict[str, Any]]:
    """读取超功率日统计多维表记录。"""
    table_name = table_config.get("name") or table_config.get("table_id") or "超功率表"
    records_url = (
        f"https://open.feishu.cn/open-apis/bitable/v1/apps/{base_token}"
        f"/tables/{table_config['table_id']}/records"
    )
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    params: dict[str, Any] = {"page_size": 500}
    if table_config.get("view_id"):
        params["view_id"] = table_config["view_id"]

    records: list[dict[str, Any]] = []
    page_token = None
    page_number = 0
    emit_log(f"读取超功率多维表: {table_name}", "info", external_log)
    while True:
        page_number += 1
        if page_token:
            params["page_token"] = page_token
        result = None
        last_error = ""
        for attempt in range(1, 4):
            try:
                response = requests.get(records_url, headers=headers, params=params, timeout=120)
            except requests.RequestException as exc:
                last_error = f"请求异常: {exc}"
            else:
                if response.status_code >= 400:
                    last_error = format_feishu_response_error(response)
                else:
                    try:
                        result = response.json()
                    except ValueError:
                        last_error = f"HTTP {response.status_code}: 响应不是有效 JSON"
                    else:
                        if result.get("code") == 0:
                            break
                        last_error = f"HTTP {response.status_code}: code={result.get('code')}, msg={result.get('msg')}"

            if attempt < 3:
                emit_log(
                    f"{table_name} 第 {page_number} 页读取失败，准备重试 {attempt + 1}/3: {last_error}",
                    "warning",
                    external_log,
                )
                time.sleep(0.2 * attempt)
        else:
            raise ValueError(f"读取超功率多维表失败({table_name}): {last_error}")

        if not result or result.get("code") != 0:
            raise ValueError(f"读取超功率多维表失败({table_name}): {last_error or '未知错误'}")

        data_page = result.get("data", {})
        page_items = data_page.get("items", [])
        records.extend(item.get("fields", {}) for item in page_items if isinstance(item.get("fields"), dict))
        emit_log(f"{table_name} 第 {page_number} 页读取完成，累计 {len(records)} 条", "info", external_log)
        if not data_page.get("has_more"):
            break
        page_token = data_page.get("page_token")
        if not page_token:
            raise ValueError(f"读取超功率多维表失败({table_name}): 返回 has_more 但缺少 page_token")

    emit_log(f"{table_name} 共获取 {len(records)} 条记录", "success", external_log)
    return records


def filter_records_by_year_month(records: list[dict[str, Any]], year: str, month_number: int) -> list[dict[str, Any]]:
    """按年月筛选多维表记录。"""
    try:
        target_year = int(str(year).strip())
    except ValueError as exc:
        raise ValueError(f"年份格式无效: {year}") from exc

    def period_number(value: Any, suffix: str, digits: str) -> int | None:
        text = str(value if value is not None else "").strip()
        match = re.fullmatch(rf"({digits}){suffix}?", text)
        return int(match.group(1)) if match else None

    filtered_records: list[dict[str, Any]] = []

    for record in records:
        fields = record.get("fields", {})
        record_year = period_number(fields.get("年度"), "年", r"\d{4}")
        record_month = period_number(fields.get("月份"), "月", r"\d{1,2}")
        if record_year == target_year and record_month == month_number:
            filtered_records.append(record)

    return filtered_records


def download_record_attachments(
    records: list[dict[str, Any]],
    token: str,
    download_folder: Path,
    external_log: Callable[[str, str], None] | None = None,
    attachment_filter: Callable[[str], bool] | None = None,
) -> tuple[list[dict[str, str]], list[str], list[Path]]:
    """下载记录“上传文件”字段中的附件，并保留多维表记录更新时间。"""
    downloaded: list[dict[str, str]] = []
    errors: list[str] = []
    downloaded_paths: list[Path] = []

    for record_index, record in enumerate(records, start=1):
        fields = record.get("fields", {})
        record_timestamp: float | None = None
        for timestamp_key in ("last_modified_time", "created_time"):
            try:
                timestamp_value = float(record.get(timestamp_key) or 0)
            except (TypeError, ValueError):
                continue
            if timestamp_value > 0:
                record_timestamp = timestamp_value / 1000 if timestamp_value >= 10_000_000_000 else timestamp_value
                break

        for field_name, field_value in fields.items():
            if str(field_name).strip() != "上传文件":
                continue
            if not isinstance(field_value, list) or not field_value:
                continue
            if not isinstance(field_value[0], dict) or "file_token" not in field_value[0]:
                continue

            for attachment in field_value:
                file_name = sanitize_download_filename(
                    attachment.get("name", ""),
                    fallback_name=f"attachment_{record_index}",
                )
                if attachment_filter is not None and not attachment_filter(file_name):
                    continue

                file_url = attachment.get("url")
                if not file_url:
                    errors.append(f"{file_name}: 无下载 URL")
                    emit_log(f"[ERROR] {file_name} 无下载 URL", "error", external_log)
                    continue

                save_path = make_unique_path(download_folder, file_name)
                try:
                    emit_log(f"下载: {save_path.name}", "info", external_log)
                    response = requests.get(
                        file_url,
                        headers={"Authorization": f"Bearer {token}"},
                        stream=True,
                        timeout=30,
                    )
                    if response.status_code != 200:
                        error_message = f"HTTP {response.status_code}"
                        try:
                            detail = response.json().get("msg", "")
                            if detail:
                                error_message += f" - {detail}"
                        except Exception:
                            pass
                        raise ValueError(error_message)

                    with save_path.open("wb") as handle:
                        for chunk in response.iter_content(chunk_size=8192):
                            if chunk:
                                handle.write(chunk)

                    if record_timestamp is not None:
                        os.utime(save_path, (record_timestamp, record_timestamp))

                    size_kb = save_path.stat().st_size / 1024
                    emit_log(f"已保存: {save_path.name} ({size_kb:.1f}KB)", "success", external_log)
                    downloaded.append({"name": save_path.name, "size": f"{size_kb:.1f}KB"})
                    downloaded_paths.append(save_path)
                except Exception as exc:
                    errors.append(f"{save_path.name}: {exc}")
                    emit_log(f"[ERROR] {save_path.name}: {exc}", "error", external_log)

    return downloaded, errors, downloaded_paths


def select_report_file(
    file_paths: list[Path],
    external_log: Callable[[str, str], None] | None = None,
    require_unique_latest: bool = False,
) -> Path:
    """从下载结果中选择用于发信的 Excel 报表。"""
    excel_files = [path for path in file_paths if path.suffix.lower() in ALLOWED_UPLOAD_EXTENSIONS]
    if not excel_files:
        raise ValueError("未下载到可发送的 Excel 报表文件")

    if len(excel_files) > 1:
        excel_files.sort(key=lambda item: item.stat().st_mtime_ns, reverse=True)
        if require_unique_latest and excel_files[0].stat().st_mtime_ns == excel_files[1].stat().st_mtime_ns:
            raise ValueError("最新多维表记录包含多个同类 Excel 附件，无法确定唯一文件")
        emit_log(f"下载到多个 Excel 报表，自动使用最新文件: {excel_files[0].name}", "info", external_log)

    return excel_files[0]


def get_excel_sheet_names(file_path: Path) -> list[str]:
    """读取 Excel 工作表名称列表。"""
    import openpyxl

    workbook = openpyxl.load_workbook(file_path, read_only=True)
    try:
        return list(workbook.sheetnames)
    finally:
        workbook.close()


def select_alarm_report_file(file_paths: list[Path], external_log: Callable[[str, str], None] | None = None) -> Path:
    """优先选择包含告警统计工作表的 Excel 文件。"""
    excel_files = [path for path in file_paths if path.suffix.lower() in ALLOWED_UPLOAD_EXTENSIONS]
    if not excel_files:
        raise ValueError("未下载到可发送的 Excel 报表文件")

    expected_names = [str(config["sheet_name"]) for config in SHEET_CONFIGS]
    ranked_files: list[tuple[int, float, Path, list[str], list[str]]] = []
    unreadable_errors: list[str] = []

    for excel_file in excel_files:
        try:
            sheet_names = get_excel_sheet_names(excel_file)
            matched_names = [sheet_name for sheet_name in expected_names if sheet_name in sheet_names]
            ranked_files.append((len(matched_names), excel_file.stat().st_mtime, excel_file, matched_names, sheet_names))
        except Exception as exc:
            unreadable_errors.append(f"{excel_file.name}: {exc}")

    if not ranked_files:
        raise ValueError(f"无法读取下载的 Excel 文件: {'; '.join(unreadable_errors)}")

    ranked_files.sort(key=lambda item: (item[0], item[1]), reverse=True)
    best_score, _mtime, best_file, matched_names, sheet_names = ranked_files[0]
    expected_count = len(expected_names)

    if len(excel_files) > 1:
        emit_log(
            f"下载到多个 Excel 报表，优先选择最匹配告警统计模板的文件: {best_file.name} "
            f"(匹配 {best_score}/{expected_count} 个工作表)",
            "info",
            external_log,
        )

    if best_score == 0:
        workbook_summaries = [f"{item[2].name}: {', '.join(item[4])}" for item in ranked_files]
        raise ValueError(f"未找到包含告警统计工作表的 Excel 文件。已检查: {' | '.join(workbook_summaries)}")

    if best_score < expected_count:
        emit_log(
            f"{best_file.name} 仅匹配到部分工作表: {', '.join(matched_names)}；实际工作表: {', '.join(sheet_names)}",
            "warning",
            external_log,
        )
    else:
        emit_log(f"已选中告警统计报表: {best_file.name}", "success", external_log)

    return best_file


def workbook_has_email_stat_sheets(file_path: Path) -> bool:
    """判断工作簿是否适配现有图片邮件发送逻辑。"""
    try:
        sheet_names = set(get_excel_sheet_names(file_path))
    except Exception:
        return False
    expected_names = {str(config["sheet_name"]) for config in SHEET_CONFIGS}
    return expected_names.issubset(sheet_names)


def attach_excel_workbook(message: MIMEMultipart, file_path: Path, month_number: int) -> None:
    """将 Excel 工作簿作为邮件附件加入消息。"""
    with file_path.open("rb") as handle:
        attachment = MIMEBase("application", "vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        attachment.set_payload(handle.read())
        encoders.encode_base64(attachment)
        attachment_filename = build_email_attachment_filename(file_path, month_number)
        attachment.add_header("Content-Disposition", "attachment", filename=attachment_filename)
        attachment.add_header(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        message.attach(attachment)


def send_report_email(
    file_path: Path,
    subject: str,
    recipient: str,
    year: str,
    month_number: int,
    config: dict[str, Any] | None = None,
    external_log: Callable[[str, str], None] | None = None,
    attachment_path: Path | None = None,
    extra_attachment_paths: list[Path] | None = None,
) -> str:
    """读取报表并发送邮件，返回最终收件人文本。"""
    month_label = f"{month_number}月"
    month_display = f"{year}年{month_number}月"
    recipients = parse_recipients(recipient)

    current_config = config or load_config()
    require_config_values(current_config, ["qq_email", "auth_code"])
    sender_email = current_config["qq_email"]
    auth_code = current_config["auth_code"]

    emit_log("开始发送邮件...", "info", external_log)
    emit_log(f"按 {year}年{month_label} 读取 Excel 数据", "info", external_log)

    dataframes = load_alarm_data(file_path, year, month_number)
    counts = {
        "机列超215KW": len(dataframes["img_jilie"]),
        "列头柜超107.5KW": len(dataframes["img_liegui"]),
        "机柜超18KW": len(dataframes["img_jigui"]),
        "单支路超6.25KW": len(dataframes["img_zhilu"]),
    }
    max_power = compute_max_power(dataframes["img_jilie"])
    emit_log(
        "数据统计: "
        f"机列{counts['机列超215KW']}, "
        f"列头柜{counts['列头柜超107.5KW']}, "
        f"机柜{counts['机柜超18KW']}, "
        f"支路{counts['单支路超6.25KW']}",
        "success",
        external_log,
    )

    emit_log("生成表格图片...", "info", external_log)
    images: dict[str, bytes] = {}
    month_filter = build_month_filter(year, month_number)
    for sheet_config in SHEET_CONFIGS:
        image_id = sheet_config["image_id"]
        images[image_id] = sheet_config_to_image(file_path, sheet_config, month_filter, dataframes[image_id], external_log)

    html_body = build_email_body(month_display, max_power, counts)

    emit_log("正在发送邮件...", "info", external_log)
    message = MIMEMultipart("related")
    message["From"] = sender_email
    message["To"] = ", ".join(recipients)
    message["Subject"] = subject
    message.attach(MIMEText(html_body, "html", "utf-8"))

    for image_id, image_data in images.items():
        image = MIMEImage(image_data)
        image.add_header("Content-ID", f"<{image_id}>")
        message.attach(image)

    logo_image = load_vnet_logo_image(external_log)
    if logo_image:
        logo = MIMEImage(logo_image)
        logo.add_header("Content-ID", f"<{VNET_LOGO_CID}>")
        logo.add_header("Content-Disposition", "inline", filename="vnet_logo.png")
        message.attach(logo)

    primary_attachment_path = attachment_path or file_path
    attach_excel_workbook(message, primary_attachment_path, month_number)
    attached_paths = {primary_attachment_path.resolve()}
    for extra_path in extra_attachment_paths or []:
        resolved_extra_path = extra_path.resolve()
        if resolved_extra_path in attached_paths:
            continue
        attach_excel_workbook(message, extra_path, month_number)
        attached_paths.add(resolved_extra_path)

    with smtplib.SMTP_SSL("smtp.qq.com", 465) as server:
        server.login(sender_email, auth_code)
        server.send_message(message, to_addrs=recipients)

    recipient_text = ", ".join(recipients)
    emit_log(f"邮件发送成功 -> {recipient_text}", "success", external_log)
    return recipient_text


def send_alarm_analysis_email(
    file_path: Path,
    subject: str,
    recipient: str,
    year: str,
    month_number: int,
    config: dict[str, Any] | None = None,
    external_log: Callable[[str, str], None] | None = None,
) -> str:
    """发送告警分析工作簿附件邮件，返回最终收件人文本。"""
    month_display = f"{year}年{month_number}月"
    recipients = parse_recipients(recipient)

    current_config = config or load_config()
    require_config_values(current_config, ["qq_email", "auth_code"])
    sender_email = current_config["qq_email"]
    auth_code = current_config["auth_code"]

    emit_log("开始发送告警分析邮件...", "info", external_log)
    message = MIMEMultipart("related")
    message["From"] = sender_email
    message["To"] = ", ".join(recipients)
    message["Subject"] = subject
    message.attach(MIMEText(build_alarm_analysis_email_body(month_display), "html", "utf-8"))

    logo_image = load_vnet_logo_image(external_log)
    if logo_image:
        logo = MIMEImage(logo_image)
        logo.add_header("Content-ID", f"<{VNET_LOGO_CID}>")
        logo.add_header("Content-Disposition", "inline", filename="vnet_logo.png")
        message.attach(logo)

    with file_path.open("rb") as handle:
        attachment = MIMEBase("application", "vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        attachment.set_payload(handle.read())
        encoders.encode_base64(attachment)
        attachment_filename = build_email_attachment_filename(file_path, month_number)
        attachment.add_header("Content-Disposition", "attachment", filename=attachment_filename)
        attachment.add_header(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        message.attach(attachment)

    with smtplib.SMTP_SSL("smtp.qq.com", 465) as server:
        server.login(sender_email, auth_code)
        server.send_message(message, to_addrs=recipients)

    recipient_text = ", ".join(recipients)
    emit_log(f"告警分析邮件发送成功 -> {recipient_text}", "success", external_log)
    return recipient_text


def download_report_attachments(
    table_name: str,
    year: str,
    month_number: int,
    config: dict[str, Any] | None = None,
    external_log: Callable[[str, str], None] | None = None,
    attachment_filter: Callable[[str], bool] | None = None,
    tenant_token: str | None = None,
    destination_folder: str | Path | None = None,
) -> dict[str, Any]:
    """下载指定年月的飞书月报附件。"""
    month_label = f"{month_number}月"
    current_config = config or load_config()
    require_config_values(current_config, ["feishu_app_id", "feishu_app_secret", "feishu_app_token"])

    table_config = get_table_config(table_name)
    emit_log(f"从【{table_name}】下载 {year}年{month_label} 的附件...", "info", external_log)
    token = tenant_token or request_feishu_tenant_token(current_config, external_log)
    all_records = fetch_bitable_records(current_config, table_config, token, external_log)
    filtered_records = filter_records_by_year_month(all_records, year, month_number)

    emit_log(f"筛选出 {len(filtered_records)} 条 {year}年{month_label} 的记录", "success", external_log)
    if not filtered_records:
        raise ValueError(f"没有找到 {year}年{month_label} 的记录")

    download_folder = Path(destination_folder or current_config["download_folder"]).expanduser()
    download_folder.mkdir(parents=True, exist_ok=True)
    downloaded, errors, downloaded_paths = download_record_attachments(
        filtered_records,
        token,
        download_folder,
        external_log,
        attachment_filter,
    )

    emit_log(f"下载完成！成功 {len(downloaded)} 个, 失败 {len(errors)} 个", "success", external_log)
    return {
        "downloaded": downloaded,
        "errors": errors,
        "folder": str(download_folder),
        "file_paths": downloaded_paths,
    }


def build_feishu_session(token: str) -> requests.Session:
    """构造已带 tenant_access_token 的飞书 Session。"""
    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {token}"})
    return session


def upload_bitable_file(
    app_token: str,
    token: str,
    file_path: Path,
    external_log: Callable[[str, str], None] | None = None,
    upload_name: str | None = None,
) -> str:
    """上传文件为多维表附件素材，并返回 file_token。"""
    if not file_path.exists():
        raise ValueError(f"待上传文件不存在: {file_path}")

    file_name = sanitize_download_filename(upload_name or file_path.name, file_path.name)
    emit_log(f"上传附件素材: {file_name}", "info", external_log)
    checksum = str(zlib.adler32(file_path.read_bytes()) & 0xFFFFFFFF)
    with file_path.open("rb") as handle:
        response = requests.post(
            "https://open.feishu.cn/open-apis/drive/v1/medias/upload_all",
            headers={"Authorization": f"Bearer {token}"},
            data={
                "file_name": file_name,
                "parent_type": "bitable_file",
                "parent_node": app_token,
                "size": str(file_path.stat().st_size),
                "checksum": checksum,
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
    if result.get("code") != 0:
        raise ValueError(f"上传附件素材失败: {result.get('msg')}")

    file_token = str(result.get("data", {}).get("file_token", "")).strip()
    if not file_token:
        raise ValueError("上传附件素材失败: 响应中没有 file_token")

    emit_log("附件素材上传成功", "success", external_log)
    return file_token


def create_report_record_with_attachment(
    app_token: str,
    table_config: dict[str, str],
    token: str,
    file_token: str,
    year: str,
    month_number: int,
    report_type_name: str,
    external_log: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """向目标多维表新增一条带附件的月报记录。"""
    emit_log(f"新增多维表记录: {report_type_name} {year}年{month_number}月", "info", external_log)
    response = requests.post(
        f"https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}/tables/{table_config['table_id']}/records",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
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
    if result.get("code") != 0:
        raise ValueError(f"新增多维表记录失败: {result.get('msg')}")

    record = result.get("data", {}).get("record", {})
    record_id = str(record.get("record_id", "")).strip()
    emit_log(f"多维表记录新增成功: {record_id}", "success", external_log)
    return record


def create_power_report_record_with_attachment(
    app_token: str,
    table_config: dict[str, str],
    token: str,
    file_token: str,
    year: str,
    month_number: int,
    category_name: str,
    external_log: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """向高功率目标表新增一条带附件的月报记录。"""
    emit_log(f"新增多维表记录: {category_name} {year}年{month_number}月", "info", external_log)
    response = requests.post(
        f"https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}/tables/{table_config['table_id']}/records",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={
            "fields": {
                "子分类": category_name,
                "年度": str(year),
                "月份": f"{month_number:02d}",
                "上传文件": [{"file_token": file_token}],
            }
        },
        timeout=60,
    )
    response.raise_for_status()
    result = response.json()
    if result.get("code") != 0:
        raise ValueError(f"新增多维表记录失败: {result.get('msg')}")

    record = result.get("data", {}).get("record", {})
    record_id = str(record.get("record_id", "")).strip()
    emit_log(f"多维表记录新增成功: {record_id}", "success", external_log)
    return record


def update_report_record_attachment(
    app_token: str,
    table_config: dict[str, str],
    token: str,
    record_id: str,
    file_token: str,
    external_log: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """覆盖目标多维表记录中的上传文件附件。"""
    normalized_record_id = str(record_id or "").strip()
    if not normalized_record_id:
        raise ValueError("缺少待覆盖的多维表记录 ID")

    emit_log(f"覆盖多维表记录附件: {normalized_record_id}", "info", external_log)
    response = requests.put(
        (
            f"https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}"
            f"/tables/{table_config['table_id']}/records/{normalized_record_id}"
        ),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"fields": {"上传文件": [{"file_token": file_token}]}},
        timeout=60,
    )
    response.raise_for_status()
    result = response.json()
    if result.get("code") != 0:
        raise ValueError(f"覆盖多维表记录附件失败: {result.get('msg')}")

    record = result.get("data", {}).get("record", {})
    emit_log(f"多维表记录附件覆盖成功: {normalized_record_id}", "success", external_log)
    return record or {"record_id": normalized_record_id}


def find_report_records(
    app_token: str,
    table_config: dict[str, str],
    token: str,
    year: str,
    month_number: int,
    report_type_name: str,
    external_log: Callable[[str, str], None] | None = None,
) -> list[dict[str, Any]]:
    """查找目标表中同类型、同年月的既有月报记录。"""
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    params: dict[str, Any] = {"page_size": 500}
    records: list[dict[str, Any]] = []
    page_token = None

    while True:
        if page_token:
            params["page_token"] = page_token
        response = requests.get(
            f"https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}/tables/{table_config['table_id']}/records",
            headers=headers,
            params=params,
            timeout=60,
        )
        response.raise_for_status()
        result = response.json()
        if result.get("code") != 0:
            raise ValueError(f"查询目标月报记录失败: {result.get('msg')}")

        data_page = result.get("data", {})
        for item in data_page.get("items", []):
            fields = item.get("fields", {})
            month_value = str(fields.get("月份", ""))
            year_value = str(fields.get("年度", ""))
            type_value = str(fields.get("月报类型", ""))
            if type_value == report_type_name and year_value == str(year) and month_value in {str(month_number), f"{month_number:02d}"}:
                records.append(item)

        if not data_page.get("has_more"):
            break
        page_token = data_page.get("page_token")

    if records:
        emit_log(f"目标表已存在 {len(records)} 条同月记录，将覆盖已有记录附件", "warning", external_log)
    return records


def find_power_report_records(
    app_token: str,
    table_config: dict[str, str],
    token: str,
    year: str,
    month_number: int,
    category_name: str,
    external_log: Callable[[str, str], None] | None = None,
) -> list[dict[str, Any]]:
    """查找高功率目标表中同子分类、同年月的既有记录。"""
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    params: dict[str, Any] = {"page_size": 500}
    records: list[dict[str, Any]] = []
    page_token = None

    while True:
        if page_token:
            params["page_token"] = page_token
        response = requests.get(
            f"https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}/tables/{table_config['table_id']}/records",
            headers=headers,
            params=params,
            timeout=60,
        )
        response.raise_for_status()
        result = response.json()
        if result.get("code") != 0:
            raise ValueError(f"查询目标月报记录失败: {result.get('msg')}")

        data_page = result.get("data", {})
        for item in data_page.get("items", []):
            fields = item.get("fields", {})
            month_value = str(fields.get("月份", ""))
            year_value = str(fields.get("年度", ""))
            category_value = str(fields.get("子分类", ""))
            if category_value == category_name and year_value == str(year) and month_value in {str(month_number), f"{month_number:02d}"}:
                records.append(item)

        if not data_page.get("has_more"):
            break
        page_token = data_page.get("page_token")

    if records:
        emit_log(f"目标表已存在 {len(records)} 条同月记录，将覆盖已有记录附件", "warning", external_log)
    return records


def report_record_sort_value(record: dict[str, Any]) -> int:
    """取记录创建时间作为选择覆盖目标的排序值。"""
    fields = record.get("fields", {}) if isinstance(record.get("fields"), dict) else {}
    candidates = [
        record.get("last_modified_time"),
        record.get("created_time"),
        fields.get("创建日期"),
        fields.get("创建时间"),
    ]
    for value in candidates:
        if isinstance(value, (int, float)):
            return int(value)
        if isinstance(value, str) and value.isdigit():
            return int(value)
    return 0


def select_report_record_for_update(records: list[dict[str, Any]]) -> dict[str, Any]:
    """当同年月存在多条记录时，选择最新的一条进行覆盖。"""
    if not records:
        raise ValueError("没有可覆盖的多维表记录")
    return max(records, key=report_record_sort_value)


def generated_file_payload(file_path: Path, display_name: str | None = None) -> dict[str, str]:
    """返回前端展示用文件信息。"""
    return {
        "name": display_name or file_path.name,
        "path": str(file_path),
        "size": f"{file_path.stat().st_size / 1024:.1f}KB",
    }


def remove_url_query_param(url: str, param_name: str) -> str:
    """移除 URL 中的指定查询参数。"""
    parsed = urlparse(url)
    query = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True) if key != param_name]
    return urlunparse(parsed._replace(query=urlencode(query)))


def first_present(record: dict[str, Any], *names: str) -> Any:
    """按候选字段名取第一个非空值。"""
    for name in names:
        value = record.get(name)
        if value not in (None, ""):
            return value
    return ""


def cell_text(value: Any) -> str:
    """把飞书单元格值转换成适合 Excel 展示的文本。"""
    if value in (None, ""):
        return ""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, (list, tuple, set)):
        parts = [cell_text(item) for item in value]
        return "\n".join(part for part in parts if part)
    if isinstance(value, dict):
        for key in ("text", "name", "en_name", "value"):
            if key in value:
                return cell_text(value[key])
        parts = [cell_text(item) for item in value.values()]
        return " ".join(part for part in parts if part)
    return str(value).strip()


def date_text(value: Any) -> str:
    """将日期字段统一输出为 YYYY-MM-DD。"""
    parsed = ali_alarm_report_generator.parse_dt(value)
    if parsed:
        return parsed.strftime("%Y-%m-%d")
    return cell_text(value)


def is_value_in_month(value: Any, month_start: datetime, month_end: datetime) -> bool:
    """判断日期值是否落在指定月份内。"""
    parsed = ali_alarm_report_generator.parse_dt(value)
    return bool(parsed and month_start <= parsed < month_end)


def is_truthy_cell(value: Any) -> bool:
    """兼容飞书 checkbox 的布尔、数字和文本返回形态。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, (list, tuple, set)):
        return any(is_truthy_cell(item) for item in value)
    return cell_text(value).lower() in {"1", "true", "yes", "y", "是", "离职", "已离职", "异动"}


def is_formal_staff_record(record: dict[str, Any]) -> bool:
    """只保留岗位性质为正式岗的人员记录。"""
    raw_value = first_present(record, "岗位性质")
    values = [
        item.strip()
        for item in re.split(r"[\n,，;；/、]+", cell_text(raw_value))
        if item.strip()
    ]
    return "正式岗" in values


def format_staff_sheet(ws, widths: list[int]) -> None:
    """设置人员导出工作表的基础样式。"""
    from openpyxl.styles import Alignment, Font
    from openpyxl.utils import get_column_letter

    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.alignment = Alignment(horizontal="center", vertical="center")
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(vertical="center", wrap_text=True)
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    for index, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(index)].width = width


def is_intern_or_backup_position(position: str) -> bool:
    """判断岗位是否归入实习生或备岗分区。"""
    return "实习" in position or "备岗" in position


def write_staff_roster_workbook(
    active_records: list[dict[str, Any]],
    all_records: list[dict[str, Any]],
    month: str,
    output_path: Path,
) -> dict[str, int]:
    """生成在职人员基础信息和本月人员变动 Excel。"""
    from openpyxl import Workbook

    month_start, month_end = ali_alarm_report_generator.month_bounds(month)
    formal_active_records = [record for record in active_records if is_formal_staff_record(record)]
    formal_all_records = [record for record in all_records if is_formal_staff_record(record)]
    output_path.parent.mkdir(parents=True, exist_ok=True)

    wb = Workbook()
    active_ws = wb.active
    active_ws.title = "在职人员基础信息"
    active_ws.append(["人员姓名", "岗位", "入职时间"])
    for record in formal_active_records:
        active_ws.append(
            [
                cell_text(first_present(record, "姓名", "人员姓名", "员工姓名")),
                cell_text(first_present(record, "岗位")),
                date_text(first_present(record, "入职日期", "入职时间")),
            ]
        )

    new_hires: list[tuple[str, str]] = []
    leavers: list[tuple[str, str]] = []
    for record in all_records:
        name = cell_text(first_present(record, "姓名", "人员姓名", "员工姓名"))
        if not name:
            continue
        position = cell_text(first_present(record, "岗位"))

        if is_value_in_month(first_present(record, "入职日期", "入职时间"), month_start, month_end):
            new_hires.append((name, position))
        if is_truthy_cell(first_present(record, "离职/异动情况", "离职情况")) and is_value_in_month(
            first_present(record, "离职/异动日期", "离职日期"),
            month_start,
            month_end,
        ):
            leavers.append((name, position))

    intern_or_backup_new_hires = [entry for entry in new_hires if is_intern_or_backup_position(entry[1])]
    intern_or_backup_leavers = [entry for entry in leavers if is_intern_or_backup_position(entry[1])]
    other_new_hires = [entry for entry in new_hires if not is_intern_or_backup_position(entry[1])]
    other_leavers = [entry for entry in leavers if not is_intern_or_backup_position(entry[1])]

    changes_ws = wb.create_sheet("本月人员变动")
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    title_rows: set[int] = set()
    header_rows: set[int] = set()
    for section_index, (title, section_new_hires, section_leavers) in enumerate(
        [
            ("实习生及备岗", intern_or_backup_new_hires, intern_or_backup_leavers),
            ("其他人员", other_new_hires, other_leavers),
        ]
    ):
        changes_ws.append([title])
        title_row = changes_ws.max_row
        title_rows.add(title_row)
        changes_ws.merge_cells(start_row=title_row, start_column=1, end_row=title_row, end_column=4)
        title_cell = changes_ws.cell(title_row, 1)
        title_cell.font = Font(bold=True, color="FFFFFF")
        title_cell.fill = PatternFill("solid", fgColor="1F4E78")
        title_cell.alignment = Alignment(horizontal="center", vertical="center")

        changes_ws.append(["本月新增人员姓名", "岗位", "离职人员姓名", "岗位"])
        header_row = changes_ws.max_row
        header_rows.add(header_row)
        for cell in changes_ws[header_row]:
            cell.font = Font(bold=True)
            cell.fill = PatternFill("solid", fgColor="D9EAF7")
            cell.alignment = Alignment(horizontal="center", vertical="center")

        for new_hire, leaver in zip_longest(section_new_hires, section_leavers, fillvalue=("", "")):
            changes_ws.append([new_hire[0], new_hire[1], leaver[0], leaver[1]])

        if section_index == 0:
            changes_ws.append([])

    for row in changes_ws.iter_rows():
        for cell in row:
            if cell.row not in title_rows | header_rows:
                cell.alignment = Alignment(vertical="center", wrap_text=True)
    changes_ws.freeze_panes = "A2"
    for index, width in enumerate([22, 24, 22, 24], start=1):
        changes_ws.column_dimensions[get_column_letter(index)].width = width

    format_staff_sheet(active_ws, [18, 24, 14])
    wb.save(output_path)
    wb.close()
    return {
        "active_count": len(formal_active_records),
        "new_hire_count": len(new_hires),
        "leaver_count": len(leavers),
        "ignored_non_formal_count": max(len(all_records) - len(formal_all_records), 0),
    }


def generate_staff_roster_monthly_report(
    year: str,
    month_number: int,
    config: dict[str, Any],
    external_log: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """从人员管理多维表导出在职人员和本月人员变动。"""
    require_config_values(config, ["feishu_app_id", "feishu_app_secret", "ali_staff_source_url"])
    source_url = str(config.get("ali_staff_source_url", "")).strip()
    full_table_url = remove_url_query_param(source_url, "view")
    download_folder = Path(config["download_folder"]).expanduser()
    download_folder.mkdir(parents=True, exist_ok=True)
    output_path = make_unique_path(download_folder, f"南通机房{year}年{month_number}月在职人员导出.xlsx")

    emit_log(f"开始导出在职人员: {year}年{month_number}月", "info", external_log)
    token = request_feishu_tenant_token(config, external_log)
    session = build_feishu_session(token)
    active_records = ali_alarm_report_generator.fetch_feishu_records(source_url, session=session)
    all_records = ali_alarm_report_generator.fetch_feishu_records(full_table_url, session=session)
    counts = write_staff_roster_workbook(active_records, all_records, f"{year}-{month_number:02d}", output_path)
    emit_log(
        f"在职人员导出完成: {output_path.name}，在职 {counts['active_count']} 人，新增 {counts['new_hire_count']} 人，离职 {counts['leaver_count']} 人",
        "success",
        external_log,
    )
    return {
        "action": "generated_staff_roster",
        "files": [generated_file_payload(output_path)],
        "record_count": len(all_records),
        **counts,
        "message": f"在职人员导出已生成: {output_path.name}",
    }


def build_bitable_record_url(app_token: str, table_config: dict[str, str], record_id: str) -> str:
    """拼出多维表记录的可打开链接。"""
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
    query_text = "&".join(query_parts)
    return f"https://vnet.feishu.cn/base/{quote(normalized_app_token, safe='')}?{query_text}"


def resolve_feishu_open_id_by_email(
    email: str,
    config: dict[str, Any],
    token: str | None = None,
    external_log: Callable[[str, str], None] | None = None,
) -> str:
    """通过邮箱解析飞书用户 open_id。"""
    normalized_email = str(email or "").strip()
    if not normalized_email:
        raise ValueError("缺少飞书用户邮箱，无法发送私聊通知")

    access_token = token or request_feishu_tenant_token(config, external_log)
    response = requests.post(
        "https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id",
        params={"user_id_type": "open_id"},
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json={"emails": [normalized_email]},
        timeout=30,
    )
    response.raise_for_status()
    result = response.json()
    if result.get("code") != 0:
        raise ValueError(f"获取飞书用户 open_id 失败: {result.get('msg')}")

    data = result.get("data", {})
    for user_item in data.get("user_list", []) or []:
        user_id = str(user_item.get("user_id") or user_item.get("open_id") or "").strip()
        if user_id:
            return user_id

    raise ValueError(f"未通过邮箱找到飞书用户: {normalized_email}")


def send_feishu_user_text(
    open_id: str,
    text: str,
    token: str,
    external_log: Callable[[str, str], None] | None = None,
) -> str:
    """向指定飞书用户发送私聊文本消息。"""
    normalized_open_id = str(open_id or "").strip()
    message_text = str(text or "").strip()
    if not normalized_open_id:
        raise ValueError("缺少飞书用户 open_id，无法发送私聊通知")
    if not message_text:
        raise ValueError("飞书私聊通知内容不能为空")

    response = requests.post(
        "https://open.feishu.cn/open-apis/im/v1/messages",
        params={"receive_id_type": "open_id"},
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={
            "receive_id": normalized_open_id,
            "msg_type": "text",
            "content": json.dumps({"text": message_text}, ensure_ascii=False),
        },
        timeout=30,
    )
    response.raise_for_status()
    result = response.json()
    if result.get("code") != 0:
        raise ValueError(f"发送飞书私聊通知失败: {result.get('msg')}")

    message_id = str(result.get("data", {}).get("message_id", "")).strip()
    emit_log(f"已向飞书用户发送私聊通知: {ALI_RECORD_NOTIFY_USER_NAME}", "success", external_log)
    return message_id


def send_bitable_record_link_feishu_message(
    *,
    year: str,
    month_number: int,
    report_type_name: str,
    records: list[dict[str, Any]],
    config: dict[str, Any],
    token: str | None = None,
    external_log: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """将生成出的多维记录链接通过飞书私聊发送给马进宇。"""
    valid_records = [item for item in records if str(item.get("record_url", "")).strip()]
    if not valid_records:
        message = "未生成可发送的多维记录链接，已跳过通知"
        emit_log(message, "warning", external_log)
        return {
            "sent": False,
            "channel": "feishu_private",
            "recipient": ALI_RECORD_NOTIFY_USER_NAME,
            "recipient_email": ALI_RECORD_NOTIFY_USER_EMAIL,
            "error": message,
        }

    require_config_values(config, ["feishu_app_id", "feishu_app_secret"])
    access_token = token or request_feishu_tenant_token(config, external_log)
    open_id = resolve_feishu_open_id_by_email(
        ALI_RECORD_NOTIFY_USER_EMAIL,
        config,
        token=access_token,
        external_log=external_log,
    )

    lines = [
        f"{ALI_RECORD_NOTIFY_USER_NAME}，您好！",
        f"{year}年{month_number}月 {report_type_name} 已生成，相关多维记录链接如下：",
    ]
    for index, item in enumerate(valid_records, start=1):
        record_id = str(item.get("record_id", "")).strip() or f"记录{index}"
        record_url = str(item.get("record_url", "")).strip()
        file_count = item.get("file_count")
        suffix = f"（附件 {file_count} 个）" if isinstance(file_count, int) and file_count >= 0 else ""
        lines.append(f"{index}. {record_id}{suffix}")
        lines.append(record_url)
    lines.append("请点击链接查看。")

    emit_log(f"开始飞书私聊发送多维记录链接 -> {ALI_RECORD_NOTIFY_USER_NAME}", "info", external_log)
    message_id = send_feishu_user_text(open_id, "\n".join(lines), access_token, external_log)
    return {
        "sent": True,
        "channel": "feishu_private",
        "recipient": ALI_RECORD_NOTIFY_USER_NAME,
        "recipient_email": ALI_RECORD_NOTIFY_USER_EMAIL,
        "open_id": open_id,
        "message_id": message_id,
        "record_count": len(valid_records),
    }


def generate_alarm_analysis_monthly_report(
    year: str,
    month_number: int,
    config: dict[str, Any],
    force_new_record: bool = False,
    external_log: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """生成阿里月度告警分析并上传到目标多维表。"""
    require_config_values(
        config,
        ["feishu_app_id", "feishu_app_secret", "feishu_app_token", "ali_alarm_source_url", "ali_alarm_template_path"],
    )
    template_path = Path(str(config.get("ali_alarm_template_path", "")).strip()).expanduser()
    if not template_path.is_absolute():
        runtime_candidate = (RUNTIME_DIR / template_path).resolve()
        bundle_candidate = (BUNDLE_DIR / template_path).resolve()
        template_path = runtime_candidate if runtime_candidate.exists() else bundle_candidate
    if not template_path.exists():
        raise ValueError(f"告警分析模板不存在: {template_path}")

    download_folder = Path(config["download_folder"]).expanduser()
    download_folder.mkdir(parents=True, exist_ok=True)
    output_path = make_unique_path(download_folder, f"EA118机房{year}年{month_number}月告警分析表.xlsx")

    emit_log(f"开始生成月度告警分析: {year}年{month_number}月", "info", external_log)
    token = request_feishu_tenant_token(config, external_log)
    session = build_feishu_session(token)
    result = ali_alarm_report_generator.generate_alarm_report(
        template=template_path,
        month=f"{year}-{month_number:02d}",
        out=output_path,
        feishu_url=str(config.get("ali_alarm_source_url", "")).strip(),
        session=session,
        progress_log=external_log,
    )
    excluded_non_target_level_count = int(result.get("excluded_non_target_level_count") or 0)
    if excluded_non_target_level_count:
        emit_log(
            f"已排除非目标等级记录 {excluded_non_target_level_count} 条，仅纳入紧急/严重/重要/次要",
            "info",
            external_log,
        )
    emit_log(f"告警分析生成完成: {output_path.name}，纳入 {result['alarm_count']} 条告警", "success", external_log)

    table_config = get_table_config("告警分析报告")
    report_type_name = "南通机房告警分析"
    existing_records = find_report_records(
        config["feishu_app_token"],
        table_config,
        token,
        year,
        month_number,
        report_type_name,
        external_log,
    )
    if existing_records and not force_new_record:
        file_token = upload_bitable_file(config["feishu_app_token"], token, output_path, external_log)
        updated_records: list[dict[str, Any]] = []
        for existing_record in existing_records:
            target_record_id = str(existing_record.get("record_id") or existing_record.get("id") or "").strip()
            updated_record = update_report_record_attachment(
                config["feishu_app_token"],
                table_config,
                token,
                target_record_id,
                file_token,
                external_log,
            )
            updated_record_id = str(updated_record.get("record_id") or target_record_id).strip()
            updated_records.append(
                {
                    "table": table_config["name"],
                    "record_id": updated_record_id,
                    "file_token": file_token,
                    "record_url": build_bitable_record_url(config["feishu_app_token"], table_config, updated_record_id),
                    "file_count": 1,
                }
            )
        selected_updated_record = select_report_record_for_update(updated_records)
        updated_payload = {
            **selected_updated_record,
            "replaced_existing_count": len(updated_records),
        }
        notification: dict[str, Any]
        try:
            notification = send_bitable_record_link_feishu_message(
                year=year,
                month_number=month_number,
                report_type_name=report_type_name,
                records=updated_records,
                config=config,
                token=token,
                external_log=external_log,
            )
        except Exception as exc:
            emit_log(f"发送多维记录链接通知失败: {exc}", "warning", external_log)
            notification = {
                "sent": False,
                "channel": "feishu_private",
                "recipient": ALI_RECORD_NOTIFY_USER_NAME,
                "recipient_email": ALI_RECORD_NOTIFY_USER_EMAIL,
                "error": str(exc),
            }
        return {
            "action": "generated_and_updated",
            "files": [generated_file_payload(output_path)],
            "updated": updated_payload,
            "updated_records": updated_records,
            "notification": notification,
            "message": f"月度告警分析已生成并覆盖多维表已有记录: {output_path.name}",
        }

    file_token = upload_bitable_file(config["feishu_app_token"], token, output_path, external_log)
    record = create_report_record_with_attachment(
        config["feishu_app_token"],
        table_config,
        token,
        file_token,
        year,
        month_number,
        report_type_name,
        external_log,
    )
    record_id = str(record.get("record_id", "")).strip()
    record_url = build_bitable_record_url(config["feishu_app_token"], table_config, record_id)
    notification: dict[str, Any]
    try:
        notification = send_bitable_record_link_feishu_message(
            year=year,
            month_number=month_number,
            report_type_name=report_type_name,
            records=[{"record_id": record_id, "record_url": record_url, "file_count": 1}],
            config=config,
            token=token,
            external_log=external_log,
        )
    except Exception as exc:
        emit_log(f"发送多维记录链接通知失败: {exc}", "warning", external_log)
        notification = {
            "sent": False,
            "channel": "feishu_private",
            "recipient": ALI_RECORD_NOTIFY_USER_NAME,
            "recipient_email": ALI_RECORD_NOTIFY_USER_EMAIL,
            "error": str(exc),
        }
    return {
        "action": "generated_and_uploaded",
        "files": [generated_file_payload(output_path)],
        "uploaded": {
            "table": table_config["name"],
            "record_id": record_id,
            "file_token": file_token,
            "record_url": record_url,
        },
        "notification": notification,
        "message": f"月度告警分析已生成并上传: {output_path.name}",
    }


def generate_over_power_monthly_report(
    year: str,
    month_number: int,
    config: dict[str, Any],
    force_new_record: bool = False,
    external_log: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """从超功率多维表生成月度超功耗 Excel 并上传到目标表。"""
    require_config_values(
        config,
        ["feishu_app_id", "feishu_app_secret", "feishu_app_token", "ali_power_alert_config_path"],
    )
    power_config = load_power_alert_config(config)

    download_folder = Path(config["download_folder"]).expanduser()
    download_folder.mkdir(parents=True, exist_ok=True)
    official_filename = f"EA118机柜超功耗告警统计{month_number}月份.xlsx"
    output_path = make_unique_path(download_folder, official_filename)

    emit_log(f"开始生成月度超功耗: {year}年{month_number}月", "info", external_log)
    token = request_feishu_tenant_token(config, external_log)
    rows_by_kind: dict[str, list[dict[str, Any]]] = {}
    for kind in ("row_line", "line_head", "cabinet", "branch"):
        rows_by_kind[kind] = fetch_power_alert_records(
            power_config["base_token"],
            power_config["tables"][kind],
            token,
            external_log,
        )

    template_path_text = str(power_config.get("template_path", "")).strip()
    result = ali_over_power_report_generator.generate_over_power_report(
        rows_by_kind,
        year,
        month_number,
        output_path,
        data_center=power_config["data_center"],
        template_path=resolve_runtime_path(template_path_text) if template_path_text else None,
    )
    counts = result["counts"]
    emit_log(
        "超功耗生成完成: "
        f"机列 {counts['row_line']}，列头柜 {counts['line_head']}，"
        f"机柜 {counts['cabinet']}，支路 {counts['branch']}",
        "success",
        external_log,
    )

    table_config = get_table_config(AUTO_DOWNLOAD_TABLE_NAME)
    category_name = "机柜超功耗"
    existing_records = find_power_report_records(
        config["feishu_app_token"],
        table_config,
        token,
        year,
        month_number,
        category_name,
        external_log,
    )
    if existing_records and not force_new_record:
        file_token = upload_bitable_file(config["feishu_app_token"], token, output_path, external_log, upload_name=official_filename)
        updated_records: list[dict[str, Any]] = []
        for existing_record in existing_records:
            target_record_id = str(existing_record.get("record_id") or existing_record.get("id") or "").strip()
            updated_record = update_report_record_attachment(
                config["feishu_app_token"],
                table_config,
                token,
                target_record_id,
                file_token,
                external_log,
            )
            updated_record_id = str(updated_record.get("record_id") or target_record_id).strip()
            updated_records.append(
                {
                    "table": table_config["name"],
                    "record_id": updated_record_id,
                    "file_token": file_token,
                    "record_url": build_bitable_record_url(config["feishu_app_token"], table_config, updated_record_id),
                    "file_count": 1,
                }
            )
        selected_updated_record = select_report_record_for_update(updated_records)
        notification = try_send_report_record_notification(
            year,
            month_number,
            category_name,
            updated_records,
            config,
            token,
            external_log,
        )
        return {
            "action": "generated_over_power_updated",
            "files": [generated_file_payload(output_path, official_filename)],
            "updated": {**selected_updated_record, "replaced_existing_count": len(updated_records)},
            "updated_records": updated_records,
            "notification": notification,
            "counts": counts,
            "message": f"月度超功耗已生成并覆盖多维表已有记录: {official_filename}",
        }

    file_token = upload_bitable_file(config["feishu_app_token"], token, output_path, external_log, upload_name=official_filename)
    record = create_power_report_record_with_attachment(
        config["feishu_app_token"],
        table_config,
        token,
        file_token,
        year,
        month_number,
        category_name,
        external_log,
    )
    record_id = str(record.get("record_id", "")).strip()
    record_url = build_bitable_record_url(config["feishu_app_token"], table_config, record_id)
    notification = try_send_report_record_notification(
        year,
        month_number,
        category_name,
        [{"record_id": record_id, "record_url": record_url, "file_count": 1}],
        config,
        token,
        external_log,
    )
    return {
        "action": "generated_over_power_uploaded",
        "files": [generated_file_payload(output_path, official_filename)],
        "uploaded": {
            "table": table_config["name"],
            "record_id": record_id,
            "file_token": file_token,
            "record_url": record_url,
        },
        "notification": notification,
        "counts": counts,
        "message": f"月度超功耗已生成并上传: {official_filename}",
    }


def try_send_report_record_notification(
    year: str,
    month_number: int,
    report_type_name: str,
    records: list[dict[str, Any]],
    config: dict[str, Any],
    token: str,
    external_log: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """发送多维记录链接通知，失败时返回错误但不中断生成。"""
    try:
        return send_bitable_record_link_feishu_message(
            year=year,
            month_number=month_number,
            report_type_name=report_type_name,
            records=records,
            config=config,
            token=token,
            external_log=external_log,
        )
    except Exception as exc:
        emit_log(f"发送多维记录链接通知失败: {exc}", "warning", external_log)
        return {
            "sent": False,
            "channel": "feishu_private",
            "recipient": ALI_RECORD_NOTIFY_USER_NAME,
            "recipient_email": ALI_RECORD_NOTIFY_USER_EMAIL,
            "error": str(exc),
        }


def monthly_report_attachment_matches(report_type: str, file_name: str) -> bool:
    """判断资料管理多维表附件是否属于指定月报类别。"""
    normalized_name = str(file_name or "").strip()
    if Path(normalized_name).suffix.lower() not in ALLOWED_UPLOAD_EXTENSIONS:
        return False
    if report_type == "over_power":
        return ("超功耗" in normalized_name or "超功率" in normalized_name) and "TOP5" not in normalized_name.upper()
    if report_type == "high_power_top5":
        return "TOP5" in normalized_name.upper()
    if report_type in {"alarm_analysis", "staff_roster"}:
        return True
    raise ValueError("不支持的阿里月报类型")


def fetch_existing_monthly_report_files(
    report_type: str,
    year: str,
    month_number: int,
    config: dict[str, Any],
    external_log: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """对暂未接入本地生成器的月报类型，复用现有飞书附件获取流程。"""
    if report_type not in {"over_power", "high_power_top5", "staff_roster"}:
        raise ValueError("不支持的阿里月报类型")

    table_name = STAFF_REPORT_TABLE_NAME if report_type == "staff_roster" else AUTO_DOWNLOAD_TABLE_NAME

    def attachment_matches(file_name: str) -> bool:
        return monthly_report_attachment_matches(report_type, file_name)

    result = download_report_attachments(
        table_name,
        year,
        month_number,
        config=config,
        external_log=external_log,
        attachment_filter=attachment_matches,
    )
    file_paths: list[Path] = result["file_paths"]
    selected_paths = [path for path in file_paths if attachment_matches(path.name)]

    if not selected_paths:
        raise ValueError(f"未在下载附件中匹配到 {ALI_REPORT_TYPE_MAP[report_type]['name']} 文件")

    selected_names = {path.name for path in selected_paths}
    for path in file_paths:
        if path.name in selected_names:
            continue
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass

    emit_log(
        f"{ALI_REPORT_TYPE_MAP[report_type]['name']} 已自动获取 {len(selected_paths)} 个文件",
        "success",
        external_log,
    )
    return {
        "action": "downloaded_existing_attachment",
        "files": [generated_file_payload(path) for path in selected_paths],
        "downloaded": [item for item in result["downloaded"] if item.get("name") in selected_names],
        "errors": result["errors"],
        "message": f"{ALI_REPORT_TYPE_MAP[report_type]['name']} 已获取完成",
    }


def generate_ali_monthly_reports_without_top5(
    year: str,
    month_number: int,
    config: dict[str, Any],
    force_new_record: bool = False,
    external_log: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """一键生成除 TOP5 外的阿里月报。"""
    emit_log(f"开始一键生成三项月报（不含TOP5）: {year}年{month_number}月", "info", external_log)
    results: list[dict[str, Any]] = []
    files: list[dict[str, Any]] = []

    for current_type in ALI_REPORT_BATCH_WITHOUT_TOP5_TYPES:
        type_name = ALI_REPORT_TYPE_MAP[current_type]["name"]
        emit_log(f"开始生成批量子项: {type_name}", "info", external_log)
        try:
            result = generate_ali_monthly_report(
                current_type,
                year,
                month_number,
                config=config,
                force_new_record=force_new_record,
                external_log=external_log,
            )
        except Exception as exc:
            emit_log(f"批量子项生成失败: {type_name} - {exc}", "error", external_log)
            raise

        result_summary = dict(result)
        result_summary["report_type"] = current_type
        result_summary["report_name"] = type_name
        results.append(result_summary)

        for file_payload in result.get("files", []) or []:
            if isinstance(file_payload, Mapping):
                file_copy = dict(file_payload)
                file_copy.setdefault("category", type_name)
                files.append(file_copy)

    emit_log(f"三项月报（不含TOP5）生成完成: {year}年{month_number}月", "success", external_log)
    return {
        "action": "generated_batch_without_top5",
        "report_types": list(ALI_REPORT_BATCH_WITHOUT_TOP5_TYPES),
        "results": results,
        "files": files,
        "message": f"{year}年{month_number}月三项月报（不含TOP5）已生成完成",
    }


def generate_ali_monthly_report(
    report_type: str,
    year: str,
    month_number: int,
    config: dict[str, Any],
    force_new_record: bool = False,
    external_log: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """统一阿里月报生成入口。"""
    if report_type not in ALI_REPORT_TYPE_MAP:
        raise ValueError("不支持的阿里月报类型")

    if report_type == "batch_without_top5":
        return generate_ali_monthly_reports_without_top5(year, month_number, config, force_new_record, external_log)
    if report_type == "alarm_analysis":
        return generate_alarm_analysis_monthly_report(year, month_number, config, force_new_record, external_log)
    if report_type == "over_power":
        return generate_over_power_monthly_report(year, month_number, config, force_new_record, external_log)
    if report_type == "staff_roster":
        return generate_staff_roster_monthly_report(year, month_number, config, external_log)
    return fetch_existing_monthly_report_files(report_type, year, month_number, config, external_log)


def build_bundle_arcname(label: str, file_path: Path, month_number: int, used_names: set[str]) -> str:
    """生成压缩包内文件名，并避免重名覆盖。"""
    clean_name = sanitize_download_filename(
        build_email_attachment_filename(file_path, month_number),
        file_path.name,
    )
    stem = Path(clean_name).stem
    suffix = Path(clean_name).suffix or file_path.suffix or ".xlsx"
    candidate = f"{label}_{stem}{suffix}"
    index = 2
    while candidate in used_names:
        candidate = f"{label}_{stem}_{index}{suffix}"
        index += 1
    used_names.add(candidate)
    return candidate


def collect_result_file_paths(result: Mapping[str, Any]) -> list[Path]:
    """从已有月报结果结构中取出本地文件路径。"""
    file_paths: list[Path] = []
    for item in result.get("files", []) or []:
        path_text = str(item.get("path", "")).strip() if isinstance(item, Mapping) else ""
        if path_text:
            file_paths.append(Path(path_text))
    return file_paths


def build_monthly_bundle_zip(
    collected_files: list[tuple[str, Path]],
    download_folder: Path,
    year: str,
    month_number: int,
) -> Path:
    """原子生成严格四项、可发送到飞书的月报 ZIP。"""
    expected_categories = ["超功率", "TOP5", "告警分析", "人员变动"]
    actual_categories = [category for category, _path in collected_files]
    if actual_categories != expected_categories:
        raise ValueError(f"四项月报分类不完整，期望 {expected_categories}，实际 {actual_categories}")

    resolved_paths: set[str] = set()
    for category, file_path in collected_files:
        path = Path(file_path)
        if not path.exists() or path.suffix.lower() != ".xlsx" or path.stat().st_size <= 0:
            raise ValueError(f"{category}文件不是有效的非空 XLSX: {path.name}")
        if not zipfile.is_zipfile(path):
            raise ValueError(f"{category}文件不是有效的 XLSX 工作簿: {path.name}")
        resolved_paths.add(str(path.resolve()))
    if len(resolved_paths) != len(expected_categories):
        raise ValueError("四项月报存在重复文件，无法打包")

    download_folder.mkdir(parents=True, exist_ok=True)
    unique_suffix = uuid.uuid4().hex
    zip_path = download_folder / f"阿里月报{year}年{month_number}月四项资料_{unique_suffix}.zip"
    temp_zip_path = zip_path.with_suffix(".part")
    used_names: set[str] = set()
    try:
        with zipfile.ZipFile(temp_zip_path, "w", compression=zipfile.ZIP_STORED) as archive:
            for category, file_path in collected_files:
                archive.write(
                    file_path,
                    build_bundle_arcname(category, file_path, month_number, used_names),
                )
        with zipfile.ZipFile(temp_zip_path, "r") as archive:
            if len(archive.infolist()) != 4 or archive.testzip() is not None:
                raise ValueError("四项月报 ZIP 完整性校验失败")
        os.replace(temp_zip_path, zip_path)
        zip_size = zip_path.stat().st_size
        if zip_size <= 0 or zip_size > FEISHU_MESSAGE_FILE_MAX_BYTES:
            raise ValueError("四项月报 ZIP 为空或超过飞书 30MB 上传上限")
        return zip_path
    except Exception:
        temp_zip_path.unlink(missing_ok=True)
        zip_path.unlink(missing_ok=True)
        raise


def download_monthly_bundle_report_files(
    year: str,
    month_number: int,
    config: dict[str, Any],
    external_log: Callable[[str, str], None] | None = None,
) -> list[tuple[str, Path]]:
    """从资料管理多维表下载四类月报，每类严格返回一个文件。"""
    require_config_values(config, ["feishu_app_id", "feishu_app_secret", "feishu_app_token"])
    token = request_feishu_tenant_token(config, external_log)
    download_folder = Path(config["download_folder"]).expanduser()
    download_folder.mkdir(parents=True, exist_ok=True)
    staging_root = download_folder / ".ali-monthly-bundle" / f"{year}-{month_number:02d}-{uuid.uuid4().hex[:8]}"

    def cleanup_staging() -> None:
        shutil.rmtree(staging_root, ignore_errors=True)
        try:
            staging_root.parent.rmdir()
        except OSError:
            pass

    def combined_power_filter(file_name: str) -> bool:
        return monthly_report_attachment_matches("over_power", file_name) or monthly_report_attachment_matches(
            "high_power_top5",
            file_name,
        )

    source_specs: dict[str, tuple[str, Callable[[str], bool]]] = {
        "power": (AUTO_DOWNLOAD_TABLE_NAME, combined_power_filter),
        "alarm": (
            ALARM_REPORT_TABLE_NAME,
            lambda file_name: monthly_report_attachment_matches("alarm_analysis", file_name),
        ),
        "staff": (
            STAFF_REPORT_TABLE_NAME,
            lambda file_name: monthly_report_attachment_matches("staff_roster", file_name),
        ),
    }

    def download_source(source_key: str, table_name: str, attachment_filter: Callable[[str], bool]) -> dict[str, Any]:
        destination_folder = staging_root / source_key
        destination_folder.mkdir(parents=True, exist_ok=True)
        return download_report_attachments(
            table_name,
            year,
            month_number,
            config=config,
            external_log=external_log,
            attachment_filter=attachment_filter,
            tenant_token=token,
            destination_folder=destination_folder,
        )

    source_results: dict[str, dict[str, Any]] = {}
    try:
        with ThreadPoolExecutor(max_workers=len(source_specs), thread_name_prefix="ali-monthly-bundle") as executor:
            futures = {
                source_key: executor.submit(download_source, source_key, table_name, attachment_filter)
                for source_key, (table_name, attachment_filter) in source_specs.items()
            }
            for source_key, future in futures.items():
                source_results[source_key] = future.result()
    except Exception:
        cleanup_staging()
        raise

    download_errors = [
        f"{source_key}: {'; '.join(str(error) for error in result.get('errors', []))}"
        for source_key, result in source_results.items()
        if result.get("errors")
    ]
    if download_errors:
        cleanup_staging()
        raise ValueError(f"四项月报附件下载不完整: {' | '.join(download_errors)}")

    def select_source_files() -> list[tuple[str, Path]]:
        power_paths = [Path(path) for path in source_results["power"].get("file_paths", [])]
        alarm_paths = [Path(path) for path in source_results["alarm"].get("file_paths", [])]
        staff_paths = [Path(path) for path in source_results["staff"].get("file_paths", [])]
        selected = [
            (
                "超功率",
                select_report_file(
                    [path for path in power_paths if monthly_report_attachment_matches("over_power", path.name)],
                    external_log,
                    require_unique_latest=True,
                ),
            ),
            (
                "TOP5",
                select_report_file(
                    [path for path in power_paths if monthly_report_attachment_matches("high_power_top5", path.name)],
                    external_log,
                    require_unique_latest=True,
                ),
            ),
            ("告警分析", select_report_file(alarm_paths, external_log, require_unique_latest=True)),
            ("人员变动", select_report_file(staff_paths, external_log, require_unique_latest=True)),
        ]
        expected_categories = ["超功率", "TOP5", "告警分析", "人员变动"]
        if [category for category, _path in selected] != expected_categories:
            raise ValueError("四项月报分类不完整，无法打包")
        missing_files = [str(path) for _category, path in selected if not path.exists()]
        if missing_files:
            raise ValueError(f"四项月报文件不存在，无法打包: {'; '.join(missing_files)}")
        resolved_paths = {str(path.resolve()) for _category, path in selected}
        if len(resolved_paths) != len(expected_categories):
            raise ValueError("四项月报存在重复文件，无法打包")
        return selected

    try:
        selected_files = select_source_files()
    except Exception:
        cleanup_staging()
        raise

    finalized_files: list[tuple[str, Path]] = []
    try:
        final_source_root = (
            download_folder
            / ".ali-monthly-bundle-files"
            / staging_root.name
        )
        for category, path in selected_files:
            category_folder = final_source_root / category
            category_folder.mkdir(parents=True, exist_ok=False)
            final_path = category_folder / path.name
            os.replace(path, final_path)
            finalized_files.append((category, final_path))
    except Exception:
        cleanup_staging()
        shutil.rmtree(final_source_root, ignore_errors=True)
        raise
    cleanup_staging()

    emit_log(
        f"四项月报已从资料管理多维表下载完成: {year}年{month_number}月（每类1个）",
        "success",
        external_log,
    )
    return finalized_files


def export_previous_month_report_bundle(
    config: dict[str, Any],
    external_log: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """下载/生成上月四项阿里月报并打包到下载目录。"""
    year, month_number, month_label = get_previous_year_month()
    download_folder = Path(config["download_folder"]).expanduser()
    download_folder.mkdir(parents=True, exist_ok=True)

    emit_log(f"开始打包导出上月月报: {year}年{month_label}", "info", external_log)
    collected_files = download_monthly_bundle_report_files(year, month_number, config, external_log)

    zip_path = build_monthly_bundle_zip(
        collected_files,
        download_folder,
        year,
        month_number,
    )

    emit_log(f"上月四项月报已打包: {zip_path.name}", "success", external_log)
    return {
        "year": year,
        "month": month_label,
        "zip_file": generated_file_payload(zip_path),
        "files": [generated_file_payload(path) | {"category": label} for label, path in collected_files],
        "folder": str(download_folder),
        "message": f"{year}年{month_label}四项月报已打包导出: {zip_path.name}",
    }


def send_previous_month_alarm_email(
    config: dict[str, Any],
    recipient: str,
    external_log: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """按旧路由兼容名称下载上月超功耗附件并发送邮件。"""
    year, month_number, month_label = get_previous_year_month()
    emit_log(f"开始发送上月超功耗邮件: {year}年{month_label}", "info", external_log)

    power_result = fetch_existing_monthly_report_files("over_power", year, month_number, config, external_log)
    power_file = select_alarm_report_file(collect_result_file_paths(power_result), external_log)

    temp_power_file = import_file_to_temp(power_file)
    subject = build_email_subject(year, month_number)
    recipient_text = send_report_email(
        temp_power_file,
        subject,
        recipient,
        year,
        month_number,
        config=config,
        external_log=external_log,
    )
    return {
        "year": year,
        "month": month_label,
        "recipient": recipient_text,
        "file": generated_file_payload(power_file),
        "message": f"{year}年{month_label}超功耗邮件已发送到：{recipient_text}",
    }


def handle_monthly_report_trigger(
    text_content: str,
    reference_time: datetime | None = None,
    source_chat_id: str | None = None,
    external_log: Callable[[str, str], None] | None = None,
) -> bool:
    """监听到月报生成后，自动下载上个月报表并发送到默认邮箱。"""
    normalized_text = str(text_content or "").strip()
    trigger_matched = MONTHLY_REPORT_TRIGGER_KEYWORD in normalized_text or (
        "\u6708\u62a5" in normalized_text and "\u751f\u6210" in normalized_text
    )
    if not trigger_matched:
        return False

    config = load_config()
    year, month_number, month_label = get_previous_year_month(reference_time)
    workflow_key = f"{AUTO_DOWNLOAD_TABLE_NAME}:{year}-{month_number:02d}"

    with auto_report_lock:
        if workflow_key in auto_report_running_keys:
            emit_log(f"自动流程已在处理中，跳过重复触发：{workflow_key}", "info", external_log)
            return False
        auto_report_running_keys.add(workflow_key)

    try:
        require_config_values(
            config,
            ["recipient", "feishu_app_id", "feishu_app_secret", "feishu_app_token", "qq_email", "auth_code"],
        )
        emit_log(
            f"检测到“{MONTHLY_REPORT_TRIGGER_KEYWORD}”消息，开始自动处理 {year}年{month_label}{AUTO_DOWNLOAD_TABLE_NAME}",
            "info",
            external_log,
        )
        download_result = download_report_attachments(
            AUTO_DOWNLOAD_TABLE_NAME,
            year,
            month_number,
            config=config,
            external_log=external_log,
        )
        report_file = select_alarm_report_file(download_result["file_paths"], external_log)
        temp_file = import_file_to_temp(report_file)
        subject = build_email_subject(year, month_number)
        recipient_text = send_report_email(
            temp_file,
            subject,
            str(config.get("recipient", "")).strip(),
            year,
            month_number,
            config=config,
            external_log=external_log,
        )
        emit_log(f"自动流程完成：{subject} 已发送到 {recipient_text}", "success", external_log)
        return True
    except Exception as exc:
        failure_message = f"自动报表任务失败：{year}年{month_number}月处理失败，原因：{exc}"
        emit_log(failure_message, "error", external_log)
        try_send_feishu_feedback(source_chat_id, failure_message, config=config, external_log=external_log)
        raise
    finally:
        with auto_report_lock:
            auto_report_running_keys.discard(workflow_key)
        cleanup_runtime_cache(external_log=external_log)


@app.route("/")
def index() -> str:
    return render_template("index.html")


@app.route("/api/config", methods=["GET"])
def get_config():
    """返回前端所需配置，并掩码敏感字段。"""
    config = load_config()
    missing_feishu = get_missing_config_labels(config, ["feishu_app_id", "feishu_app_secret", "feishu_app_token"])
    missing_email = get_missing_config_labels(config, ["qq_email", "auth_code"])
    return jsonify(
        {
            "qq_email": config.get("qq_email", ""),
            "auth_code": mask_secret(config.get("auth_code", "")),
            "recipient": config.get("recipient", ""),
            "download_folder": config.get("download_folder", ""),
            "listener_target_chat_ids": config.get("listener_target_chat_ids", []),
            "feishu_app_id": config.get("feishu_app_id", ""),
            "feishu_app_secret": mask_secret(config.get("feishu_app_secret", "")),
            "feishu_app_token": mask_secret(config.get("feishu_app_token", "")),
            "feishu_verification_token": mask_secret(config.get("feishu_verification_token", "")),
            "feishu_encrypt_key": mask_secret(config.get("feishu_encrypt_key", "")),
            "ali_alarm_source_url": config.get("ali_alarm_source_url", ""),
            "ali_staff_source_url": config.get("ali_staff_source_url", ""),
            "ali_alarm_template_path": config.get("ali_alarm_template_path", ""),
            "ali_power_alert_config_path": config.get("ali_power_alert_config_path", ""),
            "tables": BITABLE_CONFIGS,
            "ali_report_types": ALI_REPORT_TYPES,
            "missing_feishu_config": missing_feishu,
            "missing_email_config": missing_email,
        }
    )


@app.route("/api/config", methods=["POST"])
def update_config():
    """更新本地配置。"""
    try:
        data = request.get_json(silent=True) or {}
        config = load_config()
        updatable_keys = [
            "qq_email",
            "auth_code",
            "recipient",
            "download_folder",
            "feishu_app_id",
            "feishu_app_secret",
            "feishu_app_token",
            "feishu_verification_token",
            "feishu_encrypt_key",
            "ali_alarm_source_url",
            "ali_staff_source_url",
            "ali_alarm_template_path",
            "ali_power_alert_config_path",
        ]
        if "listener_target_chat_ids" in data:
            config["listener_target_chat_ids"] = normalize_chat_ids(data.get("listener_target_chat_ids"))
        for key in updatable_keys:
            if key not in data:
                continue
            value = str(data.get(key, "")).strip()
            if value and value != MASKED_VALUE:
                config[key] = value
            elif value == "":
                config[key] = ""

        save_config(config)
        add_log("配置已更新", "success")
        return jsonify({"status": "ok", "message": "配置已保存"})
    except Exception as exc:
        add_log(f"保存配置失败: {exc}", "error")
        return jsonify({"status": "error", "message": str(exc)})


@app.route("/api/logs")
def get_logs():
    """返回最近日志。"""
    return jsonify(log_cache[-50:])


@app.route("/api/upload", methods=["POST"])
def upload_file():
    """上传 Excel 文件到 temp 目录。"""
    save_path: Path | None = None
    try:
        if "file" not in request.files:
            return jsonify({"status": "error", "message": "没有文件"})

        uploaded_file = request.files["file"]
        if not uploaded_file.filename:
            return jsonify({"status": "error", "message": "没有选择文件"})

        safe_filename = sanitize_uploaded_filename(uploaded_file.filename)
        save_path = (TEMP_DIR / safe_filename).resolve()
        if not is_path_within_safe(save_path, TEMP_DIR):
            raise ValueError("文件路径无效")

        uploaded_file.save(save_path)
        add_log(f"文件已上传: {uploaded_file.filename}", "success")
        return jsonify({"status": "ok", "file_path": str(save_path)})
    except Exception as exc:
        add_log(f"上传失败: {exc}", "error")
        return jsonify({"status": "error", "message": str(exc)})
    finally:
        if save_path is not None:
            cleanup_runtime_cache(preserve_paths=[save_path], external_log=add_log)


@app.route("/api/browse_file", methods=["POST"])
def browse_file():
    """打开本机文件选择对话框，默认定位到下载目录。"""
    temp_file: Path | None = None
    try:
        import tkinter as tk
        from tkinter import filedialog

        config = load_config()
        initial_dir = Path(config["download_folder"]).expanduser().resolve()
        initial_dir.mkdir(parents=True, exist_ok=True)

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        selected_file = filedialog.askopenfilename(
            title="选择 Excel 文件",
            initialdir=str(initial_dir),
            filetypes=[
                ("Excel 文件", "*.xlsx *.xls"),
                ("所有文件", "*.*"),
            ],
        )
        root.destroy()

        if not selected_file:
            return jsonify({"status": "cancelled", "message": "未选择文件"})

        source_path = Path(selected_file).expanduser().resolve()
        if source_path.suffix.lower() not in ALLOWED_UPLOAD_EXTENSIONS:
            raise ValueError("仅支持选择 Excel 文件（.xlsx/.xls）")

        temp_file = import_file_to_temp(source_path)
        add_log(f"已从下载目录选择文件: {source_path.name}", "success")
        return jsonify(
            {
                "status": "ok",
                "file_path": str(temp_file),
                "file_name": source_path.name,
                "source_folder": str(source_path.parent),
            }
        )
    except Exception as exc:
        add_log(f"浏览文件失败: {exc}", "error")
        return jsonify({"status": "error", "message": str(exc)})
    finally:
        if temp_file is not None:
            cleanup_runtime_cache(preserve_paths=[temp_file], external_log=add_log)


@app.route("/api/preview", methods=["POST"])
def preview_data():
    """预览 Excel 统计结果。"""
    file_path: Path | None = None
    try:
        data = request.get_json(silent=True) or {}
        file_path = ensure_temp_file(str(data.get("file_path", "")))
        year, month_number, month_label = parse_year_month(data)
        add_log(f"读取文件: {file_path.name}", "info")
        add_log(f"按 {year}年{month_label} 预览数据", "info")
        stats = preview_alarm_data(file_path, year, month_number)
        add_log("数据预览完成", "success")
        return jsonify({"status": "ok", "stats": stats})
    except Exception as exc:
        add_log(f"预览失败: {exc}", "error")
        return jsonify({"status": "error", "message": str(exc)})
    finally:
        if file_path is not None:
            cleanup_runtime_cache(preserve_paths=[file_path], external_log=add_log)


@app.route("/api/send_email", methods=["POST"])
def send_email():
    """生成图片并发送邮件。"""
    try:
        data = request.get_json(silent=True) or {}
        file_path = ensure_temp_file(str(data.get("file_path", "")))
        subject = str(data.get("subject", "")).strip()
        recipient = str(data.get("recipient", "")).strip()
        year, month_number, _month_label = parse_year_month(data)
        subject = subject or build_email_subject(year, month_number)
        config = load_config()
        recipient_text = send_report_email(
            file_path,
            subject,
            recipient,
            year,
            month_number,
            config=config,
        )
        return jsonify({"status": "ok", "message": f"邮件已成功发送到：{recipient_text}"})
        year, month_number, month_label = parse_year_month(data)
        month_display = f"{year}年{month_number}月"
        recipients = parse_recipients(recipient)

        config = load_config()
        require_config_values(config, ["qq_email", "auth_code"])
        sender_email = config["qq_email"]
        auth_code = config["auth_code"]

        add_log("开始发送邮件...", "info")
        add_log(f"按 {year}年{month_label} 读取 Excel 数据", "info")

        dataframes = load_alarm_data(file_path, year, month_number)
        counts = {
            "机列超215KW": len(dataframes["img_jilie"]),
            "列头柜超107.5KW": len(dataframes["img_liegui"]),
            "机柜超18KW": len(dataframes["img_jigui"]),
            "单支路超6.25KW": len(dataframes["img_zhilu"]),
        }
        max_power = compute_max_power(dataframes["img_jilie"])
        add_log(
            "数据统计: "
            f"机列{counts['机列超215KW']}, "
            f"列头柜{counts['列头柜超107.5KW']}, "
            f"机柜{counts['机柜超18KW']}, "
            f"支路{counts['单支路超6.25KW']}",
            "success",
        )

        add_log("生成表格图片...", "info")
        images: dict[str, bytes] = {}
        month_filter = build_month_filter(year, month_number)
        for sheet_config in SHEET_CONFIGS:
            image_id = sheet_config["image_id"]
            images[image_id] = sheet_config_to_image(file_path, sheet_config, month_filter, dataframes[image_id], add_log)

        html_body = build_email_body(month_display, max_power, counts)

        add_log("正在发送邮件...", "info")
        message = MIMEMultipart("related")
        message["From"] = sender_email
        message["To"] = ", ".join(recipients)
        message["Subject"] = subject
        message.attach(MIMEText(html_body, "html", "utf-8"))

        for image_id, image_data in images.items():
            image = MIMEImage(image_data)
            image.add_header("Content-ID", f"<{image_id}>")
            message.attach(image)

        logo_image = load_vnet_logo_image()
        if logo_image:
            logo = MIMEImage(logo_image)
            logo.add_header("Content-ID", f"<{VNET_LOGO_CID}>")
            logo.add_header("Content-Disposition", "inline", filename="vnet_logo.png")
            message.attach(logo)

        with file_path.open("rb") as handle:
            attachment = MIMEBase("application", "vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            attachment.set_payload(handle.read())
            encoders.encode_base64(attachment)
            attachment_filename = build_email_attachment_filename(file_path, month_number)
            attachment.add_header("Content-Disposition", "attachment", filename=attachment_filename)
            attachment.add_header(
                "Content-Type",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
            message.attach(attachment)

        with smtplib.SMTP_SSL("smtp.qq.com", 465) as server:
            server.login(sender_email, auth_code)
            server.send_message(message, to_addrs=recipients)

        recipient_text = ", ".join(recipients)
        add_log(f"邮件发送成功 -> {recipient_text}", "success")
        return jsonify({"status": "ok", "message": f"邮件已成功发送到：{recipient_text}"})
    except Exception as exc:
        add_log(f"发送失败: {exc}", "error")
        add_log(traceback.format_exc(), "error")
        return jsonify({"status": "error", "message": str(exc)})
    finally:
        cleanup_runtime_cache(external_log=add_log)


@app.route("/api/feishu/download", methods=["POST"])
def feishu_download():
    """从飞书多维表格下载指定月份附件。"""
    try:
        data = request.get_json(silent=True) or {}
        table_name = str(data.get("table_name", "")).strip()
        year, month_number, _month_label = parse_year_month(data)
        config = load_config()
        result = download_report_attachments(
            table_name,
            year,
            month_number,
            config=config,
        )
        return jsonify(
            {
                "status": "ok",
                "downloaded": result["downloaded"],
                "errors": result["errors"],
                "folder": result["folder"],
            }
        )
        year, month_number, month_label = parse_year_month(data)
        config = load_config()
        require_config_values(config, ["feishu_app_id", "feishu_app_secret", "feishu_app_token"])

        selected_config = next((item for item in BITABLE_CONFIGS if item["name"] == table_name), None)
        if not selected_config:
            return jsonify({"status": "error", "message": "未找到表格配置"})

        add_log(f"从【{table_name}】下载 {year}年{month_label} 的附件...", "info")
        add_log("获取飞书访问令牌...", "info")

        token_response = requests.post(
            "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
            headers={"Content-Type": "application/json"},
            json={"app_id": config["feishu_app_id"], "app_secret": config["feishu_app_secret"]},
            timeout=30,
        )
        token_response.raise_for_status()
        token_result = token_response.json()
        if token_result.get("code") != 0:
            raise ValueError(f"获取 token 失败: {token_result.get('msg')}")

        token = token_result["tenant_access_token"]
        add_log("令牌获取成功", "success")

        records_url = (
            f"https://open.feishu.cn/open-apis/bitable/v1/apps/{config['feishu_app_token']}"
            f"/tables/{selected_config['table_id']}/records"
        )
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        params = {"view_id": selected_config["view_id"], "page_size": 500}

        all_records: list[dict[str, Any]] = []
        has_more = True
        page_token = None

        add_log("读取表格记录...", "info")
        while has_more:
            if page_token:
                params["page_token"] = page_token
            response = requests.get(records_url, headers=headers, params=params, timeout=30)
            response.raise_for_status()
            result = response.json()
            if result.get("code") != 0:
                raise ValueError(f"获取记录失败: {result.get('msg')}")

            data_page = result.get("data", {})
            all_records.extend(data_page.get("items", []))
            has_more = data_page.get("has_more", False)
            page_token = data_page.get("page_token")

        add_log(f"共获取 {len(all_records)} 条记录", "success")

        month_num = f"{month_number:02d}"
        filtered_records = []
        for record in all_records:
            fields = record.get("fields", {})
            record_month = str(fields.get("月份", ""))
            record_year = str(fields.get("年度", ""))
            month_matches = record_month in {month_num, str(month_number)}
            year_matches = year in record_year or record_year in {"", "None"}
            if month_matches and year_matches:
                filtered_records.append(record)

        add_log(f"筛选出 {len(filtered_records)} 条 {year}年{month_label} 的记录", "success")
        if not filtered_records:
            return jsonify({"status": "error", "message": f"没有找到 {year}年{month_label} 的记录"})

        download_folder = Path(config["download_folder"]).expanduser()
        download_folder.mkdir(parents=True, exist_ok=True)

        downloaded: list[dict[str, str]] = []
        errors: list[str] = []

        for record_index, record in enumerate(filtered_records, start=1):
            fields = record.get("fields", {})
            for field_value in fields.values():
                if not isinstance(field_value, list) or not field_value:
                    continue
                if not isinstance(field_value[0], dict) or "file_token" not in field_value[0]:
                    continue

                for attachment in field_value:
                    file_name = sanitize_download_filename(
                        attachment.get("name", ""),
                        fallback_name=f"attachment_{record_index}",
                    )
                    file_url = attachment.get("url")
                    if not file_url:
                        errors.append(f"{file_name}: 无下载 URL")
                        add_log(f"[ERROR] {file_name} 无下载 URL", "error")
                        continue

                    save_path = make_unique_path(download_folder, file_name)
                    try:
                        add_log(f"下载: {save_path.name}", "info")
                        response = requests.get(
                            file_url,
                            headers={"Authorization": f"Bearer {token}"},
                            stream=True,
                            timeout=30,
                        )
                        if response.status_code != 200:
                            error_message = f"HTTP {response.status_code}"
                            try:
                                detail = response.json().get("msg", "")
                                if detail:
                                    error_message += f" - {detail}"
                            except Exception:
                                pass
                            raise ValueError(error_message)

                        with save_path.open("wb") as handle:
                            for chunk in response.iter_content(chunk_size=8192):
                                if chunk:
                                    handle.write(chunk)

                        size_kb = save_path.stat().st_size / 1024
                        add_log(f"已保存: {save_path.name} ({size_kb:.1f}KB)", "success")
                        downloaded.append({"name": save_path.name, "size": f"{size_kb:.1f}KB"})
                    except Exception as exc:
                        errors.append(f"{save_path.name}: {exc}")
                        add_log(f"[ERROR] {save_path.name}: {exc}", "error")

        add_log(f"下载完成！成功 {len(downloaded)} 个, 失败 {len(errors)} 个", "success")
        return jsonify(
            {
                "status": "ok",
                "downloaded": downloaded,
                "errors": errors,
                "folder": str(download_folder),
            }
        )
    except Exception as exc:
        add_log(f"下载失败: {exc}", "error")
        add_log(traceback.format_exc(), "error")
        return jsonify({"status": "error", "message": str(exc)})
    finally:
        cleanup_runtime_cache(external_log=add_log)


@app.route("/api/ali_report/generate", methods=["POST"])
def ali_report_generate():
    """生成或自动获取指定类型的阿里月报。"""
    try:
        data = request.get_json(silent=True) or {}
        report_type = str(data.get("report_type", "")).strip()
        force_new_record = bool(data.get("force_new_record", False))
        year, month_number, _month_label = parse_year_month(data)
        config = load_config()
        result = generate_ali_monthly_report(
            report_type,
            year,
            month_number,
            config=config,
            force_new_record=force_new_record,
        )
        return jsonify({"status": "ok", "report_type": report_type, **result})
    except Exception as exc:
        add_log(f"阿里月报生成失败: {exc}", "error")
        add_log(traceback.format_exc(), "error")
        return jsonify({"status": "error", "message": str(exc)})
    finally:
        cleanup_runtime_cache(external_log=add_log)


@app.route("/api/ali_report/export_previous_bundle", methods=["POST"])
def ali_report_export_previous_bundle():
    """打包导出上月四项阿里月报到本地下载目录。"""
    try:
        config = load_config()
        result = export_previous_month_report_bundle(config, external_log=add_log)
        return jsonify({"status": "ok", **result})
    except Exception as exc:
        add_log(f"上月月报打包导出失败: {exc}", "error")
        add_log(traceback.format_exc(), "error")
        return jsonify({"status": "error", "message": str(exc)})
    finally:
        cleanup_runtime_cache(external_log=add_log)


@app.route("/api/ali_report/send_previous_alarm_email", methods=["POST"])
def ali_report_send_previous_alarm_email():
    """通过兼容路由下载上月超功耗附件并发送邮件。"""
    try:
        data = request.get_json(silent=True) or {}
        config = load_config()
        recipient = str(data.get("recipient") or config.get("recipient", "")).strip()
        result = send_previous_month_alarm_email(config, recipient, external_log=add_log)
        return jsonify({"status": "ok", **result})
    except Exception as exc:
        add_log(f"上月超功耗邮件发送失败: {exc}", "error")
        add_log(traceback.format_exc(), "error")
        return jsonify({"status": "error", "message": str(exc)})
    finally:
        cleanup_runtime_cache(external_log=add_log)


@app.route("/api/open_folder")
def open_folder():
    """打开下载目录。"""
    try:
        config = load_config()
        folder = Path(config["download_folder"]).expanduser().resolve()
        folder.mkdir(parents=True, exist_ok=True)

        try:
            subprocess.Popen(["explorer", str(folder)])
        except Exception:
            os.startfile(str(folder))  # type: ignore[attr-defined]

        add_log(f"已打开下载目录: {folder}", "success")
        return jsonify({"status": "ok", "folder": str(folder)})
    except Exception as exc:
        return jsonify({"status": "error", "message": str(exc)})


def resolve_generated_download_file(file_name: Any, config: Mapping[str, Any]) -> Path:
    """Return an existing generated file that is contained in the download folder."""
    raw_name = str(file_name or "").strip()
    if not raw_name or raw_name in {".", ".."} or "/" in raw_name or "\\" in raw_name:
        raise ValueError("文件名无效")

    download_folder = Path(config["download_folder"]).expanduser().resolve()
    file_path = (download_folder / raw_name).resolve()
    if not is_path_within_safe(file_path, download_folder):
        raise ValueError("文件必须位于下载目录内")
    if not file_path.is_file():
        raise FileNotFoundError("生成文件不存在或已被移动")
    return file_path


def local_file_action_response(action: str):
    try:
        data = request.get_json(silent=True) or {}
        file_path = resolve_generated_download_file(data.get("file_name"), load_config())
        if file_path.suffix.lower() not in {".xlsx", ".zip"}:
            raise ValueError("仅支持打开或定位 XLSX、ZIP 文件")

        if action == "open":
            os.startfile(str(file_path))  # type: ignore[attr-defined]
            message = f"已提交系统打开请求: {file_path.name}"
        elif action == "reveal":
            subprocess.Popen(["explorer", f"/select,{file_path}"])
            message = f"已提交资源管理器定位请求: {file_path.name}"
        else:
            raise ValueError("不支持的文件操作")

        add_log(message, "success")
        return jsonify({"status": "ok", "message": message, "file_name": file_path.name})
    except ValueError as exc:
        return jsonify({"status": "error", "message": str(exc)}), 400
    except FileNotFoundError as exc:
        return jsonify({"status": "error", "message": str(exc)}), 404
    except Exception as exc:
        add_log(f"本地文件操作失败: {exc}", "error")
        return jsonify({"status": "error", "message": str(exc)}), 500


@app.route("/api/local_file/open", methods=["POST"])
def open_generated_download_file():
    """Submit a generated download to its system default application."""
    return local_file_action_response("open")


@app.route("/api/local_file/reveal", methods=["POST"])
def reveal_generated_download_file():
    """Submit a request to select a generated download in Windows Explorer."""
    return local_file_action_response("reveal")


if __name__ == "__main__":
    print("=" * 50)
    print("  阿里月度报告邮件自动化同步 - Web版本")
    print(f"  访问地址: http://{APP_HOST}:{APP_PORT}")
    print("=" * 50)
    app.run(host=APP_HOST, port=APP_PORT, debug=False)
