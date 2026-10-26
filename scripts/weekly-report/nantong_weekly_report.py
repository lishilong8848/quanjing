#!/usr/bin/env python3
"""Generate Nantong operations weekly reports from Feishu Base data."""

from __future__ import annotations

import argparse
import calendar
import contextlib
import functools
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qs, urlparse

from env_loader import load_local_env_file


PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = PROJECT_ROOT / "config" / "nantong_weekly_report.json"
RUNTIME_LOG_DIR = PROJECT_ROOT / "runtime_logs"
SCHEDULER_STATE_FILE = RUNTIME_LOG_DIR / "nantong_weekly_report_scheduler.json"
SCHEDULER_LOG_FILE = RUNTIME_LOG_DIR / "nantong_weekly_report_scheduler.log"
MANUAL_LOG_FILE = RUNTIME_LOG_DIR / "nantong_weekly_report_manual.log"
LARK_CLI_BIN_DEFAULT = "lark-cli.cmd"

BASE_TOKEN = "Ku17b5rmgaULYJsioBpcHl0Xnqd"
TEMPLATE_DOC_URL = "https://example.feishu.cn/docx/PUBLIC_EXAMPLE_SOURCE"
WEEKLY_TABLE_ID = "tbl96c6dccf01af4"
WEEKLY_ALI_TODOS_FIELD = "阿里会议待办"
WEEKLY_INTERNAL_TODOS_FIELD = "上周周会待办"
MEETING_TABLE_ID = "tbl90ecbefe10c0b"
MEETING_LINK_FIELD = "\u5999\u8bb0\u94fe\u63a5"
MEETING_TODOS_FIELD = "\u4ee3\u529e\u4e8b\u9879"
MEETING_CREATED_FIELD = "\u521b\u5efa\u65f6\u95f4"
MEETING_LATEST_FIELD = "\u6700\u65b0\u6253\u6807"
MEETING_LINK_FIELD_ID = "fldAExyseG"
MEETING_TODOS_FIELD_ID = "fldvvOFEdU"
MEETING_CREATED_FIELD_ID = "fldk3Kd0JK"
MEETING_LATEST_FIELD_ID = "fldzm4P9RZ"
ALI_TODOS_ATTACHMENT_FIELD = "阿里待办Excel"
ALI_TODOS_ATTACHMENT_LEGACY_FIELD = "阿里待办截图"
ALI_TODOS_TEXT_FIELD = "阿里待办事项"
ALI_TODOS_ATTACHMENT_FIELD_ID = "fldhVs5z28"
ALI_TODOS_TEXT_FIELD_ID = "fldMKNUOO7"
CHANGE_TABLE_ID = "tbl5c504ae9decf2"
EVENT_TABLE_ID = "tbl39af909364aab"
ALI_DRILL_TABLE_ID = "tbl980395d192b05"
ALI_WEEKLY_DRILL_TABLE_ID = "tblbca17d39cb1e0"
PLANNED_DRILL_TABLE_ID = "tblb4d3a541a8c1f"
MAINTENANCE_TABLE_ID = "tbldb6fdaed2fed6"
ABNORMAL_MAINTENANCE_TABLE_ID = "tbl034226e2335e0"
CABINET_CAPACITY_TABLE_ID = "tbl4b0b5dfb56a00"
CABINET_HANDOVER_TABLE_ID = "tbl3611fb223d397"
EOP_TABLE_ID = "tbl622568f8db661"
PURCHASE_SUMMARY_TABLE_ID = "tbl93282b19ab82b"

BUILDINGS = ("A楼", "B楼", "C楼", "D楼", "E楼", "110站")
PROFESSIONS = ("电气", "暖通", "弱电", "消防", "EHS&消防")
CHANGE_DATE_FIELDS = ("实际开始时间", "计划延迟开始日期", "计划开始日期（阿里）")

DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": True,
    "schedule_at": "08:30",
    "schedule_weekday": 3,
    "timezone": "Asia/Shanghai",
    "poll_seconds": 60,
    "catch_up": False,
    "precreate_next_month": True,
    "precreate_at": "02:00",
    "max_pages": 10,
    "doc_identity": "bot",
    "base_identity": "bot",
    "notes_identity": "user",
    "message_identity": "bot",
    "chat_id": "oc_c79f407063dc9ca9f70cc76cb4059895",
    "template_doc_url": TEMPLATE_DOC_URL,
    "base_token": BASE_TOKEN,
    "report_parent_position": "my_library",
    "report_parent_token": "",
    "weekly_archive_view_id": "vewDqqJuM7",
    "meeting_view_id": "vewxl80poW",
    "abnormal_maintenance_view_id": "vew83NsZof",
    "ali_weekly_drills_view_id": "vewsNYKZET",
    "drill_source_base_token": "IrIibPkUOa6udGsMhu2cbOqhnWg",
    "drill_source_table_id": "tbl3c13aafddd198",
    "drill_source_view_id": "vew0UNl8ZR",
    "previous_report_seed_doc_url": "",
    "previous_report_seed_period": "",
    "professional_seed_doc_url": "",
    "tables": {
        "weekly": WEEKLY_TABLE_ID,
        "meeting": MEETING_TABLE_ID,
        "changes": CHANGE_TABLE_ID,
        "events": EVENT_TABLE_ID,
        "ali_drills": ALI_DRILL_TABLE_ID,
        "ali_weekly_drills": ALI_WEEKLY_DRILL_TABLE_ID,
        "planned_drills": PLANNED_DRILL_TABLE_ID,
        "maintenance": MAINTENANCE_TABLE_ID,
        "abnormal_maintenance": ABNORMAL_MAINTENANCE_TABLE_ID,
        "cabinet_capacity": CABINET_CAPACITY_TABLE_ID,
        "cabinet_handover": CABINET_HANDOVER_TABLE_ID,
        "eop": EOP_TABLE_ID,
        "purchase_summary": PURCHASE_SUMMARY_TABLE_ID,
    },
}


@dataclass(frozen=True)
class WeeklyPeriod:
    start: date
    end: date
    week_number: int

    @property
    def display_range(self) -> str:
        return f"{self.start.month}/{self.start.day}~{self.end.month}/{self.end.day}"

    @property
    def key(self) -> str:
        return f"{self.start.isoformat()}_{self.end.isoformat()}"


@dataclass(frozen=True)
class MeetingToken:
    kind: str
    token: str
    url: str = ""


@dataclass
class NantongWeeklyData:
    title: str
    start_date: str
    end_date: str
    week_number: int
    last_todos: list[str] = field(default_factory=list)
    meeting_todos: list[str] = field(default_factory=list)
    ali_meeting_todos: list[str] = field(default_factory=list)
    weekly_backlog: str = ""
    professional_line: str = ""
    professional_line_xml: str = ""
    professional_line_archive: str = ""
    professional_line_source: str = ""
    professional_line_error: str = ""
    operation_line: str = ""
    operation_line_xml: str = ""
    operation_line_archive: str = ""
    operation_line_source: str = ""
    operation_line_error: str = ""
    events: list[dict[str, Any]] = field(default_factory=list)
    changes: list[dict[str, Any]] = field(default_factory=list)
    drills: list[dict[str, Any]] = field(default_factory=list)
    maintenance: list[dict[str, Any]] = field(default_factory=list)
    abnormal_maintenance: list[dict[str, Any]] = field(default_factory=list)
    ali_weekly_drills: list[dict[str, Any]] = field(default_factory=list)
    cabinet_capacity: list[dict[str, Any]] = field(default_factory=list)
    cabinet_handover: list[dict[str, Any]] = field(default_factory=list)
    purchase_summary: list[dict[str, Any]] = field(default_factory=list)
    ali_drill_references: list[dict[str, Any]] = field(default_factory=list)
    eop_references: list[dict[str, Any]] = field(default_factory=list)
    previous_safety_backlog: dict[str, list[str]] = field(default_factory=dict)
    next_week_work: dict[str, list[str]] = field(default_factory=dict)
    sources: dict[str, Any] = field(default_factory=dict)


def read_config() -> dict[str, Any]:
    config = dict(DEFAULT_CONFIG)
    config["tables"] = dict(DEFAULT_CONFIG["tables"])
    if CONFIG_FILE.exists():
        try:
            payload = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"南通周报配置 JSON 无法解析：{CONFIG_FILE}: {exc}") from exc
        if isinstance(payload, dict):
            for key, value in payload.items():
                if key == "tables" and isinstance(value, dict):
                    tables = dict(config["tables"])
                    tables.update({str(k): str(v) for k, v in value.items()})
                    config["tables"] = tables
                elif key in DEFAULT_CONFIG:
                    config[key] = value
    config["schedule_at"] = normalize_time(str(config.get("schedule_at") or "08:30"), "08:30")
    config["schedule_weekday"] = int(config.get("schedule_weekday") or 3)
    config["poll_seconds"] = max(10, int(config.get("poll_seconds") or 60))
    config["max_pages"] = max(1, min(100, int(config.get("max_pages") or 10)))
    config["base_token"] = str(config.get("base_token") or BASE_TOKEN).strip()
    config["timezone"] = str(config.get("timezone") or "Asia/Shanghai").strip() or "Asia/Shanghai"
    return config


def write_config(payload: dict[str, Any]) -> dict[str, Any]:
    config = read_config()
    for key, value in payload.items():
        if key == "tables" and isinstance(value, dict):
            tables = dict(config["tables"])
            tables.update({str(k): str(v) for k, v in value.items()})
            config["tables"] = tables
        elif key in DEFAULT_CONFIG:
            config[key] = value
    config["schedule_at"] = normalize_time(str(config.get("schedule_at") or "08:30"), "08:30")
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = CONFIG_FILE.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp_path.replace(CONFIG_FILE)
    return read_config()


def normalize_time(value: str, fallback: str) -> str:
    match = re.fullmatch(r"\s*(\d{1,2}):(\d{1,2})\s*", value or "")
    if not match:
        return fallback
    hour = max(0, min(23, int(match.group(1))))
    minute = max(0, min(59, int(match.group(2))))
    return f"{hour:02d}:{minute:02d}"


def reference_date_for(reference: date | datetime | str | None = None) -> date:
    if reference is None:
        return datetime.now().astimezone().date()
    if isinstance(reference, datetime):
        return reference.date()
    if isinstance(reference, date):
        return reference
    return datetime.strptime(str(reference), "%Y-%m-%d").date()


def weekly_period_for(reference: date | datetime | str | None = None) -> WeeklyPeriod:
    ref_date = reference_date_for(reference)
    days_since_wednesday = (ref_date.weekday() - 2) % 7
    end = ref_date - timedelta(days=days_since_wednesday)
    start = end - timedelta(days=6)
    return WeeklyPeriod(start=start, end=end, week_number=end.isocalendar().week)


def weekly_period_from_dates(start: date | datetime | str, end: date | datetime | str) -> WeeklyPeriod:
    start_date = reference_date_for(start)
    end_date = reference_date_for(end)
    if start_date > end_date:
        raise ValueError("开始日期不能晚于结束日期")
    return WeeklyPeriod(start=start_date, end=end_date, week_number=end_date.isocalendar().week)


def last_period_end_date(state: dict[str, Any]) -> date | None:
    period_key = compact_text(state.get("last_success_period"))
    match = re.fullmatch(r"\d{4}-\d{2}-\d{2}_(\d{4}-\d{2}-\d{2})", period_key)
    if match:
        return reference_date_for(match.group(1))
    parsed = parse_any_date(state.get("last_success_at"))
    return parsed


def manual_period_for(
    reference: date | datetime | str | None = None,
    *,
    start_date: date | datetime | str | None = None,
    end_date: date | datetime | str | None = None,
    state: dict[str, Any] | None = None,
) -> WeeklyPeriod:
    end = reference_date_for(end_date or reference)
    if start_date:
        start = reference_date_for(start_date)
        if start > end:
            raise ValueError("开始日期不能晚于结束日期")
    else:
        start = last_period_end_date(state or {}) or weekly_period_for(end).start
        if start > end:
            start = end
    return WeeklyPeriod(start=start, end=end, week_number=end.isocalendar().week)


def format_report_title(period: WeeklyPeriod) -> str:
    return f"南通机房运维周报（{period.end.year % 100:02d}年度第{period.week_number}周 {period.display_range}）"


def escape_text(value: Any) -> str:
    return html.escape(str(value or "").strip(), quote=False).replace("\n", "<br/>")


def escape_attr(value: Any) -> str:
    return html.escape(str(value or "").strip(), quote=True)


