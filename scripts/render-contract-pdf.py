"""Render an input PDF from stdin into watermarked JPEG preview pages."""

from __future__ import annotations

import argparse
import io
import json
import math
import sys
from pathlib import Path

import fitz
from PIL import Image, ImageDraw, ImageFont


MAX_PAGES = 300
MAX_INPUT_BYTES = 100 * 1024 * 1024
MAX_PAGE_PIXELS = 25_000_000
MAX_OUTPUT_IMAGE_BYTES = 20 * 1024 * 1024
MAX_TOTAL_OUTPUT_BYTES = 512 * 1024 * 1024
RENDER_SCALE = 1.35


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--watermark-id", required=True)
    return parser.parse_args()


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in (
        Path(r"C:\Windows\Fonts\msyh.ttc"),
        Path(r"C:\Windows\Fonts\simhei.ttf"),
    ):
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def add_watermark(image: Image.Image, watermark_id: str) -> Image.Image:
    base = image.convert("RGBA")
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    text = f"仅供在线阅览 · 禁止外传 · {watermark_id[:12]}"
    font = load_font(max(20, min(base.width, base.height) // 45))
    step_x = max(420, base.width // 2)
    step_y = max(260, base.height // 4)
    for y in range(step_y // 2, base.height, step_y):
        for x in range(24, base.width, step_x):
            draw.text((x, y), text, font=font, fill=(37, 99, 235, 38))
    return Image.alpha_composite(base, overlay).convert("RGB")


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    pdf_bytes = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(pdf_bytes) > MAX_INPUT_BYTES:
        raise ValueError("PDF exceeds the 100MB rendering limit")
    if not pdf_bytes.startswith(b"%PDF-"):
        raise ValueError("input is not a PDF")

    document = fitz.open(stream=pdf_bytes, filetype="pdf")
    if document.page_count < 1 or document.page_count > MAX_PAGES:
        raise ValueError(f"unsupported page count: {document.page_count}")

    manifest: list[dict[str, int | str]] = []
    total_output_bytes = 0
    for index in range(document.page_count):
        page = document.load_page(index)
        expected_width = math.ceil(page.rect.width * RENDER_SCALE)
        expected_height = math.ceil(page.rect.height * RENDER_SCALE)
        if expected_width * expected_height > MAX_PAGE_PIXELS:
            raise ValueError(f"page {index + 1} exceeds the preview pixel limit")
        pixmap = page.get_pixmap(
            matrix=fitz.Matrix(RENDER_SCALE, RENDER_SCALE), alpha=False
        )
        if pixmap.width * pixmap.height > MAX_PAGE_PIXELS:
            raise ValueError(f"page {index + 1} exceeds the preview pixel limit")
        image = Image.open(io.BytesIO(pixmap.tobytes("png")))
        preview = add_watermark(image, args.watermark_id)
        file_name = f"page-{index + 1:04d}.jpg"
        output_path = output_dir / file_name
        preview.save(output_path, "JPEG", quality=82, optimize=True)
        output_bytes = output_path.stat().st_size
        if output_bytes > MAX_OUTPUT_IMAGE_BYTES:
            output_path.unlink(missing_ok=True)
            raise ValueError(f"page {index + 1} exceeds the preview byte limit")
        total_output_bytes += output_bytes
        if total_output_bytes > MAX_TOTAL_OUTPUT_BYTES:
            output_path.unlink(missing_ok=True)
            raise ValueError("contract preview exceeds the total byte limit")
        manifest.append(
            {
                "page": index + 1,
                "file": file_name,
                "width": preview.width,
                "height": preview.height,
                "bytes": output_bytes,
            }
        )

    print(json.dumps({"pageCount": len(manifest), "pages": manifest}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
