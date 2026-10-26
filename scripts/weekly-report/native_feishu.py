"""Web weekly engine's Feishu API adapter. Credentials arrive only on stdin.

Block schema: larksuite/oapi-sdk-python, docx/v1/model. No CLI profile is used.
"""
from __future__ import annotations
import hashlib
import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path


class NativeError(RuntimeError):
    def __init__(self, category='execution', document_url=None, api_code=None):
        super().__init__('飞书接口操作未确认')
        self.category = category
        self.document_url = document_url
        self.api_code = api_code


def document_id(url):
    match = re.fullmatch(r'https://vnet\.feishu\.cn/docx/([A-Za-z0-9]+)/*(?:\?[^#]*)?', url)
    if not match:
        raise NativeError('previous-content')
    return match[1]


COLORS = {'red': 1, 'orange': 2, 'yellow': 3, 'green': 4, 'blue': 5, 'purple': 6, 'gray': 7}
TEXT_KEYS = {2: 'text', **{i + 2: f'heading{i}' for i in range(1, 10)}, 12: 'bullet', 13: 'ordered', 14: 'code', 15: 'quote', 16: 'equation', 17: 'todo'}


def native_filter(value, field_name, field_type=lambda _: None):
    """Translate the standalone CLI filter DSL into Bitable's typed search filter."""
    if 'logic' not in value:
        return {'conjunction': value.get('conjunction', 'and'), 'conditions': [
            {**item, 'field_name': field_name(item.get('field_name', item.get('field', '')))}
            for item in value.get('conditions', [])]}
    conditions = []
    def millis(day):
        return str(int(datetime.fromisoformat(day).replace(tzinfo=timezone(timedelta(hours=8))).timestamp() * 1000))
    operators = {'>': 'isGreater', '<': 'isLess', '>=': 'isGreaterEqual', '<=': 'isLessEqual', '=': 'is', '==': 'is', '!=': 'isNot'}
    for item in value.get('conditions', []):
        if not isinstance(item, list) or len(item) != 3: raise NativeError('api-request')
        name, op, operand = item
        name = field_name(name)
        if op == 'intersects' and re.fullmatch(r'\d{4}-\d{2}-', str(operand)):
            if field_type(name) == 1:
                conditions.append({'field_name': name, 'operator': 'contains', 'value': [str(operand)]})
                continue
            start = datetime.fromisoformat(operand + '01')
            end = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
            conditions.extend([
                {'field_name': name, 'operator': 'isGreater', 'value': ['ExactDate', millis((start - timedelta(days=1)).date().isoformat())]},
                {'field_name': name, 'operator': 'isLess', 'value': ['ExactDate', millis(end.date().isoformat())]},
            ])
        else:
            if op not in operators: raise NativeError('api-request')
            date = re.fullmatch(r'ExactDate\((\d{4}-\d{2}-\d{2})\)', str(operand))
            operator = operators[op]
            day = date[1] if date else None
            if date and op in ('>=', '<='):
                # Bitable's date filters support strict comparisons; numeric >=/<= are rejected.
                day = (datetime.fromisoformat(day) + timedelta(days=-1 if op == '>=' else 1)).date().isoformat()
                operator = 'isGreater' if op == '>=' else 'isLess'
            conditions.append({'field_name': name, 'operator': operator, 'value': ['ExactDate', millis(day)] if date else [str(operand)]})
    return {'conjunction': value['logic'], 'conditions': conditions}


def inline_elements(node, inherited=None):
    style = dict(inherited or {})
    if node.tag in ('b', 'strong'): style['bold'] = True
    if node.tag in ('i', 'em'): style['italic'] = True
    if node.tag == 'u': style['underline'] = True
    if node.tag in ('s', 'del'): style['strikethrough'] = True
    if node.get('text-color'):
        color = COLORS.get(node.get('text-color'))
        if color is None: raise NativeError('document-format')
        style['text_color'] = color
    if node.tag == 'a':
        link = node.get('href', '')
        if not re.match(r'^https?://', link): raise NativeError('document-format')
        style['link'] = {'url': link}
    elements = []
    def add(text, current):
        if text:
            elements.append({'text_run': {'content': text, 'text_element_style': current}})
    add(node.text, style)
    for child in node:
        if child.tag == 'br': add('\n', style)
        elif child.tag in ('b', 'strong', 'span', 'i', 'em', 'u', 's', 'del', 'a'):
            elements.extend(inline_elements(child, style))
        else: raise NativeError('document-format')
        add(child.tail, style)
    return elements or [{'text_run': {'content': '', 'text_element_style': style}}]