def compact_text(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def split_items(value: Any) -> list[str]:
    text = compact_text(value)
    if not text:
        return []
    pieces = re.split(r"(?:\r?\n|[；;])+", text)
    result: list[str] = []
    for piece in pieces:
        cleaned = re.sub(r"^\s*(?:[-*•]|\d+[.、)]|[（(]?\d+[）)])\s*", "", piece).strip()
        if cleaned and cleaned not in result:
            result.append(cleaned)
    return result


def item_label(item: dict[str, Any], name_keys: Iterable[str]) -> str:
    for key in name_keys:
        value = compact_text(item.get(key))
        if value:
            return value
    return compact_text(item)


def format_rate(value: Any) -> str:
    text = compact_text(value)
    if not text or "%" in text:
        return text
    with contextlib.suppress(ValueError):
        number = float(text)
        if -1 <= number <= 1:
            return f"{number * 100:.0f}%"
    return text


def render_item_list(items: list[dict[str, Any]], *, kind: str) -> str:
    if not items:
        return "<p>本周无记录。</p>"
    rows: list[str] = []
    for item in items:
        if kind == "event":
            title = item_label(item, ("name", "事件名称"))
            suffix = " / ".join(
                part
                for part in [
                    compact_text(item.get("level")),
                    compact_text(item.get("professional")),
                    compact_text(item.get("status")),
                ]
                if part
            )
        elif kind == "change":
            title = item_label(item, ("name", "变更编码&描述"))
            suffix = " / ".join(
                part
                for part in [
                    compact_text(item.get("level")),
                    compact_text(item.get("professional")),
                    compact_text(item.get("progress")),
                ]
                if part
            )
        elif kind == "maintenance":
            title = item_label(item, ("name", "维护描述"))
            suffix = " / ".join(
                part
                for part in [
                    compact_text(item.get("completion_rate")),
                    compact_text(item.get("timely_rate")),
                    compact_text(item.get("date")),
                ]
                if part
            )
        elif kind == "cabinet":
            title = item_label(item, ("name", "楼栋", "building"))
            suffix = " / ".join(
                part
                for part in [
                    f"实际上电 {compact_text(item.get('powered'))}" if compact_text(item.get("powered")) else "",
                    f"本周上电 {compact_text(item.get('weekly_up'))}" if compact_text(item.get("weekly_up")) else "",
                    f"本周下电 {compact_text(item.get('weekly_down'))}" if compact_text(item.get("weekly_down")) else "",
                    f"上电率 {compact_text(item.get('power_rate'))}" if compact_text(item.get("power_rate")) else "",
                    compact_text(item.get("shift")),
                ]
                if part
            )
        elif kind == "eop":
            title = item_label(item, ("name", "演练场景", "编号"))
            suffix = " / ".join(
                part
                for part in [
                    compact_text(item.get("priority")),
                    compact_text(item.get("status")),
                ]
                if part
            )
        else:
            title = item_label(item, ("name", "演练描述", "演练场景"))
            suffix = " / ".join(
                part
                for part in [
                    compact_text(item.get("professional")),
                    compact_text(item.get("completion_rate")),
                ]
                if part
            )
        text = title if not suffix else f"{title}（{suffix}）"
        rows.append(f"<li>{escape_text(text)}</li>")
    return "<ul>" + "".join(rows) + "</ul>"


def render_checkbox_list(items: list[str], *, empty_text: str) -> str:
    if not items:
        return f"<p>{escape_text(empty_text)}</p>"
    return "".join(f'<checkbox done="false">{escape_text(item)}</checkbox>' for item in items)


def filter_by_building(items: list[dict[str, Any]], building: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    building_core = building.removesuffix("楼")
    for item in items:
        value = compact_text(item.get("building") or item.get("机楼") or item.get("变更楼栋") or item.get("楼栋"))
        normalized = value.replace("栋", "楼").replace("짜", "楼")
        if building in normalized or (building_core and re.search(rf"\b{re.escape(building_core)}\b", normalized)):
            result.append(item)
    return result


def parse_int_text(value: Any) -> int | None:
    text = compact_text(value).replace(",", "")
    if not text:
        return None
    match = re.search(r"-?\d+", text)
    return int(match.group(0)) if match else None


def format_percent_ratio(numerator: int, denominator: int) -> str:
    if denominator <= 0:
        return "暂无数据"
    value = numerator / denominator * 100
    text = f"{value:.1f}".rstrip("0").rstrip(".")
    return f"{text}%"


def unique_texts(values: Iterable[Any]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = compact_text(value)
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result


def limited_names(items: list[dict[str, Any]], keys: tuple[str, ...] = ("name",), limit: int = 4) -> str:
    names = unique_texts(item_label(item, keys) for item in items)
    if not names:
        return ""
    shown = names[:limit]
    suffix = f"等{len(names)}项" if len(names) > limit else ""
    return "、".join(shown) + suffix


def value_or_dash(value: Any) -> str:
    text = compact_text(value)
    return text if text else "-"


def render_table(headers: list[str], rows: list[list[Any]], *, header_color: str = "light-gray") -> str:
    if not rows:
        return "<p>无</p>"
    header_xml = "".join(f'<th background-color="{escape_attr(header_color)}">{escape_text(header)}</th>' for header in headers)
    body_xml = "".join(
        "<tr>" + "".join(f"<td>{escape_text(value_or_dash(cell))}</td>" for cell in row) + "</tr>"
        for row in rows
    )
    return f"<table><thead><tr>{header_xml}</tr></thead><tbody>{body_xml}</tbody></table>"


def color_value(value: Any, color: str) -> str:
    return f'<span text-color="{escape_attr(color)}">{escape_text(value)}</span>'


def label_xml(label: str, color: str) -> str:
    return f'<b><span text-color="{escape_attr(color)}">{escape_text(label)}</span></b>'


def field_xml(label: str, value: Any, color: str) -> str:
    return f'<span text-color="{escape_attr(color)}">{escape_text(label)}：</span>{escape_text(value_or_dash(value))}'


def render_numbered_xml_items(items: list[str]) -> str:
    if not items:
        return "<p>无</p>"
    return "<ol>" + "".join(f'<li seq="auto">{item}</li>' for item in items) + "</ol>"


def emphasize_leading_text(item: str) -> str:
    text = compact_text(item)
    if not text:
        return ""
    match = re.match(r"^([^：:；;，,。]{2,18}[：:])(.+)$", text)
    if match:
        return f"<b>{escape_text(match.group(1))}</b>{escape_text(match.group(2).strip())}"
    if len(text) <= 18:
        return escape_text(text)
    sentence_match = re.match(r"^([^：:；;，,。]{4,18})([，,。；;].*)$", text)
    if sentence_match:
        return f"<b>{escape_text(sentence_match.group(1))}</b>{escape_text(sentence_match.group(2))}"
    return escape_text(text)


def render_summary_numbered_items(items: list[str]) -> str:
    return render_numbered_xml_items([emphasize_leading_text(item) for item in items])


def render_metric_card(title: str, value: Any, color: str) -> str:
    return (
        f'<callout background-color="light-{escape_attr(color)}" border-color="{escape_attr(color)}" text-color="{escape_attr(color)}">'
        f"<p><b>{escape_text(title)}</b></p>"
        f"<p>{color_value(value, color)}</p>"
        "</callout>"
    )


def render_metric_cards(stats: dict[str, Any]) -> str:
    maintenance_value = stats.get("maintenance_display") or f"{stats['maintenance']}项"
    drill_value = stats.get("drills_display") or f"{stats['drills']}项"
    cards = [
        ("事件", f"{stats['events']}条", "blue"),
        ("变更", f"{stats['changes']}项", "purple"),
        ("维护", maintenance_value, "green"),
        ("演练", drill_value, "orange"),
    ]
    columns = [
        f'<column width-ratio="0.25">{render_metric_card(title, value, color)}</column>'
        for title, value, color in cards
    ]
    return "<grid>" + "".join(columns) + "</grid>"


def render_plan_deviation_text(count: int) -> str:
    if count > 0:
        return f"与计划存在偏离，共{count}项"
    return "与计划无偏离"


def render_safety_section(events: list[dict[str, Any]], previous_backlog: list[str]) -> str:
    parts = ["<h5>1、上周遗留：</h5>"]
    if previous_backlog:
        parts.extend(f"<p>{index}）{escape_text(item)}</p>" for index, item in enumerate(previous_backlog, start=1))
    else:
        parts.append("<p>1）无</p>")
    parts.append("<h5>2、本周新增：</h5>")
    if not events:
        parts.append("<p>1）无</p>")
    else:
        parts.append(render_numbered_xml_items([render_event_item_xml(item) for item in events]))
    return "".join(parts)


def render_event_table(events: list[dict[str, Any]]) -> str:
    rows = [
        [
            event_time_text(item),
            item.get("building") or item.get("机楼"),
            item_label(item, ("name", "事件名称")),
            event_resolution_text(item),
            event_final_status_text(item),
        ]
        for item in events
    ]
    return render_table(["时间", "地点", "事件", "处置方式", "最终状态"], rows, header_color="light-red")


def event_time_text(item: dict[str, Any]) -> str:
    for key in ("date", "事件发生时间", "time"):
        text = format_date_text(item.get(key))
        if text:
            return text
    return ""


def event_resolution_text(item: dict[str, Any]) -> str:
    return compact_text(
        item.get("resolution")
        or item.get("事件解决措施")
        or item.get("引用维修里面的解决措施")
        or item.get("事件应急措施")
    )


def event_final_status_text(item: dict[str, Any]) -> str:
    return compact_text(
        item.get("final_status")
        or item.get("最终状态")
        or item.get("事件目前进展")
        or item.get("检修进度")
    )


def render_event_description(item: dict[str, Any]) -> str:
    title = item_label(item, ("name", "事件名称"))
    location = compact_text(item.get("building") or item.get("机楼"))
    subject = " / ".join(part for part in [event_time_text(item), location, title] if part)
    resolution = event_resolution_text(item) or "处置待补充"
    final_status = event_final_status_text(item) or "待核对"
    return f"【事件描述】 {subject}；处置：{resolution}；最终状态：{final_status}"


def render_event_item_xml(item: dict[str, Any]) -> str:
    title = item_label(item, ("name", "事件名称"))
    location = compact_text(item.get("building") or item.get("机楼"))
    subject = " / ".join(part for part in [event_time_text(item), location] if part)
    resolution = event_resolution_text(item) or "处置待补充"
    final_status = event_final_status_text(item) or "待核对"
    subject_xml = f"<b>{escape_text(subject)}</b> / " if subject else ""
    return f"{subject_xml}{escape_text(title)}；{field_xml('处置', resolution, 'orange')}；{field_xml('最终状态', final_status, 'green')}"


def render_change_template(changes: list[dict[str, Any]]) -> str:
    return (
        "<h5>1、变更：</h5>"
        f"<p>1）{escape_text(render_plan_deviation_text(change_deviation_count(changes)))}；</p>"
        "<p>2）重点变更项：</p>"
        + (render_numbered_xml_items([render_change_item_xml(item) for item in changes]) if changes else "<p>无。</p>")
    )


def change_deviation_count(changes: list[dict[str, Any]]) -> int:
    return sum(1 for item in changes if change_has_deviation(item))


def change_has_deviation(item: dict[str, Any]) -> bool:
    if compact_text(item.get("delayed_start")) or compact_text(item.get("delayed_end")):
        return True
    progress = compact_text(item.get("progress") or item.get("变更进度"))
    return any(keyword in progress for keyword in ("延期", "延迟"))


def render_change_item(item: dict[str, Any]) -> str:
    name = item_label(item, ("name", "变更编码&描述"))
    professional = value_or_dash(item.get("professional") or item.get("专业"))
    level = value_or_dash(item.get("level") or item.get("变更等级（阿里）"))
    progress = compact_text(item.get("progress") or item.get("变更进度")) or "进度待补充"
    time_text = change_time_text(item)
    suffix = " / ".join(part for part in [professional, level, progress, time_text] if part)
    return f"{name}（{suffix}）"


def change_time_text(item: dict[str, Any]) -> str:
    delayed = format_time_range(item.get("delayed_start"), item.get("delayed_end"))
    actual = format_time_range(item.get("actual_start"), item.get("actual_end"))
    if delayed:
        return f"延迟：{delayed}；实际：{actual or '未开始'}"
    planned = format_time_range(item.get("planned_start"), item.get("planned_end"))
    return f"计划：{planned}" if planned else ""


def render_change_item_xml(item: dict[str, Any]) -> str:
    name = item_label(item, ("name", "变更编码&描述"))
    professional = value_or_dash(item.get("professional") or item.get("专业"))
    level = value_or_dash(item.get("level") or item.get("变更等级（阿里）"))
    progress = compact_text(item.get("progress") or item.get("变更进度")) or "进度待补充"
    time_text = change_time_text(item)
    time_part = f"；{field_xml('时间', time_text, 'purple')}" if time_text else ""
    return (
        f"<b>{escape_text(name)}</b>；"
        f"{field_xml('专业', professional, 'blue')}；"
        f"{field_xml('等级', level, 'orange')}；"
        f"{field_xml('进度', progress, 'green')}"
        f"{time_part}"
    )


def maintenance_quantity_summary(maintenance: list[dict[str, Any]]) -> dict[str, int | str]:
    expected_values = [parse_int_text(item.get("expected")) for item in maintenance]
    actual_expected_values = [parse_int_text(item.get("actual_expected")) for item in maintenance]
    normal_finished_values = [parse_int_text(item.get("normal_finished")) for item in maintenance]

    expected = sum(value for value in expected_values if value is not None)
    actual_expected = sum(value for value in actual_expected_values if value is not None)
    normal_finished = sum(value for value in normal_finished_values if value is not None)

    if expected > 0:
        completion_rate = format_percent_ratio(actual_expected, expected)
        completion_text = f"已完成{actual_expected}/{expected}项，完成率{completion_rate}"
    else:
        rates = unique_texts(format_rate(item.get("completion_rate")) for item in maintenance)
        completion_rate = "、".join(rates) if rates else "暂无数据"
        completion_text = f"完成率{completion_rate}"

    if actual_expected > 0 and normal_finished > 0:
        timely_rate = format_percent_ratio(normal_finished, actual_expected)
        timely_text = f"按时完成{normal_finished}/{actual_expected}项，及时率{timely_rate}"
    else:
        timely_rates = unique_texts(format_rate(item.get("timely_rate")) for item in maintenance)
        timely_rate = "、".join(timely_rates) if timely_rates else "暂无数据"
        timely_text = f"完成及时率{timely_rate}"

    return {
        "expected": expected,
        "actual_expected": actual_expected,
        "normal_finished": normal_finished,
        "completion_rate": completion_rate,
        "timely_rate": timely_rate,
        "text": f"{completion_text}；{timely_text}。",
        "display": f"{actual_expected}/{expected}项" if expected > 0 else f"{len(maintenance)}项",
    }


def render_maintenance_template(maintenance: list[dict[str, Any]], abnormal_maintenance: list[dict[str, Any]] | None = None) -> str:
    summary = limited_names(maintenance, ("name", "维护描述"))
    key_text = summary or "无"
    rate_text = compact_text(maintenance_quantity_summary(maintenance).get("text")) if maintenance else "暂无完成率数据。"
    deviation_count = len(abnormal_maintenance or [])
    return (
        "<h5>2、维护：</h5>"
        f"<p>1）{escape_text(render_plan_deviation_text(deviation_count))}；</p>"
        f"<p>2）{field_xml('重点维护项', key_text, 'green')}；</p>"
        f"<p>3）<span text-color=\"green\">计划性维保：</span>{escape_text(rate_text)}</p>"
        + render_abnormal_maintenance_summary(abnormal_maintenance or [])
    )


def render_abnormal_maintenance_summary(items: list[dict[str, Any]]) -> str:
    if not items:
        return ""
    status_counts: dict[str, int] = {}
    for item in items:
        status = compact_text(item.get("status")) or "状态未填写"
        status_counts[status] = status_counts.get(status, 0) + 1
    status_text = "；".join(f"{status}{count}项" for status, count in status_counts.items())
    details: list[str] = []
    for item in items:
        building = compact_text(item.get("building"))
        name = compact_text(item.get("name")) or compact_text(item.get("project")) or "维护项未填写"
        meta = " / ".join(
            part
            for part in [
                compact_text(item.get("mode")),
                compact_text(item.get("professional")),
                compact_text(item.get("project")),
            ]
            if part
        )
        details.append(f"{building}{name}" + (f"（{meta}）" if meta else ""))
    detail_text = format_limited_texts(unique_texts(details), limit=4)
    return f"<p>4）<span text-color=\"red\">异常维护：</span>{escape_text(f'共{len(items)}项；{status_text}；{detail_text}。')}</p>"


def render_drill_progress_summary(drills: list[dict[str, Any]]) -> str:
    if not drills:
        return "<p>2）演练完成情况：本月无演练记录。</p>"
    quantity_summary = drill_quantity_summary(drills)
    names = unique_texts(name for item in drills for name in drill_scenario_names(item))
    parts: list[str] = []
    if quantity_summary["text"]:
        parts.append(str(quantity_summary["text"]))
    text = "，".join(parts)
    if names:
        scene_text = f"场景：{format_limited_texts(names)}"
        text = f"{text}；{scene_text}" if text else scene_text
    elif not text:
        text = "演练进度待补充"
    return f"<p>2）<span text-color=\"orange\">演练完成情况：</span>{escape_text(text)}。</p>"


def drill_scenario_names(item: dict[str, Any]) -> list[str]:
    raw_names: list[Any] = []
    scenarios = item.get("scenarios")
    if isinstance(scenarios, list):
        raw_names.extend(scenarios)
    else:
        raw_names.append(scenarios)
    raw_names.extend([item.get("scenario"), item.get("演练场景")])
    name = ""
    for key in ("name", "演练描述", "问题提炼（AI）"):
        name = compact_text(item.get(key))
        if name:
            break
    if name and not re.fullmatch(r"YL-\d+", name, flags=re.I):
        raw_names.append(name)
    return unique_texts(raw_names)


def format_limited_texts(names: list[str], *, limit: int = 4) -> str:
    if not names:
        return ""
    shown = names[:limit]
    suffix = f"等{len(names)}项" if len(names) > limit else ""
    return "、".join(shown) + suffix


def render_drill_template(drills: list[dict[str, Any]], *, source_drills: bool = False) -> str:
    if source_drills or any(item.get("source_drill") for item in drills):
        summary = drill_quantity_summary(drills or [{"source_drill": True}])
        current = sorted((item for item in drills if item.get("in_week")), key=lambda item: item.get("weekly_priority", 2))
        completed = sum(bool(item.get("completed")) for item in current)
        ongoing = sum(bool(item.get("started")) and not item.get("completed") for item in current)
        pending = sum(bool(item.get("pending_approval")) for item in current)
        conflicts = sum(bool(item.get("status_conflict")) for item in current)
        progress = f"进行中{ongoing}项，已完成{completed}项，其中待审批{pending}项"
        if conflicts:
            progress += f"；状态待核对{conflicts}项"
        scenes = unique_texts(
            f"{compact_text(item.get('scenario'))}—{source_drill_progress(item)}"
            for item in current if compact_text(item.get("scenario"))
        )
        scene_text = "；".join(scenes[:3]) or "本周暂无演练进展"
        if len(scenes) > 3:
            scene_text += f"等{len(scenes)}类场景"
        return (
            "<h5>3、演练：</h5>"
            f"<p><span text-color=\"orange\">完成情况：</span>{escape_text(summary['text'])}。</p>"
            f"<p><span text-color=\"orange\">本周进展：</span>{escape_text(progress)}。</p>"
            f"<p><span text-color=\"orange\">场景简述：</span>{escape_text(scene_text)}。</p>"
        )
    return (
        "<h5>3、演练：</h5>"
        "<p>1）与计划无偏离；</p>"
        + render_drill_progress_summary(drills)
    )


def drill_quantity_summary(drills: list[dict[str, Any]]) -> dict[str, int | str]:
    if any(item.get("source_drill") for item in drills):
        planned = [item for item in drills if item.get("in_month")]
        finished = sum(bool(item.get("completed")) for item in planned)
        expected = len(planned)
        rate = format_percent_ratio(finished, expected) if expected else ""
        return {
            "finished": finished, "expected": expected, "completion_rate": rate,
            "display": f"{finished}/{expected}项" if expected else "0项",
            "text": f"本月已完成{finished}/{expected}项，完成率{rate}" if expected else "本月暂无计划演练",
        }
    finished_values = [parse_int_text(item.get("finished")) for item in drills]
    expected_values = [parse_int_text(item.get("expected")) for item in drills]
    finished = sum(value for value in finished_values if value is not None)
    expected = sum(value for value in expected_values if value is not None)
    rates = unique_texts(format_rate(item.get("completion_rate")) for item in drills)

    if expected > 0:
        completion_rate = format_percent_ratio(finished, expected)
        return {
            "finished": finished,
            "expected": expected,
            "completion_rate": completion_rate,
            "display": f"{finished}/{expected}项",
            "text": f"已完成{finished}/{expected}项，完成率{completion_rate}",
        }
    if finished > 0:
        rate_text = f"，完成率{'、'.join(rates)}" if rates else ""
        return {
            "finished": finished,
            "expected": expected,
            "completion_rate": "、".join(rates),
            "display": f"{finished}项",
            "text": f"已完成{finished}项{rate_text}",
        }
    if rates:
        rate_text = "、".join(rates)
        return {
            "finished": finished,
            "expected": expected,
            "completion_rate": rate_text,
            "display": rate_text,
            "text": f"完成率{rate_text}",
        }
    return {
        "finished": finished,
        "expected": expected,
        "completion_rate": "",
        "display": f"{len(drills)}项",
        "text": "",
    }


def render_efficiency_section(
    changes: list[dict[str, Any]],
    maintenance: list[dict[str, Any]],
    abnormal_maintenance: list[dict[str, Any]],
    drills: list[dict[str, Any]],
    *,
    source_drills: bool = False,
) -> str:
    return render_change_template(changes) + render_maintenance_template(maintenance, abnormal_maintenance) + render_drill_template(drills, source_drills=source_drills)


def render_cabinet_usage_summary(items: list[dict[str, Any]]) -> str:
    if not items:
        return "本周无机柜上下电记录"

    weekly_up_values = [parse_int_text(item.get("weekly_up")) for item in items]
    weekly_down_values = [parse_int_text(item.get("weekly_down")) for item in items]
    weekly_up = max((value for value in weekly_up_values if value is not None), default=0)
    weekly_down = max((value for value in weekly_down_values if value is not None), default=0)

    def snapshot_key(item: dict[str, Any]) -> tuple[date, int]:
        parsed = parse_any_date(item.get("date")) or date.min
        has_summary = 1 if compact_text(item.get("power_rate")) or compact_text(item.get("total")) else 0
        return parsed, has_summary

    latest = max(items, key=snapshot_key)
    powered = parse_int_text(latest.get("powered"))
    total = parse_int_text(latest.get("total"))

    text_parts = [
        f"实际上电机柜数{powered}个" if powered is not None else "",
        f"机房总规划机柜数{total}个" if total is not None else "",
        f"本周上电机柜数{weekly_up}个",
        f"本周下电机柜数{weekly_down}个",
    ]
    text = "，".join(part for part in text_parts if part)
    if not text:
        text = "本周无机柜上下电记录"
    return text


def render_management_other_section(cabinet_items: list[dict[str, Any]], purchase_items: list[dict[str, Any]]) -> str:
    return (
        f"<p>1、{label_xml('机柜使用', 'blue')}：{escape_text(render_cabinet_usage_summary(cabinet_items))}。</p>"
        + f"<p>2、{label_xml('采购信息', 'purple')}：{escape_text(render_purchase_summary(purchase_items))}。</p>"
    )


def render_purchase_summary(items: list[dict[str, Any]]) -> str:
    details: list[str] = []
    for item in items:
        item_text = compact_text(item.get("items") or item.get("采购汇总") or item.get("name"))
        if item_text and item_text not in {"0", "无", "空"}:
            details.append(item_text)
    return "；".join(unique_texts(details)) or "无"


def render_next_week_work(items: list[str]) -> str:
    if not items:
        return "<p>无</p>"
    return render_numbered_items(items)


def render_weekly_overview(data: NantongWeeklyData, stats: dict[str, Any]) -> str:
    overview = render_metric_cards(stats)
    if data.sources.get('drill_source_enabled'):
        summary = drill_quantity_summary(data.drills or [{'source_drill': True}])
        pending = sum(bool(item.get('in_week') and item.get('pending_approval')) for item in data.drills)
        overview += f"<p>演练整体完成情况：{escape_text(summary['text'])}；本周已完成待审批{pending}项。</p>"
    return overview


def render_docx_xml(data: NantongWeeklyData) -> tuple[str, dict[str, Any]]:
    maintenance_summary = maintenance_quantity_summary(data.maintenance)
    drill_summary = drill_quantity_summary(data.drills)
    ali_meeting_todos = extract_ali_todos_from_text("\n".join(data.ali_meeting_todos))
    stats = {
        "events": len(data.events),
        "changes": len(data.changes),
        "drills": len(data.drills),
        "drills_display": drill_summary["display"],
        "drills_finished": drill_summary["finished"],
        "drills_expected": drill_summary["expected"],
        "drills_completion_rate": drill_summary["completion_rate"],
        "maintenance": len(data.maintenance),
        "maintenance_display": maintenance_summary["display"],
        "maintenance_expected": maintenance_summary["expected"],
        "maintenance_actual_expected": maintenance_summary["actual_expected"],
        "maintenance_completion_rate": maintenance_summary["completion_rate"],
        "abnormal_maintenance": len(data.abnormal_maintenance),
        "ali_weekly_drills": len(data.ali_weekly_drills),
        "cabinet_capacity": len(data.cabinet_capacity),
        "cabinet_handover": len(data.cabinet_handover),
        "purchase_summary": len(data.purchase_summary),
        "ali_drill_references": len(data.ali_drill_references),
        "eop_references": len(data.eop_references),
        "last_todos": len(data.last_todos),
        "meeting_todos": len(data.meeting_todos),
        "ali_meeting_todos": len(ali_meeting_todos),
    }
    parts: list[str] = [
        f"<title>{escape_text(data.title)}</title>",
        "<h1>南通运维周报</h1>",
        f"<p>报告周期：{escape_text(data.start_date)}—{escape_text(data.end_date)} · 第{data.week_number}周</p>",
        "<h1>一、本周待办</h1>",
        "<h2>1. 阿里周会待办</h2>",
        render_checkbox_list(ali_meeting_todos, empty_text="暂无阿里周会待办。"),
        "<h2>2. 上周内部周会待办</h2>",
        render_checkbox_list(data.meeting_todos, empty_text="暂无上周内部周会待办。"),
        "<hr/>",
        "<h1>二、本周周会内容</h1>",
        "<h2>整体概况</h2>",
        render_weekly_overview(data, stats),
        "<hr/>",
        "<h2>管理线：</h2>",
    ]
    for building in BUILDINGS:
        events = filter_by_building(data.events, building)
        changes = filter_by_building(data.changes, building)
        drills = filter_by_building(data.drills, building)
        maintenance = filter_by_building(data.maintenance, building)
        abnormal_maintenance = filter_by_building(data.abnormal_maintenance, building)
        cabinet_items = filter_by_building(data.cabinet_handover + data.cabinet_capacity, building)
        purchase_items = filter_by_building(data.purchase_summary, building)
        previous_backlog = data.previous_safety_backlog.get(building, [])
        next_week_items = data.next_week_work.get(building, [])
        parts.extend(
            [
                f"<h3>{building}:</h3>",
                "<h4>一、安全（风险、故障类）</h4>",
                render_safety_section(events, previous_backlog),
                "<h4>二、效率（变更、维护、演练）</h4>",
                render_efficiency_section(changes, maintenance, abnormal_maintenance, drills,
                                          source_drills=bool(data.sources.get("drill_source_enabled"))),
                "<h4>三、其他（客户响应效率涉及重点事项）</h4>",
                render_management_other_section(cabinet_items, purchase_items),
                "<h4>四、下周重点工作</h4>",
                render_next_week_work(next_week_items),
            ]
        )
    parts.extend(
        [
            render_unassigned_drills(data),
            "<hr/>",
            render_professional_section(data),
            "<hr/>",
            render_operation_section(data),
        ]
    )
    return "".join(parts), stats


def render_unassigned_drills(data: NantongWeeklyData) -> str:
    items = [item for item in data.drills if item.get('source_drill') and
             not any(filter_by_building([item], building) for building in BUILDINGS)]
    if not items:
        return ''
    scenes = format_limited_texts(unique_texts(item.get('scenario') for item in items))
    return f"<p>演练楼栋待核对：{len(items)}项{escape_text('（' + scenes + '）' if scenes else '')}。</p>"


def clean_todo_text(value: Any) -> str:
    text = html.unescape(compact_text(value))
    if not text:
        return ""
    text = re.sub(r"@\[[^\]]+\]", "", text)
    if re.fullmatch(r"\[[^\]]+\]\(https?://[^)]+\)", text) or re.fullmatch(r"https?://\S+", text):
        return ""
    assignees = unique_texts(re.findall(r'\buser-name="([^"]+)"', text, flags=re.I))
    text = re.sub(r"<cite\b[^>]*>.*?</cite>", "", text, flags=re.I | re.S)
    text = re.sub(r"\b(?:user-id|user-name|type)=\"[^\"]*\"", "", text)
    text = re.sub(r"<br\s*/?>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\[([^\]]+)\]\(https?://[^)]+\)", r"\1", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"（\s*待分配\s*）", "", text)
    text = re.sub(r"\(\s*待分配\s*\)", "", text)
    text = re.sub(r"\b待分配\b", "", text)
    text = text.strip(" -•：:，,。；;")
    if is_noise_todo_text(text):
        return ""
    if assignees and "待办人：" not in text:
        text = f"{text}（待办人：{'、'.join(assignees)}）"
    return text


def is_noise_todo_text(text: str) -> bool:
    normalized = compact_text(text)
    if not normalized:
        return True
    if normalized in {"文字记录", "全文记录", "会议记录", "会议纪要", "暂无", "无"}:
        return True
    if re.fullmatch(r"\[[^\]]+\]\(https?://[^)]+\)", normalized):
        return True
    if re.fullmatch(r"https?://\S+", normalized):
        return True
    return False


def normalize_todo_list(items: Iterable[Any]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for item in items:
        text = clean_todo_text(item)
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result


def clean_ali_todo_text(value: Any) -> str:
    text = html.unescape(str(value or "")).strip()
    text = re.sub(r"^\s*(?:[▲△▶►◆■●•*-]|\d+\s*[.、)）])\s*", "", text)
    text = re.sub(r"\s*[；;，,。]?\s*@.*$", "", text).strip()
    text = clean_todo_text(text)
    if normalize_markdown_line(text) in {"会议主要内容", "待办事项", "阿里待办事项", "待办内容"}:
        return ""
    return text


def extract_ali_todos_from_text(value: Any) -> list[str]:
    text = str(value or "")
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</(?:p|div|li)>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\s*[▲△▶►]\s*", "\n", text)
    return unique_texts(clean_ali_todo_text(line) for line in text.splitlines())


def xlsx_column_index(cell_reference: str) -> int:
    letters = re.match(r"[A-Za-z]+", str(cell_reference or ""))
    if not letters:
        return -1
    result = 0
    for char in letters.group(0).upper():
        result = result * 26 + ord(char) - ord("A") + 1
    return result - 1


def xlsx_cell_text(cell: ET.Element, shared_strings: list[str]) -> str:
    cell_type = str(cell.attrib.get("t") or "")
    texts = [node.text or "" for node in cell.findall(".//{*}t")]
    if texts:
        return "".join(texts)
    value_node = cell.find("{*}v")
    value = value_node.text if value_node is not None and value_node.text is not None else ""
    if cell_type == "s" and value.isdigit():
        index = int(value)
        return shared_strings[index] if 0 <= index < len(shared_strings) else ""
    return value


def extract_ali_todos_from_xlsx(path: Path) -> list[str]:
    try:
        with zipfile.ZipFile(path) as archive:
            shared_strings: list[str] = []
            if "xl/sharedStrings.xml" in archive.namelist():
                root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
                shared_strings = ["".join(node.text or "" for node in item.findall(".//{*}t")) for item in root.findall("{*}si")]
            worksheet_names = sorted(
                name
                for name in archive.namelist()
                if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name)
            )
            if not worksheet_names:
                raise ValueError("Excel 中没有可读取的工作表")
            header_aliases = {"待办事项", "阿里待办事项", "会议主要内容", "待办内容"}
            for worksheet_name in worksheet_names:
                root = ET.fromstring(archive.read(worksheet_name))
                rows: list[dict[int, str]] = []
                for row in root.findall(".//{*}sheetData/{*}row"):
                    values: dict[int, str] = {}
                    for cell in row.findall("{*}c"):
                        index = xlsx_column_index(str(cell.attrib.get("r") or ""))
                        if index >= 0:
                            values[index] = xlsx_cell_text(cell, shared_strings).strip()
                    rows.append(values)
                header_row = -1
                todo_column = -1
                for row_index, values in enumerate(rows[:20]):
                    for column_index, value in values.items():
                        if normalize_markdown_line(value) in header_aliases:
                            header_row = row_index
                            todo_column = column_index
                            break
                    if todo_column >= 0:
                        break
                if todo_column < 0:
                    continue
                todos: list[str] = []
                for values in rows[header_row + 1 :]:
                    todos.extend(extract_ali_todos_from_text(values.get(todo_column, "")))
                todos = unique_texts(todos)
                if todos:
                    return todos
    except (OSError, zipfile.BadZipFile, ET.ParseError) as exc:
        raise ValueError(f"阿里待办 Excel 无法读取：{exc}") from exc
    raise ValueError("阿里待办 Excel 未找到“待办事项”列或有效待办")


def download_bitable_attachment(attachment: dict[str, Any], output_path: Path, identity: str) -> Path:
    file_token = compact_text(attachment.get("file_token"))
    if not file_token:
        raise ValueError("阿里待办 Excel 附件缺少 file_token")
    params: dict[str, str] = {}
    attachment_url = compact_text(attachment.get("url"))
    if attachment_url:
        extra = parse_qs(urlparse(attachment_url).query).get("extra")
        if extra:
            params["extra"] = extra[0]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        *resolve_lark_cli_command(),
        "api",
        "GET",
        f"/open-apis/drive/v1/medias/{file_token}/download",
        "--as",
        identity,
        "--output",
        output_path.name,
    ]
    if params:
        command.extend(["--params", json.dumps(params, ensure_ascii=False)])
    completed = subprocess.run(
        command,
        cwd=output_path.parent,
        env=normalize_env_for_lark_cli(),
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=180,
        check=False,
    )
    if completed.returncode != 0:
        message = format_lark_cli_error(completed.stderr or completed.stdout)
        raise RuntimeError(f"阿里待办 Excel 下载失败：{message}")
    if not output_path.is_file() or output_path.stat().st_size <= 0:
        raise RuntimeError("阿里待办 Excel 下载失败：未生成有效文件")
    return output_path


def update_ali_meeting_todos(record_id_value: str, todos: list[str], config: dict[str, Any]) -> Any:
    if not record_id_value:
        raise ValueError("阿里待办回写失败：会议记录缺少 record_id")
    return run_lark_cli(
        [
            "base",
            "+record-upsert",
            "--base-token",
            str(config["base_token"]),
            "--table-id",
            str(config["tables"]["meeting"]),
            "--record-id",
            record_id_value,
            "--json",
            json.dumps({ALI_TODOS_TEXT_FIELD: "\n".join(todos)}, ensure_ascii=False),
            "--as",
            str(config.get("base_identity") or "bot"),
        ],
        timeout=180,
    )


def fetch_meeting_record_attachments(record_id_value: str, config: dict[str, Any]) -> list[dict[str, Any]]:
    if not record_id_value:
        return []
    payload = run_lark_cli(
        [
            "api",
            "GET",
            f"/open-apis/bitable/v1/apps/{config['base_token']}/tables/{config['tables']['meeting']}/records/{record_id_value}",
            "--as",
            str(config.get("base_identity") or "bot"),
        ],
        timeout=120,
    )
    record = ((payload.get("data") or {}).get("record") or {}) if isinstance(payload, dict) else {}
    fields = record.get("fields") if isinstance(record, dict) else {}
    fields = fields if isinstance(fields, dict) else {}
    raw_attachments = fields.get(ALI_TODOS_ATTACHMENT_FIELD)
    if raw_attachments is None:
        raw_attachments = fields.get(ALI_TODOS_ATTACHMENT_LEGACY_FIELD)
    return [item for item in raw_attachments if isinstance(item, dict)] if isinstance(raw_attachments, list) else []


def resolve_ali_meeting_todos(meeting_record: dict[str, Any], config: dict[str, Any]) -> list[str]:
    cached_todos = extract_ali_todos_from_text(meeting_record.get(ALI_TODOS_TEXT_FIELD))
    if cached_todos:
        return cached_todos
    raw_attachments = meeting_record.get("_ali_todo_attachments")
    attachments = [item for item in raw_attachments if isinstance(item, dict)] if isinstance(raw_attachments, list) else []
    if not attachments:
        return []
    xlsx_attachments = [item for item in attachments if compact_text(item.get("name")).lower().endswith(".xlsx")]
    if not xlsx_attachments:
        raise ValueError("阿里待办附件不是 Excel，请上传 .xlsx 文件")
    record_id_value = compact_text(meeting_record.get("_record_id"))
    if any(not compact_text(item.get("url")) for item in xlsx_attachments):
        raw_attachments = fetch_meeting_record_attachments(record_id_value, config)
        raw_by_token = {compact_text(item.get("file_token")): item for item in raw_attachments}
        xlsx_attachments = [raw_by_token.get(compact_text(item.get("file_token")), item) for item in xlsx_attachments]
    todos: list[str] = []
    with tempfile.TemporaryDirectory(prefix="nantong_ali_todos_") as temporary:
        for index, attachment in enumerate(xlsx_attachments, start=1):
            name = Path(compact_text(attachment.get("name")) or f"ali-todos-{index}.xlsx").name
            output_path = Path(temporary) / f"{index}-{name}"
            download_bitable_attachment(attachment, output_path, str(config.get("base_identity") or "bot"))
            todos.extend(extract_ali_todos_from_xlsx(output_path))
    todos = unique_texts(todos)
    if not todos:
        raise ValueError("阿里待办 Excel 中没有可用待办")
    update_ali_meeting_todos(record_id_value, todos, config)
    return todos


def extract_todos_from_meeting_field(value: Any) -> list[str]:
    text = html.unescape(str(value or ""))
    if not text.strip():
        return []
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</(?:p|div|li)>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    items: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if is_todo_section_stop_line(line):
            break
        line = re.sub(r"^\s*(?:[-*•]|\d+[.、)]|[（(]?\d+[）)])\s*", "", line).strip()
        if is_todo_section_stop_line(line):
            break
        if line:
            items.append(line)
    return normalize_todo_list(items)


def extract_url_from_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        match = re.search(r"https?://\S+", value)
        return match.group(0).rstrip(")>，,。；;") if match else ""
    if isinstance(value, dict):
        for key in ("url", "link", "href"):
            found = extract_url_from_cell(value.get(key))
            if found:
                return found
        for key in ("text", "value", "name", "title", "text_arr"):
            found = extract_url_from_cell(value.get(key))
            if found:
                return found
    if isinstance(value, list):
        for item in value:
            found = extract_url_from_cell(item)
            if found:
                return found
    return ""






def meeting_record_sort_key(fields: dict[str, str]) -> str:
    return format_datetime_text(fields.get(MEETING_CREATED_FIELD)) or format_date_text(fields.get(MEETING_CREATED_FIELD))


def latest_meeting_todos_for_period(period: WeeklyPeriod, config: dict[str, Any]) -> tuple[list[str], dict[str, str]]:
    table_id = compact_text((config.get("tables") or {}).get("meeting"))
    if not table_id:
        return [], {}
    records = list_base_records(
        base_token=str(config["base_token"]),
        table_id=table_id,
        field_ids=[
            MEETING_LINK_FIELD_ID,
            MEETING_TODOS_FIELD_ID,
            MEETING_CREATED_FIELD_ID,
            MEETING_LATEST_FIELD_ID,
            ALI_TODOS_ATTACHMENT_FIELD_ID,
            ALI_TODOS_TEXT_FIELD_ID,
        ],
        identity=str(config.get("base_identity") or "bot"),
        max_pages=max(1, int(config.get("max_pages") or 10)),
        view_id=str(config.get("meeting_view_id") or ""),
        filter_json=date_range_filter(MEETING_CREATED_FIELD_ID, period),
        sort_json=[{"field": MEETING_CREATED_FIELD_ID, "desc": True}],
    )
    candidates: list[tuple[str, dict[str, str], list[str]]] = []
    for record in records:
        fields = normalize_record(record)
        raw_fields = record_fields(record)
        fields["_meeting_link"] = extract_url_from_cell(raw_fields.get(MEETING_LINK_FIELD)) or fields.get(
            MEETING_LINK_FIELD, ""
        )
        fields["_record_id"] = record_id(record)
        raw_attachments = raw_fields.get(ALI_TODOS_ATTACHMENT_FIELD)
        if raw_attachments is None:
            raw_attachments = raw_fields.get(ALI_TODOS_ATTACHMENT_LEGACY_FIELD)
        fields["_ali_todo_attachments"] = raw_attachments if isinstance(raw_attachments, list) else []
        fields[ALI_TODOS_TEXT_FIELD] = stringify_cell(raw_fields.get(ALI_TODOS_TEXT_FIELD))
        if not record_in_period(fields, [MEETING_CREATED_FIELD], period):
            continue
        todos = extract_todos_from_meeting_field(fields.get(MEETING_TODOS_FIELD))
        candidates.append((meeting_record_sort_key(fields), fields, todos))
    if not candidates:
        return [], {}
    candidates.sort(key=lambda item: item[0], reverse=True)
    _, fields, todos = candidates[0]
    return todos, fields


def render_professional_section(data: NantongWeeklyData) -> str:
    source = data.professional_line_xml or data.professional_line
    grouped = extract_professional_items(source)
    parts = ['<h1><span text-color="purple">三、专业线</span></h1>']
    order = [('电气', '电气专业线'), ('暖通', '暖通专业线'),
             ('弱电', '弱电专业线'), ('EHS&消防', 'EHS & 消防专业线')]
    for offset in (0, 2):
        parts.append('<grid>')
        for key, title in order[offset:offset + 2]:
            items = grouped.get(key) or []
            parts.extend(['<column width-ratio="0.5">',
                f'<h2>{escape_text(title)}</h2>',
                render_summary_numbered_items(items) if items else '<p>待补充。</p>',
                '</column>'])
        parts.append('</grid>')
    if grouped.get('其他'):
        parts.append('<h2>其他专业事项</h2>')
        parts.append(render_summary_numbered_items(grouped['其他']))
    elif source and not grouped:
        parts.append(f'<p>{escape_text(source)}</p>')
    if data.professional_line_error:
        parts.append(f'<p>上一期专业线内容未读取成功：{escape_text(data.professional_line_error)}</p>')
    return ''.join(parts)


def render_operation_section(data: NantongWeeklyData) -> str:
    operation_items = extract_operation_items(data.operation_line_xml or data.operation_line)
    costs = [item for item in operation_items if '成本支出' in item]
    others = [item for item in operation_items if '成本支出' not in item]
    parts = ['<h1><span text-color="green">四、运营线</span></h1>', '<h2>成本支出</h2>',
             render_summary_numbered_items(costs) if costs else '<p>待补充。</p>']
    if operation_items:
        parts.append(render_summary_numbered_items(others))
    else:
        if data.operation_line_error:
            parts.append(f"<p>上一期运营线内容未读取成功，已先保留本周自动统计。原因：{escape_text(data.operation_line_error)}</p>")
        parts.append(f"<p>{escape_text(data.operation_line or '运营线补充内容待填写。')}</p>")
    return "".join(parts)


def render_ali_weekly_drill_section(items: list[dict[str, Any]]) -> str:
    if not items:
        return "<h3>中台-阿里演练本周情况</h3><p>本周无阿里演练明细记录。</p>"
    buildings = unique_texts(item.get("building") for item in items)
    grade_counts: dict[str, int] = {}
    for item in items:
        grade = compact_text(item.get("grade")) or "未评分"
        grade_counts[grade] = grade_counts.get(grade, 0) + 1
    coverage = "、".join(buildings) if buildings else "未标注楼栋"
    grade_text = "，".join(f"{grade}{count}项" for grade, count in grade_counts.items())
    summary = f"本周阿里演练共{len(items)}项，覆盖{coverage}；{grade_text}。"
    drill_items = [render_ali_weekly_drill_item_xml(item) for item in items[:10]]
    return (
        "<h3>中台-阿里演练本周情况</h3>"
        + f"<p><span text-color=\"orange\">本周阿里演练：</span>{escape_text(summary)}</p>"
        + render_numbered_xml_items(drill_items)
    )


def render_ali_weekly_drill_item(item: dict[str, Any]) -> str:
    parts = [
        compact_text(item.get("date")),
        compact_text(item.get("building")),
        compact_text(item.get("professional")),
    ]
    subject = " / ".join(part for part in parts if part)
    scenario = compact_text(item.get("scenario")) or "未记录"
    problem = compact_text(item.get("problem")) or "未记录"
    return f"{subject}；场景：{scenario}；问题：{problem}" if subject else f"场景：{scenario}；问题：{problem}"


def render_ali_weekly_drill_item_xml(item: dict[str, Any]) -> str:
    parts = [
        compact_text(item.get("date")),
        compact_text(item.get("building")),
        compact_text(item.get("professional")),
    ]
    subject = " / ".join(part for part in parts if part)
    scenario = compact_text(item.get("scenario")) or "未记录"
    problem = compact_text(item.get("problem")) or "未记录"
    subject_xml = f"<b>{escape_text(subject)}</b>；" if subject else ""
    return (
        f"{subject_xml}"
        f"{field_xml('场景', scenario, 'purple')}；"
        f"{field_xml('问题', problem, 'red')}"
    )


def render_numbered_items(items: list[str]) -> str:
    if not items:
        return "<p>无</p>"
    return "<ol>" + "".join(f'<li seq="auto">{escape_text(item)}</li>' for item in items) + "</ol>"


def extract_professional_items(content: str) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {key: [] for key in ("电气", "暖通", "弱电", "EHS&消防", "其他")}
    current = ""
    for line in content_to_summary_lines(content):
        group = professional_group_from_line(line)
        if group:
            current = group
            continue
        item = clean_summary_item(line)
        if not item or is_summary_heading(item):
            continue
        target = current or infer_professional_group(item)
        if target:
            groups[target].append(item)
    return {key: unique_texts(value) for key, value in groups.items() if value}


def extract_operation_items(content: str) -> list[str]:
    items: list[str] = []
    for line in content_to_summary_lines(content):
        item = clean_operation_item(line)
        if not item or is_summary_heading(item):
            continue
        if "阿里演练" in item:
            break
        items.append(item)
    return unique_texts(items)[:12]


def content_to_summary_lines(content: str) -> list[str]:
    text = strip_fragment_wrapper(content)
    if not text:
        return []
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"<li\b[^>]*>", "\n", text, flags=re.I)
    text = re.sub(r"</(?:p|li|h[1-6]|tr)>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    return [line.strip() for line in text.splitlines() if line.strip()]


def professional_group_from_line(line: str) -> str:
    text = clean_summary_item(line)
    if re.search(r"^电气(?:专业线)?(?:信息)?$|电气专业线信息", text):
        return "电气"
    if re.search(r"^暖通(?:专业线)?(?:信息)?$|暖通专业线信息", text):
        return "暖通"
    if re.search(r"^弱电(?:专业线)?(?:信息)?$|弱电专业线信息", text):
        return "弱电"
    if re.search(r"EHS|消防专业线信息|^消防$", text):
        return "EHS&消防"
    if re.search(r"^其它$|^其他$", text):
        return "其他"
    return ""


def infer_professional_group(item: str) -> str:
    for key in ("电气", "暖通", "弱电", "消防"):
        if item.startswith(key):
            return "EHS&消防" if key == "消防" else key
    return ""


def is_summary_heading(item: str) -> bool:
    normalized = item.strip("：: ")
    if normalized in {"专业线", "专业线信息提取", "运营线", "运营线信息提取", "动环", "BA", "智航", "EHS", "消防", "其它", "其他"}:
        return True
    if normalized in {"亮点推进", "全景平台", "中台相关工作", "相关工作"}:
        return True
    if item.endswith(("：", ":")) and len(item) <= 16:
        return True
    if "@" in item and item.endswith(("工作", "工作：")):
        return True
    return False


def clean_summary_item(value: str) -> str:
    text = clean_markdown_item(value)
    if not text:
        return ""
    text = re.sub(r"[\(（]([^()（）]{1,40})[\)）]", lambda match: "" if is_low_value_parenthetical(match.group(1)) else match.group(0), text)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"[；;。]+$", "", text)
    text = re.sub(r"([，,]\s*){2,}", "，", text)
    if len(text) > 110:
        text = truncate_summary_item(text, 110)
    return text


def clean_operation_item(value: str) -> str:
    text = clean_summary_item(value)
    if not text:
        return ""
    text = remove_parenthetical_content(text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > 45:
        first_clause = re.split(r"[，,；;。]", text, maxsplit=1)[0].strip()
        if 4 <= len(first_clause) <= 30:
            return first_clause
        return truncate_summary_item(text, 70)
    return text


def remove_parenthetical_content(value: str) -> str:
    text = value
    previous = None
    while previous != text:
        previous = text
        text = re.sub(r"[\(（][^()（）]*[\)）]", "", text)
    return text


def is_low_value_parenthetical(text: str) -> bool:
    return bool(re.search(r"[A-Za-z0-9%‰]|已提交|待回复|预计|计划", text))


def truncate_summary_item(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit]
    for sep in ("；", ";", "。", "，", ","):
        pos = cut.rfind(sep)
        if pos >= 40:
            return cut[:pos].rstrip("，,；;。 ")
    return cut.rstrip("，,；;。 ") + "…"


def render_professional_summary(data: NantongWeeklyData) -> str:
    rows: list[str] = []
    for profession in PROFESSIONS:
        event_count = sum(1 for item in data.events if profession in compact_text(item.get("professional")))
        change_count = sum(1 for item in data.changes if profession in compact_text(item.get("professional")))
        drill_count = sum(1 for item in data.drills if profession in compact_text(item.get("professional")))
        maintenance_count = sum(1 for item in data.maintenance if profession in compact_text(item.get("professional")))
        rows.append(
            "<tr>"
            f"<td>{escape_text(profession)}</td>"
            f"<td>{event_count}</td>"
            f"<td>{change_count}</td>"
            f"<td>{drill_count}</td>"
            f"<td>{maintenance_count}</td>"
            "</tr>"
        )
    return (
        "<table>"
        '<thead><tr><th background-color="light-gray">专业</th><th background-color="light-gray">事件</th>'
        '<th background-color="light-gray">变更</th><th background-color="light-gray">演练</th><th background-color="light-gray">维护</th></tr></thead>'
        "<tbody>"
        + "".join(rows)
        + "</tbody></table>"
    )


def render_todo_insert_xml(todos: list[str]) -> str:
    return "<h2>上周内部周会待办</h2>" + render_checkbox_list(
        normalize_todo_list(todos),
        empty_text="暂无上周内部周会待办。",
    )


def escape_markdown_text(value: Any) -> str:
    text = compact_text(value)
    if not text:
        return ""
    replacements = {
        "\\": "\\\\",
        "`": "\\`",
        "*": "\\*",
        "_": "\\_",
        "[": "\\[",
        "]": "\\]",
        "$": "\\$",
        "~": "\\~",
        "<": "\\<",
    }
    return "".join(replacements.get(char, char) for char in text)


def render_todo_insert_markdown(todos: list[str]) -> str:
    cleaned = normalize_todo_list(todos)
    lines = ["## 上周内部周会待办", ""]
    if not cleaned:
        lines.append("暂无上周内部周会待办。")
    else:
        lines.extend(f"- [ ] {escape_markdown_text(item)}" for item in cleaned)
    return "\n".join(lines).rstrip()


def extract_markdown_heading_section(markdown: str, heading: str) -> str:
    lines = str(markdown or "").splitlines()
    start = -1
    start_level = 0
    for index, line in enumerate(lines):
        match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line.strip())
        if not match:
            continue
        if normalize_markdown_line(match.group(2)) == normalize_markdown_line(heading):
            start = index
            start_level = len(match.group(1))
            break
    if start < 0:
        return ""
    end = len(lines)
    for index in range(start + 1, len(lines)):
        match = re.match(r"^(#{1,6})\s+", lines[index].strip())
        if match and len(match.group(1)) <= start_level:
            end = index
            break
    while end > start and not lines[end - 1].strip():
        end -= 1
    return "\n".join(lines[start:end]).rstrip()


def fetch_doc_markdown_content(doc: str, identity: str) -> str:
    payload = run_lark_cli(
        [
            "docs",
            "+fetch",
            "--api-version",
            "v2",
            "--doc",
            doc,
            "--doc-format",
            "markdown",
            "--as",
            identity,
        ],
        timeout=180,
    )
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, dict):
            document = data.get("document")
            if isinstance(document, dict):
                return str(document.get("content") or "")
    return ""


