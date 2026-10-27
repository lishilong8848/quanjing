import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Bike,
  BookOpenCheck,
  BookOpen,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Dumbbell,
  Footprints,
  Gamepad2,
  GraduationCap,
  IdCard,
  ImageOff,
  Mail,
  Music2,
  Palette,
  Phone,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Target,
  UserRound,
  XCircle,
} from 'lucide-react';
import {
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ResponsiveContainer,
} from 'recharts';
import { getOrganizationPersonProfile } from '@/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  MBTI_TYPE_CODES,
  type OrganizationPersonCertificate,
  type OrganizationPersonProfileDetail,
  type OrganizationPersonQualityAssessment,
} from '@shared/organization-person-profile';
import {
  MBTI_PREFERENCE_DEFINITIONS,
  MBTI_TYPE_DEFINITIONS,
  isProfileEmploymentTypeDisplayValue,
  isProfileDisplayValue,
  joinProfileDisplayValues,
  resolveOrganizationPersonProfile,
  organizationProfileCacheKey,
  type MbtiPreferenceLetter,
  type OrganizationPersonProfileSummary,
} from './person-profile-model';

const PROFILE_DETAIL_CACHE_TTL_MS = 10 * 60 * 1000;

const profileDetailCache = new Map<
  string,
  {
    detail: OrganizationPersonProfileDetail;
    fetchedAt: number;
  }
>();

type ProfileLoadState =
  | { status: 'idle' }
  | { status: 'loading'; detail: OrganizationPersonProfileDetail }
  | {
      status: 'ready';
      detail: OrganizationPersonProfileDetail;
    }
  | {
      status: 'fallback';
      detail: OrganizationPersonProfileDetail;
      message: string;
    };

interface PersonProfileDialogProps {
  profile: OrganizationPersonProfileSummary | null;
  canView: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PersonProfileDialog({
  profile,
  canView,
  onOpenChange,
}: PersonProfileDialogProps) {
  const [loadState, setLoadState] = useState<ProfileLoadState>({
    status: 'idle',
  });
  const [retryVersion, setRetryVersion] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [profile?.recordId]);

  useEffect(() => {
    if (!canView) profileDetailCache.clear();
  }, [canView]);

