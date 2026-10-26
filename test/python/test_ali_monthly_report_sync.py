from __future__ import annotations

import inspect
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
TOOL_DIR = ROOT / "tools" / "ali-monthly-report"

sys.path.insert(0, str(TOOL_DIR))
try:
    from ali_monthly_reports import feishu as feishu_module
    from ali_monthly_reports import cli as cli_module
    from ali_monthly_reports.config import ReportConfig
    from ali_monthly_reports.reports import (
        generate_alarm_analysis_report,
        generate_monthly_report,
        generate_staff_roster_report,
    )
    from ali_monthly_reports.feishu import (
        find_report_records,
        sync_alarm_report_attachment,
    )
finally:
    sys.path.remove(str(TOOL_DIR))


class AlarmAnalysisSyncTests(unittest.TestCase):
    def test_generated_alarm_report_is_synced_with_the_same_session(self) -> None:
        generate_calls: list[dict[str, Any]] = []
        sync_calls: list[dict[str, Any]] = []
        shared_session = object()

        def fake_generate_alarm_report(**kwargs: Any) -> dict[str, Any]:
            generate_calls.append(kwargs)
            Path(kwargs["out"]).write_bytes(b"alarm workbook")
            return {"alarm_count": 7}

        def fake_sync_alarm_report(**kwargs: Any) -> dict[str, Any]:
            sync_calls.append(kwargs)
            return {
                "action": "generated_and_uploaded",
                "uploaded": {
                    "record_id": "rec-created",
                    "record_url": "https://example.test/record/rec-created",
                },
                "message": "月度告警分析已生成并上传",
            }

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            template_path = Path(temp_dir) / "template.xlsx"
            template_path.write_bytes(b"template")
            config = ReportConfig(
                download_folder=temp_dir,
                feishu_app_id="app-id",
                feishu_app_secret="secret",
                feishu_app_token="base-token",
                ali_alarm_source_url="https://example.test/alarm-source",
                ali_alarm_template_path=str(template_path),
            )

            result = generate_alarm_analysis_report(
                "2026",
                7,
                config,
                token_provider=lambda _config: "tenant-token",
                session_builder=lambda _token: shared_session,
                generate_alarm_report_func=fake_generate_alarm_report,
                alarm_attachment_syncer=fake_sync_alarm_report,
            )

        self.assertEqual(result["action"], "generated_and_uploaded")
        self.assertEqual(result["alarm_count"], 7)
        self.assertEqual(len(sync_calls), 1)
        self.assertIs(generate_calls[0]["session"], shared_session)
        self.assertIs(sync_calls[0]["session"], shared_session)
        self.assertEqual(sync_calls[0]["year"], "2026")
        self.assertEqual(sync_calls[0]["month_number"], 7)
        self.assertEqual(Path(sync_calls[0]["file_path"]).name, "EA118机房2026年7月告警分析表.xlsx")

    def test_existing_month_record_is_updated_after_a_single_media_upload(self) -> None:
        updated_record_ids: list[str] = []
        upload_calls: list[Path] = []

        result = sync_alarm_report_attachment(
            config=ReportConfig(feishu_app_token="base-token"),
            session=object(),
            file_path=Path("alarm.xlsx"),
            year="2026",
            month_number=7,
            record_finder=lambda **_kwargs: [{"record_id": "rec-existing"}],
            file_uploader=lambda **kwargs: upload_calls.append(kwargs["file_path"]) or "file-token",
            record_updater=lambda **kwargs: updated_record_ids.append(kwargs["record_id"])
            or {"record_id": kwargs["record_id"]},
            record_creator=lambda **_kwargs: self.fail("存在同月记录时不应新增"),
        )

        self.assertEqual(upload_calls, [Path("alarm.xlsx")])
        self.assertEqual(updated_record_ids, ["rec-existing"])
        self.assertEqual(result["action"], "generated_and_updated")
        self.assertEqual(result["updated"]["record_id"], "rec-existing")
        self.assertIn("recordId=rec-existing", result["updated"]["record_url"])

    def test_missing_month_record_is_created_with_legacy_field_mapping(self) -> None:
        create_calls: list[dict[str, Any]] = []

        def fake_create(**kwargs: Any) -> dict[str, Any]:
            create_calls.append(kwargs)
            return {"record_id": "rec-created"}

        result = sync_alarm_report_attachment(
            config=ReportConfig(feishu_app_token="base-token"),
            session=object(),
            file_path=Path("alarm.xlsx"),
            year="2026",
            month_number=7,
            record_finder=lambda **_kwargs: [],
            file_uploader=lambda **_kwargs: "file-token",
            record_updater=lambda **_kwargs: self.fail("无同月记录时不应覆盖"),
            record_creator=fake_create,
        )

        self.assertEqual(result["action"], "generated_and_uploaded")
        self.assertEqual(result["uploaded"]["record_id"], "rec-created")
        self.assertEqual(create_calls[0]["year"], "2026")
        self.assertEqual(create_calls[0]["month_number"], 7)
        self.assertEqual(create_calls[0]["report_type_name"], "南通机房告警分析")