def document_graph(xml):
    if '<!DOCTYPE' in xml.upper() or '<!ENTITY' in xml.upper(): raise NativeError('document-format')
    try: root = ET.fromstring('<fragment>' + xml + '</fragment>')
    except ET.ParseError as exc: raise NativeError('document-format') from exc
    blocks = []
    def block(kind, key, body):
        item = {'block_id': f'b{len(blocks)}', 'block_type': kind, key: body}
        blocks.append(item)
        return item
    def children(node, parent):
        ids = []
        for child in node: ids.extend(visit(child, parent))
        return ids
    def visit(node, parent=''):
        tag = node.tag
        if tag == 'title': return []
        if tag in ('docx', 'fragment', 'body', 'ul', 'ol'): return children(node, tag)
        if tag == 'hr': return [block(22, 'divider', {})['block_id']]
        if tag == 'table':
            rows = node.findall('./thead/tr') + node.findall('./tbody/tr') + node.findall('./tr')
            width = len(rows[0]) if rows else 0
            if not width or any(len(r) != width for r in rows): raise NativeError('document-format')
            item = block(31, 'table', {'property': {'row_size': len(rows), 'column_size': width, 'header_row': node.find('thead') is not None}})
            cells = []
            for row in rows:
                for cell in row:
                    target = block(32, 'table_cell', {})
                    if all(c.tag in ('span', 'b', 'strong', 'i', 'em', 'a', 'br') for c in cell):
                        text = block(2, 'text', {'elements': inline_elements(cell)})
                        target['children'] = [text['block_id']]
                    else: target['children'] = children(cell, 'table_cell')
                    cells.append(target['block_id'])
            item['children'] = cells
            item['table']['cells'] = cells
        elif tag in ('grid', 'column', 'callout'):
            if tag == 'grid': item = block(24, 'grid', {'column_size': len(node)})
            elif tag == 'column': item = block(25, 'grid_column', {'width_ratio': round(float(node.get('width-ratio', '1')) * 100)})
            else:
                attrs = {}
                for name in ('background-color', 'border-color', 'text-color'):
                    value = node.get(name)
                    if value:
                        color = COLORS.get(value.removeprefix('light-'))
                        if color is None: raise NativeError('document-format')
                        # Callout background enum uses the corresponding pale palette.
                        attrs[name.replace('-', '_')] = color
                item = block(19, 'callout', attrs)
            item['children'] = children(node, tag)
        else:
            kind = int(tag[1:]) + 2 if re.fullmatch(r'h[1-9]', tag) else {'p': 2, 'li': 13 if parent == 'ol' else 12, 'checkbox': 17}.get(tag)
            if kind is None: raise NativeError('document-format')
            body = {'elements': inline_elements(node)}
            if kind == 17: body['style'] = {'done': node.get('done') == 'true'}
            if kind == 13: body['style'] = {'sequence': node.get('seq', 'auto')}
            item = block(kind, TEXT_KEYS[kind], body)
        return [item['block_id']]
    roots = visit(root)
    if not roots or len(blocks) > 1000: raise NativeError('document-format')
    return roots, blocks


def blocks_content(blocks, doc, markdown=False):
    by_id = {b['block_id']: b for b in blocks}
    seen = set()
    def walk(key):
        if key in seen or key not in by_id: raise NativeError('previous-content')
        seen.add(key)
        item = by_id[key]
        kind = item['block_type']
        body = item.get(TEXT_KEYS.get(kind, ''), {})
        pieces = []
        for element in body.get('elements', []):
            if 'text_run' in element: pieces.append(element['text_run'].get('content', ''))
            elif 'mention_user' in element:
                mention = element['mention_user']
                pieces.append('@' + (mention.get('user_name') or mention.get('user_id', '')))
            elif 'equation' in element: pieces.append(element['equation'].get('content', ''))
            else: raise NativeError('previous-content')
        text = ''.join(pieces)
        value = ''
        if kind in TEXT_KEYS:
            if markdown:
                prefix = '#' * (kind - 2) + ' ' if 3 <= kind <= 11 else '- ' if kind in (12, 13, 17) else ''
                value = prefix + text + '\n'
            else:
                tag = f'h{kind - 2}' if 3 <= kind <= 11 else 'p'
                value = f'<{tag}>{html.escape(text)}</{tag}>'
        return value + ''.join(walk(child) for child in item.get('children', []))
    if doc not in by_id: raise NativeError('previous-content')
    return ''.join(walk(child) for child in by_id[doc].get('children', []))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None