def extract_meeting_token(value: str) -> MeetingToken:
    raw = str(value or "").strip()
    parsed = urlparse(raw)
    path_parts = [part for part in parsed.path.split("/") if part]
    if len(path_parts) >= 2:
        kind = path_parts[0].lower()
        token = path_parts[1].strip()
        if kind in {"minutes", "docx", "doc", "wiki", "notes", "note"} and token:
            normalized_kind = "minutes" if kind == "minutes" else "docx" if kind in {"doc", "docx", "wiki"} else "note"
            return MeetingToken(kind=normalized_kind, token=token, url=raw)
    if raw:
        return MeetingToken(kind="minutes" if raw.startswith("obc") else "unknown", token=raw, url=raw)
    raise ValueError("会议纪要链接为空")


def normalized_meeting_key(value: str) -> str:
    with contextlib.suppress(Exception):
        token = extract_meeting_token(value)
        if token.token:
            return f"{token.kind}:{token.token}"
    return compact_text(value).split("?", 1)[0].rstrip("/")


def existing_meeting_record_id(meeting_url: str, config: dict[str, Any]) -> str:
    table_id = str((config.get("tables") or {}).get("meeting") or "")
    base_token = str(config.get("base_token") or "")
    if not table_id or not base_token:
        return ""
    identity = str(config.get("base_identity") or "bot")
    target_key = normalized_meeting_key(meeting_url)
    field_ids = resolve_table_field_ids(base_token, table_id, ["妙记链接"], identity)
    records = list_base_records(
        base_token=base_token,
        table_id=table_id,
        field_ids=field_ids,
        identity=identity,
        max_pages=int(config.get("max_pages") or 10),
    )
    for record in records:
        fields = normalize_record(record)
        if normalized_meeting_key(fields.get("妙记链接", "")) == target_key:
            return record_id(record)
    return ""