class StaffReportConfigTests(unittest.TestCase):
    def test_staff_report_table_defaults_to_personnel_change_target(self) -> None:
        config = ReportConfig()

        self.assertTrue(
            hasattr(config, "staff_report_table_config"),
            "ReportConfig 尚未提供人员变动目标表配置",
        )
        self.assertEqual(config.staff_report_table_config["table_id"], "tblf5fc5e5730d03")
        self.assertEqual(config.staff_report_table_config["view_id"], "PUBLIC_EXAMPLE_FEISHU_DAILY_REPORT_VIEW_ID")

    def test_cli_config_file_keeps_file_values_and_applies_non_empty_environment_overrides(self) -> None:
        captured_configs: list[ReportConfig] = []

        def fake_generate_monthly_report(
            _report_type: str,
            _year: str,
            _month_number: int,
            config: ReportConfig,
        ) -> dict[str, Any]:
            captured_configs.append(config)
            return {"files": []}

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "download_folder": "file-downloads",
                        "feishu_app_token": "file-token",
                        "staff_report_table_id": "file-table",
                        "staff_report_view_id": "file-view",
                    }
                ),
                encoding="utf-8",
            )
            args = SimpleNamespace(type="staff_roster", year="2026", month=7, config=str(config_path))

            with (
                patch.dict(
                    os.environ,
                    {
                        "FEISHU_APP_TOKEN": " env-token ",
                        "STAFF_REPORT_TABLE_ID": "env-table",
                        "STAFF_REPORT_VIEW_ID": "   ",
                    },
                    clear=True,
                ),
                patch.object(cli_module, "parse_args", return_value=args),
                patch.object(
                    cli_module,
                    "generate_monthly_report",
                    side_effect=fake_generate_monthly_report,
                ),
            ):
                self.assertEqual(cli_module.main(), 0)

        self.assertEqual(len(captured_configs), 1)
        config = captured_configs[0]
        self.assertEqual(config.download_folder, "file-downloads")
        self.assertEqual(config.feishu_app_token, "env-token")
        self.assertEqual(config.staff_report_table_id, "env-table")
        self.assertEqual(config.staff_report_view_id, "file-view")


