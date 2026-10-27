import unittest
from unittest.mock import Mock
import native_feishu
import bridge


class NativeFeishuTests(unittest.TestCase):
    def test_legacy_date_month_and_state_filters_use_native_search_schema(self):
        period = bridge.report.weekly_period_from_dates('2026-10-01', '2026-10-09')
        result = native_feishu.native_filter(bridge.report.date_range_filter('fldDate', period), lambda _: '演练日期')
        self.assertEqual(result['conjunction'], 'and')
        self.assertEqual(result['conditions'][0]['operator'], 'isGreater')
        self.assertEqual(result['conditions'][0]['field_name'], '演练日期')
        self.assertEqual(result['conditions'][0]['value'], ['ExactDate', '1790697600000'])
        month = native_feishu.native_filter({'logic': 'and', 'conditions': [['计划演练时间', 'intersects', '2026-10-']]}, lambda x: x)
        self.assertEqual([c['operator'] for c in month['conditions']], ['isGreater', 'isLess'])
        planned_text = native_feishu.native_filter({'logic': 'and', 'conditions': [['计划演练时间', 'intersects', '2026-10-']]}, lambda x: x, lambda _: 1)
        self.assertEqual(planned_text['conditions'][0]['operator'], 'contains')
        status = native_feishu.native_filter({'logic': 'and', 'conditions': [['演练状态', '!=', '完成']]}, lambda x: x)
        self.assertEqual(status['conditions'][0]['operator'], 'isNot')
    def test_v3_graph_keeps_grid_callout_table_and_todos(self):
        xml = bridge.main({'action': 'offline-render', 'ali': ['检查供电'], 'local': ['复核水泵']})['xml']
        roots, blocks = native_feishu.document_graph(xml + '<table><thead><tr><td>专业</td></tr></thead><tbody><tr><td>电气</td></tr></tbody></table>')
        kinds = [b['block_type'] for b in blocks]
        for kind in [3, 7, 17, 19, 24, 25, 31, 32]:
            self.assertIn(kind, kinds)
        self.assertLess(len(blocks), 1000)
        self.assertTrue(roots)
        self.assertIn('检查供电', str(blocks))

    def test_check_never_resolves_or_runs_cli(self):
        from unittest.mock import patch
        with patch.object(bridge.report, 'resolve_lark_cli_command', side_effect=AssertionError('CLI called')), patch.object(native_feishu.NativeFeishu, 'check') as check:
            ready = bridge.main({'action': 'check', '_nativeAccessToken': 'qa-token'})
        self.assertTrue(ready['ready'])
        check.assert_called_once()

    def test_missing_token_is_safe_failure(self):
        with self.assertRaises(native_feishu.NativeError) as raised:
            native_feishu.NativeFeishu('')
        self.assertEqual(bridge.safe_failure_diagnostic(raised.exception)['category'], 'app-auth')

    def test_pagination_uses_cursor_and_field_ids_map_to_names(self):
        api = native_feishu.NativeFeishu('qa-token')
        api.request = Mock(side_effect=[
            {'items': [{'field_id': 'fldDate', 'field_name': '日期'}], 'has_more': False},
            {'items': [{'record_id': 'recA', 'fields': {'日期': 1}}], 'has_more': True, 'page_token': 'next'},
            {'items': [{'record_id': 'recB', 'fields': {'日期': 2}}], 'has_more': False},
        ])
        rows = api.list_records(base_token='baseA', table_id='tblA', field_ids=['fldDate'], identity='bot', max_pages=2, require_complete=True,
                                filter_json={'conjunction': 'and', 'conditions': [{'field': 'fldDate', 'operator': 'is', 'value': ['1']}]})
        self.assertEqual([x['record_id'] for x in rows], ['recA', 'recB'])
        self.assertEqual(api.request.call_args.kwargs['params']['page_token'], 'next')
        self.assertEqual(api.request.call_args.kwargs['body']['filter']['conditions'][0]['field_name'], '日期')

    def test_incomplete_or_repeated_pagination_fails(self):
        api = native_feishu.NativeFeishu('qa-token')
        api.fields = Mock(return_value={})
        api.request = Mock(return_value={'items': [], 'has_more': True, 'page_token': 'same'})
        with self.assertRaises(native_feishu.NativeError):
            api.list_records(base_token='baseA', table_id='tblA', field_ids=[], identity='bot', max_pages=2, require_complete=True)

    def test_url_field_uses_target_address_instead_of_display_label(self):
        api = native_feishu.NativeFeishu('qa-token')
        api.request = Mock(side_effect=[
            {'items': [{'field_id': 'fldLink', 'field_name': '链接', 'type': 15}], 'has_more': False},
            {'items': [{'record_id': 'recA', 'fields': {'链接': {'text': '周报显示名称', 'link': 'https://vnet.feishu.cn/docx/docQA'}}}], 'has_more': False},
        ])
        rows = api.list_records(base_token='baseA', table_id='tblA', field_ids=['链接'], identity='bot', max_pages=1)
        self.assertEqual(rows[0]['fields']['链接'], 'https://vnet.feishu.cn/docx/docQA')

    def test_historic_rich_text_link_extracts_hyperlink_target(self):
        api = native_feishu.NativeFeishu('qa-token')
        api.request = Mock(side_effect=[
            {'items': [{'field_id': 'fldLink', 'field_name': '链接', 'type': 1}], 'has_more': False},
            {'items': [{'record_id': 'recA', 'fields': {'链接': [{'type': 'text', 'text': '周报显示名称', 'link': 'https://vnet.feishu.cn/docx/docQA'}]}}], 'has_more': False},
        ])
        rows = api.list_records(base_token='baseA', table_id='tblA', field_ids=['链接'], identity='bot', max_pages=1)
        self.assertEqual(rows[0]['fields']['链接'], 'https://vnet.feishu.cn/docx/docQA')

    def test_document_urls_are_restricted(self):
        for url in ['https://evil.invalid/docx/abc', 'file:///a', 'https://vnet.feishu.cn/docx/../../a']:
            with self.assertRaises(native_feishu.NativeError):
                native_feishu.document_id(url)

    def test_readback_orders_children_and_preserves_heading_boundaries(self):
        blocks = [
            {'block_id': 'docA', 'block_type': 1, 'children': ['hA', 'pA', 'hB', 'pB']},
            {'block_id': 'pB', 'block_type': 2, 'text': {'elements': [{'text_run': {'content': '采购审批'}}]}},
            {'block_id': 'hA', 'block_type': 3, 'heading1': {'elements': [{'text_run': {'content': '三、专业线'}}]}},
            {'block_id': 'pA', 'block_type': 2, 'text': {'elements': [{'text_run': {'content': '电气专业线：检查供电'}}]}},
            {'block_id': 'hB', 'block_type': 3, 'heading1': {'elements': [{'text_run': {'content': '四、运营线'}}]}},
        ]
        xml = native_feishu.blocks_content(blocks, 'docA')
        self.assertIn('检查供电', bridge.report.extract_professional_section_xml(xml))
        self.assertNotIn('采购审批', bridge.report.extract_professional_section_xml(xml))
        self.assertIn('采购审批', bridge.report.extract_operation_section_xml(xml))

    def test_append_timeout_is_reconciled_without_duplicate_or_deleting_old_content(self):
        import tempfile
        with tempfile.TemporaryDirectory(prefix='weekly-native-') as work:
            api = FakeDocumentApi(work)
            api.timeout_append = True
            with self.assertRaises(native_feishu.NativeError):
                api.write('https://vnet.feishu.cn/docx/docQA', '<title>验收</title><h1>新周报</h1><p>检查供电</p>')
            self.assertIn('old', api.root['children'])
            api.timeout_append = False
            api.write('https://vnet.feishu.cn/docx/docQA', '<title>验收</title><h1>新周报</h1><p>检查供电</p>')
            self.assertEqual(api.append_count, 1)
            self.assertNotIn('old', api.root['children'])
            self.assertEqual(len(api.root['children']), 2)
            api.write('https://vnet.feishu.cn/docx/docQA', '<title>验收</title><h1>新周报</h1><p>检查供电</p>')
            self.assertEqual(api.append_count, 1)
            from pathlib import Path
            self.assertNotIn('qa-token', ''.join(p.read_text(encoding='utf-8') for p in Path(work).glob('*.json')))

    def test_bad_write_readback_never_deletes_previous_body(self):
        import tempfile
        with tempfile.TemporaryDirectory(prefix='weekly-native-') as work:
            api = FakeDocumentApi(work)
            api.corrupt = True
            with self.assertRaises(native_feishu.NativeError):
                api.write('https://vnet.feishu.cn/docx/docQA', '<h1>新周报</h1><p>检查供电</p>')
            self.assertIn('old', api.root['children'])
            self.assertEqual(api.delete_count, 0)

    def test_interrupted_write_refuses_to_delete_new_manual_edits(self):
        import tempfile
        with tempfile.TemporaryDirectory(prefix='weekly-native-') as work:
            api = FakeDocumentApi(work)
            api.timeout_append = True
            with self.assertRaises(native_feishu.NativeError):
                api.write('https://vnet.feishu.cn/docx/docQA', '<p>新周报</p>')
            api.items[1]['text']['elements'][0]['text_run']['content'] = '刚刚手动修改'
            api.revision += 1
            api.timeout_append = False
            with self.assertRaises(native_feishu.NativeError) as raised:
                api.write('https://vnet.feishu.cn/docx/docQA', '<p>新周报</p>')
            self.assertEqual(raised.exception.category, 'document-conflict')
            self.assertEqual(api.delete_count, 0)

    def test_later_batch_timeout_resumes_only_remaining_blocks(self):
        import tempfile
        with tempfile.TemporaryDirectory(prefix='weekly-native-') as work:
            api = FakeDocumentApi(work)
            api.timeout_append_at = 2
            xml = ''.join(f'<p>验收事项{i}</p>' for i in range(120))
            with self.assertRaises(native_feishu.NativeError):
                api.write('https://vnet.feishu.cn/docx/docQA', xml)
            self.assertEqual(api.append_count, 2)
            self.assertIn('old', api.root['children'])
            api.timeout_append_at = 0
            api.write('https://vnet.feishu.cn/docx/docQA', xml)
            self.assertEqual(api.append_count, 3)
            self.assertEqual(len(api.root['children']), 120)
            self.assertEqual(len(set(api.root['children'])), 120)
            self.assertEqual(len(set(api.client_tokens)), 3)

    def test_created_document_url_is_preserved_after_write_failure(self):
        import tempfile
        with tempfile.TemporaryDirectory(prefix='weekly-native-') as work:
            api = FakeDocumentApi(work)
            api.timeout_append = True
            with self.assertRaises(native_feishu.NativeError) as raised:
                api.create('<title>验收</title><p>检查供电</p>', {})
            self.assertEqual(raised.exception.document_url, 'https://vnet.feishu.cn/docx/docQA')
            self.assertEqual(api.create_count, 1)

    def test_full_template_writes_and_reads_back_without_cli(self):
        import tempfile
        with tempfile.TemporaryDirectory(prefix='weekly-native-') as work:
            api = FakeDocumentApi(work)
            xml = bridge.main({'action': 'offline-render', 'ali': ['检查供电'], 'local': ['复核水泵']})['xml']
            url, _, _ = api.create(xml, {})
            from unittest.mock import patch
            with patch.object(bridge.report, 'run_lark_cli', side_effect=api.run):
                bridge.verify_document(url, xml, 'bot')
            self.assertEqual(api.append_count, (len(native_feishu.document_graph(xml)[0]) + 49) // 50)
            self.assertEqual(api.create_count, 1)


class FakeDocumentApi(native_feishu.NativeFeishu):
    def __init__(self, work):
        super().__init__('qa-token', work)
        self.root = {'block_id': 'docQA', 'block_type': 1, 'children': ['old']}
        self.items = [self.root, {'block_id': 'old', 'block_type': 2, 'text': {'elements': [{'text_run': {'content': '旧周报'}}]}}]
        self.revision = 1
        self.append_count = self.delete_count = self.create_count = 0
        self.timeout_append = self.corrupt = False
        self.timeout_append_at = 0
        self.client_tokens = []

    def request(self, method, path, *, body=None, params=None, read=False):
        import copy
        if method == 'GET':
            if not path.endswith('/blocks'):
                return {'document': {'document_id': 'docQA', 'revision_id': self.revision}}
            return {'items': copy.deepcopy(self.items), 'document_revision_id': self.revision, 'has_more': False}
        if path == 'docx/v1/documents':
            self.create_count += 1
            self.root['children'] = []
            self.items = [self.root]
            return {'document': {'document_id': 'docQA'}}
        if method == 'POST':
            self.append_count += 1
            self.client_tokens.append(params['client_token'])
            self.assert_revision(params)
            blocks = copy.deepcopy(body['descendants'])
            ids = {b['block_id']: 'new' + b['block_id'] for b in blocks}
            for b in blocks:
                b['block_id'] = ids[b['block_id']]
                if 'children' in b: b['children'] = [ids[k] for k in b['children']]
                if 'table' in b: b['table']['cells'] = [ids[k] for k in b['table']['cells']]
            if self.corrupt: blocks[0].get('heading1', blocks[0].get('text', {}))['elements'] = [{'text_run': {'content': '错误'}}]
            self.items.extend(blocks)
            index = body['index']
            self.root['children'][index:index] = [ids[k] for k in body['children_id']]
            self.revision += 1
            if self.timeout_append or self.timeout_append_at == self.append_count: raise native_feishu.NativeError('timeout')
            return {}
        if method == 'DELETE':
            self.delete_count += 1
            self.assert_revision(params)
            del self.root['children'][body['start_index']:body['end_index']]
            self.revision += 1
            return {}
        raise AssertionError('Unexpected request')

    def assert_revision(self, params):
        if params['document_revision_id'] != self.revision: raise AssertionError('Revision not pinned')


if __name__ == '__main__':
    unittest.main()
