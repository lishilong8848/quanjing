from __future__ import annotations

import argparse
import json

from .config import ReportConfig
from .reports import generate_monthly_report


def parse_month(value: str) -> int:
    digits = "".join(char for char in str(value) if char.isdigit())
    if not digits:
        raise argparse.ArgumentTypeError("月份必须包含数字")
    month = int(digits)
    if month < 1 or month > 12:
        raise argparse.ArgumentTypeError("月份必须在 1-12 之间")
    return month


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate Ali monthly report files.")
    parser.add_argument(
        "--type",
        required=True,
        choices=["alarm_analysis", "over_power", "high_power_top5", "staff_roster"],
        help="Report type.",
    )
    parser.add_argument("--year", required=True, help="Year, e.g. 2026.")
    parser.add_argument("--month", required=True, type=parse_month, help="Month, e.g. 5 or 5月.")
    parser.add_argument("--config", help="JSON config path. If omitted, environment variables are used.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = ReportConfig.from_sources(args.config)
    result = generate_monthly_report(args.type, str(args.year), int(args.month), config)
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
