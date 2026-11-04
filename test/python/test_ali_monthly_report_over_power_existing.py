from __future__ import annotations

import copy
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from typing import Any
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "ali-monthly-report"
sys.path.insert(0, str(TOOL))
try:
    from ali_monthly_reports.config import ReportConfig
    from ali_monthly_reports import reports
finally:
    sys.path.remove(str(TOOL))


def record(identifier: str = "rec_october", *, year: Any = "2026", month: Any = "10",
           name: str = "EA118机柜超功耗告警统计10月份.xlsx", token: str = "file_october") -> dict[str, Any]:
    return {"record_id": identifier, "fields": {"年度": year, "月份": month, "子分类": "机柜超功耗",
        "上传文件": [{"name": name, "file_token": token, "url": "https://open.feishu.cn/synthetic/" + token}]}}


class ExistingOverPowerAttachmentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.config = ReportConfig(download_folder=self.directory.name, feishu_app_id="cli_synthetic",
            feishu_app_secret="synthetic", feishu_app_token="base_synthetic")
        self.downloads: list[tuple[str, Path]] = []
        self.record_reads: list[dict[str, str]] = []
        for name in ["get", "post", "put", "patch", "delete"]:
            blocked = patch("requests." + name, side_effect=AssertionError("Real external HTTP is forbidden"))
            blocked.start()
            self.addCleanup(blocked.stop)

    def download(self, url: str, destination: Path, token: str) -> None:
        self.assertEqual(token, "synthetic_tenant")
        self.downloads.append((url, destination))
        destination.write_bytes(b"synthetic existing workbook bytes")

    def run_report(self, rows: list[dict[str, Any]], downloader: Any = None) -> dict[str, Any]:
        def fetch(config: ReportConfig, table: dict[str, str], token: str, log: Any) -> list[dict[str, Any]]:
            self.assertIs(config, self.config)
            self.record_reads.append(table)
            return rows
        return reports.generate_over_power_report("2026", 10, self.config,
            token_provider=lambda _: "synthetic_tenant", table_records_fetcher=fetch,
            attachment_downloader=downloader or self.download)

    def test_existing_attachment_returns_original_record_url_without_source_generation_config(self) -> None:
        result = self.run_report([record()])
        self.assertEqual(result["action"], "downloaded_existing_attachment")
        self.assertEqual(len(self.downloads), 1)
        self.assertEqual(len(self.record_reads), 1)
        self.assertEqual(result["files"][0]["name"], "EA118机柜超功耗告警统计10月份.xlsx")
        self.assertEqual(result["reused_records"], [{"record_id": "rec_october", "record_url":
            "https://vnet.feishu.cn/base/base_synthetic?table=tblkh6YCMYtS8nHa&view=vewrHJHl3v&recordId=rec_october"}])
        self.assertFalse(any(key in result for key in ["uploaded", "updated", "updated_records"]))
        self.assertEqual(result["errors"], [])

    def test_exact_numeric_and_suffixed_period_fields_are_supported(self) -> None:
        for year, month in [(2026, 10), ("2026年", "10月"), ([{"text": "2026"}], [{"text": "10"}])]:
            with self.subTest(year=year, month=month):
                result = self.run_report([record(year=year, month=month)])
                self.assertEqual(len(result["files"]), 1)

    def test_wrong_or_ambiguous_periods_are_never_downloaded(self) -> None:
        for year, month in [(None, "10"), ("", "10"), ("None", "10"), ("20260", "10"),
                            ("2025", "10"), ("2026", "9"), ("2026", "010"), ("2026", "10月11月")]:
            with self.subTest(year=year, month=month):
                with self.assertRaisesRegex(ValueError, "没有找到"):
                    self.run_report([record(year=year, month=month)])
        self.assertEqual(self.downloads, [])

    def test_top5_and_non_xlsx_attachments_are_not_monthly_over_power_reports(self) -> None:
        for name in ["机柜超功耗TOP5.xlsx", "机柜超功率top5.xlsx", "机柜超功耗.png", "机柜超功率.pdf", "TOP5功率文件.xlsx", "告警分析.xlsx"]:
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, "未找到.*未执行生成或上传"):
                    self.run_report([record(name=name)])
        self.assertEqual(self.downloads, [])

    def test_other_month_year_and_top5_cannot_leak_into_valid_report(self) -> None:
        result = self.run_report([record("rec_previous", month="9"), record("rec_last_year", year="2025"),
            record("rec_top5", name="机柜超功耗TOP5.xlsx"), record()])
        self.assertEqual([item["record_id"] for item in result["reused_records"]], ["rec_october"])
        self.assertEqual(len(self.downloads), 1)

    def test_same_attachment_token_is_downloaded_once_without_fabricating_other_source_links(self) -> None:
        result = self.run_report([record(), record("rec_duplicate")])
        self.assertEqual(len(self.downloads), 1)
        self.assertEqual([item["record_id"] for item in result["reused_records"]], ["rec_october"])

    def test_attachment_token_is_required_before_downloading(self) -> None:
        row = record()
        row["fields"]["上传文件"][0].pop("file_token")
        with self.assertRaisesRegex(ValueError, "缺少 file_token"):
            self.run_report([row])
        self.assertEqual(self.downloads, [])

    def test_multiple_existing_versions_are_reused_with_their_own_source_records(self) -> None:
        result = self.run_report([record(), record("rec_other", name="机柜超功率10月份复核.xlsx", token="file_other")])
        self.assertEqual(len(self.downloads), 2)
        self.assertEqual([item["record_id"] for item in result["reused_records"]], ["rec_october", "rec_other"])
        self.assertEqual(len(result["files"]), 2)

    def test_duplicate_record_with_distinct_files_returns_one_original_link(self) -> None:
        result = self.run_report([record(), record(name="机柜超功率复核.xlsx", token="file_other")])
        self.assertEqual(len(result["files"]), 2)
        self.assertEqual(len(result["reused_records"]), 1)

    def test_different_same_name_attachments_do_not_overwrite_downloads(self) -> None:
        class FrozenTime(datetime):
            @classmethod
            def now(cls) -> datetime:
                return cls(2026, 11, 3, 9, 30, 0)

        def download_distinct(url: str, target: Path, token: str) -> None:
            target.write_bytes(url.rsplit("/", 1)[-1].encode())

        with patch("ali_monthly_reports.utils.datetime", FrozenTime):
            result = self.run_report([record(f"rec_{i}", token=f"file_{i}") for i in range(3)], download_distinct)
        paths = [Path(file["path"]) for file in result["files"]]
        self.assertEqual(len(set(paths)), 3)
        self.assertEqual([path.read_bytes() for path in paths], [b"file_0", b"file_1", b"file_2"])

    def test_record_id_is_required_before_downloading(self) -> None:
        row = record()
        row.pop("record_id")
        with self.assertRaisesRegex(ValueError, "缺少.*记录 ID"):
            self.run_report([row])
        self.assertEqual(self.downloads, [])

    def test_download_failure_removes_partial_file_and_does_not_report_success(self) -> None:
        def failing(url: str, target: Path, token: str) -> None:
            target.write_bytes(b"partial")
            raise OSError("synthetic network failure")
        with self.assertRaisesRegex(ValueError, "附件读取失败.*未执行生成或上传"):
            self.run_report([record()], failing)
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_partial_success_cannot_mark_the_month_successful(self) -> None:
        def mixed(url: str, target: Path, token: str) -> None:
            if url.endswith("file_other"):
                raise OSError("synthetic second failure")
            self.download(url, target, token)
        with self.assertRaisesRegex(ValueError, "附件读取失败"):
            self.run_report([record(), record("rec_failed", token="file_other")], mixed)
        completed_paths = list(Path(self.directory.name).iterdir())
        self.assertEqual(len(completed_paths), 1)
        self.assertEqual(completed_paths[0].read_bytes(), b"synthetic existing workbook bytes")

    def test_failed_same_name_attachment_does_not_remove_preexisting_file(self) -> None:
        row = record()
        previous = Path(self.directory.name) / row["fields"]["上传文件"][0]["name"]
        previous.write_bytes(b"prior completed workbook bytes")

        def failing(url: str, target: Path, token: str) -> None:
            self.assertNotEqual(target, previous)
            target.write_bytes(b"partial")
            raise OSError("synthetic network failure")

        with self.assertRaisesRegex(ValueError, "附件读取失败"):
            self.run_report([row], failing)
        self.assertEqual(list(Path(self.directory.name).iterdir()), [previous])
        self.assertEqual(previous.read_bytes(), b"prior completed workbook bytes")

    def test_missing_download_url_uses_the_existing_token_readonly_endpoint(self) -> None:
        row = record()
        row["fields"]["上传文件"][0].pop("url")
        result = self.run_report([row])
        self.assertEqual(self.downloads[0][0], "https://open.feishu.cn/open-apis/drive/v1/medias/file_october/download")
        self.assertEqual(result["reused_records"][0]["record_id"], "rec_october")

    def test_untrusted_or_credential_bearing_download_urls_are_rejected(self) -> None:
        for url in ["http://open.feishu.cn/download", "https://feishu.cn.evil.invalid/download",
                    "https://evil.invalid/download", "https://user:pass@open.feishu.cn/download"]:
            with self.subTest(url=url):
                row = record()
                row["fields"]["上传文件"][0]["url"] = url
                with self.assertRaisesRegex(ValueError, "下载地址不受信任"):
                    self.run_report([row])
        self.assertEqual(self.downloads, [])

    def test_empty_file_does_not_mark_success_and_is_removed(self) -> None:
        def empty(url: str, target: Path, token: str) -> None:
            target.write_bytes(b"")
        with self.assertRaisesRegex(ValueError, "附件读取失败"):
            self.run_report([record()], empty)
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_input_records_are_not_modified(self) -> None:
        rows = [record()]
        before = copy.deepcopy(rows)
        self.run_report(rows)
        self.assertEqual(rows, before)

    def test_no_target_records_fails_without_any_download(self) -> None:
        with self.assertRaisesRegex(ValueError, "没有找到"):
            self.run_report([])
        self.assertEqual(self.downloads, [])


if __name__ == "__main__":
    unittest.main()
