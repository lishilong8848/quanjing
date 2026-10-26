import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  CheckCircle2,
  Clock3,
  GraduationCap,
  RefreshCw,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import {
  parseTrainingCertificationModule,
  type TrainingCertificationModule,
} from './model';

import './styles.css';

const CampusCertificateDashboard = lazy(
  () => import('../CampusCertificateDashboard'),
);
const CampusTrainingDashboard = lazy(
  () => import('../CampusTrainingDashboard'),
);

export interface TrainingCertificationHeaderState {
  updatedAt: string;
  refreshing: boolean;
  refresh: () => void;
}

export type TrainingCertificationHeaderStateChange = (
  state: TrainingCertificationHeaderState,
) => void;

interface ModuleDefinition {
  key: TrainingCertificationModule;
  label: string;
  description: string;
  eyebrow: string;
  Icon: LucideIcon;
}

const MODULES: ModuleDefinition[] = [
  {
    key: 'certificate',
    label: '持证管理',
    description: '证书合规、到期风险与人员缺口',
    eyebrow: '资质合规',
    Icon: ShieldCheck,
  },
  {
    key: 'training',
    label: '培训管理',
    description: '培训计划、完成进度与考核结果',
    eyebrow: '能力发展',
    Icon: GraduationCap,
  },
];

function ModuleLoading({ label }: { label: string }) {
  return (
    <section className="training-certification-loading" role="status">
      <RefreshCw aria-hidden="true" />
      <strong>正在加载{label}</strong>
    </section>
  );
}

export default function TrainingCertificationManagementPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawModule = searchParams.get('module');
  const activeModule = parseTrainingCertificationModule(rawModule);
  const [visitedModules, setVisitedModules] = useState(() => ({
    certificate: activeModule === 'certificate',
    training: activeModule === 'training',
  }));
  const [certificateHeaderState, setCertificateHeaderState] =
    useState<TrainingCertificationHeaderState | null>(null);
  const [trainingHeaderState, setTrainingHeaderState] =
    useState<TrainingCertificationHeaderState | null>(null);
  const previousModuleRef = useRef(activeModule);
  const moduleHeadingRefs = useRef<
    Partial<Record<TrainingCertificationModule, HTMLHeadingElement | null>>
  >({});

  useEffect(() => {
    if (rawModule !== activeModule) {
      setSearchParams({ module: activeModule }, { replace: true });
    }
  }, [activeModule, rawModule, setSearchParams]);

  useEffect(() => {
    setVisitedModules((current) =>
      current[activeModule] ? current : { ...current, [activeModule]: true },
    );

    if (previousModuleRef.current === activeModule) return;
    previousModuleRef.current = activeModule;
    const frame = window.requestAnimationFrame(() => {
      moduleHeadingRefs.current[activeModule]?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeModule]);

  const activeHeaderState =
    activeModule === 'certificate'
      ? certificateHeaderState
      : trainingHeaderState;
  const activeDefinition = useMemo(
    () => MODULES.find((module) => module.key === activeModule) ?? MODULES[0],
    [activeModule],
  );

  const selectModule = useCallback(
    (nextModule: TrainingCertificationModule) => {
      if (nextModule === activeModule) return;
      setSearchParams({ module: nextModule });
    },
    [activeModule, setSearchParams],
  );

  return (
    <div className="training-certification-page" aria-label="培训持证管理">
      <header className="training-certification-hero">
        <div className="training-certification-hero-copy">
          <span className="training-certification-hero-icon" aria-hidden="true">
            <ShieldCheck />
          </span>
          <div>
            <p>人员保障</p>
            <h1>培训持证管理</h1>
            <span>统筹人员资质合规、培训计划与执行结果</span>
          </div>
        </div>

        <div className="training-certification-hero-actions">
          <p>
            <Clock3 aria-hidden="true" />
            <span>
              {activeHeaderState?.updatedAt
                ? `数据更新：${activeHeaderState.updatedAt}`
                : `${activeDefinition.label}数据准备中`}
            </span>
          </p>
          <Button
            type="button"
            disabled={!activeHeaderState || activeHeaderState.refreshing}
            aria-busy={activeHeaderState?.refreshing ?? false}
            onClick={() => activeHeaderState?.refresh()}
          >
            <RefreshCw
              className={cn(
                activeHeaderState?.refreshing &&
                  'training-certification-refresh-spinning',
              )}
              aria-hidden="true"
            />
            {activeHeaderState?.refreshing ? '刷新中' : '刷新'}
          </Button>
        </div>
      </header>

      <div className="training-certification-content">
        <nav
          className="training-certification-module-grid"
          aria-label="培训持证业务模块"
        >
          {MODULES.map((module) => {
            const selected = activeModule === module.key;
            const Icon = module.Icon;
            return (
              <button
                key={module.key}
                type="button"
                className={cn(
                  'training-certification-module-card',
                  selected && 'is-active',
                )}
                aria-pressed={activeModule === module.key}
                onClick={() => selectModule(module.key)}
              >
                <span className="training-certification-module-icon">
                  <Icon aria-hidden="true" />
                </span>
                <span className="training-certification-module-copy">
                  <small>{module.eyebrow}</small>
                  <strong>{module.label}</strong>
                  <span>{module.description}</span>
                </span>
                <span
                  className="training-certification-module-state"
                  aria-hidden="true"
                >
                  {selected ? <CheckCircle2 /> : <span>进入</span>}
                </span>
              </button>
            );
          })}
        </nav>

        <div className="training-certification-workspace">
          {visitedModules.certificate ? (
            <section
              className="training-certification-module-panel"
              hidden={activeModule !== 'certificate'}
              aria-labelledby="training-certification-certificate-title"
            >
              <h2
                id="training-certification-certificate-title"
                className="training-certification-module-heading"
                tabIndex={-1}
                ref={(node) => {
                  moduleHeadingRefs.current.certificate = node;
                }}
              >
                持证管理
              </h2>
              <Suspense fallback={<ModuleLoading label="持证管理" />}>
                <CampusCertificateDashboard
                  embedded
                  onHeaderStateChange={setCertificateHeaderState}
                />
              </Suspense>
            </section>
          ) : null}

          {visitedModules.training ? (
            <section
              className="training-certification-module-panel"
              hidden={activeModule !== 'training'}
              aria-labelledby="training-certification-training-title"
            >
              <h2
                id="training-certification-training-title"
                className="training-certification-module-heading"
                tabIndex={-1}
                ref={(node) => {
                  moduleHeadingRefs.current.training = node;
                }}
              >
                培训管理
              </h2>
              <Suspense fallback={<ModuleLoading label="培训管理" />}>
                <CampusTrainingDashboard
                  embedded
                  onHeaderStateChange={setTrainingHeaderState}
                />
              </Suspense>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