def resolve_table_field_ids(base_token: str, table_id: str, field_names: list[str], identity: str) -> list[str]:
    if not field_names:
        return []
    try:
        payload = run_lark_cli(
            [
                "base",
                "+field-list",
                "--base-token",
                base_token,
                "--table-id",
                table_id,
                "--format",
                "json",
                "--as",
                identity,
            ],
            timeout=120,
        )
    except Exception:
        return field_names
    data = payload.get("data") if isinstance(payload, dict) else None
    fields = data.get("fields") if isinstance(data, dict) else None
    if not isinstance(fields, list):
        return field_names
    name_to_id: dict[str, str] = {}
    for item in fields:
        if not isinstance(item, dict):
            continue
        name = compact_text(item.get("name"))
        field_id = compact_text(item.get("id") or item.get("field_id"))
        if name and field_id:
            name_to_id[name] = field_id
    return [name_to_id.get(name, name) for name in field_names]


def stringify_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, (int, float)):
        if value > 100000000000:
            return datetime.fromtimestamp(float(value) / 1000).strftime("%Y-%m-%d %H:%M:%S")
        return str(value)
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "、".join(filter(None, (stringify_cell(item) for item in value)))
    if isinstance(value, dict):
        for key in ("text", "name", "title", "value", "url", "link"):
            if key in value and value[key] not in (None, ""):
                return stringify_cell(value[key])
        if "text_arr" in value:
            return stringify_cell(value["text_arr"])
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value)


def record_fields(record: dict[str, Any]) -> dict[str, Any]:
    fields = record.get("fields") if isinstance(record, dict) else None
    return fields if isinstance(fields, dict) else {}


def record_id(record: dict[str, Any]) -> str:
    for key in ("record_id", "id", "recordId"):
        value = record.get(key)
        if value:
            return str(value)
    return ""


def normalize_record(record: dict[str, Any]) -> dict[str, str]:
    return {str(key): stringify_cell(value) for key, value in record_fields(record).items()}


def extract_records(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    candidates: list[Any] = []
    data = payload.get("data")
    if isinstance(data, dict):
        table_rows = data.get("data")
        table_fields = data.get("fields")
        record_ids = data.get("record_id_list")
        if isinstance(table_rows, list) and isinstance(table_fields, list):
            records: list[dict[str, Any]] = []
            for index, row in enumerate(table_rows):
                if not isinstance(row, list):
                    continue
                fields = {str(field): row[pos] if pos < len(row) else None for pos, field in enumerate(table_fields)}
                rid = ""
                if isinstance(record_ids, list) and index < len(record_ids):
                    rid = str(record_ids[index] or "")
                records.append({"record_id": rid, "fields": fields})
            return records
        candidates.extend([data.get("items"), data.get("records")])
    candidates.extend([payload.get("items"), payload.get("records")])
    for candidate in candidates:
        if isinstance(candidate, list):
            return [item for item in candidate if isinstance(item, dict)]
    return []


def parse_json_output(stdout: str) -> Any:
    text = stdout.strip()
    if not text:
        return {}
    for start in [idx for idx in (text.find("{"), text.find("[")) if idx >= 0]:
        with contextlib.suppress(json.JSONDecodeError):
            return json.loads(text[start:])
    raise ValueError(f"无法解析 lark-cli JSON 输出：{text[:300]}")


TRANSIENT_LARK_CLI_ERROR_MARKERS = (
    "Post ",
    "tenant_access_token",
    "oauth/v3/token",
    "Client.Timeout",
    "request canceled",
    "connectex",
    "i/o timeout",
    "timed out",
    "connection reset",
    "connection refused",
    "failed to respond",
    "transport",
)


def is_transient_lark_cli_error(text: str) -> bool:
    lowered = str(text or "").lower()
    return any(marker.lower() in lowered for marker in TRANSIENT_LARK_CLI_ERROR_MARKERS)


def extract_lark_cli_error_message(text: str) -> str:
    raw = str(text or "").strip()
    if not raw:
        return ""
    with contextlib.suppress(Exception):
        payload = parse_json_output(raw)
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, str):
                with contextlib.suppress(Exception):
                    nested = json.loads(error)
                    if isinstance(nested, dict):
                        return extract_lark_cli_error_message(json.dumps(nested, ensure_ascii=False))
                return error.strip()
            if isinstance(error, dict):
                message = error.get("message") or error.get("msg")
                if message:
                    return str(message).strip()
            message = payload.get("message") or payload.get("msg")
            if message:
                return str(message).strip()
    return raw


def format_lark_cli_error(text: str) -> str:
    message = extract_lark_cli_error_message(text)
    if is_transient_lark_cli_error(message):
        return f"飞书接口连接超时或网络异常，请稍后重试。原始信息：{message}"
    return message


def normalize_env_for_lark_cli() -> dict[str, str]:
    env = dict(os.environ)
    env["LARK_CLI_NO_PROXY"] = "1"
    for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
        env.pop(key, None)
    return env


def lark_cli_candidates() -> list[str]:
    candidates: list[str] = []

    def add(value: str | None) -> None:
        value = (value or "").strip().strip('"')
        if value and value not in candidates:
            candidates.append(value)

    add(os.getenv("LARK_CLI_BIN"))
    if PROJECT_ROOT.name == "scripts":
        for name in ("lark-cli.cmd", "lark-cli.exe", "lark-cli.ps1"):
            add(str(PROJECT_ROOT.parent / "tools" / "lark-cli" / name))
    add(str(PROJECT_ROOT / "tools" / "lark-cli" / "lark-cli.cmd"))
    add(str(PROJECT_ROOT / "tools" / "lark-cli" / "lark-cli.exe"))
    add(str(PROJECT_ROOT / "tools" / "lark-cli" / "lark-cli.ps1"))
    for name in ("lark-cli.cmd", "lark-cli.exe", "lark-cli", "lark-cli.ps1"):
        add(shutil.which(name))

    for env_name in ("LOCALAPPDATA", "APPDATA"):
        root = os.getenv(env_name, "").strip()
        if root:
            add(str(Path(root) / "Programs" / "nodejs" / "lark-cli.cmd"))
            add(str(Path(root) / "npm" / "lark-cli.cmd"))

    for env_name in ("ProgramFiles", "ProgramFiles(x86)"):
        root = os.getenv(env_name, "").strip()
        if root:
            add(str(Path(root) / "nodejs" / "lark-cli.cmd"))

    users_root = Path(os.getenv("SystemDrive", "C:") + "\\Users")
    if users_root.exists():
        for pattern in ("*\\AppData\\Local\\Programs\\nodejs\\lark-cli.cmd", "*\\AppData\\Roaming\\npm\\lark-cli.cmd"):
            for path in users_root.glob(pattern):
                add(str(path))

    add(LARK_CLI_BIN_DEFAULT)
    return candidates


def resolve_lark_cli_command() -> list[str]:
    for cli in lark_cli_candidates():
        path = Path(cli)
        if path.is_absolute():
            if not path.exists():
                continue
        else:
            found = shutil.which(cli)
            if found:
                cli = found
                path = Path(cli)
            else:
                project_relative = PROJECT_ROOT / cli
                if not project_relative.exists():
                    continue
                cli = str(project_relative)
                path = project_relative

        node_exe = path.with_name("node.exe")
        run_js = path.parent / "node_modules" / "@larksuite" / "cli" / "scripts" / "run.js"
        if node_exe.exists() and run_js.exists():
            return [str(node_exe), str(run_js)]
        if str(cli).lower().endswith(".ps1"):
            return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(cli)]
        return [str(cli)]

    bundled = PROJECT_ROOT / "tools" / "lark-cli" / "lark-cli.cmd"
    raise RuntimeError(
        "未找到 lark-cli。请使用包含 tools/lark-cli 的部署包，"
        f"或将 LARK_CLI_BIN 指向可用的 lark-cli.cmd。预期内置路径：{bundled}"
    )


def env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name, "").strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return default


def ensure_lark_cli_config_from_env() -> None:
    """Refresh lark-cli app credentials from env without logging secrets."""
    app_id = os.getenv("FEISHU_APP_ID", "").strip() or os.getenv("LARK_APP_ID", "").strip()
    app_secret = os.getenv("FEISHU_APP_SECRET", "").strip() or os.getenv("LARK_APP_SECRET", "").strip()
    if not app_id or not app_secret:
        return

    cli = resolve_lark_cli_command()
    env = normalize_env_for_lark_cli()
    refresh = env_bool("LARK_CLI_CONFIG_REFRESH", True)
    if not refresh:
        show = subprocess.run(
            cli + ["config", "show"],
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            env=env,
            check=False,
        )
        if show.returncode == 0:
            with contextlib.suppress(Exception):
                current = json.loads((show.stdout or "").split("\n\n", 1)[0])
                if str(current.get("appId") or "") == app_id:
                    return

    brand = os.getenv("FEISHU_BRAND", "").strip() or os.getenv("LARK_BRAND", "").strip() or "feishu"
    init = subprocess.run(
        cli + ["config", "init", "--app-id", app_id, "--app-secret-stdin", "--brand", brand],
        input=app_secret,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        env=env,
        check=False,
    )
    if init.returncode != 0:
        raise RuntimeError("lark-cli config init failed; check FEISHU_APP_ID/FEISHU_APP_SECRET and app permissions")


