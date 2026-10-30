import type { ReactNode } from 'react';
import { BookOpenCheck, BriefcaseBusiness, Camera, GraduationCap, Loader2, RefreshCw, ShieldCheck, Sparkles, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MBTI_TYPE_DEFINITIONS, isProfileDisplayValue } from '../OrganizationPage/person-profile-model';
import type { usePersonalArchive } from './use-personal-archive';

type Archive = ReturnType<typeof usePersonalArchive>;
type Value = string | number | null | undefined;
export function archiveValue(value: Value): string {
  return typeof value === 'number' ? Number.isFinite(value) ? String(value) : '未维护' : isProfileDisplayValue(value) ? String(value) : '未维护';
}
const employmentLabels = { active: '在职', departed: '离职', transferred: '异动', unknown: '待核对' } as const;
const certificateLabels = { valid: '有效', expiring: '即将到期', expired: '已过期', unknown: '待核对' } as const;

export function PersonalArchiveSummary({ archive, displayName }: { archive: Archive; displayName: string }) {
  const { profile, photo } = archive;
  const unbound = archive.response?.status === 'unbound';
  const unavailable = !profile && !archive.loading && !!archive.error;
  return <section aria-label="本人信息" className="flex items-start gap-3 rounded-lg border bg-card p-3 sm:items-center sm:gap-4 md:p-5">
    <div className="shrink-0">
      <div className="relative flex h-20 w-16 items-center justify-center overflow-hidden rounded-lg border bg-muted/30 sm:h-32 sm:w-24" aria-busy={photo.loading}>
        {photo.url ? <img className="h-full w-full object-cover object-top" src={photo.url} alt={`${profile?.name || displayName}的照片`} onError={archive.photoFailed} /> :
          <div className="flex flex-col items-center gap-2 px-1 text-center text-muted-foreground"><Camera className="size-5 sm:size-7" /><span className="text-[10px] sm:text-xs">{photo.loading || !profile && archive.loading ? '照片加载中' : photo.error || unavailable ? '照片暂不可用' : '暂无照片'}</span></div>}
        {photo.loading && <Loader2 className="absolute right-2 top-2 size-4 animate-spin text-primary" />}
      </div>
      {photo.error && <Button type="button" variant="link" size="sm" onClick={archive.retryPhoto} className="h-auto px-0 py-2">重试照片</Button>}
    </div>
    <div className="min-w-0 flex-1 space-y-2 sm:space-y-3">
      <div className="flex flex-wrap items-center gap-2"><h2 className="break-words text-xl font-semibold">{profile?.name || displayName}</h2>
        {profile && <span className={`rounded-md px-2 py-1 text-xs ${profile.employmentStatus === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-muted text-muted-foreground'}`}>{employmentLabels[profile.employmentStatus]}</span>}
      </div>
      {unbound ? <p className="text-sm text-muted-foreground">此账号尚未关联个人档案，请联系管理员核对。</p> : <dl className="grid grid-cols-2 gap-x-3 gap-y-2 sm:gap-x-6 sm:gap-y-3 xl:grid-cols-4">
        <Fact label="工号" value={profile?.employeeNo} loading={!profile && archive.loading} unavailable={unavailable} />
        <Fact label="手机号" value={profile?.phone} loading={!profile && archive.loading} unavailable={unavailable} phone />
        <Fact label="岗位" value={profile?.position} loading={!profile && archive.loading} unavailable={unavailable} />
        <Fact label="所属公司" value={profile?.company} loading={!profile && archive.loading} unavailable={unavailable} />
      </dl>}
      {archive.response?.snapshotAt && <p className="text-xs leading-5 text-muted-foreground">人员档案资料 · 更新于 {formatUpdatedAt(archive.response.snapshotAt)}</p>}
    </div>
  </section>;
}

