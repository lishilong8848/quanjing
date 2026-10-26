"""Single-stage bridge. The Nest ledger owns generation, retries and archive writes."""
from __future__ import annotations
import json
import html
import os
import re
import subprocess
import sys
import time
import traceback
from pathlib import Path

import nantong_weekly_report as report
from native_feishu import NativeFeishu, NativeError

VERSION = 'standalone-20261009-template-v3'


class DocumentConfirmationError(RuntimeError):
    def __init__(self, document_url):
        super().__init__('文档写入尚未确认')
        self.document_url = document_url


class ReadinessError(RuntimeError):
    def __init__(self, category):
        super().__init__('周报运行检查失败')
        self.category = category


def run_stage_cli(run, args: list[str], **kwargs):
    # Only side-effect-free reads may retry inside a generation stage.
    read = args[:2] in (['base', '+record-list'], ['docs', '+fetch'])
    attempts = 3 if read else 1
    timeout = min(kwargs.get('timeout', 120), 30 if read else 120)
    for attempt in range(attempts):
        try:
            return run(args, timeout=timeout, retry=False)
        except (RuntimeError, subprocess.TimeoutExpired) as exc:
            transient = isinstance(exc, subprocess.TimeoutExpired) or any(
                marker in str(exc).lower() for marker in (
                    'timed out', 'client.timeout', 'i/o timeout', 'connection reset',
                    'connectex', 'request canceled', 'connection refused', 'failed to respond',
                ))
            if not read or not transient or attempt + 1 == attempts:
                raise
            time.sleep(attempt + 1)


def safe_failure_diagnostic(exc: Exception) -> dict:
    reason = str(exc)
    if isinstance(exc, (ReadinessError, NativeError)):
        category = exc.category
    elif isinstance(exc, (TimeoutError, subprocess.TimeoutExpired)) or any(
            marker in reason.lower() for marker in ('timed out', '连接超时或网络异常')):
        category = 'timeout'
    elif '目标周报日期必须与生成结束日期一致' in reason:
        category = 'target-date'
    elif '目标周报不存在或重复' in reason:
        category = 'target-missing'
    elif '上一期继承内容读取失败' in reason:
        category = 'previous-content'
    elif 'CLI应用配置与南通系统不一致' in reason or '未找到 lark-cli' in reason:
        category = 'config'
    else:
        category = 'execution'
    return {'type': type(exc).__name__, 'category': category,
            'frames': [f'{frame.name}:{frame.lineno}' for frame in traceback.extract_tb(exc.__traceback__)][-12:]}


def verify_document(doc: str, xml: str, identity: str) -> None:
    payload = report.run_lark_cli(['docs', '+fetch', '--doc', doc, '--doc-format', 'xml', '--as', identity])
    actual = payload.get('data', {}).get('document', {}).get('content', '')
    def text(value):
        # <title> is document metadata and is absent from the fetched body.
        value = re.sub(r'<title\b[^>]*>.*?</title>', '', value, flags=re.S)
        return re.sub(r'\s+', '', html.unescape(re.sub(r'<[^>]*>', '', value)))
    expected = text(xml)
    if not expected or expected not in text(actual):
        raise RuntimeError('周报文档内容回读不一致')


def require_complete_write(payload: dict) -> None:
    result = payload.get('data', {}).get('result', {})
    status = result.get('status') if isinstance(result, dict) else result
    if status in ('failed', 'partial_success'):
        raise RuntimeError('周报文档未完整写入')


def main(payload: dict) -> dict:
    if payload.get('action') == 'offline-render':
        return run_action(payload, None)
    api = NativeFeishu(payload.get('_nativeAccessToken'), os.getenv('NANTONG_WEEKLY_WORK_DIR'))
    bindings = {'run_lark_cli': api.run, 'list_base_records': api.list_records,
                'create_report_doc': api.create, 'update_report_doc': api.write}
    original = {name: getattr(report, name) for name in bindings}
    try:
        for name, value in bindings.items(): setattr(report, name, value)
        return run_action(payload, api)
    finally:
        for name, value in original.items(): setattr(report, name, value)