def run_lark_cli(args: list[str], *, timeout: int = 180, retry: bool = True) -> Any:
    command = [*resolve_lark_cli_command(), *args]
    attempts = max(1, int(os.getenv("NANTONG_LARK_CLI_RETRIES", "3") or "3")) if retry else 1
    last_error = ""
    for attempt in range(1, attempts + 1):
        try:
            completed = subprocess.run(
                command,
                cwd=PROJECT_ROOT,
                env=normalize_env_for_lark_cli(),
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            last_error = f"lark-cli timed out after {timeout}s"
            if attempt < attempts:
                time.sleep(2 * attempt)
                continue
            raise RuntimeError(format_lark_cli_error(last_error)) from exc
        if completed.returncode == 0:
            return parse_json_output(completed.stdout)
        detail = (completed.stderr or completed.stdout or "").strip()
        last_error = detail or f"lark-cli exited with {completed.returncode}"
        if attempt < attempts and is_transient_lark_cli_error(last_error):
            time.sleep(2 * attempt)
            continue
        raise RuntimeError(format_lark_cli_error(last_error))
    raise RuntimeError(format_lark_cli_error(last_error))


@contextlib.contextmanager
def content_arg(content: str, prefix: str) -> Iterable[str]:
    RUNTIME_LOG_DIR.mkdir(parents=True, exist_ok=True)
    path = RUNTIME_LOG_DIR / f"{prefix}_{uuid.uuid4().hex}.xml"
    path.write_text(content, encoding="utf-8")
    try:
        yield "@" + path.relative_to(PROJECT_ROOT).as_posix()
    finally:
        with contextlib.suppress(FileNotFoundError):
            path.unlink()


def list_base_records(
    *,
    base_token: str,
    table_id: str,
    field_ids: list[str],
    identity: str,
    max_pages: int,
    view_id: str = "",
    filter_json: dict[str, Any] | None = None,
    sort_json: list[dict[str, Any]] | dict[str, Any] | None = None,
    require_complete: bool = False,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for page in range(max_pages):
        args = [
            "base",
            "+record-list",
            "--base-token",
            base_token,
            "--table-id",
            table_id,
            "--limit",
            "200",
            "--offset",
            str(page * 200),
            "--format",
            "json",
            "--as",
            identity,
        ]
        if view_id:
            args.extend(["--view-id", view_id])
        for field_id in field_ids:
            args.extend(["--field-id", field_id])
        if filter_json:
            args.extend(["--filter-json", json.dumps(filter_json, ensure_ascii=False)])
        if sort_json:
            args.extend(["--sort-json", json.dumps(sort_json, ensure_ascii=False)])
        page_payload = run_lark_cli(args)
        page_records = extract_records(page_payload)
        records.extend(page_records)
        data = page_payload.get("data", {}) if isinstance(page_payload, dict) else {}
        has_more = data.get("has_more") if isinstance(data, dict) else None
        more = has_more if isinstance(has_more, bool) else len(page_records) >= 200
        if not more:
            break
        if require_complete and page + 1 == max_pages:
            raise ValueError(f"数据表 {table_id} 仍有未读取记录，不能计算完整周报，请增加 max_pages")
    return records


def parse_any_date(value: Any) -> date | None:
    text = stringify_cell(value).strip()
    if not text:
        return None
    if re.fullmatch(r"\d{13}", text):
        return datetime.fromtimestamp(int(text) / 1000).date()
    if re.fullmatch(r"\d{5}", text) and 30000 <= int(text) <= 60000:
        return date(1899, 12, 30) + timedelta(days=int(text))
    match = re.search(r"(\d{4})[/-](\d{1,2})[/-](\d{1,2})", text)
    if not match:
        return None
    return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))


def format_date_text(value: Any) -> str:
    parsed = parse_any_date(value)
    return parsed.isoformat() if parsed else stringify_cell(value)


def format_datetime_text(value: Any) -> str:
    text = stringify_cell(value).strip()
    if not text:
        return ""
    if re.fullmatch(r"\d{13}", text):
        return datetime.fromtimestamp(int(text) / 1000).strftime("%Y-%m-%d %H:%M")
    match = re.search(r"(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?", text)
    if not match:
        return text
    year, month, day, hour, minute = match.groups()
    date_text = f"{int(year):04d}-{int(month):02d}-{int(day):02d}"
    if hour is None:
        return date_text
    return f"{date_text} {int(hour):02d}:{minute}"


def format_time_range(start: Any, end: Any) -> str:
    start_text = format_datetime_text(start)
    end_text = format_datetime_text(end)
    if start_text and end_text:
        if start_text[:10] == end_text[:10] and len(end_text) > 10:
            return f"{start_text}~{end_text[11:]}"
        return f"{start_text}~{end_text}"
    return start_text or end_text


def record_in_period(
    fields: dict[str, str],
    date_fields: list[str],
    period: WeeklyPeriod,
    marker_fields: list[str] | None = None,
) -> bool:
    for key in marker_fields or []:
        value = compact_text(fields.get(key))
        if "本周" in value or value == "是":
            return True
    dates = [parse_any_date(fields.get(key)) for key in date_fields]
    dates = [item for item in dates if item is not None]
    if not dates:
        marker = " ".join(fields.values())
        return "本周" in marker or "是" == fields.get("是否本周", "").strip() or "本周" in fields.get("是否为本周", "")
    if len(dates) >= 2:
        start, end = min(dates), max(dates)
        return start <= period.end and end >= period.start
    return period.start <= dates[0] <= period.end


def date_range_filter(field: str, period: WeeklyPeriod) -> dict[str, Any]:
    after = (period.start - timedelta(days=1)).isoformat()
    before = (period.end + timedelta(days=1)).isoformat()
    return {
        "logic": "and",
        "conditions": [
            [field, ">", f"ExactDate({after})"],
            [field, "<", f"ExactDate({before})"],
        ],
    }


def latest_weekly_record(records: list[dict[str, Any]], period: WeeklyPeriod) -> dict[str, str]:
    normalized = [normalize_record(record) | {"_record_id": record_id(record)} for record in records]
    contentful = [
        item
        for item in normalized
        if any(compact_text(item.get(key)) for key in ("上周遗留项", "专业线", "运营线", "本周代办"))
    ]
    in_period = [
        item
        for item in contentful
        if record_in_period(item, ["日期", "创建时间"], period)
        or str(period.week_number) in compact_text(item.get("第几周"))
        or "最新" in compact_text(item.get("新旧打标"))
    ]
    candidates = in_period or contentful or normalized
    if not candidates:
        return {}
    return sorted(candidates, key=lambda item: compact_text(item.get("创建时间") or item.get("日期")), reverse=True)[0]


def current_weekly_record(records: list[dict[str, Any]], period: WeeklyPeriod) -> dict[str, str]:
    candidates = []
    for record in records:
        fields = normalize_record(record)
        candidate_date = parse_any_date(fields.get("日期"))
        if candidate_date is not None:
            matches = candidate_date == period.end
        else:
            marker = re.search(r"(\d{4})年第\s*(\d+)\s*周", compact_text(fields.get("第几周")))
            matches = bool(marker and int(marker.group(1)) == period.end.year and int(marker.group(2)) == period.week_number)
        if matches:
            candidates.append(fields | {"_record_id": record_id(record)})
    if len(candidates) > 1:
        raise ValueError(f"同一周 {period.key} 存在多条周报记录，请先确认本周目标行")
    return candidates[0] if candidates else {}


def weekly_record_todos(fields: dict[str, str]) -> tuple[list[str], list[str]]:
    return (
        extract_todos_from_meeting_field(fields.get(WEEKLY_INTERNAL_TODOS_FIELD, "")),
        extract_ali_todos_from_text(fields.get(WEEKLY_ALI_TODOS_FIELD, "")),
    )


def previous_weekly_report_link(records: list[dict[str, Any]], period: WeeklyPeriod, config: dict[str, Any]) -> str:
    seed_url = compact_text(config.get("previous_report_seed_doc_url")) or compact_text(config.get("professional_seed_doc_url"))
    if seed_url and compact_text(config.get("previous_report_seed_period")) == period.key:
        return seed_url
    candidates: list[tuple[date, str]] = []
    template_url = compact_text(config.get("template_doc_url") or TEMPLATE_DOC_URL)
    for record in records:
        fields = normalize_record(record)
        link = extract_first_url(fields.get("链接"))
        if not link:
            continue
        if template_url and template_url.split("?", 1)[0] in link.split("?", 1)[0]:
            continue
        candidate_date = parse_any_date(fields.get("日期")) or parse_any_date(fields.get("创建时间"))
        if candidate_date and candidate_date < period.end:
            candidates.append((candidate_date, link))
    if candidates:
        return sorted(candidates, key=lambda item: item[0], reverse=True)[0][1]
    return seed_url


def current_weekly_report_link(records: list[dict[str, Any]], period: WeeklyPeriod, config: dict[str, Any]) -> str:
    candidates: list[tuple[str, str]] = []
    template_url = compact_text(config.get("template_doc_url") or TEMPLATE_DOC_URL)
    for record in records:
        fields = normalize_record(record)
        link = extract_first_url(fields.get("链接"))
        if not link:
            continue
        if template_url and template_url.split("?", 1)[0] in link.split("?", 1)[0]:
            continue
        week_marker = compact_text(fields.get("第几周"))
        week_match = re.search(r"(?:(\d{4})年)?第\s*(\d+)\s*周", week_marker)
        candidate_date = parse_any_date(fields.get("日期"))
        if candidate_date is not None:
            is_current = candidate_date == period.end
        elif week_match:
            marker_year = int(week_match.group(1)) if week_match.group(1) else period.end.year
            is_current = marker_year == period.end.year and int(week_match.group(2)) == period.week_number
        else:
            is_current = False
        if is_current:
            sort_key = compact_text(fields.get("创建时间") or fields.get("日期"))
            candidates.append((sort_key, link))
    if not candidates:
        return ""
    return sorted(candidates, key=lambda item: item[0], reverse=True)[0][1]


def extract_first_url(value: Any) -> str:
    text = compact_text(value)
    match = re.search(r"https?://[^\s)\]]+", text)
    return match.group(0) if match else text


