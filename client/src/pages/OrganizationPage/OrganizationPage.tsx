import React, { useEffect, useMemo, useState } from 'react';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { getOrganizations, getDutyStaff } from '@/api';
import { useAccess } from '@/access/AccessProvider';
import type {
  DutyStaff,
  DutyStaffByBuilding,
  NantongOrganization,
} from '@shared/api.interface';
import { canViewOrganizationPersonProfile } from '@shared/organization-person-profile';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PersonProfileDialog } from './PersonProfileDialog';
import type { OrganizationPersonProfileSummary } from './person-profile-model';
import {
  BadgeCheck,
  BriefcaseBusiness,
  Building2,
  CircleDot,
  Layers3,
  Network,
  UserRoundCheck,
  Users,
} from 'lucide-react';

const ORGANIZATION_CACHE_TTL_MS = 10 * 60 * 1000;
const BUILDINGS = ['H楼', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼', '110站'];
const MANAGEMENT_BUILDINGS = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'];
const SHIFT_ORDER = ['A班', 'B班', 'C班', 'D班'];

let organizationDataCache: {
  organizations: NantongOrganization[];
  dutyStaff: DutyStaffByBuilding[];
  fetchedAt: number;
} | null = null;

let organizationDataPromise: Promise<{
  organizations: NantongOrganization[];
  dutyStaff: DutyStaffByBuilding[];
}> | null = null;

async function fetchOrganizationData(forceRefresh = false) {
  if (!forceRefresh && organizationDataPromise) {
    return organizationDataPromise;
  }

  organizationDataPromise = Promise.all([getOrganizations(), getDutyStaff()])
    .then(([orgResponse, staffResponse]) => {
      const data = {
        organizations: orgResponse.organizations,
        dutyStaff: staffResponse.staff,
      };
      organizationDataCache = {
        ...data,
        fetchedAt: Date.now(),
      };
      return data;
    })
    .finally(() => {
      organizationDataPromise = null;
    });

  return organizationDataPromise;
}

const positionPriority: Record<string, number> = {
  设施运维经理: 1,
  设施运维副经理: 2,
  设施运维主管: 3,
  弱电主管: 4,
  电气主管: 5,
  暖通主管: 6,
  消防主管: 7,
  综合管理: 8,
  '安全&消防工程师': 9,
  消防工程师: 10,
  电气工程师: 11,
  暖通工程师: 12,
  弱电工程师: 13,
  FOC: 14,
};

const roleToneMap: Record<string, { label: string; className: string }> = {
  设施运维经理: {
    label: '园区A角',
    className: 'border-blue-200 bg-blue-50 text-blue-700',
  },
  设施运维副经理: {
    label: '园区B角',
    className: 'border-sky-200 bg-sky-50 text-sky-700',
  },
  设施运维主管: {
    label: '主管',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  },
  弱电主管: {
    label: '弱电主管',
    className: 'border-cyan-200 bg-cyan-50 text-cyan-700',
  },
  电气主管: {
    label: '电气主管',
    className: 'border-blue-200 bg-blue-50 text-blue-700',
  },
  暖通主管: {
    label: '暖通主管',
    className: 'border-teal-200 bg-teal-50 text-teal-700',
  },
  消防主管: {
    label: '消防主管',
    className: 'border-rose-200 bg-rose-50 text-rose-700',
  },
  综合管理: {
    label: '综合管理',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  },
  '安全&消防工程师': {
    label: '安全&消防工程师',
    className: 'border-rose-200 bg-rose-50 text-rose-700',
  },
  消防工程师: {
    label: '消防工程师',
    className: 'border-rose-200 bg-rose-50 text-rose-700',
  },
  电气工程师: {
    label: '电气工程师',
    className: 'border-blue-200 bg-blue-50 text-blue-700',
  },
  暖通工程师: {
    label: '暖通工程师',
    className: 'border-teal-200 bg-teal-50 text-teal-700',
  },
  弱电工程师: {
    label: '弱电工程师',
    className: 'border-cyan-200 bg-cyan-50 text-cyan-700',
  },
  FOC: {
    label: 'FOC',
    className: 'border-amber-200 bg-amber-50 text-amber-700',
  },
};

const shiftToneMap: Record<string, { dot: string; badge: string }> = {
  A班: { dot: 'bg-blue-500', badge: 'bg-blue-50 text-blue-700 ring-blue-100' },
  B班: { dot: 'bg-emerald-500', badge: 'bg-emerald-50 text-emerald-700 ring-emerald-100' },
  C班: { dot: 'bg-cyan-500', badge: 'bg-cyan-50 text-cyan-700 ring-cyan-100' },
  D班: { dot: 'bg-teal-500', badge: 'bg-teal-50 text-teal-700 ring-teal-100' },
};

const normalizeNames = (nameText: string | null): string[] => {
  if (!nameText) return [];
  return nameText
    .split(/[、,，\s]+/)
    .map((name) => name.trim())
    .filter(Boolean);
};

const displayName = (person: NantongOrganization | null | undefined) =>
  person?.supervisorText || '—';

const getRoleTone = (position: string) =>
  roleToneMap[position] || {
    label: position || '岗位',
    className: 'border-slate-200 bg-slate-50 text-slate-600',
  };

const getSpecialtyTags = (person: NantongOrganization) =>
  person.buildingsSpecialties.filter((item) => !BUILDINGS.includes(item)).slice(0, 2);

const countOrganizationPeople = (people: NantongOrganization[]) =>
  people.reduce((total, person) => {
    const names = normalizeNames(person.supervisorText);
    return total + Math.max(names.length, 1);
  }, 0);

const countDutyStaff = (buildings: DutyStaffByBuilding[]) =>
  buildings.reduce(
    (total, building) =>
      total +
      building.shifts.reduce(
        (sum, shift) => sum + (shift.leader ? 1 : 0) + (shift.staff ? 1 : 0),
        0,
      ),
    0,
  );

const sortOrganizations = (people: NantongOrganization[]) =>
  [...people].sort((a, b) => {
    const positionCompare =
      (positionPriority[a.position] || 99) - (positionPriority[b.position] || 99);
    if (positionCompare !== 0) return positionCompare;
    return displayName(a).localeCompare(displayName(b), 'zh-CN');
  });

const organizationToProfile = (
  person: NantongOrganization,
): OrganizationPersonProfileSummary => ({
  source: 'organization',
  recordId: person.recordId,
  name: person.supervisorText || '—',
  position: person.position,
  buildings: person.buildingsSpecialties,
  shift: person.shift || null,
  photoUrl: person.photoUrl || null,
  email: person.email || null,
  phone: person.phone || null,
});

const dutyStaffToProfile = (
  person: DutyStaff,
): OrganizationPersonProfileSummary => ({
  source: person.profileSource || 'certificate',
  recordId: person.id,
  name: person.appName || '—',
  position: person.position,
  buildings: person.buildingProfessional,
  shift: person.shift || null,
  photoUrl: person.photoUrl || null,
  email: person.email || null,
  phone: person.phone || null,
});

const StatCard: React.FC<{
  label: string;
  value: number;
  icon: React.ElementType;
  helper: string;
  tone: 'blue' | 'green' | 'cyan' | 'neutral';
}> = ({ label, value, icon: Icon, helper, tone }) => {
  const toneClasses = {
    blue: 'from-blue-500 to-sky-500 bg-blue-50 text-blue-700',
    green: 'from-emerald-500 to-teal-500 bg-emerald-50 text-emerald-700',
    cyan: 'from-cyan-500 to-blue-500 bg-cyan-50 text-cyan-700',
    neutral: 'from-slate-500 to-slate-400 bg-slate-50 text-slate-600',
  }[tone];

  return (
    <Card className="overflow-hidden border-slate-200/80 bg-white/85 shadow-sm">
      <CardContent className="relative p-5">
        <div className="absolute right-0 top-0 h-20 w-20 rounded-bl-[4rem] bg-gradient-to-br from-blue-50 to-emerald-50" />
        <div className="relative flex items-center gap-4">
          <div className={`flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-sm ${toneClasses.split(' ').slice(0, 2).join(' ')}`}>
            <Icon className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-500">{label}</p>
            <div className="mt-1 flex items-baseline gap-2">
              <p className="text-3xl font-semibold tracking-tight text-slate-800">{value}</p>
              <span className="text-xs text-slate-400">人</span>
            </div>
            <p className={`mt-1 text-xs font-medium ${toneClasses.split(' ').slice(2).join(' ')}`}>
              {helper}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

const PersonCard: React.FC<{
  person: NantongOrganization;
  compact?: boolean;
  canOpenProfile: boolean;
  onSelect: (profile: OrganizationPersonProfileSummary) => void;
}> = ({ person, compact = false, canOpenProfile, onSelect }) => {
  const roleTone = getRoleTone(person.position);
  const specialtyTags = getSpecialtyTags(person);
  const profile = organizationToProfile(person);

  return (
    <button
      type="button"
      disabled={!canOpenProfile}
      aria-disabled={!canOpenProfile}
      onClick={() => onSelect(profile)}
      title={canOpenProfile ? `查看${profile.name}的人员档案` : '仅管理员、子管理员可查看人员档案'}
      className={`group w-full rounded-xl border border-slate-200/80 bg-white/85 text-left shadow-sm transition duration-200 enabled:hover:-translate-y-0.5 enabled:hover:border-blue-200 enabled:hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:cursor-default disabled:opacity-90 ${
        compact ? 'p-3' : 'p-4'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${roleTone.className}`}
        >
          {roleTone.label}
        </span>
        <CircleDot className="mt-0.5 h-3.5 w-3.5 text-emerald-500 opacity-70" />
      </div>
      <p
        className={`mt-2 truncate font-semibold text-slate-800 ${
          compact ? 'text-sm' : 'text-base'
        }`}
        title={displayName(person)}
      >
        {displayName(person)}
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        {(specialtyTags.length > 0 ? specialtyTags : person.buildingsSpecialties.slice(0, 1)).map(
          (tag) => (
            <span
              key={`${person.id}-${tag}`}
              className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500"
            >
              {tag}
            </span>
          ),
        )}
      </div>
    </button>
  );
};

const SectionHeader: React.FC<{
  title: string;
  subtitle: string;
  count: number;
  icon: React.ElementType;
  tone?: 'blue' | 'green';
}> = ({ title, subtitle, count, icon: Icon, tone = 'blue' }) => (
  <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
    <div className="flex items-center gap-3">
      <div
        className={`flex h-11 w-11 items-center justify-center rounded-2xl text-white shadow-sm ${
          tone === 'green'
            ? 'bg-gradient-to-br from-emerald-500 to-teal-500'
            : 'bg-gradient-to-br from-blue-600 to-sky-500'
        }`}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-800">{title}</h2>
        <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>
      </div>
    </div>
    <Badge className="rounded-full bg-blue-50 px-3 py-1 text-blue-700 hover:bg-blue-50">
      {count} 人
    </Badge>
  </div>
);

const OperationHub: React.FC<{
  people: NantongOrganization[];
  canOpenProfile: boolean;
  onSelectPerson: (profile: OrganizationPersonProfileSummary) => void;
}> = ({ people, canOpenProfile, onSelectPerson }) => {
  const focPeople = sortOrganizations(people.filter((person) => person.position === 'FOC'));
  const corePeople = sortOrganizations(people.filter((person) => person.position !== 'FOC'));

  return (
    <section className="rounded-2xl border border-blue-200/80 bg-gradient-to-br from-blue-50 via-slate-50 to-emerald-50 p-5 shadow-sm">
      <SectionHeader
        title="H楼运维&运营中枢"
        subtitle="园区管理、专业主管、综合运营与 FOC 中台"
        count={countOrganizationPeople(people)}
        icon={Network}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        {corePeople.map((person) => (
          <PersonCard
            key={person.id}
            person={person}
            compact
            canOpenProfile={canOpenProfile}
            onSelect={onSelectPerson}
          />
        ))}
      </div>

      {focPeople.length > 0 && (
        <div className="mt-5 rounded-2xl border border-dashed border-blue-200 bg-white/60 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-blue-700">
            <Layers3 className="h-4 w-4" />
            FOC 中台协同
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {focPeople.map((person) => (
              <button
                type="button"
                key={person.id}
                disabled={!canOpenProfile}
                aria-disabled={!canOpenProfile}
                onClick={() => onSelectPerson(organizationToProfile(person))}
                title={canOpenProfile ? `查看${displayName(person)}的人员档案` : '仅管理员、子管理员可查看人员档案'}
                className="flex items-center gap-3 rounded-xl border border-amber-100 bg-amber-50/70 p-3 text-left enabled:hover:border-amber-200 disabled:cursor-default"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-xs font-bold text-amber-700 shadow-sm">
                  FOC
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-800">
                    {displayName(person)}
                  </p>
                  <p className="text-xs text-slate-500">运营中台支撑</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
};

const BuildingCluster: React.FC<{
  building: string;
  people: NantongOrganization[];
  canOpenProfile: boolean;
  onSelectPerson: (profile: OrganizationPersonProfileSummary) => void;
}> = ({ building, people, canOpenProfile, onSelectPerson }) => {
  const sortedPeople = sortOrganizations(people);
  const supervisor = sortedPeople.find((person) => person.position === '设施运维主管');
  const specialists = sortedPeople.filter((person) => person.id !== supervisor?.id);

  return (
    <article className="rounded-2xl border border-blue-100 bg-white/80 p-4 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md">
      <div className="mb-4 flex items-center justify-between rounded-xl bg-gradient-to-r from-blue-600 to-sky-500 px-4 py-3 text-white">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4" />
          <h3 className="font-semibold">{building}</h3>
        </div>
        <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs font-semibold">
          {countOrganizationPeople(people)} 人
        </span>
      </div>

      {supervisor && (
        <button
          type="button"
          disabled={!canOpenProfile}
          aria-disabled={!canOpenProfile}
          onClick={() => onSelectPerson(organizationToProfile(supervisor))}
          title={canOpenProfile ? `查看${displayName(supervisor)}的人员档案` : '仅管理员、子管理员可查看人员档案'}
          className="mb-3 w-full rounded-xl border border-emerald-100 bg-emerald-50/80 p-3 text-left transition enabled:hover:border-emerald-200 enabled:hover:bg-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-200 disabled:cursor-default"
        >
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
            <BadgeCheck className="h-3.5 w-3.5" />
            楼栋负责人
          </div>
          <p className="truncate text-base font-semibold text-slate-800">
            {displayName(supervisor)}
          </p>
        </button>
      )}

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
        {specialists.map((person) => {
          const roleTone = getRoleTone(person.position);
          return (
            <button
              type="button"
              key={person.id}
              disabled={!canOpenProfile}
              aria-disabled={!canOpenProfile}
              onClick={() => onSelectPerson(organizationToProfile(person))}
              title={canOpenProfile ? `查看${displayName(person)}的人员档案` : '仅管理员、子管理员可查看人员档案'}
              className="rounded-xl border border-slate-100 bg-slate-50/80 p-3 text-left transition enabled:hover:border-blue-200 enabled:hover:bg-blue-50/40 focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:cursor-default"
            >
              <span
                className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${roleTone.className}`}
              >
                {roleTone.label}
              </span>
              <p className="mt-2 truncate text-sm font-semibold text-slate-800">
                {displayName(person)}
              </p>
            </button>
          );
        })}
      </div>
    </article>
  );
};

const ManagementMatrix: React.FC<{
  groupedByBuilding: Record<string, NantongOrganization[]>;
  canOpenProfile: boolean;
  onSelectPerson: (profile: OrganizationPersonProfileSummary) => void;
}> = ({ groupedByBuilding, canOpenProfile, onSelectPerson }) => {
  const people = MANAGEMENT_BUILDINGS.flatMap((building) => groupedByBuilding[building] || []);

  return (
    <section className="rounded-2xl border border-blue-100 bg-slate-50/80 p-5 shadow-sm">
      <SectionHeader
        title="机楼管理&技术矩阵"
        subtitle="A-E 楼按负责人、专业工程师分层展示"
        count={countOrganizationPeople(people)}
        icon={BriefcaseBusiness}
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {MANAGEMENT_BUILDINGS.map((building) => (
          <BuildingCluster
            key={building}
            building={building}
            people={groupedByBuilding[building] || []}
            canOpenProfile={canOpenProfile}
            onSelectPerson={onSelectPerson}
          />
        ))}
      </div>
    </section>
  );
};

const StaffName: React.FC<{
  person?: DutyStaff | null;
  name?: string | null;
  muted?: boolean;
  canOpenProfile: boolean;
  onSelectPerson: (profile: OrganizationPersonProfileSummary) => void;
}> = ({ person, name, muted, canOpenProfile, onSelectPerson }) => {
  const displayValue = person?.appName || name || '—';
  const canOpen = Boolean(person?.appName && canOpenProfile);

  if (!canOpen) {
    return (
      <span
        className={`block truncate text-[13px] font-semibold leading-5 ${
          muted || !displayValue ? 'text-slate-400' : 'text-slate-800'
        }`}
        title={displayValue}
      >
        {displayValue}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelectPerson(dutyStaffToProfile(person!))}
      className="block max-w-full truncate text-left text-[13px] font-semibold leading-5 text-slate-800 transition hover:text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-200"
      title={displayValue}
    >
      {displayValue}
    </button>
  );
};

const DutyBuildingCard: React.FC<{
  buildingData: DutyStaffByBuilding;
  canOpenProfile: boolean;
  onSelectPerson: (profile: OrganizationPersonProfileSummary) => void;
}> = ({ buildingData, canOpenProfile, onSelectPerson }) => {
  const isStation = buildingData.building === '110站';
  const stationPeople = buildingData.shifts
    .map((shift) => shift.staff)
    .filter((person): person is DutyStaff => Boolean(person));
  const stationChief = stationPeople.find((person) => person.position === '110站站长');
  const stationStaff = stationPeople
    .filter((person) => person.id !== stationChief?.id)
    .sort((a, b) => {
      const shiftCompare =
        SHIFT_ORDER.indexOf(a.shift || '') - SHIFT_ORDER.indexOf(b.shift || '');
      if (shiftCompare !== 0) return shiftCompare;
      return (a.appName || '').localeCompare(b.appName || '', 'zh-CN');
    });
  const stationRows = [
    {
      rowLabel: '站务',
      leftLabel: '站长',
      leftPerson: stationChief,
      rightLabel: '值班员',
      rightPerson: stationStaff[0],
    },
    {
      rowLabel: '值班',
      leftLabel: '值班员',
      leftPerson: stationStaff[1],
      rightLabel: '值班员',
      rightPerson: stationStaff[2],
    },
    {
      rowLabel: '值班',
      leftLabel: '值班员',
      leftPerson: stationStaff[3],
      rightLabel: '值班员',
      rightPerson: stationStaff[4],
    },
    {
      rowLabel: '值班',
      leftLabel: '值班员',
      leftPerson: stationStaff[5],
      rightLabel: '值班员',
      rightPerson: stationStaff[6],
    },
  ];

  return (
    <article className="rounded-xl border border-emerald-100 bg-white/90 p-3 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-emerald-200 hover:shadow-md">
      <div className="mb-3 flex items-center justify-between rounded-lg bg-gradient-to-r from-blue-600 to-emerald-500 px-3 py-2 text-white">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4" />
          <h3 className="text-sm font-semibold">{buildingData.building}</h3>
        </div>
        <span className="rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-semibold">
          {
            buildingData.shifts.flatMap((shift) => [shift.leader, shift.staff]).filter(Boolean)
              .length
          }
          人
        </span>
      </div>

      {isStation ? (
        <div className="space-y-2">
          {stationRows.map((row, index) => {
            const tone = index === 0 ? shiftToneMap.B班 : shiftToneMap.A班;
            return (
            <div
              key={`${row.rowLabel}-${index}`}
              className="grid grid-cols-[3.4rem_1fr_1fr] items-center gap-1.5 rounded-lg border border-slate-100 bg-slate-50/80 p-1.5"
            >
              <span
                className={`inline-flex items-center justify-center gap-1 rounded-full px-1.5 py-1 text-[11px] font-semibold ring-1 ${tone.badge}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
                {row.rowLabel}
              </span>
              <div className="min-w-0 rounded-md bg-white/90 px-2 py-1">
                <p className="text-[10px] font-medium leading-4 text-slate-400">
                  {row.leftLabel}
                </p>
                <StaffName
                  person={row.leftPerson}
                  muted={!row.leftPerson}
                  canOpenProfile={canOpenProfile}
                  onSelectPerson={onSelectPerson}
                />
              </div>
              <div className="min-w-0 rounded-md bg-white/90 px-2 py-1">
                <p className="text-[10px] font-medium leading-4 text-slate-400">
                  {row.rightLabel}
                </p>
                <StaffName
                  person={row.rightPerson}
                  muted={!row.rightPerson}
                  canOpenProfile={canOpenProfile}
                  onSelectPerson={onSelectPerson}
                />
              </div>
            </div>
          );
          })}
        </div>
      ) : (
        <div className="space-y-2">
          {SHIFT_ORDER.map((shiftName) => {
            const shiftData = buildingData.shifts.find((shift) => shift.shift === shiftName);
            const tone = shiftToneMap[shiftName];

            return (
              <div
                key={shiftName}
                className="grid grid-cols-[3.4rem_1fr_1fr] items-center gap-1.5 rounded-lg border border-slate-100 bg-slate-50/80 p-1.5"
              >
                <span
                  className={`inline-flex items-center justify-center gap-1 rounded-full px-1.5 py-1 text-[11px] font-semibold ring-1 ${tone.badge}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
                  {shiftName}
                </span>
                <div className="min-w-0 rounded-md bg-white/90 px-2 py-1">
                  <p className="text-[10px] font-medium leading-4 text-slate-400">
                    值班长
                  </p>
                  <StaffName
                    person={shiftData?.leader}
                    muted={!shiftData?.leader}
                    canOpenProfile={canOpenProfile}
                    onSelectPerson={onSelectPerson}
                  />
                </div>
                <div className="min-w-0 rounded-md bg-white/90 px-2 py-1">
                  <p className="text-[10px] font-medium leading-4 text-slate-400">
                    值班员
                  </p>
                  <StaffName
                    person={shiftData?.staff}
                    muted={!shiftData?.staff}
                    canOpenProfile={canOpenProfile}
                    onSelectPerson={onSelectPerson}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
};

const DutyMatrix: React.FC<{
  dutyStaff: DutyStaffByBuilding[];
  canOpenProfile: boolean;
  onSelectPerson: (profile: OrganizationPersonProfileSummary) => void;
}> = ({ dutyStaff, canOpenProfile, onSelectPerson }) => {
  const sortedStaff = [...dutyStaff].sort(
    (a, b) => BUILDINGS.indexOf(a.building) - BUILDINGS.indexOf(b.building),
  );

  return (
    <section className="rounded-2xl border border-emerald-100 bg-gradient-to-br from-emerald-50 via-slate-50 to-blue-50 p-4 shadow-sm">
      <SectionHeader
        title="机楼值班班组"
        subtitle="按楼栋与 A-D 班组查看值班长和值班员"
        count={countDutyStaff(dutyStaff)}
        icon={UserRoundCheck}
        tone="green"
      />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
        {sortedStaff.map((building) => (
          <DutyBuildingCard
            key={building.building}
            buildingData={building}
            canOpenProfile={canOpenProfile}
            onSelectPerson={onSelectPerson}
          />
        ))}
      </div>
    </section>
  );
};

const OrganizationPage: React.FC = () => {
  const { role } = useAccess();
  const canOpenProfiles = canViewOrganizationPersonProfile(role);
  const [organizations, setOrganizations] = useState<NantongOrganization[]>([]);
  const [dutyStaff, setDutyStaff] = useState<DutyStaffByBuilding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProfile, setSelectedProfile] =
    useState<OrganizationPersonProfileSummary | null>(null);

  const handleSelectPerson = (profile: OrganizationPersonProfileSummary) => {
    if (!canOpenProfiles) return;
    setSelectedProfile(profile);
  };

  useEffect(() => {
    void loadData();
  }, []);

  useEffect(() => {
    if (!canOpenProfiles) setSelectedProfile(null);
  }, [canOpenProfiles]);

  const loadData = async (forceRefresh = false) => {
    try {
      const hasUsableCache =
        !forceRefresh &&
        organizationDataCache &&
        (organizationDataCache.organizations.length > 0 ||
          organizationDataCache.dutyStaff.length > 0) &&
        Date.now() - organizationDataCache.fetchedAt < ORGANIZATION_CACHE_TTL_MS;

      if (
        organizationDataCache &&
        !forceRefresh &&
        (organizationDataCache.organizations.length > 0 ||
          organizationDataCache.dutyStaff.length > 0)
      ) {
        setOrganizations(organizationDataCache.organizations);
        setDutyStaff(organizationDataCache.dutyStaff);
        setLoading(false);
        setError(null);
        if (hasUsableCache) {
          return;
        }
      } else {
        setLoading(true);
      }

      setError(null);
      const data = await fetchOrganizationData(forceRefresh);
      setOrganizations(data.organizations);
      setDutyStaff(data.dutyStaff);
    } catch (err) {
      logger.error('加载组织架构失败', err);
      setError('加载组织架构失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  const groupedByBuilding = useMemo(() => {
    const groups: Record<string, NantongOrganization[]> = {
      H楼: [],
      A楼: [],
      B楼: [],
      C楼: [],
      D楼: [],
      E楼: [],
      '110站': [],
    };
    const seen = new Set<string>();

    sortOrganizations(organizations).forEach((org) => {
      const key = `${org.position}-${org.supervisorText || org.recordId}`;
      if (seen.has(key)) return;
      seen.add(key);

      const building = MANAGEMENT_BUILDINGS.find((item) =>
        org.buildingsSpecialties.includes(item),
      );
      if (building) {
        groups[building].push(org);
        return;
      }

      if (org.buildingsSpecialties.includes('110站')) {
        groups['110站'].push(org);
        return;
      }

      groups['H楼'].push(org);
    });

    Object.keys(groups).forEach((building) => {
      groups[building] = sortOrganizations(groups[building]);
    });

    return groups;
  }, [organizations]);

  const stats = useMemo(() => {
    const hBuilding = countOrganizationPeople(groupedByBuilding['H楼']);
    const otherBuildings = MANAGEMENT_BUILDINGS.reduce(
      (sum, building) => sum + countOrganizationPeople(groupedByBuilding[building]),
      0,
    );
    const dutyStaffCount = countDutyStaff(dutyStaff);

    return {
      total: hBuilding + otherBuildings + dutyStaffCount,
      hBuilding,
      otherBuildings,
      dutyStaffCount,
    };
  }, [dutyStaff, groupedByBuilding]);

  if (loading) {
    return (
      <main className="mx-auto max-w-[112rem] px-5 py-8 sm:px-8">
        <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((item) => (
            <Skeleton key={item} className="h-32 rounded-2xl" />
          ))}
        </div>
        <div className="space-y-5">
          <Skeleton className="h-80 rounded-2xl" />
          <Skeleton className="h-96 rounded-2xl" />
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-8 text-center">
          <p className="text-rose-700">{error}</p>
          <button
            type="button"
            onClick={() => void loadData(true)}
            className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-blue-600 px-5 text-sm font-semibold text-white transition hover:bg-blue-700"
          >
            重新加载
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-[112rem] px-5 py-8 sm:px-8">
      <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="总人数"
          value={stats.total}
          helper="组织 + 值班"
          icon={Users}
          tone="blue"
        />
        <StatCard
          label="H楼运维&运营"
          value={stats.hBuilding}
          helper="中枢管理"
          icon={Network}
          tone="cyan"
        />
        <StatCard
          label="机楼管理&技术"
          value={stats.otherBuildings}
          helper="A-E 楼"
          icon={BriefcaseBusiness}
          tone="green"
        />
        <StatCard
          label="机楼值班人员"
          value={stats.dutyStaffCount}
          helper="班组覆盖"
          icon={UserRoundCheck}
          tone="neutral"
        />
      </section>

      <div className="space-y-6">
        <OperationHub
          people={groupedByBuilding['H楼']}
          canOpenProfile={canOpenProfiles}
          onSelectPerson={handleSelectPerson}
        />
        <ManagementMatrix
          groupedByBuilding={groupedByBuilding}
          canOpenProfile={canOpenProfiles}
          onSelectPerson={handleSelectPerson}
        />
        <DutyMatrix
          dutyStaff={dutyStaff}
          canOpenProfile={canOpenProfiles}
          onSelectPerson={handleSelectPerson}
        />
      </div>

      {organizations.length === 0 && dutyStaff.length === 0 && (
        <div className="mt-6 rounded-2xl border border-dashed border-blue-200 bg-blue-50/60 py-16 text-center">
          <Users className="mx-auto mb-4 h-12 w-12 text-blue-300" />
          <p className="text-slate-500">暂无组织架构数据</p>
          <button
            type="button"
            onClick={() => void loadData(true)}
            className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-blue-600 px-5 text-sm font-semibold text-white transition hover:bg-blue-700"
          >
            重新加载
          </button>
        </div>
      )}
      <PersonProfileDialog
        profile={selectedProfile}
        canView={canOpenProfiles}
        onOpenChange={(open) => {
          if (!open) setSelectedProfile(null);
        }}
      />
    </main>
  );
};

export default OrganizationPage;