class StaffReportSyncTests(unittest.TestCase):
    def test_generated_staff_report_is_synced_with_the_same_session(self) -> None:
        self.assertIn(
            "staff_attachment_syncer",
            inspect.signature(generate_staff_roster_report).parameters,
            "人员变动生成流程尚未接入多维表同步",
        )
        shared_session = object()
        fetch_calls: list[tuple[str, Any]] = []
        sync_calls: list[dict[str, Any]] = []

        def fake_fetch(url: str, session: Any) -> list[dict[str, Any]]:
            fetch_calls.append((url, session))
            return []

        def fake_sync(**kwargs: Any) -> dict[str, Any]:
            sync_calls.append(kwargs)
            return {
                "action": "generated_and_uploaded",
                "uploaded": {
                    "record_id": "rec-staff",
                    "record_url": "https://example.test/staff/rec-staff",
                },
                "message": "人员变动已生成并上传",
            }

        def fake_write_staff_roster(
            _active_records: list[dict[str, Any]],
            _all_records: list[dict[str, Any]],
            _month: str,
            output_path: Path,
        ) -> dict[str, int]:
            output_path.write_bytes(b"staff workbook")
            return {"active_count": 0, "new_hire_count": 0, "leaver_count": 0}

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir, patch(
            "ali_monthly_reports.reports.write_staff_roster_workbook",
            side_effect=fake_write_staff_roster,
        ):
            result = generate_staff_roster_report(
                "2026",
                7,
                ReportConfig(
                    download_folder=temp_dir,
                    feishu_app_id="app-id",
                    feishu_app_secret="secret",
                    feishu_app_token="base-token",
                    ali_staff_source_url="https://example.test/staff?view=active",
                ),
                token_provider=lambda _config: "tenant-token",
                session_builder=lambda _token: shared_session,
                fetch_records=fake_fetch,
                staff_attachment_syncer=fake_sync,
            )

        self.assertEqual(result["action"], "generated_and_uploaded")
        self.assertEqual(result["uploaded"]["record_url"], "https://example.test/staff/rec-staff")
        self.assertEqual(len(fetch_calls), 2)
        self.assertTrue(all(session is shared_session for _, session in fetch_calls))
        self.assertEqual(len(sync_calls), 1)
        self.assertIs(sync_calls[0]["session"], shared_session)
        self.assertEqual(sync_calls[0]["year"], "2026")
        self.assertEqual(sync_calls[0]["month_number"], 7)
        self.assertEqual(Path(sync_calls[0]["file_path"]).name, "南通机房2026年7月在职人员导出.xlsx")

    def test_existing_staff_month_record_is_updated_and_returns_record_url(self) -> None:
        syncer = getattr(feishu_module, "sync_staff_report_attachment", None)
        self.assertIsNotNone(syncer, "尚未提供人员变动附件同步入口")
        finder_calls: list[dict[str, Any]] = []
        updater_calls: list[dict[str, Any]] = []

        def fake_find(**kwargs: Any) -> list[dict[str, Any]]:
            finder_calls.append(kwargs)
            return [{"record_id": "rec-existing"}]

        result = syncer(
            config=ReportConfig(feishu_app_token="base-token"),
            session=object(),
            file_path=Path("staff.xlsx"),
            year="2026",
            month_number=7,
            record_finder=fake_find,
            file_uploader=lambda **_kwargs: "file-token",
            record_updater=lambda **kwargs: updater_calls.append(kwargs)
            or {"record_id": kwargs["record_id"]},
            record_creator=lambda **_kwargs: self.fail("存在同月人员变动记录时不应新增"),
        )

        self.assertEqual(finder_calls[0]["report_type_name"], "南通机房人员变动")
        self.assertEqual(finder_calls[0]["table_config"]["table_id"], "tblf5fc5e5730d03")
        self.assertEqual(finder_calls[0]["table_config"]["view_id"], "PUBLIC_EXAMPLE_FEISHU_DAILY_REPORT_VIEW_ID")
        self.assertEqual(updater_calls[0]["record_id"], "rec-existing")
        self.assertEqual(result["action"], "generated_and_updated")
        self.assertEqual(
            result["updated"]["record_url"],
            "https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE",
        )

    def test_missing_staff_month_record_is_created_without_fixed_record_id(self) -> None:
        syncer = getattr(feishu_module, "sync_staff_report_attachment", None)
        self.assertIsNotNone(syncer, "尚未提供人员变动附件同步入口")
        create_calls: list[dict[str, Any]] = []

        def fake_create(**kwargs: Any) -> dict[str, Any]:
            create_calls.append(kwargs)
            return {"record_id": "rec-created"}

        result = syncer(
            config=ReportConfig(feishu_app_token="base-token"),
            session=object(),
            file_path=Path("staff.xlsx"),
            year="2026",
            month_number=7,
            record_finder=lambda **_kwargs: [],
            file_uploader=lambda **_kwargs: "file-token",
            record_updater=lambda **_kwargs: self.fail("无同月人员变动记录时不应覆盖"),
            record_creator=fake_create,
        )

        self.assertEqual(create_calls[0]["report_type_name"], "南通机房人员变动")
        self.assertEqual(create_calls[0]["year"], "2026")
        self.assertEqual(create_calls[0]["month_number"], 7)
        self.assertNotIn("record_id", create_calls[0])
        self.assertEqual(result["action"], "generated_and_uploaded")
        self.assertEqual(result["uploaded"]["record_id"], "rec-created")
        self.assertIn("recordId=rec-created", result["uploaded"]["record_url"])


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self.payload