export function PersonalArchivePanel({ archive, onCorrect }: { archive: Archive; onCorrect?: () => void }) {
  const { profile } = archive;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">资料来自已关联的人员档案，按权限展示。未维护的栏目默认收起。</p>{onCorrect && <Button variant="outline" size="sm" onClick={onCorrect}>资料有误，申请核对</Button>}</div>
    {archive.error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
      <p>{profile ? '档案更新失败，已保留上次成功资料。' : '个人档案读取失败。'}{archive.error}</p><Button type="button" variant="outline" size="sm" disabled={archive.loading} onClick={() => void archive.refresh()}><RefreshCw className="size-4" />重试档案</Button>
    </div>}
    {archive.loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{profile ? '正在更新个人档案…' : '正在读取个人档案…'}</p>}
    {!profile ? archive.response?.status === 'unbound' ? <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">当前账号没有可展示的个人档案，仍可使用其他已开放的个人功能。</CardContent></Card> : !archive.loading && !archive.error ? <p className="py-6 text-center text-sm text-muted-foreground">暂无个人档案</p> : null : <div className="grid gap-4 lg:grid-cols-2">
      <ArchiveSection title="任职与联系" icon={BriefcaseBusiness}>
        <Facts><Fact label="体系岗位" value={profile.systemPosition} /><Fact label="用工性质" value={profile.employmentType} />
          <Fact label="楼栋 / 专业" value={listValue(profile.buildingsSpecialties)} /><Fact label="班组" value={profile.team} /><Fact label="班次" value={profile.shift} /><Fact label="直属主管" value={profile.supervisorName} />
          <Fact label="电子邮箱" value={profile.email} /><Fact label="入职日期" value={profile.entryDate} /><Fact label="身份证号" value={profile.idCardMasked} /><Fact label="车牌号" value={profile.vehiclePlate} />
          {(profile.departureDate || profile.departureReason || profile.employmentStatus === 'departed' || profile.employmentStatus === 'transferred') && <><Fact label="离职 / 异动日期" value={profile.departureDate} /><Fact label="离职 / 异动原因" value={profile.departureReason} /></>}
        </Facts>
      </ArchiveSection>
      <ArchiveSection title="教育经历" icon={GraduationCap} empty={!hasValues([profile.education, profile.school, profile.major, profile.graduationDate])}><Facts><Fact label="学历" value={profile.education} /><Fact label="毕业院校" value={profile.school} /><Fact label="所学专业" value={profile.major} /><Fact label="毕业时间" value={profile.graduationDate} /></Facts></ArchiveSection>
      <ArchiveSection title="任职履历" icon={BriefcaseBusiness} empty={!profile.employmentHistory.length}>
        {profile.employmentHistory.length ? <ol className="divide-y">{profile.employmentHistory.map(item => <li key={item.id} className="space-y-1 py-3 first:pt-0 last:pb-0"><p className="break-words text-sm font-medium">{item.title}</p><p className="text-xs text-muted-foreground">{archiveValue(item.date)}</p>{isProfileDisplayValue(item.description) && <p className="break-words text-sm text-muted-foreground">{item.description}</p>}</li>)}</ol> : <Empty>暂无任职履历</Empty>}
      </ArchiveSection>
      <ArchiveSection title="技能与兴趣" icon={Sparkles} empty={!hasValues([listValue(profile.hobbies), listValue(profile.specialties), profile.mbti])}><Facts><Fact label="兴趣爱好" value={listValue(profile.hobbies)} /><Fact label="特长" value={listValue(profile.specialties)} /><Fact label="MBTI" value={profile.mbti ? `${profile.mbti} · ${MBTI_TYPE_DEFINITIONS[profile.mbti]?.name || ''}` : null} /></Facts>
        {profile.mbti && <p className="mt-3 text-xs text-muted-foreground">人格偏好仅作沟通参考。</p>}
      </ArchiveSection>
      <ArchiveSection title="培训与演练" icon={BookOpenCheck} empty={!hasValues([...Object.values(profile.training), ...Object.values(profile.drill)])}><Facts>
        <Fact label="已完成课程" value={profile.training.completedCourses} /><Fact label="课程总数" value={profile.training.totalCourses} /><Fact label="培训完成率" value={percent(profile.training.completionRate)} /><Fact label="培训平均分" value={profile.training.averageScore} /><Fact label="签到率" value={percent(profile.training.attendanceRate)} /><Fact label="最终考核成绩" value={profile.training.finalScore} />
        <Fact label="年度演练次数" value={profile.drill.annualCount} /><Fact label="最近演练主题" value={profile.drill.latestTitle} /><Fact label="最近演练日期" value={profile.drill.latestDate} /><Fact label="最近演练评级" value={profile.drill.latestRating} />
      </Facts></ArchiveSection>
      <ArchiveSection title="持证情况" icon={ShieldCheck} empty={!profile.certificates.length || profile.certificateSource === 'demo'}>
        {profile.certificates.length && profile.certificateSource !== 'demo' ? <ul className="divide-y">{profile.certificates.map(certificate => <li key={certificate.id} className="flex flex-wrap items-start justify-between gap-2 py-3 first:pt-0 last:pb-0"><div className="min-w-0"><p className="break-words text-sm font-medium">{certificate.name}</p><p className="mt-1 text-xs text-muted-foreground">到期日期：{archiveValue(certificate.expiryDate)}</p></div><span className={`shrink-0 rounded-md px-2 py-1 text-xs ${certificate.status === 'valid' ? 'bg-emerald-50 text-emerald-700' : certificate.status === 'expired' ? 'bg-destructive/10 text-destructive' : 'bg-amber-50 text-amber-700'}`}>{certificateLabels[certificate.status]}</span></li>)}</ul> : <Empty>暂无持证记录</Empty>}
      </ArchiveSection>
      <ArchiveSection title="人员画像" icon={UserRound} empty={!hasValues(Object.values(profile.profileScores))}><Facts><Fact label="责任心" value={profile.profileScores.responsibility} /><Fact label="稳定性" value={profile.profileScores.stability} /><Fact label="协作力" value={profile.profileScores.collaboration} /><Fact label="成长潜力" value={profile.profileScores.growthPotential} /></Facts></ArchiveSection>
      <ArchiveSection title="岗位能力" icon={Sparkles} empty={!profile.abilities.length}>
        {profile.abilities.length ? <div className="divide-y">{profile.abilities.map(ability => <div key={ability.key} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"><span className="min-w-0 break-words text-sm">{ability.label}</span><div className="shrink-0 text-right"><p className="text-sm font-medium">{archiveValue(ability.score)}</p>{ability.benchmark !== null && <p className="text-xs text-muted-foreground">岗位基准 {ability.benchmark}</p>}</div></div>)}</div> : <Empty>暂无岗位能力记录</Empty>}
      </ArchiveSection>
    </div>}
  </div>;
}

function ArchiveSection({ title, icon: Icon, children, empty = false }: { title: string; icon: typeof UserRound; children: ReactNode; empty?: boolean }) {
  if (empty) return <details className="min-w-0 self-start rounded-lg border bg-card p-4"><summary className="flex cursor-pointer items-center gap-2 text-sm font-medium"><Icon className="size-4 text-muted-foreground" />{title}<span className="ml-auto text-xs font-normal text-muted-foreground">暂无资料 · 展开</span></summary><div className="mt-4">{children}</div></details>;
  return <Card className="min-w-0 gap-4"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Icon className="size-4 text-primary" />{title}</CardTitle></CardHeader><CardContent>{children}</CardContent></Card>;
}
function hasValues(values: Value[]) { return values.some(value => archiveValue(value) !== '未维护'); }
function Facts({ children }: { children: ReactNode }) { return <dl className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">{children}</dl>; }
function Fact({ label, value, loading = false, unavailable = false, phone = false }: { label: string; value: Value; loading?: boolean; unavailable?: boolean; phone?: boolean }) {
  const shown = loading ? '读取中…' : unavailable ? '暂不可用' : archiveValue(value), number = phone && typeof value === 'string' ? value.replace(/[^\d+]/g, '') : '';
  return <div className="min-w-0 space-y-1"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-words text-sm [overflow-wrap:anywhere]">{number && !loading ? <a className="text-primary hover:underline" href={`tel:${number}`}>{shown}</a> : shown}</dd></div>;
}
function Empty({ children }: { children: ReactNode }) { return <p className="py-2 text-sm text-muted-foreground">{children}</p>; }
function listValue(values: readonly string[]) { return values.filter(isProfileDisplayValue).join('、') || null; }
function percent(value: number | null) { return value === null ? null : `${value}%`; }
function formatUpdatedAt(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '时间未维护' : date.toLocaleString('zh-CN', { hour12: false }); }
