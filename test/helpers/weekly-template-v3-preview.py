"""Render representative data through the real generator; no external writes."""
import hashlib
import html
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from datetime import datetime, timezone

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'scripts/weekly-report'))
import nantong_weekly_report as report

source = Path('D:/ai/codex/随心记/.superpowers/brainstorm/nantong-weekly-template-20261008/content/weekly-report-template-v3.html')
out = root / 'output/weekly-template-type-validation-20261009'
out.mkdir(parents=True, exist_ok=True)
data = report.NantongWeeklyData(title='南通运维周报 · v3模拟验收', start_date='2026-10-01', end_date='2026-10-07', week_number=41,
    ali_meeting_todos=['模拟：跟进UPS整改（责任人：马进宇；期限：2026-10-14）'],
    meeting_todos=['模拟：复核冷机维保安排（责任人：张工）'],
    professional_line='电气专业线\n- 模拟：复核母联开关\n暖通专业线\n- 模拟：核对冷机水温\n弱电专业线\n- 模拟：检查动环采集\nEHS&消防专业线\n- 模拟：复核消防整改',
    operation_line='成本支出：模拟维保费用审批\n模拟：跟进采购审批',
    sources={'drill_source_enabled': True},
    drills=[
        {'source_drill': True, 'building': 'A楼', 'scenario': '模拟：失电演练', 'in_month': True, 'in_week': True, 'completed': True, 'pending_approval': True},
        {'source_drill': True, 'building': 'A楼', 'scenario': '模拟：冷机故障', 'in_month': True, 'in_week': True, 'started': True, 'status': '进行中'},
        {'source_drill': True, 'building': 'B楼', 'scenario': '模拟：月末计划', 'in_month': True, 'in_week': False},
        {'source_drill': True, 'building': '归属未知', 'scenario': '模拟：归属待确认', 'in_month': False, 'in_week': True},
    ])
with __import__('unittest.mock', fromlist=['patch']).patch.object(report, 'extract_ali_todos_from_text', report.extract_todos_from_meeting_field):
    xml, _ = report.render_docx_xml(data)
tree = ET.fromstring('<root>' + xml + '</root>')
headings = [''.join(node.itertext()) for node in tree.iter() if re.fullmatch('h[1-6]', node.tag)]
for value in ['一、本周待办', '二、本周周会内容', '三、专业线', '四、运营线']:
    assert value in headings
assert headings.count('二、效率（变更、维护、演练）') == 6
assert '马进宇' in xml and '2026-10-14' in xml
assert '本月已完成1/3项' in xml and '其中待审批1项' in xml
assert '演练楼栋待核对：1项' in xml
assert xml.count('<column width-ratio="0.5">') == 4
assert '<h2>成本支出</h2>' in xml
style = re.search(r'<style>(.*?)</style>', source.read_text(encoding='utf-8'), re.S).group(1)
typography_path = root / 'client/public/meeting-templates/weekly-template.css'
typography = typography_path.read_text(encoding='utf-8')
style += '\n' + typography
reference_path = root / 'client/public/meeting-templates/nantong-weekly-v3.html'
reference, replacements = re.subn(
    r'<style id="weekly-typography">.*?</style>',
    lambda _: '<style id="weekly-typography">' + typography + '</style>',
    reference_path.read_text(encoding='utf-8'), flags=re.S,
)
if replacements != 1:
    raise ValueError('模板预览字号样式缺失或重复')
reference_path.write_text(reference, encoding='utf-8')

def render(node):
    if node.tag == 'title':
        return ''
    if node.tag == 'checkbox':
        return '<label class="todo"><input type="checkbox" disabled><span>' + html.escape(''.join(node.itertext())) + '</span></label>'
    attributes = ''
    tag = node.tag
    if tag == 'grid':
        tag, attributes = 'div', ' class="columns"'
    elif tag in ('column', 'callout'):
        tag, attributes = 'div', ' class="block"'
    elif tag == 'span':
        colors = {'purple': '#8554c7', 'green': '#2d9167', 'orange': '#a46b12'}
        if node.attrib.get('text-color') in colors:
            attributes = ' style="color:' + colors[node.attrib['text-color']] + '"'
    elif re.fullmatch('h[1-5]', tag):
        if tag == 'h4':
            attributes = ' class="weekly-topic-heading"'
        if ''.join(node.itertext()) != '南通运维周报':
            tag = 'h' + str(min(int(tag[1]) + 1, 5))
    body = html.escape(node.text or '') + ''.join(render(child) + html.escape(child.tail or '') for child in node)
    if tag == 'hr':
        return '<hr>'
    return '<' + tag + attributes + '>' + body + '</' + tag + '>'

content = ''.join(render(node) for node in tree)
preview = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>v3生成器模拟验收</title><style>' + style + '</style><main class="sheet"><div class="note">模拟验收数据 · 由当前周报生成器生成，不是实际会议记录。</div>' + content + '</main></html>'
(out / 'generated-report.xml').write_text(xml, encoding='utf-8')
(root / 'client/public/meeting-templates/nantong-weekly-v3-generated-sample.html').write_text(preview, encoding='utf-8')
proof = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'passed': True, 'template': str(source),
    'templateSha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'generatedHeadings': headings,
    'rendererSha256': hashlib.sha256((root / 'scripts/weekly-report/nantong_weekly_report.py').read_bytes()).hexdigest(),
    'typographySha256': hashlib.sha256(typography_path.read_bytes()).hexdigest(),
    'generatedXmlSha256': hashlib.sha256(xml.encode()).hexdigest(), 'toolSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'scope': 'v3四章/各楼栋效率演练/三行演练进展/四专业分组/成本/责任人及期限/未知楼栋不猜测',
    'limitations': ['本地代表性渲染，无飞书真实写入', 'HTML折叠和打印交互是预览能力；飞书以原生标题、分栏和待办呈现']}
(out / 'template-proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'passed': True, 'templateSha256': proof['templateSha256']}, ensure_ascii=False))
