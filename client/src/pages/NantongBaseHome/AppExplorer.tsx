import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowUpRight,
  LockKeyhole,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { useAccess } from '@/access/AccessProvider';
import { canAccessPage } from '@/access/access-policy';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  PAGE_REGISTRY,
  NAVIGATION_DOMAINS,
  type NavigationDomainKey,
} from '@/navigation/page-switcher';
import { APP_PREVIEWS } from './portal-data';
import { portalAsset } from './portal-asset';
import { PortalImage } from './PortalImage';

export interface ExplorerSelection {
  app?: string;
  domain?: NavigationDomainKey | 'all';
}
export default function AppExplorer({
  initial,
  onTitle,
  onClose,
}: {
  initial: ExplorerSelection;
  onTitle: (title: string) => void;
  onClose: () => void;
}) {
  const { role, pagePaths, requestLogin } = useAccess();
  const [selected, setSelected] = useState(initial.app);
  const [domain, setDomain] = useState(initial.domain || 'all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const apps = useMemo(
    () =>
      PAGE_REGISTRY.filter(
        (page) =>
          (domain === 'all' || page.domainKey === domain) &&
          `${page.label}${page.description}`.includes(query.trim()),
      ),
    [domain, query],
  );
  const app = PAGE_REGISTRY.find((page) => page.label === selected);
  function directory() {
    setSelected(undefined);
    setExpanded(false);
    onTitle('全部应用');
  }
  if (!app)
    return (
      <div className="app-directory">
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索应用"
          aria-label="搜索应用"
        />
        <div className="app-category-filters">
          {[{ key: 'all', label: '全部' }, ...NAVIGATION_DOMAINS].map(
            (item) => (
              <Button
                key={item.key}
                variant="ghost"
                aria-pressed={domain === item.key}
                onClick={() =>
                  setDomain(item.key as NavigationDomainKey | 'all')
                }
              >
                {item.label}
              </Button>
            ),
          )}
        </div>
        <div className="app-directory-grid">
          {apps.map((page) => {
            const allowed = canAccessPage(role, page.path, pagePaths);
            const meta = APP_PREVIEWS[page.label];
            return (
              <button
                className="app-preview-card"
                key={page.key}
                type="button"
                onClick={() => {
                  setSelected(page.label);
                  setExpanded(false);
                  onTitle(page.label);
                }}
              >
                <div className="app-card-visual">
                  {allowed && meta?.image ? (
                    <img src={portalAsset(meta.image)} alt="" loading="lazy" />
                  ) : (
                    <page.icon />
                  )}
                </div>
                <div className="app-card-copy">
                  <h3>{page.label}</h3>
                  <p>{page.description}</p>
                  <span>
                    {allowed ? '了解应用' : '需相应权限'} <ArrowUpRight />
                  </span>
                </div>
              </button>
            );
          })}
        </div>
        {!apps.length && (
          <p className="app-empty" role="status">
            没有匹配的应用，试试其他关键词。
          </p>
        )}
      </div>
    );
  const allowed = canAccessPage(role, app.path, pagePaths);
  const meta = APP_PREVIEWS[app.label];
  const image = allowed ? meta?.image : undefined;
  const features = meta?.features || [[app.label, app.description]];
  return (
    <div className={`app-detail-body ${expanded ? 'snapshot-expanded' : ''}`}>
      <div className="app-detail">
        <div className="app-detail-media">
          <div className="app-media-toolbar">
            <span>
              {image
                ? meta?.stamp
                : app.label === '今日重点'
                  ? '页面布局示意'
                  : '功能介绍'}
            </span>
            {image && (
              <Button
                variant="ghost"
                onClick={() => setExpanded((value) => !value)}
                aria-pressed={expanded}
              >
                {expanded ? <Minimize2 /> : <Maximize2 />}
                {expanded ? '收起快照' : '放大快照'}
              </Button>
            )}
          </div>
          {image ? (
            <div className="app-snapshot-viewport">
              <PortalImage
                key={image}
                src={portalAsset(image)}
                alt={`${app.label}页面快照，仅用于功能介绍`}
              />
            </div>
          ) : app.label === '今日重点' ? (
            <div className="focus-layout">
              <h3>今日园区重点关注清单</h3>
              <div className="focus-layout-stats">
                {['封网', '变更', '事件', '其他'].map((label) => (
                  <div key={label}>
                    {label}
                    <b>—</b>
                  </div>
                ))}
              </div>
              <div className="focus-layout-grid">
                {['封网关注', '重点变更', '重点关注事件', '其他关注'].map(
                  (label) => (
                    <div key={label}>
                      <h4>{label}</h4>
                      <span>事项内容区域</span>
                      <i />
                      <i />
                    </div>
                  ),
                )}
              </div>
              <small>布局示意 · 非业务数据</small>
            </div>
          ) : (
            <div className="app-abstract">
              <app.icon />
              <h3>{app.label}</h3>
              <p>{app.description}</p>
            </div>
          )}
        </div>
        <div className="app-detail-info">
          <div className="eyebrow">
            {meta?.english || app.domainKey.toUpperCase()}
          </div>
          <h3>{meta?.lead || app.description}</h3>
          <div className="app-feature-list">
            {features.map(([title, description], index) => (
              <div className="app-feature" key={title}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <h4>{title}</h4>
                  <p>{description}</p>
                </div>
              </div>
            ))}
          </div>
          {image && (
            <p className="snapshot-note">
              快照仅作功能介绍，日期和指标不是实时数据。
            </p>
          )}
          {!allowed && (
            <p className="snapshot-note">
              <LockKeyhole />
              查看应用需要相应权限。
            </p>
          )}
        </div>
      </div>
      <div className="app-detail-footer">
        <Button variant="ghost" onClick={directory}>
          <ArrowLeft />
          返回应用目录
        </Button>
        {allowed ? (
          <Button className="portal-primary" asChild>
            {app.external ? (
              <a
                href={app.path}
                target="_blank"
                rel="noopener noreferrer"
                onClick={onClose}
              >
                进入{app.label}
                <ArrowUpRight />
              </a>
            ) : (
              <Link to={app.path} onClick={onClose}>
                进入{app.label}
                <ArrowUpRight />
              </Link>
            )}
          </Button>
        ) : (
          <Button
            className="portal-primary"
            onClick={() => {
              onClose();
              requestLogin(
                '使用此应用需要相应权限。',
                app.external ? undefined : app.path,
              );
            }}
          >
            登录后进入
            <ArrowUpRight />
          </Button>
        )}
      </div>
    </div>
  );
}
