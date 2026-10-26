import { ExternalLink } from 'lucide-react';
import { useAccess } from '@/access/AccessProvider';

const BASE = 'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE';
const WIKI = 'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE';

export const FEISHU_SOURCE_LINKS = {
  overview: [
    {
      label: '机柜月表',
      href: `${BASE}ASLxbfESPahdTKs0A9NccgbrnXc?table=tbl55d9d0575047d&view=vew26whHSY`,
    },
    {
      label: '电耗与 PUE',
      href: `${BASE}ASLxbfESPahdTKs0A9NccgbrnXc?table=tbl32bf112724ed6&view=vewUBXgM67`,
    },
    {
      label: '用水量',
      href: `${BASE}ASLxbfESPahdTKs0A9NccgbrnXc?table=tbl85eb2123a63c8&view=vewrekh8YI`,
    },
  ],
  racks: [
    {
      label: '机柜月表',
      href: `${BASE}ASLxbfESPahdTKs0A9NccgbrnXc?table=tbl55d9d0575047d&view=vew26whHSY`,
    },
    {
      label: '机柜上下电',
      href: `${BASE}ASLxbfESPahdTKs0A9NccgbrnXc?table=tbl38b1b0b822bf2&view=vewX77mW48`,
    },
  ],
  load: [
    {
      label: 'IT 负载率',
      href: `${BASE}ASLxbfESPahdTKs0A9NccgbrnXc?table=tbl35e641004a831&view=vewTUyPs7E`,
    },
  ],
  electricity: [
    {
      label: '电耗与 PUE',
      href: `${BASE}ASLxbfESPahdTKs0A9NccgbrnXc?table=tbl32bf112724ed6&view=vewUBXgM67`,
    },
    {
      label: '湿球温度',
      href: `${BASE}ASLxbfESPahdTKs0A9NccgbrnXc?table=tbl38b1b0b822bf2&view=vewX77mW48`,
    },
  ],
  water: [
    {
      label: '用水量',
      href: `${BASE}ASLxbfESPahdTKs0A9NccgbrnXc?table=tbl85eb2123a63c8&view=vewrekh8YI`,
    },
  ],
  events: [
    {
      label: '事件月表',
      href: `${WIKI}D01TwFPyXiJBY6kCBDZcMCGLnSe?table=tbl72e6608772279&view=vew0qiJFzK`,
    },
    {
      label: '重点事件',
      href: `${WIKI}G7oUwGdwaiTmimk8i2ecGTWOn4d?table=tbl8c53fd40c1f50&view=vewtj0ZiJJ`,
    },
  ],
  changes: [
    {
      label: '变更月表',
      href: `${WIKI}JhiVwgfoIimAqEk8YwEc09sknGd?table=tbl8f743982e48e1&view=vewew3vfZT`,
    },
    {
      label: '智航变更进展',
      href: `${WIKI}JhiVwgfoIimAqEk8YwEc09sknGd?table=tbl74dea197c9c1b&view=vewpHqbHoP`,
    },
  ],
  planned: [
    {
      label: '计划性维护',
      href: `${BASE}HU38bc1vnamMK9sCeOgclUvXnFc?table=tbldd9a6f0224dfc&view=vewVRb8ODO`,
    },
  ],
  unplanned: [
    {
      label: '非计划性维护',
      href: `${BASE}HU38bc1vnamMK9sCeOgclUvXnFc?table=tblf5773e339e8e1&view=vewi5Clkm5`,
    },
  ],
  alarms: [
    {
      label: '告警月表',
      href: `${WIKI}SOwsw315aiBJjgkl48ccoxIPntc?table=tbld976fa6fc1832&view=vewScMMh5S`,
    },
  ],
  risk: [
    {
      label: 'OPEN 风险项',
      href: `${BASE}IrIibPkUOa6udGsMhu2cbOqhnWg?table=tbl07ee68bd218ee&view=vew7yV6HbG`,
    },
    {
      label: '排查明细',
      href: `${BASE}IrIibPkUOa6udGsMhu2cbOqhnWg?table=tbl64acce602916f`,
    },
    {
      label: '风险排查',
      href: `${BASE}IrIibPkUOa6udGsMhu2cbOqhnWg?table=tbl863dea72c2e81&view=vewG4XuaPu`,
    },
  ],
  drill: [
    {
      label: '智航演练',
      href: `${BASE}IrIibPkUOa6udGsMhu2cbOqhnWg?table=tbl3c13aafddd198&view=vew0UNl8ZR`,
    },
  ],
  event: [
    {
      label: '智航事件',
      href: `${BASE}IrIibPkUOa6udGsMhu2cbOqhnWg?table=tbl3a6abd79ebe36&view=vew0xMcHto`,
    },
  ],
  inspection: [
    {
      label: '现场巡检',
      href: `${BASE}IrIibPkUOa6udGsMhu2cbOqhnWg?table=tblf51376b595c94&view=vewgfEzEZl`,
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
