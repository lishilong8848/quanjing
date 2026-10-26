import type {
  MeetingAction,
  MeetingDetail,
  MeetingLatestActions,
  MeetingSection,
} from '../../../shared/meeting-management.interface';

export const ACTION_MARKER =
  /^\s*(?:[-*•]\s+(?:\[[ xX]\]\s*)?|[☐☑☒□✓✔]\s*|\[[ xX]\]\s*|\d+[.、．)）]\s*|[（(]\d+[)）]\s*)/;

export function splitActions(content: string) {
  const items: {
    content: string;
    building: string | null;
    start: number;
    end: number;
  }[] = [];
  let building: string | null = null;
  let current: (typeof items)[number] | null = null;
  let numbered = false;
  for (const [lineIndex, raw] of content.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) {
      current = null;
      continue;
    }
    if (/^[A-G](?:楼|栋)[:：]$/.test(line)) {
      building = line.slice(0, -1);
      current = null;
      continue;
    }
    const marker = ACTION_MARKER;
    const value = line.replace(marker, '').trim();
    if (
      /^(?:无|暂无|无新增|无遗留(?:项|问题)?|无待办(?:项)?|不涉及|无事项)[。.;；\s]*$/.test(
        value,
      )
    ) {
      current = null;
      continue;
    }
    if (marker.test(line) || !current || (!numbered && !/^\s+/.test(raw))) {
      numbered = marker.test(line);
      current = { content: value, building, start: lineIndex, end: lineIndex };
      items.push(current);
    } else {
      current.content += `\n${line}`;
      current.end = lineIndex;
    }
  }
  return items;
}

export function parseActionSection(
  meeting: MeetingDetail,
  section: MeetingSection,
): MeetingAction[] {
  if (!section.isAction) return [];
  return splitActions(section.content).map((item, index) => {
    const content = item.content;
    const owner =
      content.match(
        /(?:示例人员019|负责人|示例人员019员|责任部门)[:：]\s*([^\s，,。；;（）()]+)/,
      )?.[1] ||
      content.match(/由([\u4e00-\u9fa5]{2,4})负责/)?.[1] ||
      null;
    const responsible =
      owner && !['待明确', '未注明', '未分配'].includes(owner) ? owner : null;
    const dueText =
      content.match(
        /(?:截止(?:时间|日期)?|完成期限)[:：]\s*([^\s，,。；;（）()]+)/,
      )?.[1] || null;
    const mentionedPeople = [
      ...new Set([
        ...Array.from(
          content.matchAll(
            /(?:与|向)([\u4e00-\u9fa5]{2,4}?)(?:面对面)?(?:沟通|确认|了解|询问)/g,
          ),
          (match) => match[1],
        ),
        ...Array.from(
          content.matchAll(
            /协调([\u4e00-\u9fa5]{2,3}?)(?:进行|调整|跟进|确认|沟通)/g,
          ),
          (match) => match[1],
        ),
        ...Array.from(
          content.matchAll(/(?:在|根据)([\u4e00-\u9fa5]{2,4})所发/g),
          (match) => match[1],
        ),
      ]),
    ].filter(
      (person) =>
        person !== responsible &&
        !/(?:供应商|厂商|厂家|部门|单位|公司|班组|团队|客户|现场|示例人员001|人员|各楼)/.test(
          person,
        ),
    );
    const buildings = [
      ...new Set([
        ...(item.building ? [item.building] : []),
        ...Array.from(
          content.matchAll(/([A-G])(?:楼|栋|(?=[、，,和及]))/g),
          (match) => `${match[1]}楼`,
        ),
      ]),
    ];
    return {
      id: `${meeting.id}:${section.key}:${index}`,
      content,
      responsible,
      dueText,
      mentionedPeople,
      buildings,
      sourceRecordId: meeting.id,
      sourceTitle: meeting.title,
      sourceDate: meeting.date,
      sectionTitle: section.title,
    };
  });
}

export function latestMeetingActions(
  meetings: MeetingDetail[],
): MeetingLatestActions | null {
  const dated = [...meetings].sort(
    (a, b) =>
      (b.date || '').localeCompare(a.date || '') ||
      (b.updatedAt || '').localeCompare(a.updatedAt || '') ||
      a.id.localeCompare(b.id),
  );
  const reports = dated
    .map((meeting) => ({
      meeting,
      items: meeting.sections.flatMap((section) =>
        parseActionSection(meeting, section),
      ),
    }))
    .filter((item) => item.items.length);
  if (!reports.length) return null;
  const date = reports[0].meeting.date;
  // 无日期的记录不能被认作同一期，保留首个来源。
  const latest = date
    ? reports.filter((item) => item.meeting.date === date)
    : reports.slice(0, 1);
  return {
    date,
    newestReportDate: dated[0]?.date || null,
    items: latest.flatMap((item) => item.items),
  };
}