def extract_document_content(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    data = payload.get("data")
    if not isinstance(data, dict):
        return ""
    document = data.get("document")
    if not isinstance(document, dict):
        return ""
    return str(document.get("content") or "")


def strip_fragment_wrapper(content: str) -> str:
    text = str(content or "").strip()
    match = re.fullmatch(r"<fragment\b[^>]*>(.*)</fragment>", text, re.S)
    return match.group(1).strip() if match else text


def remove_doc_block_ids(xml: str) -> str:
    return re.sub(r'\s+id="[^"]+"', "", xml)


def section_xml_to_text(xml: str, heading: str = "") -> str:
    section = remove_doc_block_ids(strip_fragment_wrapper(xml))
    if not section:
        return ""
    if heading:
        section = re.sub(
            rf"<h[1-6]\b[^>]*>\s*{heading_re(heading)}\s*</h[1-6]>\s*",
            "\n",
            section,
            count=1,
            flags=re.S,
        )
    section = re.sub(r"<br\s*/?>", "\n", section, flags=re.I)
    section = re.sub(r"<li\b[^>]*>", "- ", section, flags=re.I)
    section = re.sub(r"<checkbox\b[^>]*>", "- [ ] ", section, flags=re.I)
    section = re.sub(r"</(?:p|li|checkbox|h[1-6]|tr|table)>", "\n", section, flags=re.I)
    section = re.sub(r"<[^>]+>", "", section)
    text = html.unescape(section)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def heading_re(heading: str) -> str:
    return (rf"(?:<(?:span|b|em)\b[^>]*>)*\s*"
            rf"(?:[一二三四五六七八九十0-9]+[、.．）)]\s*)?{re.escape(heading)}\s*[：:]?\s*"
            rf"(?:</(?:span|b|em)>)*")


def extract_heading_section_xml(content: str, heading: str, *, stop_headings: list[str] | None = None) -> str:
    xml = strip_fragment_wrapper(content)
    heading_pattern = re.compile(rf"<h([1-6])\b[^>]*>\s*{heading_re(heading)}\s*</h\1>", re.S)
    match = heading_pattern.search(xml)
    if not match:
        return ""
    level = int(match.group(1))
    tail = xml[match.end() :]
    stop_match = None
    if stop_headings:
        stop_pattern = "|".join(heading_re(item) for item in stop_headings)
        stop_match = re.search(rf"<h[1-6]\b[^>]*>\s*(?:{stop_pattern})\s*</h[1-6]>", tail, re.S)
    if not stop_match:
        stop_match = re.search(rf"<h([1-{level}])\b[^>]*>.*?</h\1>", tail, re.S)
    end = match.end() + (stop_match.start() if stop_match else len(tail))
    section = xml[match.start() : end].strip()
    return remove_doc_block_ids(section)


def extract_professional_section_xml(content: str) -> str:
    return extract_heading_section_xml(content, "专业线", stop_headings=["运营线"])


def extract_operation_section_xml(content: str) -> str:
    return extract_heading_section_xml(content, "运营线")


def fetch_section_xml(source_doc: str, config: dict[str, Any], heading: str, *, stop_headings: list[str] | None = None) -> str:
    if not source_doc:
        return ""
    payload = run_lark_cli(
        [
            "docs",
            "+fetch",
            "--api-version",
            "v2",
            "--doc",
            source_doc,
            "--scope",
            "keyword",
            "--keyword",
            heading,
            "--context-after",
            "100",
            "--as",
            str(config.get("doc_identity") or "bot"),
        ],
        timeout=180,
    )
    return extract_heading_section_xml(extract_document_content(payload), heading, stop_headings=stop_headings)


def fetch_professional_section_xml(source_doc: str, config: dict[str, Any]) -> str:
    return fetch_section_xml(source_doc, config, "专业线", stop_headings=["运营线"])


def fetch_operation_section_xml(source_doc: str, config: dict[str, Any]) -> str:
    return fetch_section_xml(source_doc, config, "运营线")


def fetch_previous_report_markdown(source_doc: str, config: dict[str, Any]) -> str:
    if not source_doc:
        return ""
    payload = run_lark_cli(
        [
            "docs",
            "+fetch",
            "--api-version",
            "v2",
            "--doc",
            source_doc,
            "--scope",
            "keyword",
            "--keyword",
            "管理线",
            "--context-after",
            "260",
            "--doc-format",
            "markdown",
            "--as",
            str(config.get("doc_identity") or "bot"),
        ],
        timeout=180,
    )
    return strip_fragment_wrapper(extract_document_content(payload))


def extract_building_memory_from_markdown(content: str) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    text = strip_fragment_wrapper(content)
    safety_backlog: dict[str, list[str]] = {building: [] for building in BUILDINGS}
    next_week_work: dict[str, list[str]] = {building: [] for building in BUILDINGS}
    heading_pattern = re.compile(
        r"^\s{0,3}#{1,6}\s*(?:\*\*)?\s*(A楼|B楼|C楼|D楼|E楼|110站)\s*[:：]?\s*(?:\*\*)?\s*$",
        re.M,
    )
    matches = list(heading_pattern.finditer(text))
    for index, match in enumerate(matches):
        building = match.group(1)
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        section = text[match.end() : end]
        safety_backlog[building] = extract_markdown_items_between(
            section,
            start_keywords=["上周遗留"],
            stop_keywords=["本周新增", "二、效率", "#### 二", "### 二"],
        )
        next_week_work[building] = extract_markdown_items_between(
            section,
            start_keywords=["四、下周重点工作", "下周重点工作"],
            stop_keywords=["专业线", "运营线"],
        )
    return safety_backlog, next_week_work


def extract_markdown_items_between(section: str, *, start_keywords: list[str], stop_keywords: list[str]) -> list[str]:
    lines = section.splitlines()
    collecting = False
    items: list[str] = []
    for line in lines:
        raw = line.strip()
        normalized = normalize_markdown_line(raw)
        if not collecting:
            if any(keyword in normalized for keyword in start_keywords):
                collecting = True
            continue
        if any(keyword in normalized for keyword in stop_keywords):
            break
        item = clean_markdown_item(raw)
        if item:
            items.append(item)
    return unique_texts(items)


def normalize_markdown_line(value: str) -> str:
    return re.sub(r"[\s#*_`：:]+", "", value or "")


def clean_markdown_item(value: str) -> str:
    text = re.sub(r"[*_`]", "", value or "").strip()
    text = re.sub(r"^\s*#{1,6}\s*", "", text)
    text = re.sub(r"^\s*(?:[-+•]\s*|\d+\s*[.)、）]\s*)", "", text).strip()
    text = text.strip("：:;； ")
    if not text or text in {"无", "无。"}:
        return ""
    if any(keyword in text for keyword in ("上周遗留", "本周新增", "下周重点工作", "安全（风险、故障类）")):
        return ""
    return text


def normalize_event(fields: dict[str, str]) -> dict[str, Any]:
    resolution = (
        fields.get("事件解决措施")
        or fields.get("引用维修里面的解决措施")
        or fields.get("事件应急措施")
        or ""
    )
    final_status = fields.get("最终状态") or fields.get("事件目前进展") or fields.get("检修进度", "")
    return {
        "name": fields.get("事件名称", ""),
        "date": format_date_text(fields.get("事件发生时间", "")),
        "building": fields.get("机楼", ""),
        "professional": fields.get("专业", ""),
        "level": fields.get("事件等级", ""),
        "resolution": resolution,
        "final_status": final_status,
        "status": resolution or final_status,
    }


def normalize_change(fields: dict[str, str]) -> dict[str, Any]:
    return {
        "name": fields.get("变更编码&描述", ""),
        "building": fields.get("变更楼栋", ""),
        "professional": fields.get("专业", ""),
        "level": fields.get("变更等级（阿里）", ""),
        "progress": fields.get("变更进度") or fields.get("变更情况（变更完成或取消后填写）", ""),
        "planned_start": fields.get("计划开始日期（阿里）", ""),
        "planned_end": fields.get("计划结束日期（阿里）", ""),
        "delayed_start": fields.get("计划延迟开始日期", ""),
        "delayed_end": fields.get("计划延迟结束日期", ""),
        "actual_start": fields.get("实际开始时间", ""),
        "actual_end": fields.get("实际结束时间", ""),
    }


def normalize_source_drill(fields: dict[str, str], period: WeeklyPeriod) -> dict[str, Any]:
    planned = parse_any_date(fields.get("计划演练时间"))
    actual = parse_any_date(fields.get("实际演练时间"))
    execution = compact_text(fields.get("执行状态"))
    status = compact_text(fields.get("演练状态"))
    approval = compact_text(fields.get("审批状态"))
    cancelled = status in {"取消", "已取消"} or execution in {"取消", "已取消"}
    conflict = execution == "未执行" and (actual is not None or status in {"完成", "已完成"})
    completed = not conflict and (execution in {"已执行", "完成", "已完成"} or status in {"完成", "已完成"})
    completed = completed and (actual is None or actual <= period.end)
    started = bool(actual and actual <= period.end) or execution in {"进行中", "执行中", "已执行"} or status in {"进行中", "演练中", "待评估", "完成"}
    in_week = bool(
        (planned and period.start <= planned <= period.end)
        or (actual and period.start <= actual <= period.end)
        or (planned and planned < period.start and not completed and (actual is None or actual <= period.end))
    ) and not cancelled
    in_month = bool(planned and (planned.year, planned.month) == (period.end.year, period.end.month)) and not cancelled
    return {
        "source_drill": True,
        "name": fields.get("演练场景", ""), "scenario": fields.get("演练场景", ""),
        "building": fields.get("实施区域", ""), "professional": fields.get("专业", ""),
        "owner": fields.get("负责人", ""), "execution": execution, "status": status, "approval": approval,
        "completed": bool(completed), "started": started, "status_conflict": conflict,
        "pending_approval": bool(completed and approval != "审批完成"),
        "in_week": in_week, "in_month": in_month,
        "weekly_priority": 0 if actual and period.start <= actual <= period.end else
                           1 if planned and period.start <= planned <= period.end else 2,
    }


def source_drill_progress(item: dict[str, Any]) -> str:
    if item.get("status_conflict"):
        return f"{compact_text(item.get('status')) or '状态'}（待核对）"
    if item.get("pending_approval"):
        return "已完成，待审批"
    if item.get("completed"):
        return "已完成"
    return compact_text(item.get("status") or item.get("execution")) or "进行中"


def collect_source_drills(period: WeeklyPeriod, config: dict[str, Any]) -> tuple[list[dict[str, Any]], int]:
    filters = [
        {"logic": "and", "conditions": [["计划演练时间", "intersects", f"{period.end.year}-{period.end.month:02d}-"]]},
        date_range_filter("实际演练时间", period),
        {"logic": "and", "conditions": [["演练状态", "!=", "完成"]]},
    ]
    records: dict[str, dict[str, Any]] = {}
    for filter_json in filters:
        batch = list_base_records(
            base_token=str(config["drill_source_base_token"]), table_id=str(config["drill_source_table_id"]),
            field_ids=["编码", "演练场景", "实施区域", "专业", "负责人", "计划演练时间", "实际演练时间",
                       "演练状态", "执行状态", "审批状态", "演练月份", "演练年份"],
            identity=str(config.get("base_identity") or "bot"), max_pages=int(config.get("max_pages") or 10),
            view_id=str(config.get("drill_source_view_id") or ""), filter_json=filter_json, require_complete=True,
        )
        for record in batch:
            rid = record_id(record)
            if not rid:
                raise ValueError("演练记录缺少 record_id，无法去重统计")
            records[rid] = record
    items = [normalize_source_drill(normalize_record(record), period) for record in records.values()]
    return [item for item in items if item["in_month"] or item["in_week"]], len(records)


def normalize_drill(fields: dict[str, str]) -> dict[str, Any]:
    return {
        "name": fields.get("演练描述") or fields.get("演练场景") or fields.get("问题提炼（AI）", ""),
        "building": fields.get("机楼") or fields.get("演练范围", ""),
        "professional": fields.get("专业", ""),
        "scenario": fields.get("演练场景", ""),
        "source_id": fields.get("SourceID", ""),
        "code": fields.get("问题编码", ""),
        "completion_rate": format_rate(fields.get("完成率")) or fields.get("风险等级", ""),
        "finished": fields.get("已完成数量", ""),
        "expected": fields.get("应完成数量", ""),
        "month": fields.get("演练月份", ""),
    }


def enrich_planned_drills(planned_drills: list[dict[str, Any]], ali_drills: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [dict(item) for item in planned_drills]


def normalize_abnormal_maintenance(fields: dict[str, str]) -> dict[str, Any]:
    return {
        "name": fields.get("维护总项", ""),
        "status": fields.get("维护实施状态", ""),
        "category": fields.get("类别", ""),
        "mode": fields.get("维护模式", ""),
        "building": fields.get("楼栋", ""),
        "code": fields.get("维护编号", ""),
        "professional": fields.get("专业类别", ""),
        "project": fields.get("维护项目", ""),
        "start_date": format_date_text(fields.get("计划开始维护时间", "")),
        "end_date": format_date_text(fields.get("计划结束维护时间", "")),
    }


def normalize_ali_weekly_drill(fields: dict[str, str]) -> dict[str, Any]:
    scenario = fields.get("演练场景提取") or fields.get("演练场景", "")
    problem_source = fields.get("风险&问题内容描述（互联侧）") or fields.get("风险&问题内容描述（阿里侧）", "")
    return {
        "code": fields.get("问题编码", ""),
        "building": fields.get("演练机楼", ""),
        "professional": fields.get("专业", ""),
        "risk_level": fields.get("风险等级", ""),
        "date": format_date_text(fields.get("演练日期", "")),
        "scenario": scenario,
        "problem": summarize_ali_drill_problem(problem_source, scenario),
        "score": fields.get("阿里打分") or fields.get("评分（数值）", ""),
        "grade": fields.get("演练评分等级", ""),
    }


def summarize_ali_drill_problem(value: Any, scenario: Any = "") -> str:
    raw = html.unescape(str(value or "")).replace("\r", "\n")
    scenario_text = compact_text(scenario)
    items: list[str] = []
    for line in re.split(r"\n+|[；;。]+", raw):
        text = clean_markdown_item(line)
        text = re.sub(r"@\S+", "", text).strip()
        text = re.sub(r"\s+", " ", text)
        if not text or text == scenario_text or text in scenario_text:
            continue
        if scenario_text and scenario_text in text and len(text) <= len(scenario_text) + 12:
            continue
        items.append(text)
    if not items:
        return ""
    return truncate_summary_item("；".join(unique_texts(items)[:2]), 110)


def normalize_maintenance(fields: dict[str, str]) -> dict[str, Any]:
    return {
        "name": fields.get("维护描述", ""),
        "building": fields.get("机楼", ""),
        "professional": fields.get("专业", ""),
        "date": fields.get("日期（公式）", ""),
        "completion_rate": format_rate(fields.get("完成率")),
        "timely_rate": format_rate(fields.get("完成及时率")),
        "expected": fields.get("应完成数量", ""),
        "actual_expected": fields.get("实际应完成数量", ""),
        "normal_finished": fields.get("正常结束数量", ""),
    }


def normalize_cabinet(fields: dict[str, str]) -> dict[str, Any]:
    building = fields.get("楼栋", "")
    date_text = format_date_text(fields.get("日期", ""))
    shift = fields.get("班次", "")
    return {
        "name": " / ".join(part for part in [building, date_text, shift] if part),
        "building": building,
        "date": date_text,
        "shift": shift,
        "weekly_up": fields.get("本周上电机柜数（个）", ""),
        "weekly_down": fields.get("本周下电机柜数（个）", ""),
        "powered": fields.get("实际上电机柜数（个）", ""),
        "total": fields.get("机房总规划机柜数（个）", ""),
        "power_rate": format_rate(fields.get("上电率")),
    }


def normalize_purchase_summary(fields: dict[str, str]) -> dict[str, Any]:
    return {
        "name": fields.get("采购汇总", ""),
        "building": fields.get("楼栋", ""),
        "items": fields.get("采购汇总", ""),
        "amount": fields.get("采购预估价格", ""),
        "this_week": fields.get("是否本周", ""),
    }


def normalize_eop(fields: dict[str, str]) -> dict[str, Any]:
    number = fields.get("编号", "")
    title = fields.get("演练场景") or fields.get("文件名") or fields.get("编号") or fields.get("精简版EOP", "")
    if number and number not in title:
        title = f"{number} {title}"
    return {
        "name": title,
        "priority": fields.get("优先级", ""),
        "status": fields.get("文件状态", ""),
        "number": number,
        "link": fields.get("知识库链接") or fields.get("记录链接", ""),
    }


def filtered_table_records(
    *,
    base_token: str,
    table_id: str,
    field_ids: list[str],
    identity: str,
    max_pages: int,
    period: WeeklyPeriod,
    date_fields: list[str],
    normalizer: Any,
    marker_fields: list[str] | None = None,
    server_date_field: str = "",
) -> tuple[list[dict[str, Any]], int]:
    records = list_base_records(
        base_token=base_token,
        table_id=table_id,
        field_ids=field_ids,
        identity=identity,
        max_pages=max_pages,
        filter_json=date_range_filter(server_date_field, period) if server_date_field else None,
        sort_json=[{"field": server_date_field, "desc": True}] if server_date_field else None,
    )
    items: list[dict[str, Any]] = []
    for record in records:
        fields = normalize_record(record)
        if record_in_period(fields, date_fields, period, marker_fields=marker_fields):
            item = normalizer(fields)
            if any(compact_text(value) for value in item.values()):
                items.append(item)
    return items, len(records)


def collect_report_data(period: WeeklyPeriod, config: dict[str, Any]) -> NantongWeeklyData:
    base_token = str(config["base_token"])
    identity = str(config.get("base_identity") or "bot")
    tables = config["tables"]
    max_pages = int(config.get("max_pages") or 10)

    weekly_records = list_base_records(
        base_token=base_token,
        table_id=str(tables["weekly"]),
        field_ids=["日期", "创建时间", "第几周", "新旧打标", "上周遗留项", "链接", "专业线", "运营线", "本周代办",
                   WEEKLY_ALI_TODOS_FIELD, WEEKLY_INTERNAL_TODOS_FIELD],
        identity=identity,
        max_pages=max_pages,
        view_id="",
        require_complete=True,
    )
    weekly = current_weekly_record(weekly_records, period)
    current_report_doc = current_weekly_report_link([{"fields": weekly}] if weekly else [], period, config)
    previous_report_doc = previous_weekly_report_link(weekly_records, period, config)
    professional_line_xml = ""
    professional_line_archive = weekly.get("专业线", "")
    professional_line_error = ""
    operation_line_xml = ""
    operation_line_archive = weekly.get("运营线", "")
    operation_line_error = ""
    previous_safety_backlog: dict[str, list[str]] = {}
    next_week_work: dict[str, list[str]] = {}
    previous_memory_error = ""
    if previous_report_doc:
        try:
            professional_line_xml = fetch_professional_section_xml(previous_report_doc, config)
            if not professional_line_xml:
                professional_line_error = f"未在上一期文档中找到专业线模块：{previous_report_doc}"
            else:
                professional_line_archive = section_xml_to_text(professional_line_xml, "专业线")
        except Exception as exc:
            professional_line_error = str(exc)
        try:
            operation_line_xml = fetch_operation_section_xml(previous_report_doc, config)
            if not operation_line_xml:
                operation_line_error = f"未在上一期文档中找到运营线模块：{previous_report_doc}"
            else:
                operation_line_archive = section_xml_to_text(operation_line_xml, "运营线")
        except Exception as exc:
            operation_line_error = str(exc)
        try:
            previous_report_markdown = fetch_previous_report_markdown(previous_report_doc, config)
            previous_safety_backlog, next_week_work = extract_building_memory_from_markdown(previous_report_markdown)
        except Exception as exc:
            previous_memory_error = str(exc)

    events, event_total = filtered_table_records(
        base_token=base_token,
        table_id=str(tables["events"]),
        field_ids=[
            "事件名称",
            "事件发生时间",
            "事件等级",
            "机楼",
            "专业",
            "最终状态",
            "检修进度",
            "事件目前进展",
            "事件解决措施",
            "引用维修里面的解决措施",
            "事件应急措施",
            "事件发生原因",
        ],
        identity=identity,
        max_pages=max_pages,
        period=period,
        date_fields=["事件发生时间"],
        marker_fields=["公式"],
        normalizer=normalize_event,
    )

    changes, change_total = filtered_table_records(
        base_token=base_token,
        table_id=str(tables["changes"]),
        field_ids=[
            "变更编码&描述",
            "计划开始日期（阿里）",
            "计划结束日期（阿里）",
            "计划延迟开始日期",
            "计划延迟结束日期",
            "实际开始时间",
            "实际结束时间",
            "日期打标",
            "变更楼栋",
            "专业",
            "变更等级（阿里）",
            "变更进度",
            "变更情况（变更完成或取消后填写）",
        ],
        identity=identity,
        max_pages=max_pages,
        period=period,
        date_fields=[
            *CHANGE_DATE_FIELDS,
        ],
        normalizer=normalize_change,
    )

    if compact_text(config.get("drill_source_table_id")):
        planned_drills, planned_drill_total = collect_source_drills(period, config)
    else:
        planned_drills, planned_drill_total = filtered_table_records(
            base_token=base_token,
            table_id=str(tables["planned_drills"]),
            field_ids=["演练描述", "是否本周", "已完成数量", "应完成数量", "完成率", "演练月份", "机楼", "SourceID"],
            identity=identity,
            max_pages=max_pages,
            period=period,
            date_fields=["演练月份"],
            marker_fields=["是否本周"],
            normalizer=normalize_drill,
        )

    ali_drill_records = list_base_records(
        base_token=base_token,
        table_id=str(tables["ali_drills"]),
        field_ids=["SourceID", "问题编码", "风险等级", "专业", "演练场景", "问题提炼（AI）", "演练范围"],
        identity=identity,
        max_pages=1,
    )
    ali_drills = [normalize_drill(normalize_record(record)) for record in ali_drill_records[:20]]
    planned_drills = enrich_planned_drills(planned_drills, ali_drills)

    ali_weekly_drills: list[dict[str, Any]] = []
    ali_weekly_drill_total = 0
    ali_weekly_drill_table = compact_text(tables.get("ali_weekly_drills"))
    if ali_weekly_drill_table:
        ali_weekly_drill_records = list_base_records(
            base_token=base_token,
            table_id=ali_weekly_drill_table,
            field_ids=[
                "fldkUAsOit",
                "fldbewfuwn",
                "fldp8K8mAf",
                "fldrQ7hRsZ",
                "flda2Rdpjy",
                "fldrce5ldj",
                "fld3RpgHM5",
                "fldxUFisWU",
                "fld1pGK7gu",
                "flde4BSg3e",
                "fldiG6FxZ1",
                "fldmAeCYBX",
            ],
            identity=identity,
            max_pages=max_pages,
            view_id=str(config.get("ali_weekly_drills_view_id") or ""),
            filter_json=date_range_filter("flda2Rdpjy", period),
            sort_json=[{"field": "flda2Rdpjy", "desc": False}],
        )
        ali_weekly_drill_total = len(ali_weekly_drill_records)
        for record in ali_weekly_drill_records:
            fields = normalize_record(record)
            if record_in_period(fields, ["演练日期"], period):
                item = normalize_ali_weekly_drill(fields)
                if any(compact_text(value) for value in item.values()):
                    ali_weekly_drills.append(item)

    maintenance, maintenance_total = filtered_table_records(
        base_token=base_token,
        table_id=str(tables["maintenance"]),
        field_ids=[
            "维护描述",
            "是否为本周",
            "日期（公式）",
            "机楼",
            "完成率",
            "完成及时率",
            "正常结束数量",
            "实际应完成数量",
            "应完成数量",
        ],
        identity=identity,
        max_pages=max_pages,
        period=period,
        date_fields=["日期（公式）"],
        marker_fields=["是否为本周"],
        normalizer=normalize_maintenance,
    )

    abnormal_maintenance: list[dict[str, Any]] = []
    abnormal_maintenance_total = 0
    abnormal_maintenance_table = compact_text(tables.get("abnormal_maintenance"))
    if abnormal_maintenance_table:
        abnormal_maintenance_records = list_base_records(
            base_token=base_token,
            table_id=abnormal_maintenance_table,
            field_ids=[
                "维护总项",
                "维护实施状态",
                "类别",
                "维护模式",
                "楼栋",
                "维护编号",
                "专业类别",
                "维护项目",
                "计划开始维护时间",
                "计划结束维护时间",
            ],
            identity=identity,
            max_pages=max_pages,
            view_id=str(config.get("abnormal_maintenance_view_id") or ""),
        )
        abnormal_maintenance_total = len(abnormal_maintenance_records)
        abnormal_maintenance = [
            normalize_abnormal_maintenance(normalize_record(record))
            for record in abnormal_maintenance_records
            if normalize_record(record)
        ]

    cabinet_capacity, cabinet_capacity_total = filtered_table_records(
        base_token=base_token,
        table_id=str(tables["cabinet_capacity"]),
        field_ids=[
            "是否为本周",
            "日期",
            "楼栋",
            "本周上电机柜数（个）",
            "本周下电机柜数（个）",
            "实际上电机柜数（个）",
            "机房总规划机柜数（个）",
            "上电率",
        ],
        identity=identity,
        max_pages=max_pages,
        period=period,
        date_fields=["日期"],
        marker_fields=["是否为本周"],
        normalizer=normalize_cabinet,
    )

    cabinet_handover, cabinet_handover_total = filtered_table_records(
        base_token=base_token,
        table_id=str(tables["cabinet_handover"]),
        field_ids=[
            "fldrBLnkdr",
            "fldkCWHqlj",
            "fld6CearKq",
            "fldaeIqflp",
            "fld3mxdP7P",
            "fldjmoIEj4",
            "fldbVueScf",
            "fldEUqJFa6",
        ],
        identity=identity,
        max_pages=max_pages,
        period=period,
        date_fields=["日期"],
        marker_fields=["是否为本周"],
        server_date_field="fldkCWHqlj",
        normalizer=normalize_cabinet,
    )

    eop_records = list_base_records(
        base_token=base_token,
        table_id=str(tables["eop"]),
        field_ids=["编号", "精简版EOP", "演练场景", "文件名", "优先级", "文件状态", "知识库链接", "记录链接"],
        identity=identity,
        max_pages=1,
    )
    eop_references = [normalize_eop(normalize_record(record)) for record in eop_records[:20]]

    purchase_summary: list[dict[str, Any]] = []
    purchase_summary_total = 0
    purchase_summary_table = compact_text(tables.get("purchase_summary"))
    if purchase_summary_table:
        purchase_summary, purchase_summary_total = filtered_table_records(
            base_token=base_token,
            table_id=purchase_summary_table,
            field_ids=["楼栋", "采购汇总", "采购预估价格", "是否本周"],
            identity=identity,
            max_pages=max_pages,
            period=period,
            date_fields=[],
            marker_fields=["是否本周"],
            normalizer=normalize_purchase_summary,
        )

    meeting_todos, ali_meeting_todos = weekly_record_todos(weekly)

    return NantongWeeklyData(
        title=format_report_title(period),
        start_date=period.start.isoformat(),
        end_date=period.end.isoformat(),
        week_number=period.week_number,
        last_todos=split_items(weekly.get("上周遗留项")),
        meeting_todos=meeting_todos,
        ali_meeting_todos=ali_meeting_todos,
        weekly_backlog=weekly.get("本周代办", ""),
        professional_line=weekly.get("专业线", ""),
        professional_line_xml=professional_line_xml,
        professional_line_archive=professional_line_archive,
        professional_line_source=previous_report_doc,
        professional_line_error=professional_line_error,
        operation_line=weekly.get("运营线", ""),
        operation_line_xml=operation_line_xml,
        operation_line_archive=operation_line_archive,
        operation_line_source=previous_report_doc,
        operation_line_error=operation_line_error,
        events=events,
        changes=changes,
        drills=planned_drills,
        maintenance=maintenance,
        abnormal_maintenance=abnormal_maintenance,
        ali_weekly_drills=ali_weekly_drills,
        cabinet_capacity=cabinet_capacity,
        cabinet_handover=cabinet_handover,
        purchase_summary=purchase_summary,
        ali_drill_references=ali_drills,
        eop_references=eop_references,
        previous_safety_backlog=previous_safety_backlog,
        next_week_work=next_week_work,
        sources={
            "weekly_records": len(weekly_records),
            "weekly_input_record_id": weekly.get("_record_id", ""),
            "current_report_source": current_report_doc,
            "previous_report_source": previous_report_doc,
            "professional_line_copied": bool(professional_line_xml),
            "professional_line_error": professional_line_error,
            "operation_line_copied": bool(operation_line_xml),
            "operation_line_error": operation_line_error,
            "previous_memory_loaded": bool(previous_safety_backlog or next_week_work),
            "previous_memory_error": previous_memory_error,
            "events_total": event_total,
            "events": len(events),
            "changes_total": change_total,
            "changes": len(changes),
            "planned_drills_total": planned_drill_total,
            "planned_drills": len(planned_drills),
            "drill_source_enabled": bool(config.get("drill_source_table_id")),
            "ali_drill_references": len(ali_drills),
            "ali_weekly_drills_total": ali_weekly_drill_total,
            "ali_weekly_drills": len(ali_weekly_drills),
            "maintenance_total": maintenance_total,
            "maintenance": len(maintenance),
            "abnormal_maintenance_total": abnormal_maintenance_total,
            "abnormal_maintenance": len(abnormal_maintenance),
            "cabinet_capacity_total": cabinet_capacity_total,
            "cabinet_capacity": len(cabinet_capacity),
            "cabinet_handover_total": cabinet_handover_total,
            "cabinet_handover": len(cabinet_handover),
            "purchase_summary_total": purchase_summary_total,
            "purchase_summary": len(purchase_summary),
            "eop_references": len(eop_references),
            "meeting_todos": len(meeting_todos),
            "ali_meeting_todos": len(ali_meeting_todos),
            "meeting_source": weekly.get("_record_id", ""),
            "meeting_created_at": weekly.get("日期", ""),
        },
    )


def extract_doc_result(payload: Any) -> tuple[str, str]:
    if not isinstance(payload, dict):
        return "", ""
    document = ((payload.get("data") or {}).get("document") or {}) if isinstance(payload.get("data"), dict) else {}
    url = str(document.get("url") or "")
    doc_id = str(document.get("document_id") or "")
    return url, doc_id


def create_report_doc(xml: str, config: dict[str, Any]) -> tuple[str, str, Any]:
    args = ["docs", "+create", "--api-version", "v2", "--as", str(config.get("doc_identity") or "bot")]
    parent_token = str(config.get("report_parent_token") or "").strip()
    parent_position = str(config.get("report_parent_position") or "").strip()
    if parent_token:
        args.extend(["--parent-token", parent_token])
    elif parent_position:
        args.extend(["--parent-position", parent_position])
    with content_arg(xml, "nantong_weekly_report_create") as content:
        payload = run_lark_cli(args + ["--content", content], timeout=300)
    url, doc_id = extract_doc_result(payload)
    if not url and not doc_id:
        raise RuntimeError("云文档已调用创建，但返回中没有文档 URL 或 token")
    return url, doc_id, payload


def doc_token_from_link(value: str) -> str:
    token = extract_meeting_token(value)
    return token.token if token.kind in {"docx", "doc"} else ""


def update_report_doc(doc: str, xml: str, config: dict[str, Any]) -> Any:
    if not doc:
        raise ValueError("缺少要更新的周报云文档链接或 token")
    args = [
        "docs",
        "+update",
        "--api-version",
        "v2",
        "--doc",
        doc,
        "--command",
        "overwrite",
        "--as",
        str(config.get("doc_identity") or "bot"),
    ]
    with content_arg(xml, "nantong_weekly_report_update") as content:
        return run_lark_cli(args + ["--content", content], timeout=300)


def grant_report_edit_permission_to_chats(doc_token: str, chat_ids: list[str], config: dict[str, Any]) -> dict[str, Any]:
    doc_token = str(doc_token or "").strip()
    chat_ids = [chat_id for chat_id in chat_ids if str(chat_id or "").strip()]
    if not doc_token or not chat_ids:
        return {"ok": False, "skipped": True, "reason": "doc_token or chat_id not configured"}
    identity = str(config.get("permission_identity") or config.get("doc_identity") or "bot")
    results: list[dict[str, Any]] = []
    for chat_id in chat_ids:
        payload = run_lark_cli(
            [
                "drive",
                "permission.members",
                "create",
                "--params",
                json.dumps({"token": doc_token, "type": "docx", "need_notification": False}, ensure_ascii=False),
                "--data",
                json.dumps(
                    {
                        "member_type": "openchat",
                        "member_id": chat_id,
                        "perm": "edit",
                        "type": "chat",
                    },
                    ensure_ascii=False,
                ),
                "--yes",
                "--as",
                identity,
            ],
            timeout=180,
        )
        results.append({"chat_id": chat_id, "identity": identity, "result": payload})
    return {"ok": True, "chat_ids": chat_ids, "identity": identity, "results": results}


def find_heading_block_id(doc: str, heading: str, identity: str) -> str:
    payload = run_lark_cli(
        [
            "docs",
            "+fetch",
            "--api-version",
            "v2",
            "--doc",
            doc,
            "--scope",
            "keyword",
            "--keyword",
            heading,
            "--detail",
            "with-ids",
            "--as",
            identity,
        ],
        timeout=180,
    )
    content = ""
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, dict):
            document = data.get("document")
            if isinstance(document, dict):
                content = str(document.get("content") or "")
    for match in re.finditer(r"<(h[1-6])\b([^>]*)>(.*?)</\1>", content, re.S):
        text = re.sub(r"<[^>]+>", "", match.group(3)).strip()
        if text == heading:
            attr = match.group(2)
            id_match = re.search(r'\bid="([^"]+)"', attr)
            if id_match:
                return id_match.group(1)
    return ""


def update_report_todos(doc: str, todos: list[str], config: dict[str, Any]) -> Any:
    if not doc:
        raise ValueError("缺少要更新的周报云文档 token 或链接")
    xml_content = render_todo_insert_xml(todos)
    markdown_content = render_todo_insert_markdown(todos)
    identity = str(config.get("doc_identity") or "bot")
    args = [
        "docs",
        "+update",
        "--api-version",
        "v2",
        "--doc",
        doc,
        "--as",
        identity,
    ]
    current_todo_section = ""
    with contextlib.suppress(Exception):
        current_markdown = fetch_doc_markdown_content(doc, identity)
        for heading in ("上周内部周会待办", "会议纪要待办事项"):
            current_todo_section = extract_markdown_heading_section(current_markdown, heading)
            if current_todo_section:
                break
    if current_todo_section:
        with content_arg(markdown_content, "nantong_weekly_report_todos_md") as content_file:
            return run_lark_cli(
                args
                + [
                    "--command",
                    "str_replace",
                    "--doc-format",
                    "markdown",
                    "--pattern",
                    current_todo_section,
                    "--content",
                    content_file,
                ],
                timeout=180,
            )
    block_id = ""
    with contextlib.suppress(Exception):
        block_id = find_heading_block_id(doc, "阿里周会待办", identity)
        if not block_id:
            block_id = find_heading_block_id(doc, "本周待办事项", identity)
    with content_arg(xml_content, "nantong_weekly_report_todos") as content_file:
        if block_id:
            payload = run_lark_cli(
                args + ["--command", "block_insert_after", "--block-id", block_id, "--content", content_file],
                timeout=180,
            )
            with contextlib.suppress(Exception):
                run_lark_cli(
                    args
                    + [
                        "--command",
                        "str_replace",
                        "--pattern",
                        "待会议纪要链接提交后补充。",
                        "--content",
                        "",
                    ],
                    timeout=120,
                )
            return payload
        return run_lark_cli(args + ["--command", "append", "--content", content_file], timeout=180)


@contextlib.contextmanager
def weekly_record_write_lock(config: dict[str, Any]) -> Iterable[None]:
    key = uuid.uuid5(uuid.NAMESPACE_URL, f"{config['base_token']}:{config['tables']['weekly']}").hex
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR)
        kernel32.CreateMutexW.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = kernel32.CreateMutexW(None, False, f"Global\\SuiXinJiWeeklyRecords-{key}")
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        exists = ctypes.get_last_error() == 183
        try:
            if exists:
                raise RuntimeError("另一个周报进程正在写入多维表，请稍后重试")
            yield
        finally:
            kernel32.CloseHandle(handle)
        return
    import fcntl
    with (Path(tempfile.gettempdir()) / f"suixinji-weekly-{key}.lock").open("a+b") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("另一个周报进程正在写入多维表，请稍后重试") from exc
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def serialize_weekly_writes(function):
    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        config = kwargs.get("config") or args[-1]
        with weekly_record_write_lock(config):
            return function(*args, **kwargs)
    return wrapped