class _RecordingSession:
    def __init__(self, payloads: list[dict[str, Any]]) -> None:
        self.payloads = list(payloads)
        self.calls: list[dict[str, Any]] = []

    def post(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append({"url": url, **kwargs})
        return _FakeResponse(self.payloads.pop(0))


class AlarmRecordSearchTests(unittest.TestCase):
    def test_target_lookup_filters_on_server_and_keeps_month_7_07_compatibility(self) -> None:
        session = _RecordingSession(
            [
                {
                    "code": 0,
                    "data": {
                        "items": [
                            {
                                "record_id": "rec-07",
                                "fields": {
                                    "月报类型": "南通机房告警分析",
                                    "年度": "2026",
                                    "月份": "07",
                                },
                            },
                            {
                                "record_id": "rec-other-month",
                                "fields": {
                                    "月报类型": "南通机房告警分析",
                                    "年度": "2026",
                                    "月份": "08",
                                },
                            },
                        ],
                        "has_more": False,
                    },
                }
            ]
        )

        records = find_report_records(
            app_token="base-token",
            table_config={"table_id": "tbl-alarm", "view_id": "vew-alarm"},
            session=session,
            year="2026",
            month_number=7,
            report_type_name="南通机房告警分析",
        )

        self.assertEqual([item["record_id"] for item in records], ["rec-07"])
        self.assertEqual(len(session.calls), 1)
        self.assertTrue(session.calls[0]["url"].endswith("/records/search"))
        self.assertEqual(session.calls[0]["params"], {"page_size": 500})
        self.assertEqual(
            session.calls[0]["json"]["filter"]["conditions"],
            [
                {
                    "field_name": "月报类型",
                    "operator": "is",
                    "value": ["南通机房告警分析"],
                },
                {
                    "field_name": "年度",
                    "operator": "is",
                    "value": ["2026"],
                },
            ],
        )


class Top5DownloadTests(unittest.TestCase):
    def test_top5_dispatch_downloads_only_top5_attachments(self) -> None:
        records = [
            {
                "fields": {
                    "年度": "2026",
                    "月份": "07",
                    "上传文件": [
                        {"name": "EA118机柜超功耗告警统计7月份.xlsx", "url": "mock://over-power"},
                        {"name": "EA118高功率TOP5报表7月份.xlsx", "url": "mock://top5"},
                    ],
                }
            }
        ]
        downloaded_urls: list[str] = []

        def fake_download(url: str, save_path: Path, _token: str) -> None:
            downloaded_urls.append(url)
            save_path.write_bytes(b"top5")

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            result = generate_monthly_report(
                "high_power_top5",
                "2026",
                7,
                ReportConfig(
                    download_folder=temp_dir,
                    feishu_app_id="app-id",
                    feishu_app_secret="secret",
                    feishu_app_token="base-token",
                ),
                token_provider=lambda _config: "tenant-token",
                table_records_fetcher=lambda *_args: records,
                attachment_downloader=fake_download,
            )

        self.assertEqual(result["action"], "downloaded_existing_attachment")
        self.assertEqual([item["name"] for item in result["files"]], ["EA118高功率TOP5报表7月份.xlsx"])
        self.assertEqual(downloaded_urls, ["mock://top5"])


if __name__ == "__main__":
    unittest.main()
