"""Compare the local renderer with read-only Feishu outline evidence."""
import hashlib
import html
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'scripts' / 'weekly-report'))
import nantong_weekly_report as report

out = root / 'output' / 'weekly-workbench-layout-20261009'
sources = []
for name in ['template', 'week41-a', 'week41-b']:
    path = out / (name + '-outline.json')
    payload = json.loads(path.read_text(encoding='utf-8-sig'))
    assert payload['ok'] is True
    document = payload['data']['document']
    headings = [html.unescape(re.sub('<[^>]*>', '', content))
                for content in re.findall(r'<h[1-4]\b[^>]*>(.*?)</h[1-4]>', document['content'])]
    sources.append({'name': name, 'documentId': document['document_id'],
                    'revision': document['revision_id'], 'headings': headings,
                    'evidenceSha256': hashlib.sha256(path.read_bytes()).hexdigest()})

period = report.weekly_period_from_dates('2026-10-01', '2026-10-07')
data = report.NantongWeeklyData(title=report.format_report_title(period),
    start_date='2026-10-01', end_date='2026-10-07', week_number=41,
    meeting_todos=['验收：检查水泵（待办人：示例人员020）'])
xml, _ = report.render_docx_xml(data)
required = ['阿里周会待办', '上周内部周会待办', '本周周会内容', '整体概况', '管理线：', '专业线：', '运营线：']
for source in sources[1:]:
    assert all(heading in source['headings'] for heading in required)
assert all(heading in xml for heading in required)
assert all(heading in sources[0]['headings'] for heading in required[2:])
assert all(building + ':' in xml for building in report.BUILDINGS)
assert xml.count('二、效率（变更、维护A类）') == 1
assert xml.count('二、效率（变更、维护类）') == 5
assert '待办人：示例人员020' in xml and '维护A类/类' not in xml
(out / 'sample-report.xml').write_text(xml, encoding='utf-8')
proof = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'passed': True,
    'scope': '当前指定模板最新版本及第41周两份实际周报的业务结构；未宣称不存在其他业务模板',
    'sources': sources, 'generatedTitle': data.title, 'requiredSections': required,
    'changes': ['待办事项与第41周一致', '效率标题按模板区分A楼和其他楼栋'],
    'limitations': ['程序在本地生成XML，不会实时复制飞书模板的全部版式',
                    '会议图片当前同步至多维表附件，尚未自动插入周报文档'],
    'rendererSha256': hashlib.sha256((root / 'scripts/weekly-report/nantong_weekly_report.py').read_bytes()).hexdigest(),
    'toolSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
(out / 'template-audit-proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'passed': True, 'revisions': [source['revision'] for source in sources], 'title': data.title}, ensure_ascii=False))
