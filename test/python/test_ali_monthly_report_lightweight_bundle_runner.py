from __future__ import annotations

import ast
import importlib.util
import io
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import ModuleType
from unittest.mock import patch
from urllib.error import HTTPError


ROOT = Path(__file__).resolve().parents[2]
RUNNER_PATH = ROOT / "tools" / "ali-monthly-report" / "four_item_bundle_runner.py"


def load_runner() -> ModuleType:
    module_name = "nantong_ali_monthly_report_lightweight_bundle_runner_test"
    existing = sys.modules.get(module_name)
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(module_name, RUNNER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载轻量四项打包脚本")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def attachment(name: str, url: str, file_token: str | None = None) -> dict[str, str]:
    return {
        "file_token": file_token or f"box-{abs(hash((name, url)))}",
        "name": name,
        "url": url,
    }


def record(
    record_id: str,
    modified_at: int,
    files: list[dict[str, str]],
    *,
    year: str = "2026",
    month: str = "7",
) -> dict[str, object]:
    return {
        "record_id": record_id,
        "last_modified_time": str(modified_at),
        "fields": {"年度": year, "月份": month, "上传文件": files},
    }


def write_xlsx(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as workbook:
        workbook.writestr("[Content_Types].xml", value)


class LightweightBundleRunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.runner = load_runner()

    def test_runner_imports_only_python_standard_library(self) -> None:
        tree = ast.parse(RUNNER_PATH.read_text(encoding="utf-8"))
        imported_roots: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported_roots.update(alias.name.split(".", 1)[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported_roots.add(node.module.split(".", 1)[0])

        self.assertFalse(
            imported_roots & {"flask", "matplotlib", "openpyxl", "pandas", "PIL", "requests"}
        )

    def test_selects_only_the_latest_exact_month_attachment_for_each_category(self) -> None:
        source_records = {
            "power": [
                record(
                    "old-power",
                    1000,
                    [
                        attachment("EA118超功率旧.xlsx", "https://example.test/power-old"),
                        attachment("EA118TOP5旧.xlsx", "https://example.test/top5-old"),
                    ],
                ),
                record(
                    "new-power",
                    2000,
                    [
                        attachment("EA118超功率新.xlsx", "https://example.test/power-new"),
                        attachment("EA118TOP5新.xlsx", "https://example.test/top5-new"),
                    ],
                ),
            ],
            "alarm": [
                record("wrong-month", 3000, [attachment("告警8月.xlsx", "https://example.test/wrong")], month="8"),
                record("alarm", 2000, [attachment("告警分析.xlsx", "https://example.test/alarm")]),
            ],
            "staff": [
                record("staff", 2000, [attachment("人员变动.xlsx", "https://example.test/staff")]),
            ],
        }

        selected = self.runner.select_bundle_attachments(source_records, 2026, 7)

        self.assertEqual(
            [(item.category, item.name) for item in selected],
            [
                ("超功率", "EA118超功率新.xlsx"),
                ("TOP5", "EA118TOP5新.xlsx"),
                ("告警分析", "告警分析.xlsx"),
                ("人员变动", "人员变动.xlsx"),
            ],
        )

    def test_record_query_explicitly_requests_automatic_timestamps(self) -> None:
        source = self.runner.SourceSpec(
            key="alarm",
            app_token="base-token",
            table_id="alarm-table",
            view_id="alarm-view",
        )
        with patch.object(
            self.runner,
            "request_json",
            return_value={"code": 0, "data": {"items": [], "has_more": False}},
        ) as request_json:
            records = self.runner.fetch_source_records(source, "tenant-token")

        self.assertEqual(records, [])
        requested_url = request_json.call_args.args[0]
        self.assertIn("automatic_fields=true", requested_url)

    def test_attachment_download_uses_file_token_and_ignores_untrusted_record_url(self) -> None:
        selected = self.runner.select_bundle_attachments(
            {
                "power": [
                    record(
                        "power",
                        2000,
                        [
                            attachment(
                                "EA118超功率.xlsx",
                                "https://attacker.example/steal-token",
                                "box-safe-power-token",
                            ),
                            attachment("EA118TOP5.xlsx", "https://example.test/top5"),
                        ],
                    )
                ],
                "alarm": [record("alarm", 2000, [attachment("告警分析.xlsx", "https://example.test/alarm")])],
                "staff": [record("staff", 2000, [attachment("人员变动.xlsx", "https://example.test/staff")])],
            },
            2026,
            7,
        )

        download_url = self.runner.build_attachment_download_url(selected[0])

        self.assertEqual(
            download_url,
            "https://open.feishu.cn/open-apis/drive/v1/medias/box-safe-power-token/download",
        )
        self.assertNotIn("attacker.example", download_url)

    def test_attachment_download_retries_feishu_data_not_ready_response(self) -> None:
        item = self.runner.BundleAttachment(
            category="TOP5",
            name="EA118TOP5.xlsx",
            file_token="box-retry-top5-token",
            extra="",
            modified_at=2000,
            record_id="power-record",
        )
        workbook = io.BytesIO()
        with zipfile.ZipFile(workbook, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("[Content_Types].xml", "ready")
        not_ready = HTTPError(
            "https://open.feishu.cn/open-apis/drive/v1/medias/token/download",
            400,
            "Bad Request",
            {},
            io.BytesIO(b'{"msg":"Data not ready, please try again later"}'),
        )

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            with (
                patch.object(
                    self.runner.DOWNLOAD_OPENER,
                    "open",
                    side_effect=[not_ready, io.BytesIO(workbook.getvalue())],
                ) as open_download,
                patch.object(self.runner.time, "sleep") as sleep,
            ):
                downloaded = self.runner.download_attachment(
                    item,
                    "tenant-token",
                    temp_dir,
                )

            self.assertTrue(zipfile.is_zipfile(downloaded))
        self.assertEqual(open_download.call_count, 2)
        sleep.assert_called_once_with(1.0)

    def test_bundle_downloads_exactly_four_selected_files_and_creates_one_zip(self) -> None:
        source_records = {
            "power": [
                record(
                    "power",
                    2000,
                    [
                        attachment("EA118超功率.xlsx", "https://example.test/power"),
                        attachment("EA118TOP5.xlsx", "https://example.test/top5"),
                    ],
                )
            ],
            "alarm": [record("alarm", 2000, [attachment("告警分析.xlsx", "https://example.test/alarm")])],
            "staff": [record("staff", 2000, [attachment("人员变动.xlsx", "https://example.test/staff")])],
        }

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            config = {
                "download_folder": temp_dir,
                "feishu_app_id": "test-app",
                "feishu_app_secret": "test-secret",
                "feishu_app_token": "test-base",
                "high_power_table_id": "power-table",
                "high_power_view_id": "power-view",
                "alarm_report_table_id": "alarm-table",
                "alarm_report_view_id": "alarm-view",
                "staff_report_table_id": "staff-table",
                "staff_report_view_id": "staff-view",
            }

            def fake_fetch(source, _token):
                return source_records[source.key]

            download_calls: list[str] = []

            def fake_download(item, _token, destination):
                download_calls.append(item.category)
                path = Path(destination) / item.name
                write_xlsx(path, item.category)
                return path

            with (
                patch.object(self.runner, "request_tenant_token", return_value="shared-token"),
                patch.object(self.runner, "fetch_source_records", side_effect=fake_fetch),
                patch.object(self.runner, "download_attachment", side_effect=fake_download),
            ):
                result = self.runner.create_monthly_bundle(2026, 7, config)

            zip_path = Path(result["zip_file"]["path"])
            with zipfile.ZipFile(zip_path, "r") as archive:
                names = archive.namelist()

        self.assertCountEqual(download_calls, ["超功率", "TOP5", "告警分析", "人员变动"])
        self.assertEqual(len(names), 4)
        self.assertEqual([item["category"] for item in result["source_files"]], download_calls)


if __name__ == "__main__":
    unittest.main()