def run_action(payload: dict, api: NativeFeishu | None) -> dict:
    action = payload.get('action')
    if action == 'offline-render':
        data = report.NantongWeeklyData(title='验收周报', start_date='2026-10-01', end_date='2026-10-07', week_number=41,
                                      ali_meeting_todos=payload.get('ali', []), meeting_todos=payload.get('local', []))
        xml, stats = report.render_docx_xml(data)
        return {'xml': xml, 'stats': stats, 'version': VERSION}
    if action == 'check':
        api.check(report.DEFAULT_CONFIG['base_token'], report.DEFAULT_CONFIG['tables']['weekly'])
        return {'ready': True, 'version': VERSION}
    config = dict(report.DEFAULT_CONFIG)
    config['tables'] = dict(report.DEFAULT_CONFIG['tables'])
    config['chat_id'] = ''
    config['report_parent_position'] = ''
    config['report_parent_token'] = os.getenv('NANTONG_WEEKLY_FOLDER_TOKEN', '')
    report.RUNTIME_LOG_DIR = Path(os.environ['NANTONG_WEEKLY_WORK_DIR'])
    report.PROJECT_ROOT = report.RUNTIME_LOG_DIR.parent
    report.RUNTIME_LOG_DIR.mkdir(parents=True, exist_ok=True)
    if action == 'prepare':
        period = report.weekly_period_from_dates(payload['startDate'], payload['endDate'])
        target = payload['targetRecordId']
        selected_fields = {}
        def selected(records, requested):
            matches = [r for r in records if report.record_id(r) == target]
            if len(matches) != 1:
                raise RuntimeError('目标周报不存在或重复')
            fields = report.normalize_record(matches[0])
            if report.parse_any_date(fields.get('日期')) != requested.end:
                raise RuntimeError('目标周报日期必须与生成结束日期一致')
            selected_fields.update(fields)
            return fields | {'_record_id': target}
        report.current_weekly_record = selected
        original_list = report.list_base_records
        def complete_records(**kwargs):
            kwargs['require_complete'] = True
            return original_list(**kwargs)
        report.list_base_records = complete_records
        data = report.collect_report_data(period, config)
        if any(data.sources.get(name) for name in ['professional_line_error', 'operation_line_error', 'previous_memory_error']):
            raise RuntimeError('上一期继承内容读取失败，请核对文档权限后重试')
        # Preserve responsibility and deadlines; the legacy Ali cleaner discards @ suffixes.
        report.extract_ali_todos_from_text = report.extract_todos_from_meeting_field
        data.meeting_todos, data.ali_meeting_todos = report.weekly_record_todos(selected_fields)
        xml, _ = report.render_docx_xml(data)
        return {'xml': xml, 'professional': data.professional_line_archive or data.professional_line,
                'operations': data.operation_line_archive or data.operation_line, 'title': data.title}
    if action == 'create':
        url, token, result = report.create_report_doc(payload['xml'], config)
        url = url or f'https://example.feishu.cn/docx/PUBLIC_EXAMPLE_SOURCE'
        try:
            require_complete_write(result)
            verify_document(url, payload['xml'], str(config.get('doc_identity') or 'bot'))
        except Exception as exc:
            raise DocumentConfirmationError(url) from exc
        return {'documentUrl': url}
    if action == 'document':
        result = report.update_report_doc(payload['documentUrl'], payload['xml'], config)
        require_complete_write(result)
        verify_document(payload['documentUrl'], payload['xml'], str(config.get('doc_identity') or 'bot'))
        return {'documentUrl': payload['documentUrl']}
    raise ValueError('Unsupported bridge action')


if __name__ == '__main__':
    try:
        result = main(json.load(sys.stdin))
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False))
    except Exception as exc:
        # Never print CLI stderr/config, tokens, user content or raw exception text.
        error = {'ok': False, 'message': '周报引擎执行失败，请核对运行配置、来源权限及目标日期后重试'}
        error['diagnostic'] = safe_failure_diagnostic(exc)
        if isinstance(exc, DocumentConfirmationError) or getattr(exc, 'document_url', None):
            error['documentUrl'] = exc.document_url
        print(json.dumps(error, ensure_ascii=False))
        sys.exit(1)
