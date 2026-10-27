import {
  latestMeetingActions,
  parseActionSection,
  splitActions,
} from './meeting.actions';
import { mapWeeklyMeeting } from './meeting.mapper';

describe('周会最新待办提取', () => {
  it('无编号的换行段落各自拆分，缩进续行保留在同一段',()=>{
    expect(splitActions('采购接油盘\n沟通工具研发\n  补充测试范围').map(item=>item.content)).toEqual(['采购接油盘','沟通工具研发\n补充测试范围']);
  });
  it('复选框和独立段落分别提取，保留每项的原文定位', () => {
    const original =
      '☐ 待办：接油盘采购\n☐ 待办：工具研发\n\n独立段落一\n\n独立段落二';
    expect(
      splitActions(original).map((item) => ({
        content: item.content,
        start: item.start,
        end: item.end,
      })),
    ).toEqual([
      { content: '待办：接油盘采购', start: 0, end: 0 },
      { content: '待办：工具研发', start: 1, end: 1 },
      { content: '独立段落一', start: 3, end: 3 },
      { content: '独立段落二', start: 5, end: 5 },
    ]);
  });
  const make = (id: string, date: string, content: string) =>
    mapWeeklyMeeting({
      record_id: id,
      fields: { 日期: date, 第几周: `${date}周报`, 本周代办: content },
    });
  it('按编号拆分，延续换行保留，沟通对象不冒充责任人', () => {
    const meeting = make(
      'recA',
      '2026-08-19',
      '1. 与郭海源沟通A楼ATS问题\n保留备件\n2. 调整B楼液位（责任人：张三；截止：2026-08-21）',
    );
    const actions = parseActionSection(meeting, meeting.sections[0]);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      responsible: null,
      mentionedPeople: ['郭海源'],
      buildings: ['A楼'],
    });
    expect(actions[0].content).toContain('保留备件');
    expect(actions[1]).toMatchObject({
      responsible: '张三',
      dueText: '2026-08-21',
      buildings: ['B楼'],
    });
  });
  it('忽略无事项与楼栋小标题，不捏造已完成或过期状态', () => {
    const meeting = make(
      'recA',
      '2026-08-19',
      'A楼：\n1）无；\nB楼：\n1）暂无\nC楼：\n1）更换电池',
    );
    const actions = parseActionSection(meeting, meeting.sections[0]);
    expect(actions).toHaveLength(1);
    expect(actions[0].buildings).toEqual(['C楼']);
    expect(actions[0]).not.toHaveProperty('status');
  });
  it('最新周报未填时回溯最新有实际待办日期，并保留同日不同来源', () => {
    const result = latestMeetingActions([
      make('recOld', '2026-06-01', '1. 老事项'),
      make('recA', '2026-08-19', '1. 跟进供应商'),
      make('recB', '2026-08-19', '1. 调整报警'),
      make('recNew', '2026-10-07', '无'),
    ]);
    expect(result?.date).toBe('2026-08-19');
    expect(result?.items.map((item) => item.sourceRecordId)).toEqual([
      'recA',
      'recB',
    ]);
    expect(result?.newestReportDate).toBe('2026-10-07');
  });
  it('没有明确责任人和截止时间时留空；空源返回null', () => {
    expect(latestMeetingActions([])).toBeNull();
    const meeting = make('recA', '2026-08-19', '1. 下午与武源面对面沟通问题');
    expect(parseActionSection(meeting, meeting.sections[0])[0]).toMatchObject({
      responsible: null,
      dueText: null,
      mentionedPeople: ['武源'],
    });
  });
  it('供应商和部门等对象不被标记为人员', () => {
    const meeting = make(
      'recA',
      '2026-08-19',
      '1. 与高荣沟通，向供应商确认合同，向部门确认安排',
    );
    expect(
      parseActionSection(meeting, meeting.sections[0])[0].mentionedPeople,
    ).toEqual(['高荣']);
  });
});
