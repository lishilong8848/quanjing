import {
  Component,
  Suspense,
  lazy,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Box,
  CalendarDays,
  ClipboardList,
  PanelsTopLeft,
  Server,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  NAVIGATION_DOMAINS,
  type NavigationDomainKey,
} from '@/navigation/page-switcher';
import { CampusTour } from './CampusTour';
import { CampusLocation, CampusMetrics } from './CampusOverview';
import { SystemsGallery } from './SystemsGallery';
import type { ExplorerSelection } from './AppExplorer';
import './portal.css';

const PORTAL_THEME_STYLE = {
  '--portal-blue': '#005bff',
  '--portal-blue-hover': '#0049d6',
  '--portal-green': '#27ab71',
  '--portal-mint': '#0ec692',
  '--portal-green-text': '#177749',
  '--portal-paper': '#fdfefe',
  '--portal-wash': '#f2f5fa',
  '--portal-soft': '#eaf1ff',
  '--portal-ink': '#222b3b',
  '--portal-muted': '#647081',
  '--portal-line': '#dce4ec',
  '--portal-navy': '#0a1933',
  '--portal-navy-soft': '#172b49',
  '--portal-light': '#f7faff',
  '--portal-radius': '0.5rem',
  '--portal-gutter': 'clamp(0.75rem, 2vw, 1.5rem)',
  width: '100%',
  minWidth: 0,
  background: 'var(--portal-wash)',
  color: 'var(--portal-ink)',
  fontFamily: 'Inter, Arial, sans-serif',
  lineHeight: 1.5,
} as CSSProperties;

const createExplorer = () => lazy(() => import('./AppExplorer'));
const domainIcons = {
  operations: PanelsTopLeft,
  people: Users,
  safety: ShieldCheck,
  equipment: Server,
  supply: Box,
  knowledge: BookOpen,
};
const domainDetails = {
  operations: '态势 · 重点 · 运行',
  people: '排班 · 组织 · 培训',
  safety: '施工 · 风险 · 质量',
  equipment: '孪生 · 轮巡 · 定位',
  supply: '采购 · 库存 · 合同',
  knowledge: '知识 · 复盘 · 报告',
};
const cards = [
  {
    name: '今日航图',
    Icon: PanelsTopLeft,
    description: '总览园区运行态势，掌握关键事件与工作进展。',
    english: 'OPERATIONS OVERVIEW',
  },
  {
    name: '今日重点',
    Icon: ClipboardList,
    description: '聚合当日重点与跟进事项，让每一项工作有序推进。',
    english: "TODAY'S PRIORITIES",
  },
  {
    name: '排班中心',
    Icon: CalendarDays,
    description: '查看楼栋值班与人员安排，做好每一班的现场保障。',
    english: 'TEAM & SCHEDULE',
  },
];

class ExplorerBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="portal-loading" role="alert">
        应用介绍加载失败。
        <Button variant="outline" onClick={this.props.onRetry}>
          重新加载
        </Button>
      </div>
    ) : (
      this.props.children
    );
  }
}

export default function NantongBaseHomePage() {
  const [selection, setSelection] = useState<ExplorerSelection | null>(null);
  const [title, setTitle] = useState('全部应用');
  const [Explorer, setExplorer] = useState(createExplorer);
  const [attempt, setAttempt] = useState(0);
  const trigger = useRef<HTMLElement | null>(null);
  function open(next: ExplorerSelection) {
    trigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setTitle(
      next.app ||
        NAVIGATION_DOMAINS.find((domain) => domain.key === next.domain)
          ?.label ||
        '全部应用',
    );
    setSelection(next);
  }
  const openApp = (app: string) => open({ app });
  return (
    <div
      className="nantong-portal"
      data-portal-version="react-photo-20260910-layout"
      style={PORTAL_THEME_STYLE}
    >
      <CampusTour onExplore={() => openApp('今日航图')} />
      <CampusMetrics />
      <section className="quick-strip" aria-label="业务快捷入口">
        <div className="wrap quick-grid">
          {NAVIGATION_DOMAINS.filter((domain) => domain.key !== 'platform').map(
            (domain) => {
              const key = domain.key as Exclude<
                NavigationDomainKey,
                'platform'
              >;
              const Icon = domainIcons[key];
              return (
                <button
                  className="quick-item"
                  type="button"
                  key={key}
                  onClick={() => open({ domain: key })}
                >
                  <Icon />
                  <span>
                    <strong>{domain.label}</strong>
                    <small>{domainDetails[key]}</small>
                  </span>
                </button>
              );
            },
          )}
        </div>
      </section>
      <section
        className="workspace wrap"
        aria-labelledby="portal-workspace-title"
      >
        <div className="section-heading">
          <div>
            <div className="eyebrow">YOUR DAILY WORKSPACE</div>
            <h2 id="portal-workspace-title">今日工作，从这里开始</h2>
            <p>关键工作直达，园区协同有序。</p>
          </div>
          <button
            type="button"
            className="text-link"
            onClick={() => open({ domain: 'all' })}
          >
            查看全部应用
            <ArrowRight />
          </button>
        </div>
        <div className="work-grid">
          {cards.map((card, index) => (
            <Card
              key={card.name}
              className={`work-card ${index === 0 ? 'featured' : ''}`}
            >
              <button type="button" onClick={() => openApp(card.name)}>
                <span className="work-icon">
                  <card.Icon />
                </span>
                <h3>{card.name}</h3>
                <p>{card.description}</p>
                <span className="card-label">{card.english}</span>
                <ArrowUpRight className="corner-arrow" />
              </button>
            </Card>
          ))}
        </div>
      </section>
      <SystemsGallery dialogOpen={selection !== null} onExplore={openApp} />
      <CampusLocation />
      <footer className="portal-footer">
        <div className="wrap">
          <strong>世纪互联 · 南通数据中心</strong>
          <small>连接算力与未来，让每一次运行更可靠。</small>
        </div>
      </footer>
      <Dialog
        open={selection !== null}
        onOpenChange={(openState) => {
          if (!openState) setSelection(null);
        }}
      >
        <DialogContent
          className="nantong-portal portal-dialog"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus({ preventScroll: true });
          }}
        >
          <div className="portal-dialog-header">
            <DialogTitle>{title}</DialogTitle>
            <DialogClose asChild>
              <Button variant="ghost" size="icon" aria-label="关闭应用介绍">
                <X />
              </Button>
            </DialogClose>
          </div>
          <DialogDescription className="sr-only">
            应用功能介绍与访问入口
          </DialogDescription>
          <div className="portal-dialog-body">
            <ExplorerBoundary
              key={attempt}
              onRetry={() => {
                setExplorer(createExplorer());
                setAttempt((value) => value + 1);
              }}
            >
              <Suspense
                fallback={
                  <div className="portal-loading" role="status">
                    正在加载应用介绍…
                  </div>
                }
              >
                {selection && (
                  <Explorer
                    initial={selection}
                    onTitle={setTitle}
                    onClose={() => setSelection(null)}
                  />
                )}
              </Suspense>
            </ExplorerBoundary>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
