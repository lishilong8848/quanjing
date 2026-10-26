import unittest
import subprocess
import os
import json
from types import SimpleNamespace
from unittest.mock import patch
import bridge


class DocumentConfirmationTests(unittest.TestCase):
    def test_native_readiness_reports_safe_api_failure(self):
        from native_feishu import NativeFeishu, NativeError
        with patch.object(NativeFeishu, 'check', side_effect=NativeError('api-permission')):
            with self.assertRaises(NativeError) as raised:
                bridge.main({'action': 'check', '_nativeAccessToken': 'qa-token'})
            self.assertEqual(bridge.safe_failure_diagnostic(raised.exception)['category'], 'api-permission')

    def test_integrated_cli_candidates_include_app_tools_and_explicit_path_first(self):
        from pathlib import Path
        project = Path('C:/qa-app/scripts')
        with patch.object(bridge.report, 'PROJECT_ROOT', project), patch.dict(os.environ, {'LARK_CLI_BIN': 'C:/explicit/lark-cli.cmd'}):
            candidates = bridge.report.lark_cli_candidates()
            self.assertEqual(candidates[0], 'C:/explicit/lark-cli.cmd')
            self.assertIn(str(project.parent / 'tools' / 'lark-cli' / 'lark-cli.cmd'), candidates)

    def test_transient_read_timeout_recovers_without_restarting_generation(self):
        from unittest.mock import Mock
        run = Mock(side_effect=[RuntimeError('i/o timeout'), {'data': {'items': []}}])
        with patch.object(bridge.time, 'sleep'):
            self.assertEqual(bridge.run_stage_cli(run, ['base', '+record-list']), {'data': {'items': []}})
        self.assertEqual(run.call_count, 2)

    def test_reads_have_bounded_retry_and_permission_errors_do_not_retry(self):
        from unittest.mock import Mock
        for error, attempts in [(RuntimeError('i/o timeout'), 3), (RuntimeError('Permission denied'), 1)]:
            run = Mock(side_effect=error)
            with patch.object(bridge.time, 'sleep'):
                with self.assertRaises(RuntimeError):
                    bridge.run_stage_cli(run, ['docs', '+fetch'])
            self.assertEqual(run.call_count, attempts)
            self.assertFalse(run.call_args.kwargs['retry'])

    def test_write_timeout_never_retries_or_becomes_success(self):
        from unittest.mock import Mock
        for args in [['docs', '+create'], ['docs', '+update'], ['base', '+record-create']]:
            run = Mock(side_effect=subprocess.TimeoutExpired('cli', 30))
            with self.assertRaises(subprocess.TimeoutExpired):
                bridge.run_stage_cli(run, args)
            self.assertEqual(run.call_count, 1)
    def test_safe_failure_diagnostic_excludes_raw_content_and_classifies_known_errors(self):
        sensitive = 'PRIVATE_SENTINEL token=SECRET https://example.invalid/private'
        for error, category in [(TimeoutError(sensitive), 'timeout'),
                                (RuntimeError('飞书接口连接超时或网络异常 ' + sensitive), 'timeout'),
                                (RuntimeError('目标周报日期必须与生成结束日期一致 ' + sensitive), 'target-date'),
                                (RuntimeError('目标周报不存在或重复 ' + sensitive), 'target-missing'),
                                (RuntimeError('上一期继承内容读取失败 ' + sensitive), 'previous-content'),
                                (RuntimeError(sensitive), 'execution')]:
            diagnostic = bridge.safe_failure_diagnostic(error)
            self.assertEqual(diagnostic['category'], category)
            self.assertNotIn('PRIVATE_SENTINEL', str(diagnostic))
            self.assertNotIn('SECRET', str(diagnostic))
            self.assertNotIn('https://', str(diagnostic))
    def test_report_structure_matches_verified_template(self):
        data = bridge.report.NantongWeeklyData(
            title='验收周报', start_date='2026-10-01', end_date='2026-10-07', week_number=41,
            meeting_todos=['检查水泵（待办人：示例人员020）'],
        )
        xml, _ = bridge.report.render_docx_xml(data)
        for heading in ['一、本周待办', '阿里周会待办', '上周内部周会待办', '二、本周周会内容',
                        '整体概况', '管理线：', '三、专业线', '四、运营线']:
            self.assertIn(heading, xml)
        self.assertEqual(xml.count('二、效率（变更、维护、演练）'), 6)
        self.assertNotIn('维护A类/类', xml)
        self.assertIn('待办人：示例人员020', xml)

    def test_v3_numbered_styled_sections_remain_readable_next_week(self):
        source = '<h1><span text-color="purple">三、专业线</span></h1><h2>电气专业线</h2><p>检查母联开关</p><h1><span text-color="green">四、运营线</span></h1><p>成本支出：本月维保费用</p>'
        professional = bridge.report.extract_professional_section_xml(source)
        self.assertIn('检查母联开关', professional)
        self.assertNotIn('本月维保费用', professional)
        self.assertIn('本月维保费用', bridge.report.extract_operation_section_xml(source))
        self.assertTrue(bridge.report.extract_professional_section_xml('<h2>专业线：</h2><p>旧周报内容</p>'))

    def test_v3_professional_grid_preserves_all_four_groups_and_costs(self):
        data = bridge.report.NantongWeeklyData(title='验收', start_date='2026-10-01', end_date='2026-10-07', week_number=41,
            professional_line='电气专业线\n- 复核母联开关\n暖通专业线\n- 核对冷机水温\n弱电专业线\n- 检查动环采集\nEHS&消防专业线\n- 复核消防整改',
            operation_line='成本支出：本月维保费用\n跟进采购审批')
        xml = bridge.report.render_professional_section(data)
        self.assertEqual(xml.count('<column width-ratio="0.5">'), 4)
        for value in ['复核母联开关', '核对冷机水温', '检查动环采集', '复核消防整改']:
            self.assertIn(value, xml)
        operations = bridge.report.render_operation_section(data)
        self.assertIn('<h2>成本支出</h2>', operations)
        self.assertIn('本月维保费用', operations)
        self.assertIn('跟进采购审批', operations)

    def test_v3_drills_distinguish_monthly_plan_weekly_progress_and_conflicts(self):
        drills = [
            {'source_drill': True, 'building': 'A楼', 'scenario': '失电演练', 'in_month': True, 'in_week': True, 'completed': True, 'pending_approval': True},
            {'source_drill': True, 'building': 'A楼', 'scenario': '空调故障', 'in_month': True, 'in_week': True, 'started': True, 'status': '进行中'},
            {'source_drill': True, 'building': 'A楼', 'scenario': '月末计划', 'in_month': True, 'in_week': False},
            {'source_drill': True, 'building': 'A楼', 'scenario': '待核对', 'in_month': False, 'in_week': True, 'status_conflict': True, 'status': '待评估'},
        ]
        xml = bridge.report.render_drill_template(drills, source_drills=True)
        for value in ['本月已完成1/3项', '完成率33.3%', '进行中1项', '已完成1项', '其中待审批1项', '状态待核对1项', '场景简述']:
            self.assertIn(value, xml)
        self.assertNotIn('月末计划—', xml)

    def test_v3_unmapped_drills_are_not_guessed_into_buildings(self):
        data = bridge.report.NantongWeeklyData(title='验收', start_date='2026-10-01', end_date='2026-10-07', week_number=41,
            drills=[{'source_drill': True, 'building': '区域未明确', 'scenario': '应急演练', 'in_month': True, 'in_week': True}],
            sources={'drill_source_enabled': True})
        xml, _ = bridge.report.render_docx_xml(data)
        self.assertIn('演练楼栋待核对：1项', xml)
        self.assertIn('演练整体完成情况', xml)
        self.assertEqual(xml.count('应急演练'), 1)

    def test_partial_write_is_not_success(self):
        with self.assertRaises(RuntimeError):
            bridge.require_complete_write({'data': {'result': {'status': 'partial_success'}}})

    def test_changed_markup_with_same_text_is_confirmed(self):
        with patch.object(bridge.report, 'run_lark_cli', return_value={'data': {'document': {'content': '<h1 id="a">周报</h1><p><b>示例人员019</b>：示例人员020</p>'}}}):
            bridge.verify_document('doc', '<h1>周报</h1><p>示例人员019：示例人员020</p>', 'bot')

    def test_missing_content_fails_confirmation(self):
        with patch.object(bridge.report, 'run_lark_cli', return_value={'data': {'document': {'content': '<p>空文档</p>'}}}):
            with self.assertRaises(RuntimeError):
                bridge.verify_document('doc', '<p>周报内容</p>', 'bot')

    def test_title_metadata_is_not_compared_as_body(self):
        with patch.object(bridge.report, 'run_lark_cli', return_value={'data': {'document': {'content': '<h1>本周待办</h1><p>检查设备</p>'}}}):
            bridge.verify_document('doc', '<title>周报</title><h1>本周待办</h1><p>检查设备</p>', 'bot')


if __name__ == '__main__':
    unittest.main()
