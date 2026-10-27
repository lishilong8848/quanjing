import React, { useEffect, useState } from 'react';
import {
  Activity,
  BellRing,
  Boxes,
  Building2,
  ClipboardList,
  Cpu,
  Database,
  Gauge,
  GitBranch,
  HardDrive,
  RadioTower,
  Radar,
  ShieldCheck,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';

type ArchitectureUnit = {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  accent: 'blue' | 'cyan' | 'green' | 'amber';
};

type AgentFoundationDomain = {
  title: string;
  items: string[];
  icon?: LucideIcon;
  brand?: 'feishu' | 'dingtalk';
  layout?: 'ecosystem' | 'dense' | 'environment';
  summary?: {
    metric?: string;
    subject?: string;
    action?: string;
    statement?: string;
  };
  tone: 'blue' | 'cyan' | 'green';
};

type AgentCapabilityItem = {
  label: string;
  details?: string[];
};

type AgentChainLayer = {
  marker: '1' | 'N' | 'X';
  title: string;
  subtitle: string;
  description: string;
  tone: 'cyan' | 'blue' | 'green';
};

type BaixiaoshengSkill = {
  label: string;
  tone: 'cyan' | 'blue' | 'green';
};

type BaixiaoshengWorkspace = {
  title: string;
  icon: LucideIcon;
  accent: 'cyan' | 'blue' | 'green' | 'amber';
  bullets: string[];
};

const executionUnits: ArchitectureUnit[] = [
  { title: '基地人力调度', subtitle: 'Workforce Dispatch', icon: RadioTower, accent: 'cyan' },
  { title: '容量资源运营', subtitle: 'Capacity Operations', icon: HardDrive, accent: 'blue' },
  { title: '电暖能耗管控', subtitle: 'Power & Thermal', icon: Zap, accent: 'amber' },
  { title: '工单化全域覆盖', subtitle: 'Ticket Coverage', icon: ClipboardList, accent: 'green' },
  { title: '资产生命周期管理', subtitle: 'Asset Lifecycle', icon: Boxes, accent: 'cyan' },
  { title: '安全环境管控', subtitle: 'Security & EHS', icon: ShieldCheck, accent: 'amber' },
  { title: '成本采购统筹', subtitle: 'Cost Procurement', icon: Gauge, accent: 'green' },
  { title: '客户交付服务', subtitle: 'Customer Delivery', icon: Building2, accent: 'blue' },
];

const levelMarkers = [
  { level: 'L3', title: '智能调度', subtitle: 'SMART DISPATCH' },
  { level: 'L2', title: '运营管控', subtitle: 'OPERATIONS' },
  { level: 'L1', title: '数字基座', subtitle: 'DIGITAL BASE' },
];

const flowPaths = [
  'M430 405 C365 455 300 495 235 525',
  'M525 405 C505 455 492 494 480 525',
  'M675 405 C695 455 710 494 720 525',
  'M770 405 C835 455 900 495 965 525',
  'M445 410 C355 505 290 575 235 626',
  'M545 410 C518 505 498 575 480 626',
  'M655 410 C688 505 708 575 720 626',
  'M755 410 C845 505 910 575 965 626',
];

const flowDots = [
  { cx: 235, cy: 525 },
  { cx: 480, cy: 525 },
  { cx: 720, cy: 525 },
  { cx: 965, cy: 525 },
  { cx: 235, cy: 626 },
  { cx: 480, cy: 626 },
  { cx: 720, cy: 626 },
  { cx: 965, cy: 626 },
];

const signalPills = [
  { label: '态势感知', value: 'ONLINE', icon: Activity },
  { label: '联动闭环', value: '8域协同', icon: GitBranch },
  { label: '规则引擎', value: '实时编排', icon: Cpu },
];

const aiCapabilities: AgentCapabilityItem[] = [
  {
    label: '知识问答',
    details: ['百晓生-随时问', '南通藏经阁'],
  },
  {
    label: '业务记忆',
    details: ['交接班&容量自动化', '阿里月报自动化', '体系月报自动化', '各类通报端到端'],
  },
  { label: '异常分析' },
  { label: '风险预警' },
  { label: '决策建议' },
  { label: '业务指导' },
  { label: '任务协同' },
  { label: '报告生成' },
  { label: '自我进化' },
];

const agentAiInsight = '依托1+N数据底座，沉淀感知、记忆、分析、决策与协同能力，形成面向南通基地运维场景的智能体中枢。';

const baixiaoshengSkills: BaixiaoshengSkill[] = [
  { label: '属地动环skill', tone: 'green' },
  { label: 'Outlook-skill', tone: 'blue' },
  { label: '智航数据skill', tone: 'cyan' },
  { label: '图片处理skill', tone: 'blue' },
  { label: '飞书多维skill', tone: 'cyan' },
  { label: '文档编辑skill', tone: 'green' },
  { label: '......', tone: 'blue' },
];

const baixiaoshengWorkspaces: BaixiaoshengWorkspace[] = [
  {
    title: '随钉办',
    icon: BellRing,
    accent: 'cyan',
    bullets: [
      '面向机房经理&主管',
      '数据提取与结构化汇总',
      '异常识别与风险提示',
      '重点问题跟踪建议',
    ],
  },
  {
    title: '随知录',
    icon: Database,
    accent: 'blue',
    bullets: [
      '面向属地全员',
      '无缝链接属地运维知识库',
      '随心记，日程、纪要自动化',
      '客户信息（封网/风险等）的自动化发布',
    ],
  },
  {
    title: '全景工作台',
    icon: Activity,
    accent: 'green',
    bullets: [
      '面向属地管理&技术',
      '合规性校验，全员持证自动化查询&更新',
      '施工管理的全流程辅助管理',
      '运行风险的跨前提示与模式切换',
      '容量、能效指标收集、处理、分析&预警',
    ],
  },
  {
    title: '灯塔工作台',
    icon: Building2,
    accent: 'amber',
    bullets: [
      '面向现场值班&工程师',
      '运维各类工单通报自动化，自动建单',
      '事件-检修/变更/施工-跟进-闭环',
      '交接班&容量自动化',
      '客户各类报表自动化',
      '属地告警标准化治理',
    ],
  },
];

const agentChainLayers: AgentChainLayer[] = [
  {
    marker: '1',
    title: '运维中枢层 / 园区',
    subtitle: '全局穿透的数字孪生',
    description: '跨系统数据物理打通，汇聚成园区层级全景运营数据底座',
    tone: 'cyan',
  },
  {
    marker: 'N',
    title: '神经节点层 / 机楼&专业',
    subtitle: '多业务线的领域横型',
    description: '由多个机楼&专业数据向上聚合，形成运行、运维、人员等各类运行&运营数据集',
    tone: 'blue',
  },
  {
    marker: 'X',
    title: '神经末梢层 / 员工',
    subtitle: '全员参与的微单元数字化',
    description: '线下数据&流程全量线上迁移，数据一次填报、全域复用',
    tone: 'green',
  },
];

const agentFoundationDomains: AgentFoundationDomain[] = [
  {
    title: '飞书生态',
    items: [
      '全景-事件管理',
      '全景-变更管理',
      '全景-维修管理',
      '全景-演练管理',
      '全景-维护管理',
      '全景-风险管理',
      '全景-培训管理',
      '全景-采购&合同',
      '全景-资料知识库',
      '全景-EHS管理',
      '全景-库房管理',
      '全景-横向中台',
    ],
    brand: 'feishu',
    layout: 'ecosystem',
    summary: { metric: '20+', subject: '系统', action: '聚合' },
    tone: 'cyan',
  },
  {
    title: '钉钉&智航',
    items: [
      '钉钉-阿里演练',
      '钉钉-风险问题',
      '钉钉-客户会议',
      '钉钉-基线看板',
      '钉钉-任务协同',
      '智航-风险排查',
      '智航-变更管控',
      '智航-演练管理',
    ],
    brand: 'dingtalk',
    layout: 'dense',
    summary: { statement: '打破系统独立割据，完成全域数据汇聚与联动应用' },
    tone: 'blue',
  },
  {
    title: '联动属地动环',
    items: ['全量设备告警', '电力运行效能', '暖通数据采集', '机柜容量数据'],
    icon: Radar,
    layout: 'environment',
    summary: { metric: '百万级', subject: '数据集', action: '加工与质量提纯' },
    tone: 'green',
  },
];

function SignalPill({ label, value, icon: Icon }: { label: string; value: string; icon: LucideIcon }) {
  return (
    <div className="ops-signal-pill">
      <Icon className="size-3.5" />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ArchitectureNode({ unit, index }: { unit: ArchitectureUnit; index: number }) {
  const Icon = unit.icon;

  return (
    <article
      className={`ops-business-node ops-business-node-${unit.accent}`}
      style={{ animationDelay: `${520 + index * 70}ms` }}
    >
      <div className="ops-business-node-glow" />
      <div className="ops-node-icon">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <h3>{unit.title}</h3>
        <p>{unit.subtitle}</p>
      </div>
    </article>
  );
}

function BrandMark({ brand }: { brand: 'feishu' | 'dingtalk' }) {
  if (brand === 'feishu') {
    return (
      <svg aria-hidden="true" className="ops-brand-mark ops-brand-feishu" viewBox="0 0 24 24">
        <path d="M12.9238 12.8029C12.9427 12.784 12.9616 12.7682 12.9806 12.7493C13.0184 12.7146 13.0563 12.6767 13.091 12.6389L13.1667 12.5631L13.397 12.336L14.7315 11.0173L15.0659 10.686C15.129 10.6229 15.1952 10.563 15.2615 10.5031C15.3845 10.3926 15.5076 10.2854 15.6369 10.1813C15.7536 10.0866 15.8767 9.99514 15.9997 9.9068C16.1732 9.78376 16.3499 9.67019 16.5329 9.55977C16.7127 9.45251 16.8957 9.35471 17.085 9.26322C17.2616 9.17804 17.4415 9.09917 17.6276 9.02661C17.7317 8.9856 17.8326 8.94774 17.9399 8.91304C17.9935 8.89411 18.044 8.87834 18.0977 8.86256C17.6276 7.00439 16.7632 5.3008 15.5991 3.84959C15.3719 3.56566 15.0249 3.40161 14.6589 3.40161H5.0084C4.83489 3.40161 4.76233 3.6256 4.90114 3.72656C8.18528 6.13997 10.9236 9.24114 12.9017 12.825C12.908 12.8187 12.9175 12.8124 12.9238 12.8029Z" fill="#00D6B9" />
        <path d="M9.09696 21.2986C14.0815 21.2986 18.4225 18.5476 20.6877 14.4843C20.7666 14.3423 20.8454 14.1972 20.918 14.052C20.8044 14.2729 20.6751 14.4811 20.5394 14.6767C20.4889 14.7461 20.4385 14.8155 20.388 14.8818C20.3217 14.9669 20.2555 15.049 20.1861 15.1278C20.1324 15.1909 20.0757 15.2509 20.0189 15.3108C19.9021 15.4307 19.7823 15.5474 19.6561 15.6547C19.5867 15.7146 19.5141 15.7714 19.4415 15.8282C19.3564 15.8944 19.268 15.9575 19.1797 16.0143C19.1229 16.0522 19.0661 16.09 19.0093 16.1247C18.9494 16.1626 18.8895 16.1973 18.8264 16.232C18.7002 16.3014 18.574 16.3645 18.4446 16.4245C18.3311 16.4749 18.2175 16.5223 18.1008 16.5633C17.9746 16.6106 17.8452 16.6516 17.7159 16.6863C17.5234 16.7399 17.3247 16.7809 17.1259 16.8125C16.9808 16.8346 16.8357 16.8504 16.6874 16.863C16.5328 16.8724 16.3751 16.8787 16.2173 16.8756C16.0438 16.8724 15.8703 16.863 15.6936 16.844C15.5643 16.8314 15.435 16.8125 15.3056 16.7873C15.192 16.7683 15.0785 16.7431 14.9649 16.7178C14.9049 16.7021 14.845 16.6895 14.7851 16.6737C14.6179 16.6295 14.4538 16.5822 14.2898 16.5349C14.2077 16.5096 14.1257 16.4875 14.0437 16.4623C13.9206 16.4245 13.7976 16.3897 13.6777 16.3519C13.5768 16.3203 13.479 16.2888 13.378 16.2572C13.2834 16.2257 13.1887 16.1942 13.0941 16.1626C13.031 16.1405 12.9647 16.1184 12.9016 16.0964C12.8228 16.0711 12.7471 16.0427 12.6682 16.0143C12.6114 15.9954 12.5578 15.9765 12.501 15.9544C12.3906 15.9134 12.2802 15.8755 12.1729 15.8345C12.1098 15.8093 12.0467 15.7872 11.9836 15.7619C11.8984 15.7304 11.8132 15.6957 11.7312 15.6641C11.6429 15.6294 11.5514 15.5947 11.4631 15.5569C11.4063 15.5348 11.3463 15.5096 11.2895 15.4875C11.217 15.4591 11.1476 15.4275 11.075 15.3991C11.0214 15.3771 10.9646 15.3518 10.911 15.3297C10.8542 15.3045 10.7974 15.2793 10.7406 15.254C10.6901 15.2319 10.6428 15.2099 10.5923 15.1878C10.5482 15.1688 10.5008 15.1468 10.4567 15.1278C10.4094 15.1057 10.3652 15.0868 10.3179 15.0647C10.2705 15.0427 10.2232 15.0206 10.1759 14.9985C10.116 14.9701 10.056 14.9417 9.99608 14.9165C9.93299 14.8881 9.87304 14.8565 9.80995 14.8281C9.7437 14.7966 9.67745 14.765 9.6112 14.7303C9.55441 14.7019 9.49762 14.6735 9.44084 14.6483C6.45324 13.1592 3.80321 11.1717 1.54438 8.76145C1.43081 8.64157 1.23206 8.72044 1.23206 8.88449L1.23836 18.0933C1.23836 18.494 1.43712 18.8726 1.77153 19.0934C3.86631 20.4878 6.38699 21.2986 9.09696 21.2986Z" fill="#3370FF" />
        <path d="M23.7322 9.29488C22.7226 8.79642 21.5838 8.5188 20.3818 8.5188C19.6688 8.5188 18.9747 8.6166 18.3217 8.80273C18.246 8.82481 18.1703 8.8469 18.0977 8.86898C18.0441 8.88476 17.9905 8.90368 17.94 8.91946C17.8359 8.95416 17.7318 8.99202 17.6276 9.03303C17.4447 9.10559 17.2617 9.18446 17.085 9.26964C16.8957 9.36113 16.7128 9.45893 16.5329 9.56619C16.35 9.67345 16.1701 9.79018 15.9998 9.91322C15.8767 10.0016 15.7569 10.093 15.637 10.1877C15.5076 10.2918 15.3846 10.3991 15.2616 10.5095C15.1953 10.5694 15.1322 10.6325 15.066 10.6925L14.7315 11.0206L13.3939 12.3424L13.1636 12.5696L13.0879 12.6453C13.05 12.6831 13.0122 12.7178 12.9775 12.7557C12.9586 12.7746 12.9396 12.7904 12.9207 12.8093C12.8923 12.8377 12.8639 12.863 12.8355 12.8882C12.804 12.9166 12.7724 12.9481 12.7409 12.9765C11.9143 13.7368 10.9931 14.3899 9.99304 14.923C10.053 14.9514 10.1129 14.9798 10.1729 15.0051C10.2202 15.0271 10.2675 15.0492 10.3148 15.0713C10.359 15.0934 10.4063 15.1123 10.4536 15.1344C10.4978 15.1533 10.5451 15.1754 10.5893 15.1943C10.6398 15.2164 10.6871 15.2385 10.7376 15.2606C10.7944 15.2858 10.8511 15.3111 10.9079 15.3363C10.9616 15.3584 11.0184 15.3836 11.072 15.4057C11.1445 15.4373 11.2139 15.4657 11.2865 15.4941C11.3433 15.5193 11.4032 15.5414 11.46 15.5635C11.5484 15.5982 11.6367 15.636 11.7282 15.6707C11.8134 15.7023 11.8954 15.737 11.9806 15.7685C12.0437 15.7938 12.1068 15.8158 12.1699 15.8411C12.2803 15.8821 12.3875 15.9231 12.498 15.961C12.5547 15.9799 12.6084 16.002 12.6652 16.0209C12.744 16.0493 12.8197 16.0745 12.8986 16.1029C12.9617 16.125 13.028 16.1471 13.0911 16.1692C13.1857 16.2007 13.2803 16.2323 13.375 16.2638C13.4728 16.2954 13.5737 16.3269 13.6747 16.3585C13.7977 16.3963 13.9176 16.4342 14.0406 16.4689C14.1227 16.4941 14.2047 16.5162 14.2867 16.5414C14.4508 16.5888 14.618 16.6361 14.782 16.6803C14.842 16.696 14.9019 16.7118 14.9618 16.7244C15.0754 16.7528 15.189 16.7749 15.3026 16.7938C15.4319 16.8159 15.5613 16.8348 15.6906 16.8506C15.8673 16.8695 16.0408 16.8822 16.2143 16.8822C16.372 16.8853 16.5298 16.879 16.6844 16.8695C16.8326 16.8601 16.9778 16.8412 17.1229 16.8191C17.3248 16.7875 17.5204 16.7465 17.7128 16.6929C17.8422 16.6582 17.9715 16.6172 18.0977 16.5698C18.2144 16.5257 18.328 16.4815 18.4416 16.4279C18.5709 16.3679 18.7003 16.3048 18.8233 16.2354C18.8833 16.2007 18.9464 16.166 19.0063 16.1282C19.0631 16.0935 19.1199 16.0556 19.1767 16.0178C19.265 15.9578 19.3533 15.8947 19.4385 15.8316C19.5111 15.7748 19.5836 15.718 19.653 15.6581C19.7792 15.5508 19.8991 15.4341 20.0158 15.3142C20.0726 15.2543 20.1294 15.1943 20.183 15.1313C20.2524 15.0524 20.3187 14.9704 20.3849 14.8852C20.4354 14.8189 20.4859 14.7495 20.5364 14.6801C20.672 14.4845 20.7982 14.2763 20.9118 14.0586L21.0411 13.7999L22.2084 11.4748L22.2053 11.4812C22.5807 10.6578 23.1012 9.91953 23.7322 9.29488Z" fill="#133C9A" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" className="ops-brand-mark ops-brand-dingtalk" viewBox="0 0 32 32">
      <path
        d="M24.9 7.2c-3.2-1.7-7.4-2.3-12.5-1.8 3.1 1.8 5.3 3.4 6.6 4.8-3.9-.5-7.1-.2-9.7.9 3.7 2.4 7.2 3.7 10.4 3.9l-5.1 1.2c1.2 1.3 2.7 2 4.5 2.1l-4.4 5.8 8.8-7.1c3.3-2.6 3.8-6.1 1.4-9.8Z"
        fill="#1E9BFF"
      />
      <path
        d="M10.1 10.9c3.5 2.3 6.8 3.5 10 3.6-2.1.8-4.3 1.3-6.6 1.5 1.1 1.4 2.7 2.2 4.9 2.3"
        fill="none"
        stroke="#EAF6FF"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.15"
        opacity="0.88"
      />
    </svg>
  );
}

function AgentCapabilityRow({
  label,
  title,
  items,
  variant,
}: {
  label: string;
  title: string;
  items: AgentCapabilityItem[];
  variant: 'ai' | 'data';
}) {
  return (
    <div className={`ops-agent-row ops-agent-row-${variant}`}>
      <div className="ops-agent-layer-label">{label}</div>
      <div className="ops-agent-row-body">
        <div className="ops-agent-title-wrap">
          <h2>{title}</h2>
        </div>
        <div className="ops-agent-chip-grid">
          {items.map((item) => (
            <div
              aria-label={item.details ? `${item.label}：${item.details.join('、')}` : item.label}
              className={`ops-agent-chip${item.details ? ' ops-agent-chip-has-popover' : ''}`}
              key={item.label}
              tabIndex={item.details ? 0 : undefined}
            >
              <span className="ops-agent-chip-label">{item.label}</span>
              {item.details ? (
                <span className="ops-agent-chip-popover" role="tooltip">
                  {item.details.map((detail) => (
                    <span key={detail}>{detail}</span>
                  ))}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AgentChainSummaryCard({ layer, index }: { layer: AgentChainLayer; index: number }) {
  return (
    <article
      className={`ops-agent-chain-card ops-agent-chain-card-${layer.tone}`}
      style={{ animationDelay: `${index * 90}ms` }}
    >
      <div className="ops-agent-chain-marker">{layer.marker}</div>
      <div>
        <h3>{layer.title}</h3>
        <strong>{layer.subtitle}</strong>
        <p>{layer.description}</p>
      </div>
    </article>
  );
}

function AgentFoundationDomainCard({
  domain,
  index,
}: {
  domain: AgentFoundationDomain;
  index: number;
}) {
  const Icon = domain.icon;
  const brandLabel = domain.brand === 'feishu' ? '飞书标识' : domain.brand === 'dingtalk' ? '钉钉标识' : undefined;
  const summaryLabel = domain.summary
    ? domain.summary.statement ?? `${domain.summary.metric ?? ''}${domain.summary.subject ?? ''}${domain.summary.action ?? ''}`
    : undefined;

  return (
    <article
      className={`ops-agent-domain-card ops-agent-domain-${domain.tone}${domain.layout ? ` ops-agent-domain-${domain.layout}` : ''}`}
      style={{ animationDelay: `${index * 90}ms` }}
    >
      <h3>
        <span className="ops-agent-domain-icon" aria-label={brandLabel}>
          {domain.brand ? <BrandMark brand={domain.brand} /> : Icon ? <Icon className="size-5" /> : null}
        </span>
        <span>{domain.title}</span>
      </h3>
      <div className="ops-agent-domain-items">
        {domain.items.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
      {domain.summary ? (
        <div
          aria-label={summaryLabel}
          className="ops-agent-domain-summary"
        >
          <span className="ops-agent-summary-ellipsis">...</span>
          {domain.summary.statement ? (
            <strong className="ops-agent-summary-statement">{domain.summary.statement}</strong>
          ) : (
            <strong>
              <span className="ops-agent-summary-metric">{domain.summary.metric}</span>
              <span className="ops-agent-summary-subject">{domain.summary.subject}</span>
              <span className="ops-agent-summary-action">{domain.summary.action}</span>
            </strong>
          )}
        </div>
      ) : null}
    </article>
  );
}

function BaixiaoshengModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="ops-baixiao-modal" role="dialog" aria-labelledby="ops-baixiao-title" aria-modal="true">
      <button aria-label="关闭南通基地-百晓生弹窗" className="ops-baixiao-backdrop" onClick={onClose} type="button" />
      <section className="ops-baixiao-panel">
        <button aria-label="关闭" className="ops-baixiao-close" onClick={onClose} type="button">
          <X className="size-5" />
        </button>

        <header className="ops-baixiao-hero">
          <div className="ops-baixiao-identity">
            <div className="ops-baixiao-title-card">
              <Cpu className="size-6" />
              <h2 id="ops-baixiao-title">南通基地-百晓生（本体）</h2>
            </div>
            <p>
              南通基地运维智能体常驻于各运维群中，结合各类运维数据、知识文档和群聊上下文，为各类业务场景提供智能支持，推动从“群内沟通”进一步升级为“群内协同+群内智能”。
            </p>
          </div>

          <div className="ops-baixiao-skill-zone" aria-label="百晓生技能矩阵">
            <div className="ops-baixiao-skill-grid">
              {baixiaoshengSkills.map((skill) => (
                <span className={`ops-baixiao-skill ops-baixiao-skill-${skill.tone}`} key={skill.label}>
                  {skill.label}
                </span>
              ))}
            </div>
            <div className="ops-baixiao-skill-total">
              <strong>30+</strong>
              <span>skill 能力矩阵</span>
            </div>
          </div>
        </header>

        <div className="ops-baixiao-workspace-grid">
          {baixiaoshengWorkspaces.map((workspace, index) => {
            const Icon = workspace.icon;

            return (
              <article
                className={`ops-baixiao-workspace ops-baixiao-workspace-${workspace.accent}`}
                key={workspace.title}
                style={{ animationDelay: `${120 + index * 70}ms` }}
              >
                <div className="ops-baixiao-workspace-title">
                  <Icon className="size-5" />
                  <h3>{workspace.title}</h3>
                </div>
                <ul>
                  {workspace.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export default function OperationsArchitecturePage() {
  const [isBaixiaoshengOpen, setIsBaixiaoshengOpen] = useState(false);

  return (
    <div className="operations-architecture">
      <div className="ops-architecture-scroll" aria-label="南通全景运维调度中心业务架构图横向画布">
        <section
          className="ops-architecture-canvas"
          role="img"
          aria-label="世纪互联南通基地多维运营中心到全景运维调度中心、南通基地百晓生和八个运营模块的业务架构图"
        >
          <div className="ops-grid-layer" />
          <div className="ops-scan-layer" />
          <div className="ops-particle-layer" />

          <header className="ops-arch-header">
            <div className="ops-kicker">VNET Nantong Operations</div>
            <h1>南通全景运维调度中心业务架构图</h1>
            <p>NANTONG PANORAMIC OPERATIONS DISPATCH CENTER BUSINESS ARCHITECTURE</p>
          </header>

          <aside className="ops-level-rail" aria-hidden="true">
            {levelMarkers.map((item) => (
              <div className="ops-level-marker" key={item.level}>
                <strong>{item.level}</strong>
                <span>{item.title}</span>
                <em>{item.subtitle}</em>
              </div>
            ))}
          </aside>

          <svg className="ops-flow-map" viewBox="0 0 1200 760" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="opsFlowGradient" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stopColor="hsl(184 92% 54% / 0.1)" />
                <stop offset="48%" stopColor="hsl(184 92% 54% / 0.72)" />
                <stop offset="100%" stopColor="hsl(142 76% 52% / 0.22)" />
              </linearGradient>
              <filter id="opsFlowGlow">
                <feGaussianBlur stdDeviation="3.2" result="coloredBlur" />
                <feMerge>
                  <feMergeNode in="coloredBlur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            {flowPaths.map((path, index) => (
              <path
                className="ops-flow-path"
                d={path}
                key={path}
                style={{ animationDelay: `${index * 150}ms` }}
              />
            ))}
            {flowDots.map((dot, index) => (
              <circle
                className="ops-flow-dot"
                cx={dot.cx}
                cy={dot.cy}
                key={`${dot.cx}-${dot.cy}`}
                r="4"
                style={{ animationDelay: `${index * 180}ms` }}
              />
            ))}
          </svg>

          <section className="ops-center-stack" aria-label="核心调度中心">
            <div className="ops-core-panel">
              <div className="ops-core-halo" />
              <div className="ops-core-title-row">
                <Database className="size-8" />
                <div>
                  <h2>全景运维调度中心</h2>
                  <p>PANORAMIC OPERATIONS DISPATCH CENTER</p>
                </div>
              </div>
              <div className="ops-core-signals">
                {signalPills.map((item) => (
                  <SignalPill {...item} key={item.label} />
                ))}
              </div>
            </div>
          </section>

          <aside className="ops-digital-platform" aria-label="南通基地-百晓生">
            <div className="ops-platform-pulses" aria-hidden="true">
              <span className="ops-platform-gate ops-platform-gate-left" />
              <span className="ops-platform-wave" />
              <span className="ops-platform-gate ops-platform-gate-right" />
            </div>
            <button
              aria-label={`打开南通基地-百晓生本体能力弹窗。${agentAiInsight}`}
              className="ops-cube-hotspot"
              onClick={() => setIsBaixiaoshengOpen(true)}
              type="button"
            >
              <div className="ops-cube-wrap" aria-hidden="true">
                <div className="ops-cube">
                  {['front', 'back', 'right', 'left', 'top', 'bottom'].map((face) => (
                    <span className={`ops-cube-face ops-cube-${face}`} key={face} />
                  ))}
                </div>
              </div>
              <div className="ops-agent-ai-dialog ops-cube-ai-dialog" role="tooltip">
                <span>智能体说明</span>
                <p>{agentAiInsight}</p>
              </div>
            </button>
            <h2>南通基地-百晓生</h2>
            <p>OPERATIONS AI AGENT</p>
          </aside>

          <section className="ops-bottom-grid" aria-label="八个运营模块矩阵">
            {executionUnits.map((unit, index) => (
              <ArchitectureNode unit={unit} index={index} key={unit.title} />
            ))}
          </section>

          <div className="ops-footer-status" aria-hidden="true">
            <span><BellRing className="size-3.5" /> 调度事件流</span>
            <span>7栋楼宇</span>
            <span>动力 · 环境 · 网络 · 服务</span>
            <span>闭环处置中</span>
          </div>
        </section>

        <section className="ops-agent-section" aria-label="南通基地百晓生运维智能体能力矩阵">
          <div className="ops-agent-shell">
            <header className="ops-agent-foundation-heading">
              <h2>南通基地全景运营的1+N+X全价值链数据底座</h2>
            </header>

            <div className="ops-agent-chain-grid" aria-label="1+N+X数据底座层级说明">
              {agentChainLayers.map((layer, index) => (
                <AgentChainSummaryCard index={index} key={layer.marker} layer={layer} />
              ))}
            </div>

            <AgentCapabilityRow
              label="AI智慧层"
              title="“南通基地-百晓生”属地运维智能体"
              items={aiCapabilities}
              variant="ai"
            />

            <div className="ops-agent-row ops-agent-row-data-base">
              <div className="ops-agent-layer-label">数据底座</div>
              <div className="ops-agent-foundation-panel">
                <div className="ops-agent-domain-grid">
                  {agentFoundationDomains.map((domain, index) => (
                    <AgentFoundationDomainCard domain={domain} index={index} key={domain.title} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
      {isBaixiaoshengOpen ? <BaixiaoshengModal onClose={() => setIsBaixiaoshengOpen(false)} /> : null}
    </div>
  );
}
