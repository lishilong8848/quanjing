from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

from openpyxl import Workbook


ROOT = Path(__file__).resolve().parents[2]
LEGACY_TOOL_DIR = ROOT / "tools" / "ali-monthly-report-email"


def load_legacy_app() -> ModuleType:
    module_name = "nantong_ali_monthly_report_email_test"
    existing = sys.modules.get(module_name)
    if existing is not None:
        return existing

    sys.path.insert(0, str(LEGACY_TOOL_DIR))
    try:
        spec = importlib.util.spec_from_file_location(module_name, LEGACY_TOOL_DIR / "app.py")
        if spec is None or spec.loader is None:
            raise RuntimeError("无法加载阿里月报邮件程序")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(LEGACY_TOOL_DIR))


class AliMonthlyReportEmailTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.legacy_app = load_legacy_app()

    def test_previous_month_power_email_uses_power_workbook_as_its_only_attachment(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            output_dir = Path(temp_dir)
            power_file = output_dir / "EA118机柜超功耗告警统计表7月份.xlsx"
            temp_power_file = output_dir / "temp-power.xlsx"
            power_file.write_bytes(b"power-workbook")
            temp_power_file.write_bytes(b"temp-power-workbook")
            config = {"download_folder": str(output_dir)}

            with (
                patch.object(
                    self.legacy_app,
                    "get_previous_year_month",
                    return_value=("2026", 7, "7月"),
                ),
                patch.object(
                    self.legacy_app,
                    "download_report_attachments",
                    side_effect=AssertionError("超功耗邮件不得下载告警分析附件"),
                ),
                patch.object(
                    self.legacy_app,
                    "fetch_existing_monthly_report_files",
                    return_value={"file_paths": [power_file]},
                ),
                patch.object(
                    self.legacy_app,
                    "select_alarm_report_file",
                    return_value=power_file,
                ),
                patch.object(
                    self.legacy_app,
                    "import_file_to_temp",
                    return_value=temp_power_file,
                ),
                patch.object(
                    self.legacy_app,
                    "send_report_email",
                    return_value="ma.jinyu@vnet.com",
                ) as send_mock,
            ):
                result = self.legacy_app.send_previous_month_alarm_email(
                    config,
                    "ma.jinyu@vnet.com",
                )

        send_mock.assert_called_once_with(
            temp_power_file,
            self.legacy_app.build_email_subject("2026", 7),
            "ma.jinyu@vnet.com",
            "2026",
            7,
            config=config,
            external_log=None,
        )
        self.assertEqual(result["file"]["name"], power_file.name)
        self.assertIn("超功耗邮件", result["message"])

    def test_mei_bingbing_is_visible_only_in_the_email_body_cc_line(self) -> None:
        opening_html = self.legacy_app.build_email_opening_html()

        self.assertIn("抄送:", opening_html)
        self.assertIn("mei.bingbing@vnet.com", opening_html)
        self.assertNotIn("mei.bingbing@vnet.com", self.legacy_app.DEFAULT_RECIPIENT)

    def test_recipient_parser_removes_mei_from_legacy_or_manual_delivery_lists(self) -> None:
        recipients = self.legacy_app.parse_recipients(
            "ma.jinyu@vnet.com; MEI.BINGBING@vnet.com; liu.xiaoxing2-wb@sne.vnet.com"
        )

        self.assertEqual(
            recipients,
            ["ma.jinyu@vnet.com", "liu.xiaoxing2-wb@sne.vnet.com"],
        )
        with self.assertRaisesRegex(ValueError, "有效的收件人"):
            self.legacy_app.parse_recipients("mei.bingbing@vnet.com")

    def test_power_email_mime_keeps_mei_out_of_delivery_and_attaches_the_power_workbook(self) -> None:
        sent: dict[str, object] = {}

        class CapturingSmtp:
            def __init__(self, host: str, port: int) -> None:
                sent["host"] = host
                sent["port"] = port

            def __enter__(self) -> "CapturingSmtp":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def login(self, sender: str, auth_code: str) -> None:
                sent["login"] = (sender, auth_code)

            def send_message(self, message: Message, *, to_addrs: list[str]) -> None:
                sent["message"] = message
                sent["to_addrs"] = list(to_addrs)

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            power_file = Path(temp_dir) / "EA118机柜超功耗告警统计表7月份.xlsx"
            workbook = Workbook()
            workbook.active.title = "机列超215功率统计"
            workbook.save(power_file)
            workbook.close()
            original_bytes = power_file.read_bytes()
            empty_frame = self.legacy_app.pd.DataFrame()
            frames = {
                sheet["image_id"]: empty_frame.copy()
                for sheet in self.legacy_app.SHEET_CONFIGS
            }

            with (
                patch.object(self.legacy_app, "load_alarm_data", return_value=frames),
                patch.object(self.legacy_app, "sheet_config_to_image", return_value=b"not-used"),
                patch.object(self.legacy_app, "load_vnet_logo_image", return_value=None),
                patch.object(self.legacy_app, "MIMEImage", side_effect=lambda *_args, **_kwargs: Message()),
                patch.object(self.legacy_app.smtplib, "SMTP_SSL", CapturingSmtp),
            ):
                recipient_text = self.legacy_app.send_report_email(
                    power_file,
                    self.legacy_app.build_email_subject("2026", 7),
                    (
                        "ma.jinyu@vnet.com; mei.bingbing@vnet.com; "
                        "liu.xiaoxing2-wb@sne.vnet.com"
                    ),
                    "2026",
                    7,
                    config={"qq_email": "sender@example.test", "auth_code": "test-auth"},
                )

        message = sent["message"]
        self.assertIsInstance(message, Message)
        assert isinstance(message, Message)
        html_parts = [
            part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8")
            for part in message.walk()
            if part.get_content_type() == "text/html"
        ]
        attachments = [
            part
            for part in message.walk()
            if part.get_content_disposition() == "attachment"
        ]

        self.assertEqual(
            recipient_text,
            "ma.jinyu@vnet.com, liu.xiaoxing2-wb@sne.vnet.com",
        )
        self.assertEqual(
            sent["to_addrs"],
            ["ma.jinyu@vnet.com", "liu.xiaoxing2-wb@sne.vnet.com"],
        )
        self.assertIsNone(message.get("Cc"))
        self.assertIn("mei.bingbing@vnet.com", "\n".join(html_parts))
        self.assertEqual(len(attachments), 1)
        self.assertEqual(
            attachments[0].get_filename(),
            "EA118机柜超功耗告警统计表7月份.xlsx",
        )
        self.assertEqual(attachments[0].get_payload(decode=True), original_bytes)


if __name__ == "__main__":
    unittest.main()