def verify_weekly_record_write(result: Any, expected: dict[str, Any], config: dict[str, Any], rid: str = "") -> None:
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise ValueError("周报条目写入未确认成功")
    data = result.get("data") or {}
    returned = data.get("record") if isinstance(data, dict) else None
    rid = rid or (record_id(returned) if isinstance(returned, dict) else "")
    if not rid:
        returned_records = extract_records(result)
        rid = record_id(returned_records[0]) if len(returned_records) == 1 else ""
    if not rid:
        raise ValueError("周报条目写入缺少 record_id，无法回读确认")
    readback = run_lark_cli([
        "base", "+record-get", "--base-token", str(config["base_token"]),
        "--table-id", str(config["tables"]["weekly"]), "--record-id", rid,
        "--as", str(config.get("base_identity") or "bot"), "--format", "json",
    ])
    records = extract_records(readback)
    if len(records) != 1 or record_id(records[0]) != rid:
        raise ValueError("周报条目回读失败")
    fields = normalize_record(records[0])
    for name, value in expected.items():
        actual = fields.get(name, "")
        if name == "日期":
            matches = parse_any_date(actual) == parse_any_date(value)
        elif name == "链接":
            matches = doc_token_from_link(extract_first_url(actual)) == doc_token_from_link(value)
        else:
            matches = actual.replace("\r\n", "\n") == str(value or "").replace("\r\n", "\n")
        if not matches:
            raise ValueError(f"周报条目回读不一致：{name}")


@serialize_weekly_writes
def upsert_weekly_report_link(data: NantongWeeklyData, doc_url: str, config: dict[str, Any]) -> Any:
    if not doc_url:
        return {}
    base_token = str(config["base_token"])
    table_id = str(config["tables"]["weekly"])
    identity = str(config.get("base_identity") or "bot")
    records = list_base_records(
        base_token=base_token,
        table_id=table_id,
        field_ids=["日期", "创建时间", "第几周", "链接", "专业线", "运营线"],
        identity=identity,
        max_pages=int(config.get("max_pages") or 10),
        view_id="",
        require_complete=True,
    )
    period = weekly_period_from_dates(data.start_date, data.end_date)
    target = current_weekly_record(records, period)
    target_doc_token = doc_token_from_link(doc_url)
    for record in records:
        archived_url = extract_first_url(normalize_record(record).get("链接"))
        if not archived_url:
            continue
        archived_doc_token = doc_token_from_link(archived_url)
        if (target_doc_token and archived_doc_token == target_doc_token) or archived_url == doc_url:
            if record_id(record) != compact_text(target.get("_record_id")):
                raise ValueError("该云文档已归档到其他周，停止覆盖")
            archived = normalize_record(record)
            expected_lines = {
                "专业线": data.professional_line_archive or data.professional_line,
                "运营线": data.operation_line_archive or data.operation_line,
            }
            if all(archived.get(name, "").replace("\r\n", "\n") == str(value or "").replace("\r\n", "\n")
                   for name, value in expected_lines.items()):
                return {
                    "ok": True,
                    "skipped": True,
                    "reason": "weekly report document and archived lines are unchanged",
                    "record_id": record_id(record),
                }
    payload = {
        "日期": data.end_date,
        "链接": doc_url,
        "专业线": data.professional_line_archive or data.professional_line,
        "运营线": data.operation_line_archive or data.operation_line,
    }
    args = [
        "base",
        "+record-upsert",
        "--base-token",
        base_token,
        "--table-id",
        table_id,
        "--json",
        json.dumps(payload, ensure_ascii=False),
        "--as",
        identity,
    ]
    if target:
        rid = compact_text(target.get("_record_id"))
        if not rid:
            raise ValueError("本周预建条目缺少 record_id，停止归档")
        args.extend(["--record-id", rid])
    result = run_lark_cli(args, timeout=180, retry=bool(target))
    verify_weekly_record_write(result, payload, config, compact_text(target.get("_record_id")))
    return result


def resolve_chat_ids(value: Any) -> list[str]:
    if isinstance(value, (list, tuple, set)):
        raw = "\n".join(str(item or "") for item in value)
    else:
        raw = str(value or "")
    chat_ids: list[str] = []
    seen: set[str] = set()
    for item in re.split(r"[\s,，;；]+", raw):
        chat_id = item.strip()
        if not chat_id or chat_id in seen:
            continue
        seen.add(chat_id)
        chat_ids.append(chat_id)
    return chat_ids


def send_report_message(data: NantongWeeklyData, report_url: str, config: dict[str, Any]) -> dict[str, Any]:
    chat_ids = resolve_chat_ids(config.get("chat_id") or os.getenv("NANTONG_WEEKLY_REPORT_CHAT_ID") or os.getenv("OPS_REPORT_CHAT_ID"))
    if not chat_ids:
        return {"ok": False, "skipped": True, "reason": "chat_id not configured"}
    markdown = "\n".join(
        [
            f"**{data.title}**",
            "",
            f"周期：{data.start_date} ~ {data.end_date}",
            (
                f"事件：{len(data.events)} 条；变更：{len(data.changes)} 条；"
                f"演练：{len(data.drills)} 条；维护：{len(data.maintenance)} 条；"
                f"机柜：{len(data.cabinet_handover)} 条"
            ),
            "",
            f"[打开周报]({report_url})",
        ]
    )
    identity = str(config.get("message_identity") or "bot")
    results: list[dict[str, Any]] = []
    message_key = uuid.uuid5(uuid.NAMESPACE_URL, report_url or f"{data.title}:{time.time()}").hex[:16]
    for chat_id in chat_ids:
        payload = run_lark_cli(
            [
                "im",
                "+messages-send",
                "--chat-id",
                chat_id,
                "--markdown",
                markdown,
                "--idempotency-key",
                f"nantong-weekly:{chat_id[-8:]}:{data.end_date.replace('-', '')}:{message_key}",
                "--as",
                identity,
            ],
            timeout=180,
        )
        results.append({"chat_id": chat_id, "identity": identity, "result": payload})
    return {"ok": True, "chat_ids": chat_ids, "identity": identity, "results": results}


def extract_todos_from_notes_payload(payload: Any) -> list[str]:
    todos: list[str] = []

    def add(value: Any) -> None:
        text = todo_to_text(value)
        if text and text not in todos:
            todos.append(text)

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if str(key).lower() in {"todos", "todo_list", "action_items", "actions"} or str(key) in {"待办事项", "行动项"}:
                    if isinstance(child, list):
                        for item in child:
                            add(item)
                    else:
                        add(child)
                else:
                    walk(child)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(payload)
    return todos


def todo_to_text(value: Any) -> str:
    if isinstance(value, str):
        return clean_todo_text(value)
    if not isinstance(value, dict):
        return clean_todo_text(value)
    content = ""
    for key in ("content", "text", "title", "summary", "name", "任务", "待办"):
        if value.get(key):
            content = stringify_cell(value[key])
            break
    if not content:
        return ""
    extras: list[str] = []
    for label, keys in {
        "负责人": ("assignee", "owner", "负责人"),
        "截止": ("due_time", "deadline", "due_date", "截止时间", "截止"),
    }.items():
        for key in keys:
            if value.get(key):
                extra = clean_todo_text(stringify_cell(value[key]))
                if extra:
                    extras.append(f"{label}：{extra}")
                break
    return clean_todo_text(content if not extras else f"{content}（{'，'.join(extras)}）")


def normalize_section_marker(line: str) -> str:
    text = str(line or "").strip()
    text = re.sub(r"^#{1,6}\s*", "", text)
    text = re.sub(r"^[-+*•]\s*(?:\[[ xX]\]|☐|□|☑|✅)?\s*", "", text)
    text = re.sub(r"^(?:\[[ xX]\]|☐|□|☑|✅)\s*", "", text)
    text = re.sub(r"\\([*_`])", r"\1", text)
    return normalize_markdown_line(clean_markdown_item(text))


def is_todo_section_stop_line(line: str) -> bool:
    if re.match(r"^#{1,6}\s+", line):
        return True
    normalized = normalize_section_marker(line)
    if not normalized:
        return False
    if normalized in {
        "各楼工作汇报",
        "工作汇报",
        "本周工作汇报",
        "上周工作汇报",
        "会议总结",
        "总结",
        "会议内容",
        "工作内容",
    }:
        return True
    if re.fullmatch(r"[A-EＡ-Ｅ一二三四五]楼", normalized, flags=re.I):
        return True
    return False


def is_generated_weekly_report_content(content: str) -> bool:
    text = str(content or "")
    normalized = normalize_markdown_line(text[:5000])
    return (
        "南通机房运维周报" in text[:500]
        or ("本周周会内容" in normalized and "本周待办事项" in normalized)
        or ("管理线" in normalized and "专业线" in normalized and "本周待办事项" in normalized)
    )


def is_todo_section_start_line(line: str) -> bool:
    normalized = normalize_section_marker(line).upper()
    return normalized in {
        "待办",
        "待办事项",
        "本周待办事项",
        "会议纪要待办事项",
        "行动项",
        "TODO",
        "TODOS",
    }


def extract_todos_from_text(text: str) -> list[str]:
    todos: list[str] = []
    in_todo_section = False
    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if is_todo_section_start_line(line):
            in_todo_section = True
            continue
        if not in_todo_section:
            continue
        if is_todo_section_stop_line(line):
            break
        if re.match(r"^<task\b", line, flags=re.I):
            continue
        prefix_match = re.match(r"^(?:[-*•]\s*)?(?:\[[ xX]\]|☐|□|☑|✅)\s*(.+)$", line)
        numbered_match = re.match(r"^(?:\d+[.、)]|[（(]?\d+[）)])\s*(.+)$", line)
        candidate = ""
        if prefix_match:
            candidate = prefix_match.group(1)
        elif numbered_match:
            candidate = numbered_match.group(1)
        elif re.match(r"^[-*•]\s+", line):
            candidate = re.sub(r"^[-*•]\s+", "", line)
        if candidate:
            candidate = clean_todo_text(candidate)
            if candidate and candidate not in todos:
                todos.append(candidate)
    return todos


def extract_task_ids_from_text(text: str) -> list[str]:
    task_ids: list[str] = []
    for task_id in re.findall(r"<task\b[^>]*\btask-id=[\"']([^\"']+)[\"'][^>]*>", str(text or ""), flags=re.I):
        if task_id and task_id not in task_ids:
            task_ids.append(task_id)
    return task_ids


def extract_task_summary_from_payload(payload: Any) -> str:
    candidates: list[Any] = []

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            for key in ("summary", "title", "content", "text", "name", "任务", "待办"):
                if value.get(key):
                    candidates.append(value[key])
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(payload)
    for candidate in candidates:
        text = todo_to_text(candidate)
        if text:
            return text
    return ""