class NativeFeishu:
    def __init__(self, token, work=None):
        if not isinstance(token, str) or not token or '\n' in token: raise NativeError('app-auth')
        self._token = token
        self.work = Path(work) if work else None
        self._fields = {}
        self._field_types = {}
        self._documents = {}
        self._opener = urllib.request.build_opener(_NoRedirect())

    def request(self, method, path, *, body=None, params=None, read=False):
        if not re.fullmatch(r'[A-Za-z0-9_/-]+', path): raise NativeError()
        url = 'https://open.feishu.cn/open-apis/' + path
        if params: url += '?' + urllib.parse.urlencode(params)
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        attempts = 3 if read else 1
        for attempt in range(attempts):
            req = urllib.request.Request(url, data=data, method=method, headers={'Authorization': 'Bearer ' + self._token, 'Content-Type': 'application/json; charset=utf-8'})
            try:
                with self._opener.open(req, timeout=15 if read else 60) as response:
                    payload = json.load(response)
                if payload.get('code') != 0:
                    raise NativeError('api-permission' if payload.get('code') in (99991663, 99991672, 99991668, 91403) else 'api-request', api_code=payload.get('code'))
                if not isinstance(payload.get('data'), dict): raise NativeError('api-request')
                return payload['data']
            except urllib.error.HTTPError as exc:
                if exc.code in (401, 403): raise NativeError('api-permission') from exc
                if not read or exc.code not in (429, 500, 502, 503, 504) or attempt + 1 == attempts: raise NativeError('api-request') from exc
            except (urllib.error.URLError, TimeoutError) as exc:
                if not read or attempt + 1 == attempts: raise NativeError('timeout') from exc
            time.sleep(attempt + 1)

    def check(self, base, table):
        self.request('GET', f'bitable/v1/apps/{base}/tables/{table}/records', params={'page_size': 1}, read=True)

    def fields(self, base, table):
        key = (base, table)
        if key in self._fields: return self._fields[key]
        result = {}; types = {}; page = None; visited = set()
        for _ in range(20):
            data = self.request('GET', f'bitable/v1/apps/{base}/tables/{table}/fields', params={'page_size': 100, **({'page_token': page} if page else {})}, read=True)
            for item in data.get('items', []):
                result[item['field_id']] = item['field_name']
                types[item['field_name']] = item.get('type')
            if not data.get('has_more'):
                self._fields[key] = result
                self._field_types[key] = types
                return result
            page = data.get('page_token')
            if not page or page in visited: break
            visited.add(page)
        raise NativeError('api-request')

    def list_records(self, *, base_token, table_id, field_ids, identity, max_pages, view_id='', filter_json=None, sort_json=None, require_complete=False):
        names = self.fields(base_token, table_id)
        def field_name(key):
            if key.startswith('fld') and key not in names: raise NativeError('api-request')
            return names.get(key, key)
        def mapped(value):
            if isinstance(value, list): return [mapped(v) for v in value]
            if not isinstance(value, dict): return value
            return {('field_name' if k == 'field' else k): field_name(v) if k in ('field', 'field_name') else mapped(v) for k, v in value.items()}
        body = {}
        if view_id: body['view_id'] = view_id
        # Some historic optional fields no longer exist; filter/sort references must still resolve.
        selected = [names.get(f, f) for f in field_ids if f in names or f in names.values()]
        if selected: body['field_names'] = list(dict.fromkeys(selected))
        if filter_json: body['filter'] = mapped(native_filter(filter_json, field_name, lambda name: self._field_types.get((base_token, table_id), {}).get(name)))
        if sort_json: body['sort'] = mapped(sort_json)
        records = []; page = None; visited = set()
        for _ in range(max_pages):
            data = self.request('POST', f'bitable/v1/apps/{base_token}/tables/{table_id}/records/search', body=body, params={'page_size': 200, 'user_id_type': 'open_id', **({'page_token': page} if page else {})}, read=True)
            if not isinstance(data.get('items'), list): raise NativeError('api-request')
            for item in data['items']:
                fields = item.get('fields')
                if not isinstance(fields, dict): raise NativeError('api-request')
                adapted = dict(fields)
                for name, value in fields.items():
                    if self._field_types.get((base_token, table_id), {}).get(name) == 15 or name in ('链接', '知识库链接', '记录链接'):
                        # Historic URL columns are rich text, with labels and targets in separate keys.
                        def links(cell):
                            if isinstance(cell, list): return [target for entry in cell for target in links(entry)]
                            if isinstance(cell, dict): return links(cell.get('link') or cell.get('url') or cell.get('text') or '')
                            return re.findall(r'https?://[^\s<>]+', cell) if isinstance(cell, str) else []
                        targets = links(value)
                        if len(set(targets)) > 1: raise NativeError('previous-content')
                        adapted[name] = targets[0] if targets else ''
                records.append({**item, 'fields': adapted})
            if not data.get('has_more'): return records
            page = data.get('page_token')
            if not page or page in visited: raise NativeError('api-request')
            visited.add(page)
        if require_complete: raise NativeError('api-request')
        return records

    def blocks(self, doc):
        metadata = self.request('GET', f'docx/v1/documents/{doc}', read=True)
        revision = metadata.get('document', {}).get('revision_id')
        if not isinstance(revision, int) or revision < 0: raise NativeError('previous-content')
        items = []; page = None; seen = set()
        for _ in range(40):
            data = self.request('GET', f'docx/v1/documents/{doc}/blocks', params={'page_size': 500, 'document_revision_id': revision if revision is not None else -1, **({'page_token': page} if page else {})}, read=True)
            if not isinstance(data.get('items'), list): raise NativeError('previous-content')
            current = data.get('document_revision_id')
            if revision is not None and current is not None and revision != current: raise NativeError('previous-content')
            revision = current if current is not None else revision
            items.extend(data['items'])
            if not data.get('has_more'): return items, revision
            page = data.get('page_token')
            if not page or page in seen: break
            seen.add(page)
        raise NativeError('previous-content')

    def fetch(self, doc, markdown=False):
        token = document_id(doc)
        if token not in self._documents: self._documents[token] = self.blocks(token)[0]
        blocks = self._documents[token]
        return {'data': {'document': {'content': blocks_content(blocks, token, markdown)}}}

    def run(self, args, **kwargs):
        if args[:2] == ['docs', '+fetch']:
            return self.fetch(args[args.index('--doc') + 1], '--doc-format' in args and args[args.index('--doc-format') + 1] == 'markdown')
        if args[:2] == ['base', '+field-list']:
            fields = self.fields(args[args.index('--base-token') + 1], args[args.index('--table-id') + 1])
            return {'data': {'fields': [{'id': key, 'name': value} for key, value in fields.items()]}}
        raise NativeError('api-request')

    def create(self, xml, config):
        document_graph(xml)  # Validate the complete template before creating any document.
        title = ET.fromstring('<fragment>' + xml + '</fragment>').findtext('.//title') or '南通运维周报'
        body = {'title': title}
        if config.get('report_parent_token'): body['folder_token'] = config['report_parent_token']
        result = self.request('POST', 'docx/v1/documents', body=body)
        doc = result.get('document', {}).get('document_id')
        if not isinstance(doc, str) or not re.fullmatch('[A-Za-z0-9]+', doc): raise NativeError('api-request')
        url = f'https://example.feishu.cn/docx/PUBLIC_EXAMPLE_SOURCE'
        try: self.write(url, xml)
        except Exception as exc: raise NativeError(getattr(exc, 'category', 'execution'), url) from exc
        return url, doc, {'data': {'result': {'status': 'success'}}}

    def write(self, url, xml, config=None, _depth=0):
        doc = document_id(url)
        roots, desired = document_graph(xml)
        if _depth > len(roots) // 50 + 3: raise NativeError('api-request')
        key = hashlib.sha256((doc + '\0' + xml).encode()).hexdigest()
        if not self.work: raise NativeError('workspace')
        self.work.mkdir(parents=True, exist_ok=True)
        journal = self.work / f'native-write-{key}.json'
        def save(state):
            tmp = journal.with_suffix('.tmp')
            tmp.write_text(json.dumps(state, ensure_ascii=False), encoding='utf-8')
            tmp.replace(journal)
        actual, revision = self.blocks(doc)
        by_id = {b['block_id']: b for b in actual}
        current_roots = by_id.get(doc, {}).get('children', [])
        if not isinstance(current_roots, list) or doc not in by_id: raise NativeError('api-request')
        expected = {b['block_id']: b for b in desired}
        def fingerprint(ids):
            ordered = []; seen = set()
            def visit(key):
                if key in seen or key not in by_id: raise NativeError('document-conflict')
                seen.add(key)
                item = by_id[key]
                ordered.append(item)
                for child in item.get('children', []): visit(child)
            for key in ids: visit(key)
            return hashlib.sha256(json.dumps(ordered, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        def matches(ids, wanted_roots=roots):
            def subset(want, got):
                if isinstance(want, dict): return isinstance(got, dict) and all(subset(v, got.get(k, {} if v == {} else False if v is False else None)) for k, v in want.items())
                if isinstance(want, list): return isinstance(got, list) and len(want) == len(got) and all(subset(a, b) for a, b in zip(want, got))
                return want == got
            def tree(want_id, got_id):
                want, got = expected[want_id], by_id.get(got_id, {})
                body = {k: v for k, v in want.items() if k not in ('block_id', 'children')}
                if 'table' in body: body['table'] = {k: v for k, v in body['table'].items() if k != 'cells'}
                wc, gc = want.get('children', []), got.get('children', [])
                return subset(body, got) and len(wc) == len(gc) and all(tree(a, b) for a, b in zip(wc, gc))
            return len(ids) == len(wanted_roots) and all(tree(a, b) for a, b in zip(wanted_roots, ids))
        if matches(current_roots):
            save({'phase': 'done'})
            return {'data': {'result': {'status': 'success'}}}
        state = json.loads(journal.read_text(encoding='utf-8')) if journal.exists() else None
        if not state:
            state = {'phase': 'append', 'old': current_roots, 'revision': revision, 'oldFingerprint': fingerprint(current_roots)}
            save(state)
        if state['phase'] == 'done': raise NativeError('document-conflict')
        old = state['old']
        if fingerprint(old) != state['oldFingerprint']: raise NativeError('document-conflict')
        count = len(current_roots) - len(old)
        if count < 0 or count > len(roots) or current_roots[count:] != old or not matches(current_roots[:count], roots[:count]):
            raise NativeError('document-conflict')
        if count == len(roots):
            state['phase'] = 'cleanup'; save(state)
        elif state['phase'] == 'append' and (count > 0 or revision == state['revision']):
            batch_roots = roots[count:count + 50]
            batch_ids = set()
            def collect(key):
                batch_ids.add(key)
                for child in expected[key].get('children', []): collect(child)
            for root in batch_roots: collect(root)
            batch = [b for b in desired if b['block_id'] in batch_ids]
            client_token = hashlib.sha256((key + ':' + str(count)).encode()).hexdigest()[:32]
            self.request('POST', f'docx/v1/documents/{doc}/blocks/{doc}/descendant', body={'children_id': batch_roots, 'descendants': batch, 'index': count}, params={'document_revision_id': revision, 'client_token': client_token, 'user_id_type': 'open_id'})
            return self.write(url, xml, _depth=_depth + 1)
        else: raise NativeError('document-conflict')
        # Readback confirmed every new block before touching the previous body.
        if old:
            self.request('DELETE', f'docx/v1/documents/{doc}/blocks/{doc}/children/batch_delete', body={'start_index': len(roots), 'end_index': len(current_roots)}, params={'document_revision_id': revision if revision is not None else -1, 'client_token': key[32:]})
            return self.write(url, xml, _depth=_depth + 1)
        raise NativeError('api-request')
