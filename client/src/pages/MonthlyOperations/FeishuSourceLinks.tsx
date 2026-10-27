import { ExternalLink } from 'lucide-react';
import { useAccess } from '@/access/AccessProvider';

const BASE = 'https://vnet.feishu.cn/base/';
const WIKI = 'https://vnet.feishu.cn/wiki/';

export const FEISHU_SOURCE_LINKS = {
  overview: [
    {
      label: '机柜月表',
      href: `${BASE}ASLxbfESPahdTKs0A9NccgbrnXc?table=tblDYQYihJ0CgepE&view=vew26whHSY`,
    },
    {
      label: '电耗与 PUE',
      href: `${BASE}ASLxbfESPahdTKs0A9NccgbrnXc?table=tblqSskJvBnx9UJj&view=vewUBXgM67`,
    },
    {
      label: '用水量',
      href: `${BASE}ASLxbfESPahdTKs0A9NccgbrnXc?table=tblz4TkZqrUJB90y&view=vewrekh8YI`,
    },
  ],
  racks: [
    {
      label: '机柜月表',
      href: `${BASE}ASLxbfESPahdTKs0A9NccgbrnXc?table=tblDYQYihJ0CgepE&view=vew26whHSY`,
    },
    {
      label: '机柜上下电',
      href: `${BASE}ASLxbfESPahdTKs0A9NccgbrnXc?table=tblz8rjxdtRRlYmS&view=vewX77mW48`,
    },
  ],
  load: [
    {
      label: 'IT 负载率',
      href: `${BASE}ASLxbfESPahdTKs0A9NccgbrnXc?table=tblBgaPzuVj7V9Q6&view=vewTUyPs7E`,
    },
  ],
  electricity: [
    {
      label: '电耗与 PUE',
      href: `${BASE}ASLxbfESPahdTKs0A9NccgbrnXc?table=tblqSskJvBnx9UJj&view=vewUBXgM67`,
    },
    {
      label: '湿球温度',
      href: `${BASE}ASLxbfESPahdTKs0A9NccgbrnXc?table=tblz8rjxdtRRlYmS&view=vewX77mW48`,
    },
  ],
  water: [
    {
      label: '用水量',
      href: `${BASE}ASLxbfESPahdTKs0A9NccgbrnXc?table=tblz4TkZqrUJB90y&view=vewrekh8YI`,
    },
  ],
  events: [
    {
      label: '事件月表',
      href: `${WIKI}D01TwFPyXiJBY6kCBDZcMCGLnSe?table=tblj9XJLq5QzTAqX&view=vew0qiJFzK`,
    },
    {
      label: '重点事件',
      href: `${WIKI}G7oUwGdwaiTmimk8i2ecGTWOn4d?table=tbl07kaaLGodiTqQ&view=vewtj0ZiJJ`,
    },
  ],
  changes: [
    {
      label: '变更月表',
      href: `${WIKI}JhiVwgfoIimAqEk8YwEc09sknGd?table=tblBvg6wCYSX3hcg&view=vewew3vfZT`,
    },
    {
      label: '智航变更进展',
      href: `${WIKI}JhiVwgfoIimAqEk8YwEc09sknGd?table=tbl2cJuTBqRdIm8Z&view=vewpHqbHoP`,
    },
  ],
  planned: [
    {
      label: '计划性维护',
      href: `${BASE}HU38bc1vnamMK9sCeOgclUvXnFc?table=tblzk7WrXxNWQy6V&view=vewVRb8ODO`,
    },
  ],
  unplanned: [
    {
      label: '非计划性维护',
      href: `${BASE}HU38bc1vnamMK9sCeOgclUvXnFc?table=tbl4Yh8Uye8bjLls&view=vewi5Clkm5`,
    },
  ],
  alarms: [
    {
      label: '告警月表',
      href: `${WIKI}SOwsw315aiBJjgkl48ccoxIPntc?table=tblD7hi70s6U6rlU&view=vewScMMh5S`,
    },
  ],
  risk: [
    {
      label: 'OPEN 风险项',
      href: `${BASE}IrIibPkUOa6udGsMhu2cbOqhnWg?table=tblviRG8ZDfY7AnF&view=vew7yV6HbG`,
    },
    {
      label: '排查明细',
      href: `${BASE}IrIibPkUOa6udGsMhu2cbOqhnWg?table=tblNddknaoXp2ASG`,
    },
    {
      label: '风险排查',
      href: `${BASE}IrIibPkUOa6udGsMhu2cbOqhnWg?table=tblkSEwsxqGKQDIw&view=vewG4XuaPu`,
    },
  ],
  drill: [
    {
      label: '智航演练',
      href: `${BASE}IrIibPkUOa6udGsMhu2cbOqhnWg?table=tbleCzxRd2yF7lT7&view=vew0UNl8ZR`,
    },
  ],
  event: [
    {
      label: '智航事件',
      href: `${BASE}IrIibPkUOa6udGsMhu2cbOqhnWg?table=tbl06hMoUMdGVEvn&view=vew0xMcHto`,
    },
  ],
  inspection: [
    {
      label: '现场巡检',
      href: `${BASE}IrIibPkUOa6udGsMhu2cbOqhnWg?table=tblTXHrDH4Mv0971&view=vewgfEzEZl`,
    },
  ],
} as const;

export type FeishuSourceKey = keyof typeof FEISHU_SOURCE_LINKS;

export function FeishuSourceLinks({ source }: { source: FeishuSourceKey }) {
  const { role } = useAccess();
  if (role !== 'admin') return null;

  return (
    <nav className="mo-feishu-sources" aria-label="飞书数据源">
      {FEISHU_SOURCE_LINKS[source].map(({ label, href }) => (
        <a
          key={href}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`在飞书中打开${label}源表`}
        >
          {label}源表
          <ExternalLink aria-hidden="true" />
        </a>
      ))}
    </nav>
  );
}