def task_id_read_identities(config: dict[str, Any]) -> list[str]:
    identities: list[str] = []
    for value in (config.get("task_identity"), config.get("notes_identity"), config.get("doc_identity"), "bot"):
        identity = str(value or "").strip()
        if identity and identity not in identities:
            identities.append(identity)
    return identities


def extract_todos_from_task_ids(task_ids: list[str], config: dict[str, Any]) -> list[str]:
    todos: list[str] = []
    disabled_identities: set[str] = set()
    for task_id in task_ids:
        for identity in task_id_read_identities(config):
            if identity in disabled_identities:
                continue
            try:
                payload = run_lark_cli(
                    [
                        "task",
                        "tasks",
                        "get",
                        "--params",
                        json.dumps({"task_guid": task_id, "user_id_type": "open_id"}, ensure_ascii=False),
                        "--as",
                        identity,
                    ],
                    timeout=120,
                )
            except RuntimeError:
                disabled_identities.add(identity)
                continue
            text = extract_task_summary_from_payload(payload)
            if text and text not in todos:
                todos.append(text)
                break
    return todos


def lark_user_identity_ready() -> bool:
    try:
        payload = run_lark_cli(["auth", "status"], timeout=60)
    except RuntimeError:
        return False
    if not isinstance(payload, dict):
        return False
    identities = payload.get("identities")
    if not isinstance(identities, dict):
        return False
    user = identities.get("user")
    if not isinstance(user, dict):
        return False
    return bool(user.get("available")) or str(user.get("status") or "").lower() == "ready"


def task_permission_error_message() -> str:
    if not lark_user_identity_ready():
        return (
            "会议纪要包含飞书原生待办，但运行机器未登录 lark-cli user，无法读取待办标题；"
            "请在项目根目录执行 scripts\\authorize_lark_user_task.ps1 完成一次授权"
        )
    return (
        "会议纪要包含飞书原生待办，但当前登录 user 或 bot 不是这些待办的参与者，无法读取待办标题；"
        "请使用待办可见账号重新执行 scripts\\authorize_lark_user_task.ps1 授权"
    )


def extract_todos_from_followup_plan(text: str) -> list[str]:
    todos: list[str] = []
    collecting = False
    start_keywords = ("后续工作计划", "后续计划", "下一步", "下周工作", "工作计划")
    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        heading_match = re.match(r"^#{1,6}\s*(.+?)\s*$", line)
        if heading_match:
            heading = normalize_markdown_line(heading_match.group(1))
            if any(keyword in heading for keyword in start_keywords):
                collecting = True
                continue
            if collecting:
                break
        elif not collecting and normalize_markdown_line(clean_markdown_item(line)) in start_keywords:
            collecting = True
            continue
        if not collecting:
            continue
        if re.match(r"^<task\b", line, flags=re.I):
            break
        if re.match(r"^#{1,6}\s+", line):
            break
        if not re.match(r"^(?:[-+*•]\s+|\d+[.、)]\s+|[（(]?\d+[）)]\s+)", line):
            continue
        candidate = clean_todo_text(clean_markdown_item(line))
        if candidate and candidate not in todos:
            todos.append(candidate)
    return todos


def extract_todos_from_meeting_link(meeting_url: str, config: dict[str, Any]) -> list[str]:
    token = extract_meeting_token(meeting_url)
    if token.kind == "minutes":
        payload = run_lark_cli(
            [
                "vc",
                "+notes",
                "--minute-tokens",
                token.token,
                "--format",
                "json",
                "--as",
                str(config.get("notes_identity") or "user"),
            ],
            timeout=240,
        )
        todos = extract_todos_from_notes_payload(payload)
        if todos:
            return todos
    payload = run_lark_cli(
        [
            "docs",
            "+fetch",
            "--api-version",
            "v2",
            "--doc",
            meeting_url,
            "--doc-format",
            "markdown",
            "--as",
            str(config.get("doc_identity") or "bot"),
        ],
        timeout=180,
    )
    content = ""
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, dict):
            document = data.get("document")
            if isinstance(document, dict):
                content = str(document.get("content") or "")
    if is_generated_weekly_report_content(content):
        raise ValueError("当前链接是已生成的周报页，不是会议纪要链接；请在控制台填写源会议纪要链接")
    task_ids = extract_task_ids_from_text(content)
    visible_todos = extract_todos_from_text(content)
    if task_ids:
        task_todos = extract_todos_from_task_ids(task_ids, config)
        combined_todos = normalize_todo_list(task_todos + visible_todos)
        if combined_todos:
            return combined_todos
        raise ValueError(task_permission_error_message())
    if visible_todos:
        return visible_todos
    return []


def extract_optional_todos_from_meeting_link(meeting_url: str, config: dict[str, Any]) -> tuple[list[str], str]:
    try:
        todos = normalize_todo_list(extract_todos_from_meeting_link(meeting_url, config))
    except Exception as exc:
        return [], str(exc)
    if not todos:
        return [], "会议纪要中未识别到待办事项"
    return todos, ""


def upsert_meeting_todos(meeting_url: str, todos: list[str], config: dict[str, Any]) -> Any:
    base_token = str(config["base_token"])
    table_id = str(config["tables"]["meeting"])
    identity = str(config.get("base_identity") or "bot")
    cleaned_todos = normalize_todo_list(todos)
    payload = {
        "妙记链接": meeting_url,
        "代办事项": "\n".join(cleaned_todos),
    }
    existing_record_id = existing_meeting_record_id(meeting_url, config)
    args = [
        "base",
        "+record-upsert",
        "--base-token",
        base_token,
        "--table-id",
        table_id,
        "--json",
        json.dumps(payload, ensure_ascii=False),
        "--as",
        identity,
    ]
    if existing_record_id:
        args.extend(["--record-id", existing_record_id])
    return run_lark_cli(
        args,
        timeout=180,
    )


def read_state() -> dict[str, Any]:
    if not SCHEDULER_STATE_FILE.exists():
        return {}
    try:
        payload = json.loads(SCHEDULER_STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("周报状态读取失败，已停止写入；请保留原状态文件并核对恢复") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("周报状态格式错误，已停止写入")
    return payload


def write_state(patch: dict[str, Any]) -> dict[str, Any]:
    state = read_state()
    state.update(patch)
    RUNTIME_LOG_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = SCHEDULER_STATE_FILE.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp_path.replace(SCHEDULER_STATE_FILE)
    return state


def append_log(message: str, *, file: Path = SCHEDULER_LOG_FILE) -> None:
    RUNTIME_LOG_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S")
    with file.open("a", encoding="utf-8") as handle:
        handle.write(f"{timestamp} {message}\n")


def run_once(
    reference_date: str = "",
    *,
    manual_window: bool = False,
    start_date: str = "",
    end_date: str = "",
    force_new_report: bool = False,
) -> dict[str, Any]:
    ensure_lark_cli_config_from_env()
    config = read_config()
    state = read_state()
    period = (
        manual_period_for(reference_date or None, start_date=start_date or None, end_date=end_date or None, state=state)
        if manual_window
        else weekly_period_for(reference_date or None)
    )
    pending_period = compact_text(state.get("pending_report_period"))
    pending_status = compact_text(state.get("pending_report_status"))
    pending_operation_id = compact_text(state.get("pending_report_operation_id"))
    pending_doc = compact_text(state.get("pending_report_url") or state.get("pending_report_doc_token"))
    if pending_status == "creating" and not pending_doc:
        raise RuntimeError(
            "南通周报云文档创建结果未落盘；为避免重复创建已停止自动重试，"
            "请先在飞书云空间核对后清理 pending_report_* 状态"
        )
    if pending_period and pending_period != period.key and (pending_status or pending_doc):
        raise RuntimeError(
            f"存在未完成的南通周报任务 {pending_period}，请先完成或清理 pending_report_* 状态"
        )
    if not force_new_report and pending_period and (pending_status or pending_doc):
        raise RuntimeError(
            f"南通周报定时任务 {pending_period} 尚未完成，手工生成已停止；"
            "请先完成或清理 pending_report_* 状态"
        )
    if pending_period != period.key:
        pending_doc = ""
    data = collect_report_data(period, config)
    xml, stats = render_docx_xml(data)
    existing_doc = pending_doc or ("" if force_new_report else compact_text(data.sources.get("current_report_source")))
    create_payload: Any = {}
    update_payload: Any = {}
    reused_existing = bool(existing_doc)
    if existing_doc:
        update_payload = update_report_doc(existing_doc, xml, config)
        doc_url = existing_doc
        doc_token = doc_token_from_link(existing_doc)
    else:
        if force_new_report:
            pending_operation_id = pending_operation_id or f"nantong-weekly:{period.key}"
            write_state(
                {
                    "pending_report_period": period.key,
                    "pending_report_status": "creating",
                    "pending_report_operation_id": pending_operation_id,
                    "pending_report_url": "",
                    "pending_report_doc_token": "",
                }
            )
        doc_url, doc_token, create_payload = create_report_doc(xml, config)
        if force_new_report:
            write_state(
                {
                    "pending_report_period": period.key,
                    "pending_report_status": "document_created",
                    "pending_report_operation_id": pending_operation_id,
                    "pending_report_url": doc_url,
                    "pending_report_doc_token": doc_token,
                }
            )
    permission_payload: Any = {}
    permission_error = ""
    try:
        permission_payload = grant_report_edit_permission_to_chats(
            doc_token or doc_token_from_link(doc_url),
            resolve_chat_ids(config.get("chat_id") or os.getenv("NANTONG_WEEKLY_REPORT_CHAT_ID") or os.getenv("OPS_REPORT_CHAT_ID")),
            config,
        )
    except Exception as exc:
        permission_error = str(exc)
    link_payload = upsert_weekly_report_link(data, doc_url or doc_token, config)
    message_payload: Any = {}
    message_error = ""
    try:
        message_payload = send_report_message(data, doc_url or doc_token, config)
    except Exception as exc:
        message_error = str(exc)
    result = {
        "ok": True,
        "kind": "weekly",
        "report_title": data.title,
        "report_url": doc_url,
        "report_doc_token": doc_token,
        "period": period.key,
        "start_date": data.start_date,
        "end_date": data.end_date,
        "manual_window": manual_window,
        "force_new_report": force_new_report,
        "week_number": data.week_number,
        "todos": data.meeting_todos,
        "todo_count": len(data.meeting_todos),
        "stats": stats,
        "sources": data.sources,
        "created": create_payload,
        "updated": update_payload,
        "permission_grant": permission_payload,
        "permission_error": permission_error,
        "reused_existing_report": reused_existing,
        "link_upserted": bool(link_payload),
        "message_send": message_payload,
        "message_error": message_error,
        "finished_at": datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S"),
    }
    state_patch = {
        "last_success_at": result["finished_at"],
        "last_success_period": result["period"],
        "last_report_url": doc_url,
        "last_report_doc_token": doc_token,
        "last_report_title": data.title,
        "last_todo_update_at": result["finished_at"],
        "last_todo_meeting_url": data.sources.get("meeting_source", ""),
        "last_todo_count": len(data.meeting_todos),
        "last_error": "",
    }
    if force_new_report:
        state_patch.update(
            {
                "pending_report_period": "",
                "pending_report_status": "",
                "pending_report_operation_id": "",
                "pending_report_url": "",
                "pending_report_doc_token": "",
            }
        )
    write_state(state_patch)
    return result


def submit_todo_link(meeting_url: str, *, doc: str = "") -> dict[str, Any]:
    ensure_lark_cli_config_from_env()
    config = read_config()
    target_doc = doc or str(read_state().get("last_report_doc_token") or read_state().get("last_report_url") or "")
    if not target_doc:
        raise ValueError("没有可更新的周报云文档，请先生成本周周报或传入 --doc")
    todos, todo_warning = extract_optional_todos_from_meeting_link(meeting_url, config)
    if todo_warning:
        raise ValueError(f"会议待办读取未成功，未修改周报：{todo_warning}")
    update_payload = update_report_todos(target_doc, todos, config)
    meeting_payload: Any = {}
    with contextlib.suppress(Exception):
        meeting_payload = upsert_meeting_todos(meeting_url, todos, config)
    result = {
        "ok": True,
        "meeting_url": meeting_url,
        "report_doc": target_doc,
        "todos": todos,
        "todo_count": len(todos),
        "todo_warning": todo_warning,
        "updated": update_payload,
        "meeting_record_upserted": bool(meeting_payload),
        "finished_at": datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S"),
    }
    write_state(
        {
            "last_todo_update_at": result["finished_at"],
            "last_todo_meeting_url": meeting_url,
            "last_todo_count": len(todos),
            "last_todo_warning": todo_warning,
            "last_error": "",
        }
    )
    return result


def next_month_weekly_dates(reference: date, weekday: int = 3) -> list[date]:
    first = (reference.replace(day=1) + timedelta(days=32)).replace(day=1)
    current = first + timedelta(days=(weekday - first.weekday()) % 7)
    dates = []
    while current.month == first.month:
        dates.append(weekly_period_for(current).end)
        current += timedelta(days=7)
    return dates


def monthly_precreate_due(now: datetime, config: dict[str, Any], state: dict[str, Any]) -> bool:
    if not config.get("enabled") or not config.get("precreate_next_month"):
        return False
    if now.day != calendar.monthrange(now.year, now.month)[1]:
        return False
    hour, minute = map(int, normalize_time(str(config.get("precreate_at") or "02:00"), "02:00").split(":"))
    next_month = (now.date().replace(day=1) + timedelta(days=32)).replace(day=1).strftime("%Y-%m")
    return (now.hour, now.minute) >= (hour, minute) and state.get("last_precreated_month") != next_month


@serialize_weekly_writes
def precreate_next_month_records(reference: date, config: dict[str, Any]) -> dict[str, Any]:
    dates = next_month_weekly_dates(reference, int(config.get("schedule_weekday", 3)))
    identity = str(config.get("base_identity") or "bot")
    records = list_base_records(
        base_token=str(config["base_token"]), table_id=str(config["tables"]["weekly"]),
        field_ids=["日期", "第几周"], identity=identity, max_pages=int(config.get("max_pages") or 10),
        filter_json=date_range_filter("日期", weekly_period_from_dates(min(dates), max(dates))),
        require_complete=True,
    )
    missing = []
    for day in dates:
        period = weekly_period_from_dates(day - timedelta(days=6), day)
        if not current_weekly_record(records, period):
            missing.append(day)
    created = 0
    for day in missing:
        payload = {"日期": day.isoformat()}
        result = run_lark_cli([
            "base", "+record-upsert", "--base-token", str(config["base_token"]),
            "--table-id", str(config["tables"]["weekly"]), "--as", identity,
            "--json", json.dumps(payload, ensure_ascii=False),
        ], retry=False)
        verify_weekly_record_write(result, payload, config)
        created += 1
    target_month = (reference.replace(day=1) + timedelta(days=32)).replace(day=1).strftime("%Y-%m")
    return {"month": target_month, "created": created, "existing": len(dates) - created}


def scheduler_due(now: datetime, config: dict[str, Any], state: dict[str, Any]) -> bool:
    if not bool(config.get("enabled")):
        return False
    if now.weekday() != int(config.get("schedule_weekday") or 3):
        return False
    schedule_at = normalize_time(str(config.get("schedule_at") or "08:30"), "08:30")
    target_hour, target_minute = [int(part) for part in schedule_at.split(":", 1)]
    if (now.hour, now.minute) < (target_hour, target_minute):
        return False
    period = weekly_period_for(now)
    if state.get("skip_scheduled_period") == period.key:
        return False
    if state.get("last_success_period") == period.key:
        return False
    if not bool(config.get("catch_up")) and now.date() != period.end + timedelta(days=1):
        return False
    return True


def run_scheduler() -> int:
    append_log("[NANTONG-WEEKLY] 调度循环启动。")
    while True:
        try:
            config = read_config()
            state = read_state()
            now = datetime.now().astimezone()
            if monthly_precreate_due(now, config, state):
                ensure_lark_cli_config_from_env()
                prepared = precreate_next_month_records(now.date(), config)
                write_state({"last_precreated_month": prepared["month"]})
                append_log(f"[NANTONG-WEEKLY] 下月周报条目已准备：{prepared['month']}，新增{prepared['created']}条。")
            if scheduler_due(now, config, state):
                append_log("[NANTONG-WEEKLY] 到达周报生成时间，开始执行。")
                write_state({"last_attempt_at": now.strftime("%Y-%m-%d %H:%M:%S")})
                result = run_once(force_new_report=True)
                append_log(f"[NANTONG-WEEKLY] 生成完成：{result.get('report_url') or result.get('report_doc_token')}")
            time.sleep(int(config.get("poll_seconds") or 60))
        except KeyboardInterrupt:
            append_log("[NANTONG-WEEKLY] 调度循环停止。")
            return 0
        except Exception as exc:
            write_state({"last_error": str(exc), "last_error_at": datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S")})
            append_log(f"[NANTONG-WEEKLY] 调度异常：{exc}")
            time.sleep(60)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate Nantong operations weekly report.")
    parser.add_argument("--run-once", action="store_true", help="Generate the weekly report once.")
    parser.add_argument("--week-date", default="", help="Reference date for the Thu-Wed period, YYYY-MM-DD.")
    parser.add_argument("--manual-window", action="store_true", help="Use manual date window instead of the Thu-Wed schedule window.")
    parser.add_argument("--start-date", default="", help="Manual report start date, YYYY-MM-DD.")
    parser.add_argument("--end-date", default="", help="Manual report end date, YYYY-MM-DD.")
    parser.add_argument("--schedule", action="store_true", help="Run the weekly scheduler loop.")
    parser.add_argument("--todos", action="store_true", help="Read a meeting/minutes link and update the latest report.")
    parser.add_argument("--meeting-url", default="", help="Feishu minutes/doc link used with --todos.")
    parser.add_argument("--doc", default="", help="Report doc URL/token for --todos; defaults to latest generated report.")
    parser.add_argument("--print-config", action="store_true", help="Print effective config JSON.")
    return parser


def write_manual_log(result: dict[str, Any]) -> None:
    RUNTIME_LOG_DIR.mkdir(parents=True, exist_ok=True)
    with MANUAL_LOG_FILE.open("a", encoding="utf-8") as handle:
        handle.write(f"===== {datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S')} manual run =====\n")
        handle.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")


def main(argv: list[str] | None = None) -> int:
    load_local_env_file(override=True)
    args = build_parser().parse_args(argv)
    try:
        if args.print_config:
            print(json.dumps(read_config(), ensure_ascii=False, indent=2))
            return 0
        if args.schedule:
            return run_scheduler()
        if args.todos:
            if not args.meeting_url:
                raise ValueError("--todos 需要 --meeting-url")
            result = submit_todo_link(args.meeting_url, doc=args.doc)
            write_manual_log(result)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        if args.run_once:
            result = run_once(
                args.week_date,
                manual_window=args.manual_window,
                start_date=args.start_date,
                end_date=args.end_date,
            )
            write_manual_log(result)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        build_parser().print_help()
        return 2
    except Exception as exc:
        payload = {
            "ok": False,
            "error": str(exc),
            "finished_at": datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S"),
        }
        write_state({"last_error": str(exc), "last_error_at": payload["finished_at"]})
        write_manual_log(payload)
        print(json.dumps(payload, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