  useEffect(() => {
    if (!profile || !canView) {
      setLoadState({ status: 'idle' });
      return;
    }

    const cacheKey = organizationProfileCacheKey(profile);
    const summaryDetail = resolveOrganizationPersonProfile(profile);
    const cached = profileDetailCache.get(cacheKey);
    let lastMbtiSync = 0;
    try {
      lastMbtiSync = Number(window.localStorage.getItem(`nantong-mbti-updated:${profile.recordId}`) || 0);
    } catch {
      // 浏览器禁用本地存储时仍按常规缓存规则读取。
    }
    if (
      retryVersion === 0 &&
      cached &&
      cached.fetchedAt >= lastMbtiSync &&
      Date.now() - cached.fetchedAt < PROFILE_DETAIL_CACHE_TTL_MS
    ) {
      setLoadState({
        status: 'ready',
        detail: cached.detail,
      });
      return;
    }

    const controller = new AbortController();
    setLoadState({ status: 'loading', detail: summaryDetail });
    void getOrganizationPersonProfile(
      profile.source,
      profile.recordId,
      controller.signal,
    )
      .then(({ profile: detail }) => {
        if (controller.signal.aborted) return;
        const resolvedDetail = resolveOrganizationPersonProfile(profile, detail);
        profileDetailCache.set(cacheKey, {
          detail: resolvedDetail,
          fetchedAt: Date.now(),
        });
        setLoadState({
          status: 'ready',
          detail: resolvedDetail,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadState({
          status: 'fallback',
          detail: summaryDetail,
          message: getErrorMessage(error),
        });
      });

    return () => controller.abort();
  }, [canView, profile, retryVersion]);

  const detail = loadState.status === 'idle' ? null : loadState.detail;
  const photoSrc = resolveEmployeePhotoUrl(
    detail?.photoUrl || profile?.photoUrl,
  );
  const mbtiDefinition = detail?.mbti
    ? MBTI_TYPE_DEFINITIONS[detail.mbti]
    : null;
  const displayedPosition = [detail?.position, profile?.position].find(
    isProfileDisplayValue,
  );
  const displayedBuildings = (
    detail?.buildingsSpecialties ||
    profile?.buildings ||
    []
  ).filter(isProfileDisplayValue);

  return (
    <Dialog
      open={Boolean(profile && canView)}
      onOpenChange={(open) => {
        if (!open) {
          setLoadState({ status: 'idle' });
          setRetryVersion(0);
        }
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-[72rem] gap-0 overflow-hidden rounded-2xl border-blue-100 bg-slate-50 p-0 shadow-2xl">
        {profile && (
          <div className="grid max-h-[90vh] min-h-0 overflow-y-auto lg:grid-cols-[18rem_minmax(0,1fr)] lg:overflow-hidden">
            <aside className="relative overflow-hidden bg-gradient-to-b from-blue-800 via-blue-700 to-blue-500 px-5 py-5 text-white lg:max-h-[90vh] lg:overflow-y-auto">
              <div className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-white/10" />
              <div className="absolute -bottom-20 -left-20 h-56 w-56 rounded-full bg-emerald-300/15" />
              <div className="relative flex h-full flex-col">
                <div className="text-xs font-semibold tracking-[0.24em] text-blue-100">
                  世纪互联 · VNET
                </div>
                <DialogHeader className="mt-3 text-left">
                  <DialogTitle className="text-xl text-white">
                    人员档案
                  </DialogTitle>
                  <DialogDescription className="text-xs text-blue-100">
                    PERSONNEL PROFILE
                  </DialogDescription>
                </DialogHeader>

                <div className="mt-4 grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-4 lg:block">
                  <div className="aspect-[3/4] w-28 shrink-0 overflow-hidden rounded-2xl border-2 border-white/35 bg-white/15 shadow-xl lg:mx-auto lg:w-36">
                    {photoSrc && !imageFailed ? (
                      <img
                        src={photoSrc}
                        alt={profile.name}
                        className="h-full w-full object-cover object-top"
                        onError={() => setImageFailed(true)}
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-3xl font-bold text-white">
                        {initialsForName(profile.name)}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 lg:mt-3 lg:text-center">
                    <h2 className="truncate text-2xl font-bold tracking-tight">
                      {detail?.name || profile.name}
                    </h2>
                    {displayedPosition && (
                      <p className="mt-1 text-sm font-semibold text-blue-100">
                        {displayedPosition}
                      </p>
                    )}
                    {displayedBuildings.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5 lg:justify-center">
                        {displayedBuildings.map((item) => (
                          <span
                            key={item}
                            className="rounded-full border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] font-medium"
                          >
                            {item}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                  <IdentityMeta label="员工工号" value={detail?.employeeNo} />
                  <IdentityMeta
                    label="班组 / 班次"
                    value={joinValues(
                      detail?.team,
                      detail?.shift || profile.shift,
                    )}
                  />
                  <IdentityMeta
                    label="用工性质"
                    value={
                      isProfileEmploymentTypeDisplayValue(
                        detail?.employmentType,
                      )
                        ? detail?.employmentType
                        : null
                    }
                  />
                  <IdentityMeta
                    label="直属主管"
                    value={detail?.supervisorName}
                  />
                </div>

                {detail && (
                  <>
                    <section className="mt-4 rounded-2xl border border-white/15 bg-slate-950/15 p-3.5 shadow-inner">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-[11px] font-semibold tracking-[0.18em] text-blue-100">
                            MBTI · 16 型人格
                          </p>
                          <p className="mt-1 text-lg font-bold">{detail.mbti ? `${detail.mbti} · ${mbtiDefinition?.name}` : '尚未测试'}</p>
                        </div>
                        <Sparkles className="h-5 w-5 text-emerald-200" />
                      </div>
                      {mbtiDefinition && <p className="mt-1 min-h-9 text-xs leading-5 text-blue-50/90">{mbtiDefinition.traits}</p>}
                      {detail.mbti && <div className="mt-3 flex gap-2">
                        {detail.mbti.split('').map((letter) => (
                          <MbtiLetter
                            key={letter}
                            letter={letter as MbtiPreferenceLetter}
                          />
                        ))}
                      </div>}
                    </section>

                    <section className="mt-3">
                      <p className="text-[11px] font-semibold tracking-[0.16em] text-blue-100">
                        16 型人格图谱
                      </p>
                      <div className="mt-2 grid grid-cols-4 gap-1.5">
                        {MBTI_TYPE_CODES.map((code) => (
                          <Tooltip key={code}>
                            <TooltipTrigger asChild>
                              <span
                                tabIndex={0}
                                className={cn(
                                  'cursor-help rounded-md border px-1 py-1 text-center text-[10px] font-bold outline-none focus:ring-2 focus:ring-white/60',
                                  detail?.mbti === code
                                    ? 'border-emerald-200 bg-emerald-300 text-blue-950'
                                    : 'border-white/15 bg-white/10 text-blue-50',
                                )}
                              >
                                {code}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              <p className="font-semibold">
                                {code} · {MBTI_TYPE_DEFINITIONS[code].name}
                              </p>
                              <p className="mt-0.5 max-w-48 text-[11px] opacity-90">
                                {MBTI_TYPE_DEFINITIONS[code].traits}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        ))}
                      </div>
                      <p className="mt-2 text-[10px] leading-4 text-blue-100/80">
                        人格偏好仅作沟通参考，不代表能力或绩效结论。
                      </p>
                    </section>
                  </>
                )}
              </div>
            </aside>

            <div className="min-h-0 bg-slate-50 p-4 pr-9 sm:p-5 sm:pr-9 lg:max-h-[90vh] lg:overflow-y-auto">
              {(loadState.status === 'loading' || loadState.status === 'fallback') && (
                <ProfileDataNotice
                  state={loadState}
                  onRetry={() => {
                    profileDetailCache.delete(
                      organizationProfileCacheKey(profile),
                    );
                    setRetryVersion((value) => value + 1);
                  }}
                />
              )}
              {detail && <ProfileDetailGrid detail={detail} />}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProfileDetailGrid({
  detail,
}: {
  detail: OrganizationPersonProfileDetail;
}) {
  const hobbies = detail.hobbies.filter(isProfileDisplayValue);
  const specialties = detail.specialties.filter(isProfileDisplayValue);
  const employmentHistory = detail.employmentHistory.filter((item) =>
    isProfileDisplayValue(item.title),
  );
  const hasProfileScores = Object.values(detail.profileScores).some(
    (value) => value !== null,
  );
  const hasAbilities = detail.abilities.some((item) => item.score !== null);
  const hasTraining = Object.values(detail.training).some(
    (value) => value !== null,
  );
  const hasDrill = Object.values(detail.drill).some(isProfileDisplayValue);

  return (
    <div className="grid gap-3.5 xl:grid-cols-2">
      <ProfileSection
        icon={UserRound}
        title="基础信息"
        className="xl:col-span-2"
      >
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-12">
          <ProfileFact
            icon={BriefcaseBusiness}
            label="体系岗位"
            value={detail.systemPosition}
            tone="blue"
            emphasis
            className="lg:col-span-3"
          />
          <ProfileFact
            icon={Building2}
            label="所属公司"
            value={detail.company}
            tone="indigo"
            emphasis
            className="lg:col-span-5"
          />
          <ProfileFact
            icon={UserRound}
            label="人员状态"
            value={employmentStatusLabel(detail.employmentStatus)}
            tone={detail.employmentStatus === 'active' ? 'emerald' : 'amber'}
            emphasis
            className="lg:col-span-2"
          />
          <ProfileFact
            icon={CalendarDays}
            label="入职日期"
            value={detail.entryDate}
            tone="cyan"
            className="lg:col-span-2"
          />

          <ProfileFact
            icon={GraduationCap}
            label="学历 / 院校"
            value={joinValues(detail.education, detail.school)}
            tone="violet"
            className="lg:col-span-6"
          />
          <ProfileFact
            icon={BookOpenCheck}
            label="专业 / 毕业时间"
            value={joinValues(detail.major, detail.graduationDate)}
            tone="violet"
            className="lg:col-span-6"
          />

          <ProfileFact
            icon={Phone}
            label="联系电话"
            value={detail.phone}
            tone="cyan"
            className="lg:col-span-3"
          />
          <ProfileFact
            icon={Mail}
            label="电子邮箱"
            value={detail.email}
            tone="blue"
            valueClassName="break-all"
            className="lg:col-span-4"
          />
          <ProfileFact
            icon={IdCard}
            label="身份证号"
            value={detail.idCardMasked}
            className="lg:col-span-3"
          />
          <ProfileFact
            icon={IdCard}
            label="车牌号"
            value={detail.vehiclePlate}
            tone="amber"
            className="lg:col-span-2"
          />

          {detail.employmentStatus !== 'active' && (
            <>
              <ProfileFact
                icon={CalendarDays}
                label="离职 / 异动日期"
                value={detail.departureDate}
                className="lg:col-span-3"
              />
              <ProfileFact
                icon={BriefcaseBusiness}
                label="离职 / 异动原因"
                value={detail.departureReason}
                className="lg:col-span-3"
              />
            </>
          )}
          {hobbies.length > 0 && (
            <ProfileFact
              icon={Target}
              label="兴趣爱好"
              tone="cyan"
              className={cn(
                'sm:col-span-2',
                specialties.length > 0 ? 'lg:col-span-6' : 'lg:col-span-12',
              )}
            >
              <div className="flex flex-wrap gap-2">
                {hobbies.map((hobby) => (
                  <HobbyChip key={hobby} hobby={hobby} />
                ))}
              </div>
            </ProfileFact>
          )}

          {specialties.length > 0 && (
            <ProfileFact
              icon={Sparkles}
              label="特长标签"
              tone="indigo"
              className={cn(
                'sm:col-span-2',
                hobbies.length > 0 ? 'lg:col-span-6' : 'lg:col-span-12',
              )}
            >
              <div className="flex flex-wrap gap-2">
                {specialties.map((specialty, index) => (
                  <SpecialtyTag
                    key={specialty}
                    specialty={specialty}
                    index={index}
                  />
                ))}
              </div>
            </ProfileFact>
          )}
        </div>
      </ProfileSection>

      {hasProfileScores && (
        <ProfileSection icon={Target} title="人员画像">
          <div className="grid grid-cols-2 gap-3">
            <ScoreTile
              label="责任心"
              value={detail.profileScores.responsibility}
            />
            <ScoreTile label="稳定性" value={detail.profileScores.stability} />
            <ScoreTile
              label="协作力"
              value={detail.profileScores.collaboration}
            />
            <ScoreTile
              label="成长潜力"
              value={detail.profileScores.growthPotential}
            />
          </div>
        </ProfileSection>
      )}

      {employmentHistory.length > 0 && (
        <ProfileSection icon={BriefcaseBusiness} title="任职履历">
          <div className="space-y-3">
            {employmentHistory.map((item, index) => (
              <div key={item.id} className="grid grid-cols-[1rem_1fr] gap-3">
                <div className="relative flex justify-center">
                  <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-blue-600 ring-4 ring-blue-50" />
                  {index < employmentHistory.length - 1 && (
                    <span className="absolute top-4 h-[calc(100%+0.75rem)] w-px bg-blue-100" />
                  )}
                </div>
                <div className="pb-2">
                  <p className="text-sm font-semibold text-slate-800">
                    {item.title}
                  </p>
                  {isProfileDisplayValue(item.date) && (
                    <p className="mt-0.5 text-xs text-slate-400">{item.date}</p>
                  )}
                  {isProfileDisplayValue(item.description) && (
                    <p className="mt-1 text-xs text-slate-500">
                      {item.description}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </ProfileSection>
      )}

      <ProfileSection
        icon={ClipboardCheck}
        title="质量履职记录"
        className="xl:col-span-2"
      >
        <QualityAssessmentHistory assessment={detail.qualityAssessment} />
      </ProfileSection>

      {hasAbilities && (
        <ProfileSection icon={Sparkles} title="能力雷达">
          <AbilityRadar detail={detail} />
        </ProfileSection>
      )}

      {(hasTraining || hasDrill) && (
        <ProfileSection icon={BookOpenCheck} title="培训与演练">
          <TrainingAndDrill detail={detail} />
        </ProfileSection>
      )}

      {detail.certificates.length > 0 && (
        <ProfileSection
          icon={ShieldCheck}
          title="持证情况"
          className="xl:col-span-2"
        >
          <CertificateList certificates={detail.certificates} />
        </ProfileSection>
      )}
    </div>
  );
}

function QualityAssessmentHistory({
  assessment,
}: {
  assessment: OrganizationPersonQualityAssessment;
}) {
  const totalEvidence = assessment.records.reduce(
    (total, record) => total + record.images.length + record.attachments.length,
    0,
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-100 bg-gradient-to-r from-blue-50 to-slate-50 px-3.5 py-3">
        <div>
          <p className="text-sm font-bold text-slate-800">年度绩效考核依据</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            记录质量检查中已唯一确认到本人的问题与现场证据
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-white px-2.5 py-1.5 text-xs font-semibold text-blue-700 shadow-sm">
            {assessment.records.length} 条记录
          </span>
          <span className="rounded-lg bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 shadow-sm">
            {totalEvidence} 项证据
          </span>
        </div>
      </div>

      {assessment.status === 'unavailable' ? (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-800">
          <AlertCircle className="h-4 w-4 shrink-0" />
          质量履职记录暂不可用，请等待后台数据同步。
        </div>
      ) : assessment.records.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-center text-sm text-slate-500">
          暂无已确认到本人的质量履职问题记录
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {assessment.records.map((record) => {
            const imageEvidence = [
              ...record.images,
              ...record.attachments,
            ].filter(({ mimeType }) => mimeType.startsWith('image/'));
            return (
              <article
                key={record.id}
                className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-blue-50 px-2 py-1 text-xs font-bold text-blue-700">
                      {record.building}
                    </span>
                    <span className="text-xs font-semibold text-slate-500">
                      年份待确认 · {record.month}
                    </span>
                  </div>
                  {assessment.status === 'stale' && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                      数据更新可能延迟
                    </span>
                  )}
                </div>
                <p className="mt-3 text-xs font-semibold text-blue-700">
                  {record.item}
                </p>
                <p className="mt-1 text-sm font-semibold leading-6 text-slate-800">
                  {record.issue}
                </p>
                {record.supplemental && (
                  <p className="mt-1.5 text-xs leading-5 text-slate-500">
                    {record.supplemental}
                  </p>
                )}
                {imageEvidence.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {imageEvidence.map((evidence, index) => (
                      <a
                        className="quality-record-evidence relative flex h-20 w-28 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50"
                        href={evidence.url}
                        target="_blank"
                        rel="noreferrer"
                        key={`${evidence.url}-${index}`}
                        aria-label={`打开质量问题证据：${evidence.name}`}
                      >
                        <img
                          className="h-full w-full object-cover"
                          src={evidence.url}
                          alt={`质量问题证据：${evidence.name}`}
                          loading="lazy"
                          onError={(event) => {
                            event.currentTarget.hidden = true;
                            event.currentTarget.nextElementSibling?.removeAttribute(
                              'hidden',
                            );
                          }}
                        />
                        <span
                          className="flex flex-col items-center gap-1 px-2 text-center text-[10px] text-slate-500"
                          hidden
                        >
                          <ImageOff className="h-4 w-4" />
                          证据加载失败
                        </span>
                      </a>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProfileSection({
  icon: Icon,
  title,
  className,
  children,
}: React.PropsWithChildren<{
  icon: React.ElementType;
  title: string;
  className?: string;
}>) {
  return (
    <section
      className={cn(
        'rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.04)]',
        className,
      )}
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
          <Icon className="h-4 w-4" />
        </span>
        <h3 className="font-semibold text-slate-800">{title}</h3>
      </div>
      {children}
    </section>
  );
}

type ProfileFactTone =
  | 'slate'
  | 'blue'
  | 'indigo'
  | 'cyan'
  | 'emerald'
  | 'amber'
  | 'violet';

const PROFILE_FACT_TONES: Record<
  ProfileFactTone,
  { surface: string; icon: string; label: string; value: string }
> = {
  slate: {
    surface: 'border-slate-200/70 bg-slate-50/90',
    icon: 'bg-white text-slate-500',
    label: 'text-slate-400',
    value: 'text-slate-700',
  },
  blue: {
    surface: 'border-blue-200/70 bg-gradient-to-br from-blue-50 to-white',
    icon: 'bg-blue-100 text-blue-700',
    label: 'text-blue-500',
    value: 'text-blue-950',
  },
  indigo: {
    surface: 'border-indigo-200/70 bg-gradient-to-br from-indigo-50 to-white',
    icon: 'bg-indigo-100 text-indigo-700',
    label: 'text-indigo-500',
    value: 'text-indigo-950',
  },
  cyan: {
    surface: 'border-cyan-200/70 bg-gradient-to-br from-cyan-50 to-white',
    icon: 'bg-cyan-100 text-cyan-700',
    label: 'text-cyan-600',
    value: 'text-cyan-950',
  },
  emerald: {
    surface: 'border-emerald-200/80 bg-gradient-to-br from-emerald-50 to-white',
    icon: 'bg-emerald-100 text-emerald-700',
    label: 'text-emerald-600',
    value: 'text-emerald-800',
  },
  amber: {
    surface: 'border-amber-200/80 bg-gradient-to-br from-amber-50 to-white',
    icon: 'bg-amber-100 text-amber-700',
    label: 'text-amber-600',
    value: 'text-amber-900',
  },
  violet: {
    surface: 'border-violet-200/70 bg-gradient-to-br from-violet-50 to-white',
    icon: 'bg-violet-100 text-violet-700',
    label: 'text-violet-500',
    value: 'text-violet-950',
  },
};

function ProfileFact({
  icon: Icon,
  label,
  value,
  tone = 'slate',
  emphasis = false,
  valueClassName,
  className,
  children,
}: React.PropsWithChildren<{
  icon: React.ElementType;
  label: string;
  value?: string | null;
  tone?: ProfileFactTone;
  emphasis?: boolean;
  valueClassName?: string;
  className?: string;
}>) {
  if (children === undefined && !isProfileDisplayValue(value)) return null;
  const palette = PROFILE_FACT_TONES[tone];
  return (
    <div
      className={cn(
        'group min-w-0 rounded-xl border p-3 shadow-[0_4px_14px_rgba(15,23,42,0.025)] motion-safe:transition motion-safe:duration-200 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md',
        palette.surface,
        className,
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2 text-[11px] font-semibold',
          palette.label,
        )}
      >
        <span
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-lg shadow-sm',
            palette.icon,
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span>{label}</span>
      </div>
      {children !== undefined ? (
        <div className="mt-2">{children}</div>
      ) : (
        <p
          className={cn(
            'mt-2 whitespace-normal break-words font-semibold leading-5',
            emphasis ? 'text-base sm:text-[17px]' : 'text-sm',
            palette.value,
            valueClassName,
          )}
        >
          {value}
        </p>
      )}
    </div>
  );
}

const HOBBY_PRESENTATIONS: Array<{
  pattern: RegExp;
  icon: React.ElementType;
  className: string;
}> = [
  {
    pattern: /骑行|自行车/u,
    icon: Bike,
    className: 'border-sky-200 bg-sky-100 text-sky-800',
  },
  {
    pattern: /音乐|唱歌|乐器/u,
    icon: Music2,
    className: 'border-violet-200 bg-violet-100 text-violet-800',
  },
  {
    pattern: /阅读|读书/u,
    icon: BookOpen,
    className: 'border-amber-200 bg-amber-100 text-amber-800',
  },
  {
    pattern: /摄影|拍照/u,
    icon: Camera,
    className: 'border-rose-200 bg-rose-100 text-rose-800',
  },
  {
    pattern: /跑步|健身|羽毛球|篮球|足球|运动/u,
    icon: Dumbbell,
    className: 'border-emerald-200 bg-emerald-100 text-emerald-800',
  },
  {
    pattern: /徒步|登山|旅行/u,
    icon: Footprints,
    className: 'border-orange-200 bg-orange-100 text-orange-800',
  },
  {
    pattern: /游戏|电竞/u,
    icon: Gamepad2,
    className: 'border-indigo-200 bg-indigo-100 text-indigo-800',
  },
  {
    pattern: /绘画|书法|手工/u,
    icon: Palette,
    className: 'border-fuchsia-200 bg-fuchsia-100 text-fuchsia-800',
  },
];

function HobbyChip({ hobby }: { hobby: string }) {
  const presentation = HOBBY_PRESENTATIONS.find(({ pattern }) =>
    pattern.test(hobby),
  ) || {
    icon: Target,
    className: 'border-cyan-200 bg-cyan-100 text-cyan-800',
  };
  const Icon = presentation.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold shadow-sm',
        presentation.className,
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {hobby}
    </span>
  );
}

const SPECIALTY_TAG_TONES = [
  'border-blue-200 bg-blue-50 text-blue-800',
  'border-teal-200 bg-teal-50 text-teal-800',
  'border-orange-200 bg-orange-50 text-orange-800',
  'border-indigo-200 bg-indigo-50 text-indigo-800',
] as const;

function SpecialtyTag({
  specialty,
  index,
}: {
  specialty: string;
  index: number;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold shadow-sm',
        SPECIALTY_TAG_TONES[index % SPECIALTY_TAG_TONES.length],
      )}
    >
      <Sparkles className="h-3.5 w-3.5" />
      {specialty}
    </span>
  );
}

function ScoreTile({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null;
  return (
    <div className="rounded-lg border border-blue-100 bg-gradient-to-br from-blue-50 to-slate-50 p-3">
      <div className="flex items-end justify-between gap-2">
        <span className="text-xs font-medium text-slate-500">{label}</span>
        <span className="text-xl font-bold text-blue-700">
          {value}
          <small className="ml-0.5 text-[10px] font-semibold text-blue-400">
            分
          </small>
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-blue-100">
        <div
          className="h-full rounded-full bg-gradient-to-r from-blue-600 to-emerald-400"
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

function AbilityRadar({ detail }: { detail: OrganizationPersonProfileDetail }) {
  const chartData = useMemo(
    () =>
      detail.abilities
        .filter((item) => item.score !== null)
        .map((item) => ({
          ...item,
          score: item.score as number,
          fullMark: 100,
        })),
    [detail.abilities],
  );
  return (
    <div>
      <div className="relative h-56">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={chartData} outerRadius="68%">
            <PolarGrid stroke="#dbeafe" />
            <PolarAngleAxis
              dataKey="label"
              tick={{ fill: '#64748b', fontSize: 11 }}
            />
            <Radar
              dataKey="score"
              stroke="#2563eb"
              fill="#3b82f6"
              fillOpacity={0.28}
            />
            <Radar
              dataKey="benchmark"
              stroke="#10b981"
              fill="transparent"
              strokeDasharray="4 4"
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {chartData.map((item) => (
          <div
            key={item.key}
            className="rounded-lg bg-blue-50/70 px-2 py-1.5 text-center"
          >
            <p className="truncate text-[10px] text-slate-500">{item.label}</p>
            <p className="mt-0.5 text-xs font-bold text-blue-700">
              {item.score} 分
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrainingAndDrill({
  detail,
}: {
  detail: OrganizationPersonProfileDetail;
}) {
  const metrics: Array<readonly [string, number | null, string]> = [
    [
      '完成课程',
      detail.training.completedCourses,
      detail.training.totalCourses ? `/ ${detail.training.totalCourses}` : '',
    ],
    ['培训完成率', detail.training.completionRate, '%'],
    ['培训平均分', detail.training.averageScore, ''],
    ['培训签到率', detail.training.attendanceRate, '%'],
    ['最终考核', detail.training.finalScore, ''],
  ];
  const visibleMetrics = metrics.filter(
    (item): item is readonly [string, number, string] => item[1] !== null,
  );
  const hasDrill = Object.values(detail.drill).some(isProfileDisplayValue);
  const drillMeta = joinValues(
    detail.drill.latestDate,
    detail.drill.annualCount === null
      ? null
      : `年度 ${detail.drill.annualCount} 次`,
  );
  return (
    <div className="space-y-3">
      {visibleMetrics.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {visibleMetrics.map(([label, value, suffix]) => (
            <div key={label} className="rounded-lg bg-slate-50 px-3 py-2">
              <p className="text-[11px] text-slate-400">{label}</p>
              <p className="mt-0.5 text-base font-bold text-slate-700">
                {value}
                {suffix}
              </p>
            </div>
          ))}
        </div>
      )}
      {hasDrill && (
        <div className="rounded-lg border border-emerald-100 bg-emerald-50/70 p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold text-emerald-800">最近演练</p>
            {isProfileDisplayValue(detail.drill.latestRating) && (
              <span className="rounded-full bg-white px-2 py-0.5 text-xs font-bold text-emerald-700">
                {detail.drill.latestRating}
              </span>
            )}
          </div>
          {isProfileDisplayValue(detail.drill.latestTitle) && (
            <p className="mt-1 text-sm font-semibold text-slate-700">
              {detail.drill.latestTitle}
            </p>
          )}
          {drillMeta && (
            <p className="mt-1 text-xs text-slate-400">{drillMeta}</p>
          )}
        </div>
      )}
    </div>
  );
}

function CertificateList({
  certificates,
}: {
  certificates: OrganizationPersonCertificate[];
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {certificates.map((certificate) => {
        const tone = certificateTone(certificate.status);
        const StatusIcon = tone.icon;
        return (
          <div
            key={certificate.id}
            className={cn(
              'group rounded-xl border p-3 shadow-sm motion-safe:transition motion-safe:duration-200 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md',
              tone.card,
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2">
                <span
                  className={cn(
                    'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                    tone.iconBox,
                  )}
                >
                  <StatusIcon className="h-4 w-4" />
                </span>
                <p className="whitespace-normal break-words text-sm font-bold leading-5 text-slate-800">
                  {certificate.name}
                </p>
              </div>
              {tone.label && (
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold',
                    tone.badge,
                  )}
                >
                  {tone.label}
                </span>
              )}
            </div>
            {isProfileDisplayValue(certificate.expiryDate) && (
              <div className="mt-3 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                <CalendarDays className="h-3.5 w-3.5" />
                <span>{certificate.expiryDate} 到期</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MbtiLetter({ letter }: { letter: MbtiPreferenceLetter }) {
  const definition = MBTI_PREFERENCE_DEFINITIONS[letter];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex h-9 w-9 cursor-help items-center justify-center rounded-lg border border-white/25 bg-white/15 text-sm font-extrabold outline-none transition hover:bg-white/25 focus:ring-2 focus:ring-white/70"
          aria-label={`${letter}：${definition.label}`}
        >
          {letter}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64">
        <p className="font-semibold">
          {letter} · {definition.label}
        </p>
        <p className="mt-1 text-[11px] leading-4 opacity-90">
          {definition.description}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function IdentityMeta({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  if (!isProfileDisplayValue(value)) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-white/10 px-2.5 py-2">
      <p className="text-[10px] text-blue-100">{label}</p>
      <p className="mt-0.5 truncate font-semibold" title={value || undefined}>
        {value}
      </p>
    </div>
  );
}

function ProfileDataNotice({
  state,
  onRetry,
}: {
  state: ProfileLoadState;
  onRetry: () => void;
}) {
  if (state.status === 'loading') {
    return (
      <p className="mb-4 text-xs text-slate-500" role="status">
        正在读取人员档案…
      </p>
    );
  }
  if (state.status !== 'fallback') return null;

  return (
    <div
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50/80 px-3.5 py-2.5"
      title={state.message}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
        <p className="text-xs leading-5 text-amber-800">实时档案暂不可用</p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onRetry}
        className="h-8 border-amber-300 bg-white text-amber-800 hover:bg-amber-100"
      >
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
        重新加载
      </Button>
    </div>
  );
}

function certificateTone(status: OrganizationPersonCertificate['status']) {
  if (status === 'valid')
    return {
      label: '有效',
      icon: CheckCircle2,
      iconBox: 'bg-emerald-100 text-emerald-700',
      card: 'border-emerald-100 bg-gradient-to-br from-white to-emerald-50',
      badge: 'bg-emerald-100 text-emerald-700',
    };
  if (status === 'expiring')
    return {
      label: '临期',
      icon: Clock3,
      iconBox: 'bg-amber-100 text-amber-700',
      card: 'border-amber-100 bg-gradient-to-br from-white to-amber-50',
      badge: 'bg-amber-100 text-amber-700',
    };
  if (status === 'expired')
    return {
      label: '过期',
      icon: XCircle,
      iconBox: 'bg-rose-100 text-rose-700',
      card: 'border-rose-100 bg-gradient-to-br from-white to-rose-50',
      badge: 'bg-rose-100 text-rose-700',
    };
  return {
    label: null,
    icon: AlertCircle,
    iconBox: 'bg-slate-200 text-slate-600',
    card: 'border-slate-200 bg-gradient-to-br from-white to-slate-50',
    badge: 'bg-slate-200 text-slate-600',
  };
}

function employmentStatusLabel(
  status: OrganizationPersonProfileDetail['employmentStatus'],
): string | null {
  if (status === 'active') return '在职';
  if (status === 'departed') return '已离职';
  if (status === 'transferred') return '已异动';
  return null;
}

function joinValues(
  ...values: Array<string | null | undefined>
): string | null {
  return joinProfileDisplayValues(...values);
}

function initialsForName(name: string): string {
  return name.trim().slice(-2) || '人员';
}

function resolveEmployeePhotoUrl(photoUrl?: string | null): string | null {
  if (!photoUrl) return null;
  if (!photoUrl.startsWith('/')) return photoUrl;
  if (typeof window === 'undefined') return photoUrl;
  const backendPort =
    window.location.port === '8888' ? '3001' : window.location.port;
  return `${window.location.protocol}//${window.location.hostname}${backendPort ? `:${backendPort}` : ''}${photoUrl}`;
}

function getErrorMessage(error: unknown): string {
  const candidate = error as {
    response?: { data?: { message?: string } };
    message?: string;
  };
  return (
    candidate?.response?.data?.message || candidate?.message || '请稍后重试'
  );
}
