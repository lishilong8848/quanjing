from __future__ import annotations

import importlib.util
import os
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import ModuleType
from typing import Any
from unittest.mock import patch

from openpyxl import Workbook


ROOT = Path(__file__).resolve().parents[2]
LEGACY_TOOL_DIR = ROOT / "tools" / "ali-monthly-report-email"


def load_legacy_app() -> ModuleType:
    module_name = "nantong_ali_monthly_report_four_item_bundle_test"
    existing = sys.modules.get(module_name)
    if existing is not None:
        return existing

    sys.path.insert(0, str(LEGACY_TOOL_DIR))
    try:
        spec = importlib.util.spec_from_file_location(module_name, LEGACY_TOOL_DIR / "app.py")
        if spec is None or spec.loader is None:
            raise RuntimeError("无法加载阿里月报程序")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(LEGACY_TOOL_DIR))


class FourItemBundleDownloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.legacy_app = load_legacy_app()

    def test_downloads_four_categories_from_three_bitable_queries_with_one_token(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            output_dir = Path(temp_dir)
            fixture_dir = output_dir / "fixtures"
            fixture_dir.mkdir()
            candidates = {
                "高功率TOP5报表": [
                    fixture_dir / "超功率-旧.xlsx",
                    fixture_dir / "超功率-新.xlsx",
                    fixture_dir / "TOP5-旧.xlsx",
                    fixture_dir / "TOP5-新.xlsx",
                ],
                "告警分析报告": [
                    fixture_dir / "告警分析-旧.xlsx",
                    fixture_dir / "告警分析-新.xlsx",
                ],
                "人员变动报告": [
                    fixture_dir / "人员变动-旧.xlsx",
                    fixture_dir / "人员变动-新.xlsx",
                ],
            }
            for index, path_value in enumerate(path for paths in candidates.values() for path in paths):
                path_value.write_bytes(path_value.name.encode("utf-8"))
                os.utime(path_value, (1000 + index, 1000 + index))

            calls: list[dict[str, Any]] = []

            def fake_download(table_name: str, year: str, month_number: int, **kwargs: Any) -> dict[str, Any]:
                calls.append(
                    {
                        "table_name": table_name,
                        "year": year,
                        "month": month_number,
                        "tenant_token": kwargs.get("tenant_token"),
                        "destination_folder": kwargs.get("destination_folder"),
                    }
                )
                destination_folder = Path(kwargs["destination_folder"])
                file_paths = [
                    Path(shutil.copy2(path, destination_folder / path.name))
                    for path in candidates[table_name]
                    if kwargs["attachment_filter"](path.name)
                ]
                return {
                    "downloaded": [{"name": path.name} for path in file_paths],
                    "errors": [],
                    "folder": str(output_dir),
                    "file_paths": file_paths,
                }

            config = {
                "download_folder": str(output_dir),
                "feishu_app_id": "test-app",
                "feishu_app_secret": "test-secret",
                "feishu_app_token": "test-base",
            }
            with (
                patch.object(
                    self.legacy_app,
                    "request_feishu_tenant_token",
                    return_value="shared-token",
                ) as token_mock,
                patch.object(
                    self.legacy_app,
                    "download_report_attachments",
                    side_effect=fake_download,
                ),
                patch.object(
                    self.legacy_app,
                    "generate_staff_roster_monthly_report",
                    side_effect=AssertionError("四项打包不得重新生成在职人员文件"),
                ),
            ):
                selected = self.legacy_app.download_monthly_bundle_report_files(
                    "2026",
                    7,
                    config,
                )

        self.assertEqual(
            [(category, path.name) for category, path in selected],
            [
                ("超功率", "超功率-新.xlsx"),
                ("TOP5", "TOP5-新.xlsx"),
                ("告警分析", "告警分析-新.xlsx"),
                ("人员变动", "人员变动-新.xlsx"),
            ],
        )
        token_mock.assert_called_once_with(config, None)
        self.assertEqual(len(calls), 3)
        self.assertEqual(
            {call["table_name"] for call in calls},
            {"高功率TOP5报表", "告警分析报告", "人员变动报告"},
        )
        self.assertEqual(sum(call["table_name"] == "高功率TOP5报表" for call in calls), 1)
        self.assertTrue(all(call["tenant_token"] == "shared-token" for call in calls))
        self.assertEqual(len({str(call["destination_folder"]) for call in calls}), 3)
        final_source_root = output_dir / ".ali-monthly-bundle-files"
        self.assertTrue(
            all(path.is_relative_to(final_source_root) for _category, path in selected)
        )
        self.assertFalse((output_dir / ".ali-monthly-bundle").exists())

    def test_year_month_filter_requires_an_exact_period(self) -> None:
        records = [
            {"record_id": "exact", "fields": {"年度": "2026", "月份": "7"}},
            {
                "record_id": "localized",
                "fields": {"年度": "2026年", "月份": "07月"},
            },
            {
                "record_id": "wrong-year-prefix",
                "fields": {"年度": "20260", "月份": "7"},
            },
            {"record_id": "missing-year", "fields": {"年度": "", "月份": "7"}},
            {
                "record_id": "wrong-month-prefix",
                "fields": {"年度": "2026", "月份": "17"},
            },
            {"record_id": "other-month", "fields": {"年度": 2026, "月份": 8}},
        ]

        filtered = self.legacy_app.filter_records_by_year_month(
            records,
            "2026",
            7,
        )

        self.assertEqual(
            [record["record_id"] for record in filtered],
            ["exact", "localized"],
        )

    def test_latest_attachment_uses_bitable_record_time_not_download_order(self) -> None:
        class FakeResponse:
            status_code = 200

            def __init__(self, body: bytes) -> None:
                self.body = body

            def iter_content(self, chunk_size: int):
                del chunk_size
                yield self.body

        records = [
            {
                "record_id": "new-record",
                "last_modified_time": "1760000000000",
                "fields": {
                    "上传文件": [
                        {
                            "file_token": "new-token",
                            "name": "告警分析-新.xlsx",
                            "url": "https://example.test/new",
                        }
                    ]
                },
            },
            {
                "record_id": "old-record",
                "last_modified_time": "1750000000000",
                "fields": {
                    "上传文件": [
                        {
                            "file_token": "old-token",
                            "name": "告警分析-旧.xlsx",
                            "url": "https://example.test/old",
                        }
                    ]
                },
            },
        ]

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with patch.object(
                self.legacy_app.requests,
                "get",
                side_effect=lambda url, **_kwargs: FakeResponse(url.encode("utf-8")),
            ):
                _downloaded, errors, paths = self.legacy_app.download_record_attachments(
                    records,
                    "test-token",
                    Path(temp_dir),
                )
            selected = self.legacy_app.select_report_file(paths)

        self.assertEqual(errors, [])
        self.assertEqual(selected.name, "告警分析-新.xlsx")

    def test_any_matching_attachment_download_error_aborts_the_bundle(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            output_dir = Path(temp_dir)
            config = {
                "download_folder": str(output_dir),
                "feishu_app_id": "test-app",
                "feishu_app_secret": "test-secret",
                "feishu_app_token": "test-base",
            }

            def fake_download(table_name: str, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
                return {
                    "downloaded": [],
                    "errors": ["最新版附件下载超时"] if table_name == "告警分析报告" else [],
                    "file_paths": [],
                }

            with (
                patch.object(
                    self.legacy_app,
                    "request_feishu_tenant_token",
                    return_value="shared-token",
                ),
                patch.object(
                    self.legacy_app,
                    "download_report_attachments",
                    side_effect=fake_download,
                ),
            ):
                with self.assertRaisesRegex(ValueError, "下载不完整"):
                    self.legacy_app.download_monthly_bundle_report_files(
                        "2026",
                        7,
                        config,
                    )

            self.assertFalse((output_dir / ".ali-monthly-bundle").exists())

    def test_previous_month_export_zips_exactly_the_four_selected_files(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            output_dir = Path(temp_dir)
            selected = []
            for category, file_name in [
                ("超功率", "over-power.xlsx"),
                ("TOP5", "top5.xlsx"),
                ("告警分析", "alarm.xlsx"),
                ("人员变动", "staff-change.xlsx"),
            ]:
                file_path = output_dir / file_name
                workbook = Workbook()
                workbook.active["A1"] = category
                workbook.save(file_path)
                workbook.close()
                selected.append((category, file_path))

            config = {"download_folder": str(output_dir)}
            with (
                patch.object(
                    self.legacy_app,
                    "get_previous_year_month",
                    return_value=("2026", 7, "7月"),
                ),
                patch.object(
                    self.legacy_app,
                    "download_monthly_bundle_report_files",
                    return_value=selected,
                ) as download_mock,
            ):
                result = self.legacy_app.export_previous_month_report_bundle(config)

            zip_path = Path(result["zip_file"]["path"])
            with zipfile.ZipFile(zip_path, "r") as archive:
                archive_names = archive.namelist()

        download_mock.assert_called_once_with("2026", 7, config, None)
        self.assertEqual(len(archive_names), 4)
        self.assertEqual([item["category"] for item in result["files"]], [item[0] for item in selected])
        self.assertEqual({name.split("_", 1)[0] for name in archive_names}, {item[0] for item in selected})

    def test_strict_zip_rejects_oversize_and_removes_partial_output(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            output_dir = Path(temp_dir)
            selected: list[tuple[str, Path]] = []
            for category in ["超功率", "TOP5", "告警分析", "人员变动"]:
                file_path = output_dir / f"{category}.xlsx"
                workbook = Workbook()
                workbook.active["A1"] = category
                workbook.save(file_path)
                workbook.close()
                selected.append((category, file_path))

            with patch.object(self.legacy_app, "FEISHU_MESSAGE_FILE_MAX_BYTES", 1):
                with self.assertRaisesRegex(ValueError, "30MB"):
                    self.legacy_app.build_monthly_bundle_zip(
                        selected,
                        output_dir,
                        "2026",
                        7,
                    )

            self.assertEqual(list(output_dir.glob("*.zip")), [])
            self.assertEqual(list(output_dir.glob("*.part")), [])

    def test_same_latest_record_with_multiple_category_attachments_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            first = Path(temp_dir) / "告警分析-A.xlsx"
            second = Path(temp_dir) / "告警分析-B.xlsx"
            first.write_bytes(b"a")
            second.write_bytes(b"b")
            os.utime(first, (1_760_000_000, 1_760_000_000))
            os.utime(second, (1_760_000_000, 1_760_000_000))

            with self.assertRaisesRegex(ValueError, "多个"):
                self.legacy_app.select_report_file(
                    [first, second],
                    require_unique_latest=True,
                )


if __name__ == "__main__":
    unittest.main()
