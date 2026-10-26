import * as React from 'react';
import { createPortal } from 'react-dom';
import {
  Eraser,
  Loader2,
  PenLine,
  Plus,
  Save,
  Search,
  Signature,
  Trash2,
  X,
} from 'lucide-react';

import { searchConstructionOnsiteFollowers } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { ConstructionStaffCandidate } from '@shared/api.interface';
import {
  applyOnlineWorkFormTargetDefaults,
  createEmptyOnlineWorkFormDraft,
  createEmptyOnlineWorkFormPerson,
  createOnlineWorkFormPersonFromCrewMember,
  createOnlineWorkFormPeopleFromCrewMembers,
  ONLINE_WORK_FORM_BASE_VALUES,
  ONLINE_WORK_FORM_COMMON_MEASURES,
  ONLINE_WORK_FORM_WORK_TYPE_MEASURES,
  type OnlineWorkFormCrewMember,
  type OnlineWorkFormDraft,
  type OnlineWorkFormKind,
  type OnlineWorkFormPerson,
  type OnlineWorkFormTarget,
} from './online-work-form-model';

export {
  createEmptyOnlineWorkFormDraft,
  createOnlineWorkFormPeopleFromCrewMembers,
  getOnlineWorkFormTarget,
  type OnlineWorkFormCrewMember,
  type OnlineWorkFormDraft,
  type OnlineWorkFormKind,
  type OnlineWorkFormPerson,
  type OnlineWorkFormTarget,
} from './online-work-form-model';

export function OnlineWorkFormDialog({
  target,
  open,
  draft,
  crewMembers = [],
  onDraftChange,
  onGenerateFile,
  onOpenChange,
}: {
  target: OnlineWorkFormTarget | null;
  open: boolean;
  draft?: OnlineWorkFormDraft;
  crewMembers?: OnlineWorkFormCrewMember[];
  onDraftChange: (fieldKey: string, draft: OnlineWorkFormDraft) => void;
  onGenerateFile: (
    fieldKey: string,
    file: File,
    draft: OnlineWorkFormDraft,
  ) => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const [currentDraft, setCurrentDraft] =
    React.useState<OnlineWorkFormDraft | null>(null);
  const [generating, setGenerating] = React.useState(false);

  React.useEffect(() => {
    if (!target) {
      setCurrentDraft(null);
      setGenerating(false);
      return;
    }
    setCurrentDraft(
      applyOnlineWorkFormTargetDefaults(
        target,
        draft || createEmptyOnlineWorkFormDraft(target),
      ),
    );
  }, [draft, target]);

  const updateValue = React.useCallback((key: string, value: string) => {
    setCurrentDraft((current) =>
      current
        ? { ...current, values: { ...current.values, [key]: value } }
        : current,
    );
  }, []);

  const updatePerson = React.useCallback(
    (id: string, key: keyof OnlineWorkFormPerson, value: string) => {
      setCurrentDraft((current) =>
        current
          ? {
              ...current,
              people: current.people.map((person) =>
                person.id === id ? { ...person, [key]: value } : person,
              ),
            }
          : current,
      );
    },
    [],
  );

  const addPerson = React.useCallback(() => {
    setCurrentDraft((current) =>
      current
        ? {
            ...current,
            people: [...current.people, createEmptyOnlineWorkFormPerson()],
          }
        : current,
    );
  }, []);

  const removePerson = React.useCallback((id: string) => {
    setCurrentDraft((current) => {
      if (!current || current.people.length <= 1) {
        return current;
      }
      return {
        ...current,
        people: current.people.filter((person) => person.id !== id),
      };
    });
  }, []);

  const toggleCrewMember = React.useCallback(
    (member: OnlineWorkFormCrewMember) => {
      setCurrentDraft((current) => {
        if (!current || !target) {
          return current;
        }
        const exists = current.people.some(
          (person) => person.id === member.recordId,
        );
        const rawPeople = exists
          ? current.people.filter((person) => person.id !== member.recordId)
          : [
              ...current.people,
              createOnlineWorkFormPersonFromCrewMember(
                member,
                current.people.find((person) => person.id === member.recordId),
              ),
            ];
        const nextPeople = normalizeOnlineWorkFormPeopleForTarget(
          target,
          current.values,
          rawPeople,
        );
        return {
          ...current,
          people: nextPeople,
          values: {
            ...current.values,
            constructionCount: String(nextPeople.length || ''),
          },
        };
      });
    },
    [target],
  );

  const selectAllCrewMembers = React.useCallback(() => {
    setCurrentDraft((current) =>
      current && target
        ? {
            ...current,
            people: normalizeOnlineWorkFormPeopleForTarget(
              target,
              current.values,
              createOnlineWorkFormPeopleFromCrewMembers(
                crewMembers,
                current.people,
              ),
            ),
            values: {
              ...current.values,
              constructionCount: String(crewMembers.length || ''),
            },
          }
        : current,
    );
  }, [crewMembers, target]);

  const selectCrewMembers = React.useCallback(
    (members: readonly OnlineWorkFormCrewMember[]) => {
      setCurrentDraft((current) =>
        current && target
          ? {
              ...current,
              people: normalizeOnlineWorkFormPeopleForTarget(
                target,
                current.values,
                createOnlineWorkFormPeopleFromCrewMembers(
                  members,
                  current.people,
                ),
              ),
              values: {
                ...current.values,
                constructionCount: String(members.length || ''),
              },
          }
        : current,
      );
    },
    [target],
  );

  const clearCrewMembers = React.useCallback(() => {
    setCurrentDraft((current) =>
      current
        ? {
            ...current,
            people: [],
            values: {
              ...current.values,
              constructionCount: '',
            },
          }
        : current,
    );
  }, []);

  const toggleMeasure = React.useCallback((measure: string) => {
    setCurrentDraft((current) => {
      if (!current) {
        return current;
      }
      const enabled = current.measures.includes(measure);
      return {
        ...current,
        measures: enabled
          ? current.measures.filter((item) => item !== measure)
          : [...current.measures, measure],
      };
    });
  }, []);

  const updateSignature = React.useCallback((signatureDataUrl: string) => {
    setCurrentDraft((current) =>
      current ? { ...current, signatureDataUrl } : current,
    );
  }, []);

  const persistDraft = React.useCallback(() => {
    if (target && currentDraft) {
      onDraftChange(target.fieldKey, currentDraft);
    }
  }, [currentDraft, onDraftChange, target]);

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        persistDraft();
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, persistDraft],
  );

  const handleGenerateFile = React.useCallback(async () => {
    if (!target || !currentDraft) {
      return;
    }
    if (target.kind === 'workApplication' && currentDraft.people.length === 0) {
      return;
    }
    if (target.kind === 'trainingSignIn' && currentDraft.people.length === 0) {
      return;
    }
    const nextValues =
      target.kind === 'riskDisclosure'
        ? {
            ...currentDraft.values,
            constructionCount: String(currentDraft.people.length || ''),
            riskDisclosureTime: clampDatetimeLocalToNow(
              currentDraft.values.riskDisclosureTime,
            ),
          }
        : currentDraft.values;
    setGenerating(true);
    const nextDraft = {
      ...currentDraft,
      people: normalizeOnlineWorkFormPeopleForTarget(
        target,
        nextValues,
        currentDraft.people,
      ),
      values: nextValues,
      updatedAt: new Date().toISOString(),
    };
    try {
      const file = await createOnlineWorkFormFile(target, nextDraft);
      await onGenerateFile(target.fieldKey, file, nextDraft);
    } finally {
      setGenerating(false);
    }
  }, [currentDraft, onGenerateFile, target]);

  const values = currentDraft?.values || ONLINE_WORK_FORM_BASE_VALUES;
  const canGenerate =
    Boolean(target && currentDraft) &&
    (target?.kind !== 'workApplication' || Boolean(currentDraft?.people.length)) &&
    (target?.kind !== 'trainingSignIn' || Boolean(currentDraft?.people.length));
  const title = target
    ? getOnlineWorkFormTitle(target)
    : '在线填表';
  const measureOptions = target
    ? [
        ...ONLINE_WORK_FORM_COMMON_MEASURES,
        ...(ONLINE_WORK_FORM_WORK_TYPE_MEASURES[target.workType] || []),
      ]
    : [];

  React.useEffect(() => {
    if (!open) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleOpenChange(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleOpenChange, open]);

  const stopNestedDialogEvent = React.useCallback(
    (event: React.SyntheticEvent) => {
      event.stopPropagation();
    },
    [],
  );

  const handleContentWheel = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      event.stopPropagation();
    },
    [],
  );

  if (!open || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/55 p-4"
      style={{ zIndex: 1000, pointerEvents: 'auto' }}
      onPointerDown={stopNestedDialogEvent}
      onMouseDown={stopNestedDialogEvent}
      onClick={stopNestedDialogEvent}
      onFocus={stopNestedDialogEvent}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-0 shadow-[0_24px_70px_rgba(15,23,42,0.22)]"
        style={{
          maxHeight: 'calc(100vh - 48px)',
          zIndex: 1001,
          pointerEvents: 'auto',
        }}
        onPointerDown={stopNestedDialogEvent}
        onMouseDown={stopNestedDialogEvent}
        onClick={stopNestedDialogEvent}
        onFocus={stopNestedDialogEvent}
      >
        <div className="relative shrink-0 border-b border-slate-100 bg-white px-6 py-4 pr-12">
          <div className="flex items-center gap-2 text-lg font-semibold text-slate-950">
            <PenLine className="h-5 w-5 text-blue-600" />
            <span>{title}</span>
          </div>
          <div className="mt-1 text-sm text-slate-500">
            {target ? `${target.workType} · ${target.label}` : ''}
          </div>
          <button
            type="button"
            className="absolute right-4 top-4 rounded-md p-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
            onClick={() => handleOpenChange(false)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {target && currentDraft ? (
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-slate-50/60 px-6 py-5"
            onWheel={handleContentWheel}
          >
            {target.kind === 'workApplication' ? (
              <WorkApplicationTemplateForm
                values={values}
                people={currentDraft.people}
                crewMembers={crewMembers}
                onValueChange={updateValue}
                onUpdatePerson={updatePerson}
                onToggleCrewMember={toggleCrewMember}
                onSelectAllCrewMembers={selectAllCrewMembers}
                onClearCrewMembers={clearCrewMembers}
              />
            ) : target.kind === 'riskDisclosure' ? (
              <RiskDisclosureTemplateForm
                target={target}
                values={values}
                people={currentDraft.people}
                crewMembers={crewMembers}
                onValueChange={updateValue}
                onUpdatePerson={updatePerson}
                onToggleCrewMember={toggleCrewMember}
                onSelectCrewMembers={selectCrewMembers}
                onClearCrewMembers={clearCrewMembers}
              />
            ) : target.kind === 'trainingSignIn' ? (
              <TrainingSignInTemplateForm
                target={target}
                values={values}
                people={currentDraft.people}
                crewMembers={crewMembers}
                onValueChange={updateValue}
                onUpdatePerson={updatePerson}
                onToggleCrewMember={toggleCrewMember}
                onSelectAllCrewMembers={selectAllCrewMembers}
                onClearCrewMembers={clearCrewMembers}
              />
            ) : (
            <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
              <div className="grid gap-3 md:grid-cols-3">
                <FormControl label="编号">
                  <Input
                    value={values.formNo}
                    onChange={(event) =>
                      updateValue('formNo', event.target.value)
                    }
                    placeholder="自动或手工编号"
                  />
                </FormControl>
                <FormControl label="项目名称">
                  <Input
                    value={values.projectName}
                    onChange={(event) =>
                      updateValue('projectName', event.target.value)
                    }
                    placeholder="填写施工项目"
                  />
                </FormControl>
                <FormControl label="施工单位">
                  <Input
                    value={values.contractor}
                    onChange={(event) =>
                      updateValue('contractor', event.target.value)
                    }
                    placeholder="填写单位名称"
                  />
                </FormControl>
                {false && (
                  <FormControl label="申请人">
                    <Input
                      value={values.approver}
                      onChange={(event) =>
                        updateValue('approver', event.target.value)
                      }
                      placeholder="填写申请人"
                    />
                  </FormControl>
                )}
                <FormControl label="作业地点">
                  <Input
                    value={values.workLocation}
                    onChange={(event) =>
                      updateValue('workLocation', event.target.value)
                    }
                    placeholder="楼栋/机房/区域"
                  />
                </FormControl>
                <FormControl label="开始时间">
                  <Input
                    type="datetime-local"
                    value={values.startDate}
                    onChange={(event) =>
                      updateValue('startDate', event.target.value)
                    }
                  />
                </FormControl>
                <FormControl label="结束时间">
                  <Input
                    type="datetime-local"
                    value={values.endDate}
                    onChange={(event) =>
                      updateValue('endDate', event.target.value)
                    }
                  />
                </FormControl>
              </div>

              <FormControl label={getWorkContentLabel(target.kind)}>
                <Textarea
                  value={values.workContent}
                  onChange={(event) =>
                    updateValue('workContent', event.target.value)
                  }
                  className="min-h-20 bg-white"
                  placeholder="填写作业内容、培训主题或考核范围"
                />
              </FormControl>

              {target.kind === 'permit' && (
                <div className="rounded-lg border border-blue-100 bg-blue-50/40 p-3">
                  <div className="mb-2 text-sm font-semibold text-slate-800">
                    安全措施
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    {measureOptions.map((measure) => {
                      const checked = currentDraft.measures.includes(measure);
                      return (
                        <label
                          key={measure}
                          className={cn(
                            'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm',
                            checked
                              ? 'border-blue-200 bg-white text-slate-900'
                              : 'border-slate-200 bg-white/70 text-slate-500',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleMeasure(measure)}
                            className="mt-1"
                          />
                          <span>{measure}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {false && (
                <div className="grid gap-3 md:grid-cols-3">
                  <FormControl label="施工准备">
                    <Textarea
                      value={values.risks}
                      onChange={(event) =>
                        updateValue('risks', event.target.value)
                      }
                      className="min-h-24 bg-white"
                      placeholder="材料、工具、审批、现场准备"
                    />
                  </FormControl>
                  <FormControl label="安全措施">
                    <Textarea
                      value={values.controls}
                      onChange={(event) =>
                        updateValue('controls', event.target.value)
                      }
                      className="min-h-24 bg-white"
                      placeholder="隔离、挂牌、防护、监护等"
                    />
                  </FormControl>
                  <FormControl label="影响范围">
                    <Textarea
                      value={values.emergency}
                      onChange={(event) =>
                        updateValue('emergency', event.target.value)
                      }
                      className="min-h-24 bg-white"
                      placeholder="业务影响、风险说明、恢复方式"
                    />
                  </FormControl>
                </div>
              )}

              {target.kind === 'trainingAssessment' && (
                <div className="grid gap-3 md:grid-cols-2">
                  <FormControl label="考核主题">
                    <Input
                      value={values.assessmentTopic}
                      onChange={(event) =>
                        updateValue('assessmentTopic', event.target.value)
                      }
                    />
                  </FormControl>
                  <FormControl label="考核结果">
                    <Input
                      value={values.assessmentResult}
                      onChange={(event) =>
                        updateValue('assessmentResult', event.target.value)
                      }
                      placeholder="合格/需补考/其他"
                    />
                  </FormControl>
                </div>
              )}

              <PeopleEditor
                kind={target.kind}
                people={currentDraft.people}
                onAdd={addPerson}
                onRemove={removePerson}
                onUpdate={updatePerson}
              />

              <div className="grid gap-3 md:grid-cols-3">
                <FormControl label={getPrimarySignerLabel(target.kind)}>
                  <Input
                    value={values.approver}
                    onChange={(event) =>
                      updateValue('approver', event.target.value)
                    }
                  />
                </FormControl>
                <FormControl label="监护人">
                  <Input
                    value={values.guardian}
                    onChange={(event) =>
                      updateValue('guardian', event.target.value)
                    }
                  />
                </FormControl>
                <FormControl label="备注">
                  <Input
                    value={values.remarks}
                    onChange={(event) =>
                      updateValue('remarks', event.target.value)
                    }
                  />
                </FormControl>
              </div>

              <SignaturePad
                value={currentDraft.signatureDataUrl}
                onChange={updateSignature}
              />
            </div>
            )}
          </div>
        ) : (
          <div className="min-h-48 bg-slate-50" />
        )}

        <div className="flex shrink-0 justify-end gap-2 border-t border-slate-100 bg-white px-6 py-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={!canGenerate || generating}
            className="bg-blue-600 text-white hover:bg-blue-700"
            onClick={handleGenerateFile}
          >
            {generating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {generating ? '生成中' : '生成并回填附件'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function FormControl({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-sm font-semibold text-slate-700">
      {label}
      {children}
    </label>
  );
}

function TrainingSignInTemplateForm({
  target,
  values,
  people,
  crewMembers,
  onValueChange,
  onUpdatePerson,
  onToggleCrewMember,
  onSelectAllCrewMembers,
  onClearCrewMembers,
}: {
  target: OnlineWorkFormTarget;
  values: Record<string, string>;
  people: OnlineWorkFormPerson[];
  crewMembers: OnlineWorkFormCrewMember[];
  onValueChange: (key: string, value: string) => void;
  onUpdatePerson: (
    id: string,
    key: keyof OnlineWorkFormPerson,
    value: string,
  ) => void;
  onToggleCrewMember: (member: OnlineWorkFormCrewMember) => void;
  onSelectAllCrewMembers: () => void;
  onClearCrewMembers: () => void;
}) {
  const selectedById = React.useMemo(
    () => new Map(people.map((person) => [person.id, person])),
    [people],
  );
  const [signaturePerson, setSignaturePerson] =
    React.useState<OnlineWorkFormPerson | null>(null);

  return (
    <>
      <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
        <div className="overflow-x-auto rounded-md border border-slate-300 bg-white">
          <table className="min-w-[920px] w-full border-collapse text-sm text-slate-950">
            <tbody>
              <tr>
                <TemplateLabel>课程名称</TemplateLabel>
                <TemplateCell colSpan={5}>
                  <TemplateInput
                    value={values.projectName}
                    onChange={(value) => onValueChange('projectName', value)}
                  />
                </TemplateCell>
              </tr>
              <tr>
                <TemplateLabel>培训类别</TemplateLabel>
                <TemplateCell colSpan={2}>
                  <TemplateInput
                    value={values.trainingCategory || '线下'}
                    onChange={(value) =>
                      onValueChange('trainingCategory', value)
                    }
                  />
                </TemplateCell>
                <TemplateLabel>讲师</TemplateLabel>
                <TemplateCell colSpan={2}>
                  <TemplateInput
                    value={values.trainer}
                    onChange={(value) => onValueChange('trainer', value)}
                  />
                </TemplateCell>
              </tr>
              <tr>
                <TemplateLabel>培训时间</TemplateLabel>
                <TemplateCell colSpan={2}>
                  <TemplateDateTimeInput
                    label="培训时间"
                    value={values.startDate}
                    onChange={(value) => onValueChange('startDate', value)}
                  />
                </TemplateCell>
                <TemplateLabel>培训地点</TemplateLabel>
                <TemplateCell colSpan={2}>
                  <TemplateInput
                    value={values.workLocation}
                    onChange={(value) => onValueChange('workLocation', value)}
                  />
                </TemplateCell>
              </tr>
              <tr>
                <TemplateLabel>主要内容</TemplateLabel>
                <TemplateCell colSpan={5}>
                  <TemplateTextarea
                    value={values.workContent}
                    onChange={(value) => onValueChange('workContent', value)}
                    rows={3}
                  />
                </TemplateCell>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
            <div>
              <div className="text-sm font-semibold text-slate-900">
                {target.workType}培训签到
              </div>
              <div className="mt-1 text-xs text-slate-500">
                从同项目施工人员台账选择，已选
                <span className="mx-1 font-semibold text-blue-700">
                  {people.length}/{crewMembers.length}
                </span>
                人
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                className="font-semibold text-blue-600 hover:text-blue-700 disabled:text-slate-400"
                disabled={crewMembers.length === 0}
                onClick={onSelectAllCrewMembers}
              >
                全选
              </button>
              <button
                type="button"
                className="rounded border border-rose-100 bg-white px-2 py-1 font-semibold text-rose-600 shadow-sm hover:border-rose-200 hover:bg-rose-50 disabled:border-slate-100 disabled:bg-transparent disabled:text-slate-400 disabled:shadow-none"
                disabled={people.length === 0}
                onClick={onClearCrewMembers}
              >
                取消所有选择
              </button>
            </div>
          </div>
          {crewMembers.length === 0 ? (
            <div className="m-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              未读取到同项目施工人员台账，请先更新人员名单。
            </div>
          ) : null}
          <div className="overflow-x-auto">
            <table className="min-w-[760px] w-full border-collapse text-sm">
              <thead>
                <tr className="bg-white text-left text-xs font-semibold text-slate-500">
                  <th className="w-12 border-b border-slate-200 px-3 py-2">
                    选择
                  </th>
                  <th className="w-12 border-b border-slate-200 px-3 py-2">
                    序号
                  </th>
                  <th className="border-b border-slate-200 px-3 py-2">姓名</th>
                  <th className="border-b border-slate-200 px-3 py-2">单位</th>
                  <th className="w-48 border-b border-slate-200 px-3 py-2">
                    签名
                  </th>
                </tr>
              </thead>
              <tbody>
                {crewMembers.map((member, index) => {
                  const selectedPerson = selectedById.get(member.recordId);
                  const selected = Boolean(selectedPerson);
                  return (
                    <tr
                      key={member.recordId}
                      className={
                        selected ? 'bg-white' : 'bg-slate-50/70 text-slate-400'
                      }
                    >
                      <td className="border-b border-slate-100 px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => onToggleCrewMember(member)}
                          className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200"
                        />
                      </td>
                      <td className="border-b border-slate-100 px-3 py-2 text-slate-500">
                        {index + 1}
                      </td>
                      <td className="border-b border-slate-100 px-3 py-2 font-semibold text-slate-800">
                        {member.name}
                      </td>
                      <td className="border-b border-slate-100 px-2 py-2">
                        {selectedPerson ? (
                          <span
                            className={cn(
                              'block rounded-md border px-3 py-2 text-sm',
                              selectedPerson.company
                                ? 'border-slate-200 bg-slate-50 text-slate-900'
                                : 'border-amber-200 bg-amber-50 text-amber-700',
                            )}
                          >
                            {selectedPerson.company || '未关联台账单位'}
                          </span>
                        ) : (
                          <span className="px-1 text-xs text-slate-400">
                            未选择
                          </span>
                        )}
                      </td>
                      <td className="border-b border-slate-100 px-2 py-2">
                        {selectedPerson ? (
                          <button
                            type="button"
                            className="flex h-11 w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-2 text-left text-sm text-slate-700 shadow-sm transition hover:border-blue-300 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                            onClick={() => setSignaturePerson(selectedPerson)}
                          >
                            {isSignatureImage(selectedPerson.signature) ? (
                              <img
                                src={selectedPerson.signature}
                                alt="签字预览"
                                className="h-8 max-w-[150px] object-contain"
                              />
                            ) : (
                              <>
                                <Signature className="h-4 w-4 shrink-0 text-blue-600" />
                                <span className="truncate">
                                  {selectedPerson.signature || '手写签名'}
                                </span>
                              </>
                            )}
                          </button>
                        ) : (
                          <span className="px-1 text-xs text-slate-400">
                            未选择
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <PersonSignatureDialog
        person={signaturePerson}
        onCancel={() => setSignaturePerson(null)}
        onSave={(value) => {
          if (signaturePerson) {
            onUpdatePerson(signaturePerson.id, 'signature', value);
          }
          setSignaturePerson(null);
        }}
      />
    </>
  );
}

function RiskDisclosureTemplateForm({
  target,
  values,
  people,
  crewMembers,
  onValueChange,
  onUpdatePerson,
  onToggleCrewMember,
  onSelectCrewMembers,
  onClearCrewMembers,
}: {
  target: OnlineWorkFormTarget;
  values: Record<string, string>;
  people: OnlineWorkFormPerson[];
  crewMembers: OnlineWorkFormCrewMember[];
  onValueChange: (key: string, value: string) => void;
  onUpdatePerson: (
    id: string,
    key: keyof OnlineWorkFormPerson,
    value: string,
  ) => void;
  onToggleCrewMember: (member: OnlineWorkFormCrewMember) => void;
  onSelectCrewMembers: (members: readonly OnlineWorkFormCrewMember[]) => void;
  onClearCrewMembers: () => void;
}) {
  const eligibleCrewMembers = React.useMemo(
    () => getRiskDisclosureEligibleCrewMembers(target.workType, crewMembers),
    [crewMembers, target.workType],
  );
  const certificateRule = getRiskDisclosureCertificateRule(target.workType);
  const nowMax = getNowDatetimeLocalValue();
  const selectedPeopleCount = people.length;
  const [crewSelectorOpen, setCrewSelectorOpen] = React.useState(false);

  return (
    <>
      <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
        <div className="overflow-x-auto rounded-md border border-slate-300 bg-white">
        <table className="min-w-[920px] w-full border-collapse text-sm text-slate-950">
          <tbody>
            <tr>
              <TemplateCell colSpan={2}>
                <InlineTemplateInput
                  label="作业单位："
                  value={values.contractor}
                  onChange={(value) => onValueChange('contractor', value)}
                />
              </TemplateCell>
              <TemplateCell colSpan={2}>
                <div className="flex items-center gap-2">
                  <span className="shrink-0 font-semibold">作业人数：</span>
                  <button
                    type="button"
                    onClick={() => setCrewSelectorOpen(true)}
                    className="flex h-10 min-w-0 flex-1 items-center justify-between rounded-md border border-slate-200 bg-white px-3 text-left font-semibold text-blue-700 shadow-none transition hover:border-blue-300 hover:bg-blue-50/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
                  >
                    <span>
                      {selectedPeopleCount ? `${selectedPeopleCount}人` : '选择人员'}
                    </span>
                    <Search className="h-4 w-4 text-blue-500" />
                  </button>
                </div>
              </TemplateCell>
            </tr>
            <tr>
              <TemplateCell colSpan={2}>
                <div className="flex items-center gap-2">
                  <span className="shrink-0 font-semibold">风险交底人：</span>
                  <div className="min-w-0 flex-1">
                    <OnsiteStaffSingleSelect
                      valueId={values.disclosurePersonId}
                      valueName={values.disclosurePerson}
                      onChange={(candidate) => {
                        onValueChange('disclosurePersonId', candidate?.id || '');
                        onValueChange('disclosurePerson', candidate?.name || '');
                      }}
                    />
                  </div>
                </div>
              </TemplateCell>
              <TemplateCell colSpan={2}>
                <div className="flex items-center gap-2">
                  <span className="shrink-0 font-semibold">交底时间：</span>
                  <Input
                    type="datetime-local"
                    value={values.riskDisclosureTime}
                    max={nowMax}
                    onClick={(event) =>
                      openNativeDateTimePicker(event.currentTarget)
                    }
                    onFocus={(event) =>
                      openNativeDateTimePicker(event.currentTarget)
                    }
                    onChange={(event) =>
                      onValueChange(
                        'riskDisclosureTime',
                        clampDatetimeLocalToNow(event.target.value),
                      )
                    }
                    className="h-10 rounded-md border-slate-200 bg-white px-3 shadow-none focus-visible:border-blue-300 focus-visible:ring-blue-100"
                  />
                </div>
              </TemplateCell>
            </tr>
            <tr>
              <td
                rowSpan={5}
                className="w-16 border border-slate-300 bg-slate-50 px-3 py-3 text-center text-base font-semibold leading-8"
              >
                <div className="mx-auto flex w-6 flex-col items-center gap-1">
                  {'安全交底和风险告知'.split('').map((word) => (
                    <span key={word}>{word}</span>
                  ))}
                </div>
              </td>
              <TemplateCell colSpan={3}>
                <RiskDisclosureTextarea
                  label="作业许可范围及作业环境："
                  value={values.riskWorkEnvironment}
                  onChange={(value) =>
                    onValueChange('riskWorkEnvironment', value)
                  }
                  rows={3}
                />
              </TemplateCell>
            </tr>
            <tr>
              <TemplateCell colSpan={3}>
                <RiskDisclosureTextarea
                  label="作业风险："
                  value={values.risks}
                  onChange={(value) => onValueChange('risks', value)}
                  rows={3}
                />
              </TemplateCell>
            </tr>
            <tr>
              <TemplateCell colSpan={3}>
                <RiskDisclosureTextarea
                  label="防范措施（工艺、设备、个体防护等）："
                  value={values.controls}
                  onChange={(value) => onValueChange('controls', value)}
                  rows={3}
                />
              </TemplateCell>
            </tr>
            <tr>
              <TemplateCell colSpan={3}>
                <RiskDisclosureTextarea
                  label="应急措施："
                  value={values.emergency}
                  onChange={(value) => onValueChange('emergency', value)}
                  rows={3}
                />
              </TemplateCell>
            </tr>
            <tr>
              <TemplateCell colSpan={3}>
                <RiskDisclosureTextarea
                  label="其他注意事项："
                  value={values.remarks}
                  onChange={(value) => onValueChange('remarks', value)}
                  rows={3}
                />
              </TemplateCell>
            </tr>
            <tr>
              <TemplateCell colSpan={4}>
                <div className="space-y-3">
                  <div className="text-base leading-8">
                    我方所有施工作业人员已明确知晓该作业项目的风险、危害、防范措施和其它注意事项。
                  </div>
                  <HandwritingCaptureField
                    value={values.riskHandwritingDataUrl}
                    onChange={(value) =>
                      onValueChange('riskHandwritingDataUrl', value)
                    }
                  />
                  <div className="text-right text-sm text-slate-500">
                    （作业方负责人手写上述内容）
                  </div>
                </div>
              </TemplateCell>
            </tr>
            <tr>
              <TemplateCell colSpan={4}>
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-2">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">
                        接受风险交底人签字：
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        已选 {selectedPeopleCount} 人，点击作业人数可维护人员和签名。
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setCrewSelectorOpen(true)}
                    >
                      <Search className="h-4 w-4" />
                      选择人员
                    </Button>
                  </div>
                </div>
              </TemplateCell>
            </tr>
            <tr>
              <TemplateCell colSpan={4}>
                <div className="flex items-center justify-end gap-3">
                  <span className="text-sm font-semibold text-slate-700">
                    日期
                  </span>
                  <Input
                    type="date"
                    value={values.riskDisclosureDate}
                    onChange={(event) =>
                      onValueChange('riskDisclosureDate', event.target.value)
                    }
                    className="h-9 w-48 border-slate-200 bg-white text-sm"
                  />
                </div>
              </TemplateCell>
            </tr>
          </tbody>
        </table>
        </div>
      </div>
      <RiskDisclosureCrewMemberDialog
        open={crewSelectorOpen}
        title={`${target.workType}风险交底人员`}
        workType={target.workType}
        people={people}
        crewMembers={crewMembers}
        eligibleCrewMembers={eligibleCrewMembers}
        certificateRule={certificateRule}
        onUpdate={onUpdatePerson}
        onToggleCrewMember={onToggleCrewMember}
        onSelectEligibleCrewMembers={() => onSelectCrewMembers(eligibleCrewMembers)}
        onClearCrewMembers={onClearCrewMembers}
        onClose={() => setCrewSelectorOpen(false)}
      />
    </>
  );
}

function InlineTemplateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex min-h-11 items-center gap-2">
      <span className="shrink-0 font-semibold">{label}</span>
      <div className="min-w-0 flex-1">
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 rounded-md border-slate-200 bg-white px-3 shadow-none focus-visible:border-blue-300 focus-visible:ring-blue-100"
        />
      </div>
    </div>
  );
}

function RiskDisclosureTextarea({
  label,
  value,
  rows,
  onChange,
}: {
  label: string;
  value: string;
  rows: number;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-h-36 cursor-text flex-col">
      <span className="font-semibold text-slate-900">{label}</span>
      <Textarea
        value={value}
        rows={rows}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 min-h-28 flex-1 resize-y rounded-md border-slate-200 bg-white px-3 py-2 text-sm shadow-none focus-visible:border-blue-300 focus-visible:ring-blue-100"
      />
    </label>
  );
}

function RiskDisclosureCrewMemberDialog({
  open,
  title,
  workType,
  people,
  crewMembers,
  eligibleCrewMembers,
  certificateRule,
  onUpdate,
  onToggleCrewMember,
  onSelectEligibleCrewMembers,
  onClearCrewMembers,
  onClose,
}: {
  open: boolean;
  title: string;
  workType: string;
  people: OnlineWorkFormPerson[];
  crewMembers: OnlineWorkFormCrewMember[];
  eligibleCrewMembers: OnlineWorkFormCrewMember[];
  certificateRule: string;
  onUpdate: (
    id: string,
    key: keyof OnlineWorkFormPerson,
    value: string,
  ) => void;
  onToggleCrewMember: (member: OnlineWorkFormCrewMember) => void;
  onSelectEligibleCrewMembers: () => void;
  onClearCrewMembers: () => void;
  onClose: () => void;
}) {
  if (!open || typeof document === 'undefined') {
    return null;
  }
  const stopDialogEvent = (event: React.SyntheticEvent) => {
    event.stopPropagation();
  };
  const handleBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-slate-950/45 px-4 py-6"
      style={{ zIndex: 1050, pointerEvents: 'auto' }}
      role="dialog"
      aria-modal="true"
      onPointerDown={stopDialogEvent}
      onMouseDown={stopDialogEvent}
      onClick={handleBackdropClick}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-xl"
        style={{ pointerEvents: 'auto' }}
        onPointerDown={stopDialogEvent}
        onMouseDown={stopDialogEvent}
        onClick={stopDialogEvent}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <div className="text-lg font-semibold text-slate-900">{title}</div>
            <div className="mt-1 text-sm text-slate-500">
              已选 {people.length} 人，生成文档仅回填人数。
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <RiskDisclosureCrewMemberTable
            workType={workType}
            people={people}
            crewMembers={crewMembers}
            eligibleCrewMembers={eligibleCrewMembers}
            certificateRule={certificateRule}
            onUpdate={onUpdate}
            onToggleCrewMember={onToggleCrewMember}
            onSelectEligibleCrewMembers={onSelectEligibleCrewMembers}
            onClearCrewMembers={onClearCrewMembers}
          />
        </div>
        <div className="flex shrink-0 justify-end border-t border-slate-100 bg-slate-50 px-5 py-4">
          <Button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          >
            完成
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function RiskDisclosureCrewMemberTable({
  workType,
  people,
  crewMembers,
  eligibleCrewMembers,
  certificateRule,
  onUpdate,
  onToggleCrewMember,
  onSelectEligibleCrewMembers,
  onClearCrewMembers,
}: {
  workType: string;
  people: OnlineWorkFormPerson[];
  crewMembers: OnlineWorkFormCrewMember[];
  eligibleCrewMembers: OnlineWorkFormCrewMember[];
  certificateRule: string;
  onUpdate: (
    id: string,
    key: keyof OnlineWorkFormPerson,
    value: string,
  ) => void;
  onToggleCrewMember: (member: OnlineWorkFormCrewMember) => void;
  onSelectEligibleCrewMembers: () => void;
  onClearCrewMembers: () => void;
}) {
  const [signaturePerson, setSignaturePerson] =
    React.useState<OnlineWorkFormPerson | null>(null);
  const selectedById = new Map(people.map((person) => [person.id, person]));

  return (
    <>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-blue-100 bg-blue-50/60 px-3 py-2">
          <div className="text-xs text-slate-600">
            按{workType}证书筛选，可选
            <span className="mx-1 font-semibold text-blue-700">
              {eligibleCrewMembers.length}/{crewMembers.length}
            </span>
            人，已选
            <span className="mx-1 font-semibold text-blue-700">
              {people.length}
            </span>
            人
          </div>
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              className="font-semibold text-blue-600 hover:text-blue-700 disabled:text-slate-400"
              disabled={eligibleCrewMembers.length === 0}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onSelectEligibleCrewMembers();
              }}
            >
              全选可选人员
            </button>
            <button
              type="button"
              className="rounded border border-rose-100 bg-white px-2 py-1 font-semibold text-rose-600 shadow-sm hover:border-rose-200 hover:bg-rose-50 disabled:border-slate-100 disabled:bg-transparent disabled:text-slate-400 disabled:shadow-none"
              disabled={people.length === 0}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onClearCrewMembers();
              }}
            >
              取消所有选择
            </button>
          </div>
        </div>
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          筛选规则：{certificateRule}
        </div>
        {crewMembers.length === 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            未读取到同项目施工人员台账，请先更新人员名单。
          </div>
        )}
        {crewMembers.length > 0 && eligibleCrewMembers.length === 0 && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            当前施工人员台账中没有符合该作业证书要求的人员。
          </div>
        )}
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-slate-50 text-xs text-slate-500">
              <th className="w-12 border border-slate-200 px-2 py-1">选择</th>
              <th className="w-12 border border-slate-200 px-2 py-1">序号</th>
              <th className="border border-slate-200 px-2 py-1">姓名</th>
              <th className="border border-slate-200 px-2 py-1">身份证号</th>
              <th className="border border-slate-200 px-2 py-1">资质证书</th>
              <th className="border border-slate-200 px-2 py-1">签字</th>
            </tr>
          </thead>
          <tbody>
            {eligibleCrewMembers.map((member, index) => {
              const selectedPerson = selectedById.get(member.recordId);
              const selected = Boolean(selectedPerson);
              const certificateText = getCrewMemberCertificateText(member);

              return (
                <tr
                  key={member.recordId}
                  className={
                    selected ? 'bg-white' : 'bg-slate-50/70 text-slate-500'
                  }
                >
                  <td className="border border-slate-200 px-2 py-1 text-center">
                    <input
                      type="checkbox"
                      checked={selected}
                      readOnly
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onToggleCrewMember(member);
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200"
                    />
                  </td>
                  <td className="border border-slate-200 px-2 py-1 text-center text-slate-500">
                    {index + 1}
                  </td>
                  <td className="border border-slate-200 px-2 py-1 font-semibold text-slate-800">
                    {member.name}
                  </td>
                  <td className="border border-slate-200 px-2 py-1">
                    {member.certificateNo || '未填写'}
                  </td>
                  <td className="border border-slate-200 px-2 py-1">
                    {certificateText || '未填写'}
                  </td>
                  <td className="border border-slate-200 px-1 py-1">
                    {selectedPerson ? (
                      <button
                        type="button"
                        className="flex h-10 w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-2 text-left text-xs text-slate-700 shadow-sm transition hover:border-blue-300 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                        onClick={() => setSignaturePerson(selectedPerson)}
                      >
                        {isSignatureImage(selectedPerson.signature) ? (
                          <img
                            src={selectedPerson.signature}
                            alt="签字预览"
                            className="h-8 max-w-[120px] object-contain"
                          />
                        ) : (
                          <>
                            <Signature className="h-4 w-4 shrink-0 text-blue-600" />
                            <span className="truncate">
                              {selectedPerson.signature || '手写签名'}
                            </span>
                          </>
                        )}
                      </button>
                    ) : (
                      <span className="px-1 text-xs text-slate-400">未选择</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <PersonSignatureDialog
        person={signaturePerson}
        onCancel={() => setSignaturePerson(null)}
        onSave={(value) => {
          if (signaturePerson) {
            onUpdate(signaturePerson.id, 'signature', value);
          }
          setSignaturePerson(null);
        }}
      />
    </>
  );
}

function HandwritingCaptureField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <div className="rounded-lg border border-slate-200 bg-slate-50">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <PenLine className="h-4 w-4 text-blue-600" />
            作业方负责人手写内容
          </div>
          <div className="flex gap-2">
            {value ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onChange('')}
              >
                <Eraser className="h-4 w-4" />
                清除
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(true)}
            >
              <PenLine className="h-4 w-4" />
              {value ? '重新手写' : '手写填写'}
            </Button>
          </div>
        </div>
        <div className="min-h-32 bg-white p-3">
          {isSignatureImage(value) ? (
            <img
              src={value}
              alt="手写内容预览"
              className="max-h-32 w-full object-contain"
            />
          ) : (
            <div className="flex h-28 items-center justify-center rounded-md border border-dashed border-slate-300 text-sm text-slate-400">
              点击“手写填写”录入负责人手写内容
            </div>
          )}
        </div>
      </div>
      <HandwritingCaptureDialog
        open={open}
        value={value}
        onCancel={() => setOpen(false)}
        onSave={(nextValue) => {
          onChange(nextValue);
          setOpen(false);
        }}
      />
    </>
  );
}

function HandwritingCaptureDialog({
  open,
  value,
  onCancel,
  onSave,
}: {
  open: boolean;
  value: string;
  onCancel: () => void;
  onSave: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = React.useState('');

  React.useEffect(() => {
    setDraftValue(value || '');
  }, [value, open]);

  if (!open || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-slate-950/45 px-4"
      style={{ zIndex: 1100, pointerEvents: 'auto' }}
      role="dialog"
      aria-modal="true"
      onPointerDown={(event) => {
        event.stopPropagation();
        onCancel();
      }}
    >
      <div
        className="w-full max-w-4xl rounded-lg bg-white shadow-xl"
        style={{ pointerEvents: 'auto' }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <div className="text-base font-semibold text-slate-900">
              作业方负责人手写内容
            </div>
            <div className="mt-1 text-xs text-slate-500">
              手写确认已知晓风险、危害、防范措施和注意事项
            </div>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onCancel}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="p-4">
          <SignaturePad
            value={draftValue}
            title="手写内容"
            onChange={setDraftValue}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <Button type="button" variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button type="button" onClick={() => onSave(draftValue)}>
            <Save className="h-4 w-4" />
            保存手写内容
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function WorkApplicationTemplateForm({
  values,
  people,
  crewMembers,
  onValueChange,
  onUpdatePerson,
  onToggleCrewMember,
  onSelectAllCrewMembers,
  onClearCrewMembers,
}: {
  values: Record<string, string>;
  people: OnlineWorkFormPerson[];
  crewMembers: OnlineWorkFormCrewMember[];
  onValueChange: (key: string, value: string) => void;
  onUpdatePerson: (
    id: string,
    key: keyof OnlineWorkFormPerson,
    value: string,
  ) => void;
  onToggleCrewMember: (member: OnlineWorkFormCrewMember) => void;
  onSelectAllCrewMembers: () => void;
  onClearCrewMembers: () => void;
}) {
  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
      <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-7 text-amber-950">
        <div className="font-semibold">填写本表单时，请认真阅读以下信息：</div>
        <div>1、作业安全申请单适用于阿里IDC维修、维护、施工（含特殊作业），一切可能产生风险的现场操作；</div>
        <div>2、单张施工单对应一个施工项目，有效期最长15天；</div>
        <div>3、涉及特殊作业要办理对应的特殊作业许可证，有效期最长3天（临时用电有效期最长15天）；</div>
        <div>4、本申请单一式两份，一份交由施工方放置施工现场，一份交由阿里数据中心合作伙伴EHS工程师存档。</div>
      </div>

      <div className="overflow-x-auto rounded-md border border-slate-300 bg-white">
        <table className="min-w-[980px] w-full border-collapse text-sm text-slate-900">
          <tbody>
            <TemplateRow label="作业项目" colSpan={5}>
              <TemplateInput
                value={values.projectName}
                onChange={(value) => onValueChange('projectName', value)}
              />
            </TemplateRow>
            <tr>
              <TemplateLabel>作业日期</TemplateLabel>
              <TemplateCell colSpan={5}>
                <div className="grid gap-2 md:grid-cols-[minmax(220px,1fr)_auto_minmax(220px,1fr)] md:items-end">
                  <TemplateDateTimeInput
                    label="开始"
                    value={values.startDate}
                    onChange={(value) => onValueChange('startDate', value)}
                  />
                  <span className="pb-2 text-center text-slate-500">至</span>
                  <TemplateDateTimeInput
                    label="结束"
                    value={values.endDate}
                    onChange={(value) => onValueChange('endDate', value)}
                  />
                </div>
              </TemplateCell>
            </tr>
            <TemplateRow label="作业单位" colSpan={5}>
              <TemplateInput
                value={values.contractor}
                onChange={(value) => onValueChange('contractor', value)}
              />
            </TemplateRow>
            <tr>
              <TemplateLabel>作业方负责人</TemplateLabel>
              <TemplateCell colSpan={2}>
                <CrewMemberSingleSelect
                  valueId={values.workPartyLeadId}
                  valueName={values.workPartyLead}
                  crewMembers={crewMembers}
                  onChange={(member) => {
                    onValueChange('workPartyLeadId', member?.recordId || '');
                    onValueChange('workPartyLead', member?.name || '');
                    onValueChange('workPartyPhone', member?.phone || '');
                  }}
                />
              </TemplateCell>
              <TemplateLabel>联系电话</TemplateLabel>
              <TemplateCell colSpan={2}>
                <TemplateInput
                  value={values.workPartyPhone}
                  onChange={(value) => onValueChange('workPartyPhone', value)}
                />
              </TemplateCell>
            </tr>
            <TemplateRow label="施工人数" colSpan={5}>
              <TemplateInput
                value={values.constructionCount}
                onChange={(value) => onValueChange('constructionCount', value)}
              />
            </TemplateRow>
            <tr>
              <TemplateLabel>现场示例人员019</TemplateLabel>
              <TemplateCell colSpan={2}>
                <OnsiteStaffSingleSelect
                  valueId={values.siteResponsibleId}
                  valueName={values.siteResponsible}
                  onChange={(candidate) => {
                    onValueChange('siteResponsibleId', candidate?.id || '');
                    onValueChange('siteResponsible', candidate?.name || '');
                    onValueChange('siteResponsiblePhone', candidate?.phone || '');
                  }}
                />
              </TemplateCell>
              <TemplateLabel>联系电话</TemplateLabel>
              <TemplateCell colSpan={2}>
                <TemplateInput
                  value={values.siteResponsiblePhone}
                  onChange={(value) =>
                    onValueChange('siteResponsiblePhone', value)
                  }
                />
              </TemplateCell>
            </tr>
            <tr>
              <TemplateLabel>
                作业人员身份证号及资质证书
                <br />
                <span className="text-xs font-normal">（可另贴附件）</span>
              </TemplateLabel>
              <TemplateCell colSpan={5}>
                <WorkApplicationPeopleTable
                  people={people}
                  crewMembers={crewMembers}
                  onUpdate={onUpdatePerson}
                  onToggleCrewMember={onToggleCrewMember}
                  onSelectAllCrewMembers={onSelectAllCrewMembers}
                  onClearCrewMembers={onClearCrewMembers}
                />
              </TemplateCell>
            </tr>
            <tr>
              <TemplateLabel>作业地点</TemplateLabel>
              <TemplateCell colSpan={5}>
                <div className="grid gap-2 md:grid-cols-4">
                  <InlineField
                    label="园区"
                    value={values.park}
                    onChange={(value) => onValueChange('park', value)}
                  />
                  <InlineField
                    label="楼栋"
                    value={values.building}
                    onChange={(value) => onValueChange('building', value)}
                  />
                  <InlineField
                    label="楼层"
                    value={values.floor}
                    onChange={(value) => onValueChange('floor', value)}
                  />
                  <InlineField
                    label="房间或区域"
                    value={values.roomArea}
                    onChange={(value) => onValueChange('roomArea', value)}
                  />
                </div>
              </TemplateCell>
            </tr>
            <TemplateRow label="作业内容描述" colSpan={5}>
              <TemplateTextarea
                value={values.workContent}
                onChange={(value) => onValueChange('workContent', value)}
                rows={3}
              />
            </TemplateRow>
            <TemplateRow label="材料堆放点" colSpan={5}>
              <TemplateTextarea
                value={values.materialStackPoint}
                onChange={(value) =>
                  onValueChange('materialStackPoint', value)
                }
                rows={2}
              />
            </TemplateRow>
            <tr>
              <TemplateLabel>特殊作业</TemplateLabel>
              <TemplateCell colSpan={5}>
                <CheckboxGrid
                  value={values.specialWorks}
                  options={[
                    '临时用电作业',
                    '有限空间作业',
                    '高处作业',
                    '动火作业',
                    '消防系统关闭作业',
                    '开挖动土作业',
                    '吊装作业',
                  ]}
                  onChange={(value) => onValueChange('specialWorks', value)}
                />
                <div className="mt-1 text-xs text-slate-500">注：如有则勾选</div>
              </TemplateCell>
            </tr>
            <tr>
              <TemplateLabel>能源切断</TemplateLabel>
              <TemplateCell colSpan={5}>
                <CheckboxGrid
                  value={values.energyCuts}
                  options={['水', '电', '气']}
                  onChange={(value) => onValueChange('energyCuts', value)}
                />
              </TemplateCell>
            </tr>
            <tr>
              <TemplateLabel>停用设备</TemplateLabel>
              <TemplateCell colSpan={2}>
                <CheckboxGrid
                  value={values.equipmentDisabled}
                  options={['是', '否']}
                  single
                  onChange={(value) =>
                    onValueChange('equipmentDisabled', value)
                  }
                />
              </TemplateCell>
              <TemplateLabel>停用设备</TemplateLabel>
              <TemplateCell colSpan={2}>
                <TemplateInput
                  value={values.disabledEquipment}
                  onChange={(value) =>
                    onValueChange('disabledEquipment', value)
                  }
                />
              </TemplateCell>
            </tr>
            <ApprovalRows
              title="作业现场负责人"
              nameKey="siteOwner"
              dateKey="siteOwnerDate"
              opinionKey="siteOwnerOpinion"
              values={values}
              onValueChange={onValueChange}
            />
            <ApprovalRows
              title="审核人"
              nameKey="ehsReviewer"
              dateKey="ehsReviewDate"
              opinionKey="ehsOpinion"
              values={values}
              onValueChange={onValueChange}
            />
            <ApprovalRows
              title="一级审批"
              nameKey="levelOneApprover"
              dateKey="levelOneDate"
              opinionKey="levelOneOpinion"
              values={values}
              onValueChange={onValueChange}
            />
          </tbody>
        </table>
      </div>

      <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
        说明：对于施工内容不涉及的角色，审批签字栏可留空。
      </div>
    </div>
  );
}

function TemplateRow({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan: number;
  children: React.ReactNode;
}) {
  return (
    <tr>
      <TemplateLabel>{label}</TemplateLabel>
      <TemplateCell colSpan={colSpan}>{children}</TemplateCell>
    </tr>
  );
}

function TemplateLabel({ children }: { children: React.ReactNode }) {
  return (
    <td className="w-40 border border-slate-300 bg-slate-50 px-3 py-2 text-center font-semibold">
      {children}
    </td>
  );
}

function TemplateCell({
  children,
  colSpan = 1,
}: {
  children: React.ReactNode;
  colSpan?: number;
}) {
  return (
    <td colSpan={colSpan} className="border border-slate-300 px-3 py-2">
      {children}
    </td>
  );
}

function TemplateDateTimeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-slate-500">
      {label}
      <Input
        type="datetime-local"
        value={value}
        onClick={(event) => openNativeDateTimePicker(event.currentTarget)}
        onFocus={(event) => openNativeDateTimePicker(event.currentTarget)}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 min-w-[220px] rounded-md border-slate-200 bg-white px-2 text-sm text-slate-900 shadow-none focus-visible:ring-blue-200"
      />
    </label>
  );
}

function openNativeDateTimePicker(input: HTMLInputElement) {
  const pickerInput = input as HTMLInputElement & {
    showPicker?: () => void;
  };
  if (typeof pickerInput.showPicker !== 'function') {
    return;
  }
  try {
    pickerInput.showPicker();
  } catch {
    // Some browsers only allow showPicker during a direct user gesture.
  }
}

function CrewMemberSingleSelect({
  valueId,
  valueName,
  crewMembers,
  onChange,
}: {
  valueId?: string;
  valueName?: string;
  crewMembers: OnlineWorkFormCrewMember[];
  onChange: (member: OnlineWorkFormCrewMember | null) => void;
}) {
  const selectedId =
    valueId ||
    crewMembers.find((member) => member.name === valueName)?.recordId ||
    '';

  return (
    <select
      value={selectedId}
      onChange={(event) => {
        const member =
          crewMembers.find((item) => item.recordId === event.target.value) ||
          null;
        onChange(member);
      }}
      className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-900 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
    >
      <option value="">
        {crewMembers.length > 0 ? '请选择作业方负责人' : '暂无人员台账'}
      </option>
      {crewMembers.map((member) => (
        <option key={member.recordId} value={member.recordId}>
          {member.name}
          {member.phone ? `（${member.phone}）` : ''}
        </option>
      ))}
    </select>
  );
}

function OnsiteStaffSingleSelect({
  valueId,
  valueName,
  onChange,
}: {
  valueId?: string;
  valueName?: string;
  onChange: (candidate: ConstructionStaffCandidate | null) => void;
}) {
  const [query, setQuery] = React.useState(valueName || '');
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<ConstructionStaffCandidate[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const onChangeRef = React.useRef(onChange);

  React.useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  React.useEffect(() => {
    if (valueName && query !== valueName) {
      setQuery(valueName);
    }
  }, [query, valueName]);

  React.useEffect(() => {
    if (!open && !query.trim()) {
      return undefined;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setMessage('');
      searchConstructionOnsiteFollowers(query.trim(), controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return;
          setItems(response.items);
          const exactMatch =
            !valueId && valueName && query.trim() === valueName.trim()
              ? response.items.find((item) => item.name === valueName.trim())
              : null;
          if (exactMatch) {
            onChangeRef.current(exactMatch);
          }
          setMessage(
            response.configured
              ? response.message || ''
              : response.message || '在职人员视图待配置',
          );
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setItems([]);
          setMessage(getOnlineFormErrorMessage(error, '现场示例人员019加载失败'));
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setLoading(false);
          }
        });
    }, 220);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, valueId, valueName]);

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <Input
        value={query}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          if (valueId) {
            onChange(null);
          }
        }}
        placeholder="搜索现场示例人员019"
        className="h-9 border-slate-200 bg-white pl-8 text-sm focus-visible:ring-blue-200"
      />
      {open && (
        <div className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
              正在加载人员
            </div>
          ) : items.length > 0 ? (
            items.map((item) => (
              <button
                key={item.id}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange(item);
                  setQuery(item.name);
                  setOpen(false);
                }}
                onClick={(event) => event.preventDefault()}
                className={cn(
                  'flex w-full items-start justify-between gap-3 border-b border-slate-100 px-3 py-2 text-left text-sm transition last:border-b-0 hover:bg-blue-50/70',
                  valueId === item.id && 'bg-blue-50 text-blue-700',
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold">
                    {item.name}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-slate-500">
                    {[
                      item.phone,
                      item.position,
                      item.buildingSpecialties.join(' / '),
                      item.team,
                    ]
                      .filter(Boolean)
                      .join(' · ') || '在职人员'}
                  </span>
                </span>
                {item.onDutyToday && (
                  <span className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-500">
                    今日{item.onDutyToday}
                  </span>
                )}
              </button>
            ))
          ) : (
            <div className="px-3 py-3 text-sm text-slate-500">
              {message || '未找到匹配的在职人员'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function getOnlineFormErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return fallback;
}

function TemplateInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
    />
  );
}

function TemplateTextarea({
  value,
  rows,
  onChange,
}: {
  value: string;
  rows: number;
  onChange: (value: string) => void;
}) {
  return (
    <Textarea
      value={value}
      rows={rows}
      onChange={(event) => onChange(event.target.value)}
      className="min-h-0 resize-y border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
    />
  );
}

function InlineField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-slate-500">
      {label}
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 border-slate-200 bg-white"
      />
    </label>
  );
}

function CheckboxGrid({
  value,
  options,
  single = false,
  onChange,
}: {
  value: string;
  options: string[];
  single?: boolean;
  onChange: (value: string) => void;
}) {
  const selected = new Set(splitListValue(value));
  return (
    <div className="grid gap-2 md:grid-cols-3">
      {options.map((option) => (
        <label key={option} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={selected.has(option)}
            onChange={() => {
              if (single) {
                onChange(selected.has(option) ? '' : option);
                return;
              }
              const next = new Set(selected);
              if (next.has(option)) {
                next.delete(option);
              } else {
                next.add(option);
              }
              onChange(Array.from(next).join('、'));
            }}
          />
          <span>{option}</span>
        </label>
      ))}
    </div>
  );
}

function WorkApplicationPeopleTable({
  people,
  crewMembers,
  onUpdate,
  onToggleCrewMember,
  onSelectAllCrewMembers,
  onClearCrewMembers,
}: {
  people: OnlineWorkFormPerson[];
  crewMembers: OnlineWorkFormCrewMember[];
  onUpdate: (
    id: string,
    key: keyof OnlineWorkFormPerson,
    value: string,
  ) => void;
  onToggleCrewMember: (member: OnlineWorkFormCrewMember) => void;
  onSelectAllCrewMembers: () => void;
  onClearCrewMembers: () => void;
}) {
  const selectedById = new Map(people.map((person) => [person.id, person]));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-blue-100 bg-blue-50/60 px-3 py-2">
        <div className="text-xs text-slate-600">
          从同项目施工人员台账选择，已选
          <span className="mx-1 font-semibold text-blue-700">
            {people.length}/{crewMembers.length}
          </span>
          人
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            className="font-semibold text-blue-600 hover:text-blue-700 disabled:text-slate-400"
            disabled={crewMembers.length === 0}
            onClick={onSelectAllCrewMembers}
          >
            全选
          </button>
          <button
            type="button"
            className="rounded border border-rose-100 bg-white px-2 py-1 font-semibold text-rose-600 shadow-sm hover:border-rose-200 hover:bg-rose-50 disabled:border-slate-100 disabled:bg-transparent disabled:text-slate-400 disabled:shadow-none"
            disabled={people.length === 0}
            onClick={onClearCrewMembers}
          >
            取消所有选择
          </button>
        </div>
      </div>
      {crewMembers.length === 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          未读取到同项目施工人员台账，请先更新人员名单后再生成申请单。
        </div>
      )}
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-slate-50 text-xs text-slate-500">
            <th className="w-12 border border-slate-200 px-2 py-1">选择</th>
            <th className="w-12 border border-slate-200 px-2 py-1">序号</th>
            <th className="border border-slate-200 px-2 py-1">姓名</th>
            <th className="border border-slate-200 px-2 py-1">身份证号</th>
            <th className="border border-slate-200 px-2 py-1">资质证书</th>
            <th className="border border-slate-200 px-2 py-1">签字</th>
          </tr>
        </thead>
        <tbody>
          {crewMembers.map((member, index) => {
            const selectedPerson = selectedById.get(member.recordId);
            const selected = Boolean(selectedPerson);
            const certificateText =
              member.certificateSummary ||
              member.complianceStatus ||
              member.issueSummary ||
              '';

            return (
              <tr
                key={member.recordId}
                className={
                  selected ? 'bg-white' : 'bg-slate-50/70 text-slate-400'
                }
              >
                <td className="border border-slate-200 px-2 py-1 text-center">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => onToggleCrewMember(member)}
                    className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200"
                  />
                </td>
                <td className="border border-slate-200 px-2 py-1 text-center text-slate-500">
                  {index + 1}
                </td>
                <td className="border border-slate-200 px-2 py-1 font-semibold text-slate-800">
                  {member.name}
                </td>
                <td className="border border-slate-200 px-2 py-1">
                  {member.certificateNo || '未填写'}
                </td>
                <td className="border border-slate-200 px-2 py-1">
                  {certificateText || '未填写'}
                </td>
                <td className="border border-slate-200 px-1 py-1">
                  {selectedPerson ? (
                    <TemplateInput
                      value={selectedPerson.signature}
                      onChange={(value) =>
                        onUpdate(selectedPerson.id, 'signature', value)
                      }
                    />
                  ) : (
                    <span className="px-1 text-xs text-slate-400">未选择</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ApprovalRows({
  title,
  nameKey,
  dateKey,
  opinionKey,
  values,
  onValueChange,
}: {
  title: string;
  nameKey: string;
  dateKey: string;
  opinionKey: string;
  values: Record<string, string>;
  onValueChange: (key: string, value: string) => void;
}) {
  return (
    <tr>
      <TemplateCell colSpan={2}>
        <div className="flex items-center gap-2">
          <span className="shrink-0 font-semibold text-slate-900">
            {title}：
          </span>
          <TemplateInput
            value={values[nameKey] || ''}
            onChange={(value) => onValueChange(nameKey, value)}
          />
        </div>
      </TemplateCell>
      <TemplateCell colSpan={2}>
        <div className="flex items-center gap-2">
          <span className="shrink-0 font-semibold text-slate-900">日期：</span>
          <Input
            type="date"
            value={values[dateKey] || ''}
            onChange={(event) => onValueChange(dateKey, event.target.value)}
            className="border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
          />
        </div>
      </TemplateCell>
      <TemplateCell colSpan={2}>
        <div className="flex items-center gap-2">
          <span className="shrink-0 font-semibold text-slate-900">意见：</span>
          <TemplateInput
            value={values[opinionKey] || ''}
            onChange={(value) => onValueChange(opinionKey, value)}
          />
        </div>
      </TemplateCell>
    </tr>
  );
}

function PeopleEditor({
  kind,
  people,
  onAdd,
  onRemove,
  onUpdate,
}: {
  kind: OnlineWorkFormKind;
  people: OnlineWorkFormPerson[];
  onAdd: () => void;
  onRemove: (id: string) => void;
  onUpdate: (
    id: string,
    key: keyof OnlineWorkFormPerson,
    value: string,
  ) => void;
}) {
  const [signaturePerson, setSignaturePerson] =
    React.useState<OnlineWorkFormPerson | null>(null);

  return (
    <>
      <div className="rounded-lg border border-slate-200">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2">
          <div className="text-sm font-semibold text-slate-800">
            {kind === 'trainingAssessment'
              ? '考核人员'
              : kind === 'trainingSignIn'
                ? '培训签到'
                : '作业人员'}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onAdd}>
            <Plus className="h-4 w-4" />
            添加人员
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[820px] w-full border-collapse text-sm">
            <thead>
              <tr className="bg-white text-left text-xs font-semibold text-slate-500">
                <th className="w-12 border-b border-slate-200 px-3 py-2">序号</th>
                <th className="border-b border-slate-200 px-3 py-2">姓名</th>
                <th className="border-b border-slate-200 px-3 py-2">单位</th>
                <th className="border-b border-slate-200 px-3 py-2">岗位</th>
                <th className="border-b border-slate-200 px-3 py-2">身份证号</th>
                <th className="border-b border-slate-200 px-3 py-2">签字</th>
                <th className="w-12 border-b border-slate-200 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {people.map((person, index) => (
                <tr key={person.id}>
                  <td className="border-b border-slate-100 px-3 py-2 text-slate-500">
                    {index + 1}
                  </td>
                  <td className="border-b border-slate-100 px-2 py-2">
                    <Input
                      value={person.name}
                      onChange={(event) =>
                        onUpdate(person.id, 'name', event.target.value)
                      }
                    />
                  </td>
                  <td className="border-b border-slate-100 px-2 py-2">
                    <Input
                      value={person.company}
                      onChange={(event) =>
                        onUpdate(person.id, 'company', event.target.value)
                      }
                    />
                  </td>
                  <td className="border-b border-slate-100 px-2 py-2">
                    <Input
                      value={person.role}
                      onChange={(event) =>
                        onUpdate(person.id, 'role', event.target.value)
                      }
                    />
                  </td>
                  <td className="border-b border-slate-100 px-2 py-2">
                    <Input
                      value={person.idCard}
                      onChange={(event) =>
                        onUpdate(person.id, 'idCard', event.target.value)
                      }
                    />
                  </td>
                  <td className="border-b border-slate-100 px-2 py-2">
                    <button
                      type="button"
                      className="flex h-12 w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-2 text-left text-sm text-slate-700 shadow-sm transition hover:border-blue-300 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                      onClick={() => setSignaturePerson(person)}
                    >
                      {isSignatureImage(person.signature) ? (
                        <img
                          src={person.signature}
                          alt="签字预览"
                          className="h-9 max-w-[140px] object-contain"
                        />
                      ) : (
                        <>
                          <Signature className="h-4 w-4 shrink-0 text-blue-600" />
                          <span className="truncate">
                            {person.signature || '手写签名'}
                          </span>
                        </>
                      )}
                    </button>
                  </td>
                  <td className="border-b border-slate-100 px-2 py-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={people.length <= 1}
                      onClick={() => onRemove(person.id)}
                    >
                      <Trash2 className="h-4 w-4 text-rose-500" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <PersonSignatureDialog
        person={signaturePerson}
        onCancel={() => setSignaturePerson(null)}
        onSave={(value) => {
          if (signaturePerson) {
            onUpdate(signaturePerson.id, 'signature', value);
          }
          setSignaturePerson(null);
        }}
      />
    </>
  );
}

function PersonSignatureDialog({
  person,
  onCancel,
  onSave,
}: {
  person: OnlineWorkFormPerson | null;
  onCancel: () => void;
  onSave: (value: string) => void;
}) {
  const [draftSignature, setDraftSignature] = React.useState('');

  React.useEffect(() => {
    setDraftSignature(person?.signature || '');
  }, [person]);

  if (!person || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-slate-950/45 px-4"
      style={{ zIndex: 1100, pointerEvents: 'auto' }}
      role="dialog"
      aria-modal="true"
      onPointerDown={(event) => {
        event.stopPropagation();
        onCancel();
      }}
    >
      <div
        className="w-full max-w-3xl rounded-lg bg-white shadow-xl"
        style={{ pointerEvents: 'auto' }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <div className="text-base font-semibold text-slate-900">
              {person.name ? `${person.name} 签字` : '人员签字'}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              手写完成后点击保存签名
            </div>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onCancel}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="p-4">
          <SignaturePad value={draftSignature} onChange={setDraftSignature} />
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <Button type="button" variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button type="button" onClick={() => onSave(draftSignature)}>
            <Save className="h-4 w-4" />
            保存签名
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SignaturePad({
  value,
  title = '手写签名',
  onChange,
}: {
  value: string;
  title?: string;
  onChange: (value: string) => void;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const drawingRef = React.useRef(false);
  const lastPointRef = React.useRef<{ x: number; y: number } | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !value) {
      return;
    }
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }
    const image = new Image();
    image.onload = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
    };
    image.src = value;
  }, [value]);

  const drawTo = React.useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !drawingRef.current) {
        return;
      }
      const context = canvas.getContext('2d');
      if (!context) {
        return;
      }
      const point = getCanvasPoint(canvas, event);
      const lastPoint = lastPointRef.current || point;
      context.strokeStyle = '#0f172a';
      context.lineWidth = 2.6;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.beginPath();
      context.moveTo(lastPoint.x, lastPoint.y);
      context.lineTo(point.x, point.y);
      context.stroke();
      lastPointRef.current = point;
    },
    [],
  );

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      drawingRef.current = true;
      lastPointRef.current = getCanvasPoint(event.currentTarget, event);
      drawTo(event);
    },
    [drawTo],
  );

  const finishDrawing = React.useCallback(() => {
    const canvas = canvasRef.current;
    drawingRef.current = false;
    lastPointRef.current = null;
    if (canvas) {
      onChange(canvas.toDataURL('image/png'));
    }
  }, [onChange]);

  const clearSignature = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const context = canvas.getContext('2d');
    context?.clearRect(0, 0, canvas.width, canvas.height);
    onChange('');
  }, [onChange]);

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          <Signature className="h-4 w-4 text-blue-600" />
          {title}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={clearSignature}
        >
          <Eraser className="h-4 w-4" />
          清除
        </Button>
      </div>
      <div className="p-3">
        <canvas
          ref={canvasRef}
          width={880}
          height={180}
          className="h-40 w-full touch-none rounded-md border border-dashed border-slate-300 bg-white"
          onPointerDown={(event) => {
            event.stopPropagation();
            handlePointerDown(event);
          }}
          onPointerMove={(event) => {
            event.stopPropagation();
            drawTo(event);
          }}
          onPointerUp={(event) => {
            event.stopPropagation();
            finishDrawing();
          }}
          onPointerCancel={(event) => {
            event.stopPropagation();
            finishDrawing();
          }}
          onPointerLeave={(event) => {
            event.stopPropagation();
            if (drawingRef.current) {
              finishDrawing();
            }
          }}
        />
      </div>
    </div>
  );
}

function createOnlineWorkFormFile(
  target: OnlineWorkFormTarget,
  draft: OnlineWorkFormDraft,
): Promise<File> {
  const html = renderOnlineWorkFormHtml(target, draft);
  return Promise.resolve(
    new File([createWordDocumentHtml(html)], createOnlineWorkFormFileName(target), {
      type: 'application/msword',
      lastModified: Date.now(),
    }),
  );
}

function createWordDocumentHtml(html: string): string {
  return `\ufeff${html.replace(
    '<html lang="zh-CN">',
    '<html lang="zh-CN" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">',
  ).replace(
    '</head>',
    `<style>
      @page WordSection1 { size: A4; margin: 18mm 16mm 18mm 16mm; }
      .WordSection1 { page: WordSection1; }
      body { background: #fff !important; }
      .sheet { width: auto !important; max-width: none !important; margin: 0 !important; padding: 0 !important; box-shadow: none !important; }
      .fixed-word-sheet { width: 160mm !important; max-width: 160mm !important; margin: 0 auto !important; padding: 4mm 0 0 !important; box-shadow: none !important; }
      .fixed-word-sheet table.fixed-word-table { width: 160mm !important; }
    </style>
    <!--[if gte mso 9]>
    <xml>
      <w:WordDocument>
        <w:View>Print</w:View>
        <w:Zoom>100</w:Zoom>
        <w:DoNotOptimizeForBrowser/>
      </w:WordDocument>
    </xml>
    <![endif]-->
  </head>`,
  ).replace(/<main class="([^"]*\bsheet\b[^"]*)">/, '<main class="$1 WordSection1">')}`;
}

function renderOnlineWorkFormHtml(
  target: OnlineWorkFormTarget,
  draft: OnlineWorkFormDraft,
): string {
  if (target.kind === 'workApplication') {
    return renderWorkApplicationHtml(target, draft);
  }
  if (target.kind === 'trainingSignIn') {
    return renderTrainingSignInHtml(target, draft);
  }
  if (target.kind === 'riskDisclosure') {
    return renderRiskDisclosureHtml(target, draft);
  }
  const values = draft.values;
  const peopleRows = draft.people
    .map(
      (person, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(person.name)}</td>
          <td>${escapeHtml(person.company)}</td>
          <td>${escapeHtml(person.role)}</td>
          <td>${escapeHtml(person.idCard)}</td>
          <td>${renderPersonSignatureHtml(person.signature)}</td>
        </tr>`,
    )
    .join('');
  const measureRows = draft.measures
    .map((measure, index) => `<div>${index + 1}. ${escapeHtml(measure)}</div>`)
    .join('');
  const signature = draft.signatureDataUrl
    ? `<img src="${draft.signatureDataUrl}" alt="签名" class="signature" />`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(getOnlineWorkFormTitle(target))}</title>
  <style>
    body { margin: 0; background: #f8fafc; color: #0f172a; font-family: "Microsoft YaHei", Arial, sans-serif; }
    .sheet { width: 960px; max-width: calc(100vw - 40px); margin: 24px auto; background: #fff; padding: 32px; box-shadow: 0 8px 30px rgba(15, 23, 42, .12); }
    h1 { margin: 0 0 18px; text-align: center; font-size: 24px; letter-spacing: 0; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #1e293b; padding: 8px; min-height: 28px; vertical-align: top; font-size: 14px; line-height: 1.55; }
    th { background: #f1f5f9; font-weight: 700; text-align: center; }
    .label { width: 120px; background: #f8fafc; font-weight: 700; text-align: center; }
    .section { margin-top: 14px; }
    .block { min-height: 88px; white-space: pre-wrap; }
    .measure { min-height: 112px; }
    .signature { max-width: 260px; max-height: 90px; object-fit: contain; }
    .person-signature { max-width: 140px; max-height: 40px; object-fit: contain; }
    .muted { color: #64748b; font-size: 12px; text-align: right; margin-top: 12px; }
    @media print { body { background: #fff; } .sheet { box-shadow: none; margin: 0; width: auto; max-width: none; } }
  </style>
</head>
<body>
  <main class="sheet">
    <h1>${escapeHtml(getOnlineWorkFormTitle(target))}</h1>
    <table>
      <tr>
        <td class="label">编号</td>
        <td>${escapeHtml(values.formNo)}</td>
        <td class="label">作业类型</td>
        <td>${escapeHtml(target.workType)}</td>
      </tr>
      <tr>
        <td class="label">项目名称</td>
        <td colspan="3">${escapeHtml(values.projectName)}</td>
      </tr>
      <tr>
        <td class="label">施工单位</td>
        <td>${escapeHtml(values.contractor)}</td>
        <td class="label">作业地点</td>
        <td>${escapeHtml(values.workLocation)}</td>
      </tr>
      <tr>
        <td class="label">开始时间</td>
        <td>${escapeHtml(formatDatetimeValue(values.startDate))}</td>
        <td class="label">结束时间</td>
        <td>${escapeHtml(formatDatetimeValue(values.endDate))}</td>
      </tr>
      <tr>
        <td class="label">${escapeHtml(getWorkContentLabel(target.kind))}</td>
        <td colspan="3" class="block">${escapeHtml(values.workContent)}</td>
      </tr>
      ${renderKindRows(target, values, measureRows)}
    </table>

    <table class="section">
      <thead>
        <tr>
          <th style="width: 52px;">序号</th>
          <th>姓名</th>
          <th>单位</th>
          <th>岗位</th>
          <th>身份证号</th>
          <th>签字</th>
        </tr>
      </thead>
      <tbody>${peopleRows}</tbody>
    </table>

    <table class="section">
      <tr>
        <td class="label">${escapeHtml(getPrimarySignerLabel(target.kind))}</td>
        <td>${escapeHtml(getPrimarySignerValue(target.kind, values))}</td>
        <td class="label">监护人</td>
        <td>${escapeHtml(values.guardian)}</td>
      </tr>
      <tr>
        <td class="label">备注</td>
        <td colspan="3">${escapeHtml(values.remarks)}</td>
      </tr>
      <tr>
        <td class="label">手写签名</td>
        <td colspan="3">${signature}</td>
      </tr>
    </table>
    <div class="muted">在线填表生成时间：${escapeHtml(formatGeneratedTime(draft.updatedAt))}</div>
  </main>
</body>
</html>`;
}

function renderRiskDisclosureHtml(
  target: OnlineWorkFormTarget,
  draft: OnlineWorkFormDraft,
): string {
  const values = draft.values;
  const selectedPeople = draft.people;
  const signatureImages = selectedPeople
    .map((person) => person.signature.trim())
    .filter((signature) => isSignatureImage(signature));
  const constructionCount =
    selectedPeople.length ? String(selectedPeople.length) : values.constructionCount;
  const disclosureDate = getChineseDateParts(
    values.riskDisclosureDate || values.riskDisclosureTime || draft.updatedAt,
  );
  const handwriting = isSignatureImage(values.riskHandwritingDataUrl)
    ? `<img src="${values.riskHandwritingDataUrl}" alt="负责人手写内容" class="handwriting-image" />`
    : `
      <div class="handwriting-lines">
        <div></div>
        <div></div>
      </div>`;
  const peopleSignatures = signatureImages.length
    ? signatureImages
        .map(
          (signature) => `
            <div class="person-signature-item">
              <span><img src="${signature}" alt="签字" class="person-signature" /></span>
            </div>`,
        )
        .join('')
    : '<div class="empty-signature-space">&nbsp;</div>';
  const verticalTitle = '安全交底和风险告知'
    .split('')
    .map((char) => `<div>${escapeHtml(char)}</div>`)
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(getOnlineWorkFormTitle(target))}</title>
  <style>
    @page WordSection1 { size: A4; margin: 18mm 16mm 18mm 16mm; }
    body { margin: 0; background: #fff; color: #000; font-family: SimSun, "宋体", "Microsoft YaHei", Arial, sans-serif; }
    .sheet { width: 160mm; max-width: calc(100vw - 40px); margin: 12px auto; background: #fff; padding-top: 4mm; }
    h1 { margin: 0 0 3mm; text-align: center; font-size: 16pt; font-weight: 700; line-height: 1.2; letter-spacing: 0; }
    table { width: 160mm; border-collapse: collapse; table-layout: fixed; border: 1px solid #000; }
    td { border: 1px solid #000; padding: 2mm 3mm; vertical-align: top; font-size: 10.5pt; line-height: 1.45; mso-line-height-rule: exactly; }
    .half { height: 12mm; vertical-align: middle; }
    .inline-label { font-weight: 400; }
    .inline-value { white-space: pre-wrap; }
    .vertical-title { width: 24mm; text-align: center; vertical-align: middle; padding: 0; }
    .vertical-title-inner { width: 24mm; margin: 0 auto; text-align: center; font-size: 12pt; font-weight: 700; line-height: 1.72; }
    .risk-field { height: 18mm; white-space: pre-wrap; }
    .risk-field.tall { height: 24mm; }
    .risk-label { font-weight: 400; }
    .declaration { height: 92mm; padding: 5mm 5mm 3mm; }
    .declaration-text { text-indent: 2em; font-size: 11pt; line-height: 1.75; }
    .handwriting-wrapper { height: 24mm; margin: 4mm 14mm 1mm; overflow: hidden; text-align: center; }
    .handwriting-image { display: block; max-width: 100%; max-height: 22mm; height: 22mm; margin: 0 auto; }
    .handwriting-lines div { height: 8mm; border-bottom: 1px solid #000; }
    .responsible-note { margin-right: 2mm; text-align: right; font-size: 10.5pt; }
    .accept-title { margin-top: 9mm; font-size: 11pt; }
    .accept-signatures { min-height: 22mm; padding: 3mm 8mm; }
    .person-signature-item { display: inline-block; min-width: 32mm; margin: 0 6mm 2mm 0; }
    .person-signature { max-width: 30mm; max-height: 9mm; vertical-align: middle; }
    .empty-signature-space { height: 18mm; }
    .date-line { text-align: right; font-size: 11pt; }
    .date-line span { display: inline-block; min-width: 10mm; text-align: center; }
    @media print { .sheet { width: 160mm; max-width: none; margin: 0 auto; } }
  </style>
</head>
<body>
  <main class="sheet fixed-word-sheet">
    <h1>南通集群特殊作业风险交底单</h1>
    <table class="fixed-word-table">
      <colgroup>
        <col style="width: 24mm">
        <col style="width: 58mm">
        <col style="width: 34mm">
        <col style="width: 44mm">
      </colgroup>
      <tr>
        <td colspan="2" class="half"><span class="inline-label">作业单位：</span><span class="inline-value">${escapeHtml(values.contractor)}</span></td>
        <td colspan="2" class="half"><span class="inline-label">作业人数：</span><span class="inline-value">${escapeHtml(constructionCount)}</span></td>
      </tr>
      <tr>
        <td colspan="2" class="half"><span class="inline-label">风险交底人：</span><span class="inline-value">${escapeHtml(values.disclosurePerson)}</span></td>
        <td colspan="2" class="half"><span class="inline-label">交底时间：</span><span class="inline-value">${escapeHtml(formatChineseDateTime(values.riskDisclosureTime))}</span></td>
      </tr>
      <tr>
        <td rowspan="5" class="vertical-title">
          <div class="vertical-title-inner">${verticalTitle}</div>
        </td>
        <td colspan="3" class="risk-field"><span class="risk-label">作业许可范围及作业环境：</span>${escapeHtml(values.riskWorkEnvironment)}</td>
      </tr>
      <tr>
        <td colspan="3" class="risk-field"><span class="risk-label">作业风险：</span>${escapeHtml(values.risks)}</td>
      </tr>
      <tr>
        <td colspan="3" class="risk-field tall"><span class="risk-label">防范措施（工艺、设备、个体防护等）：</span>${escapeHtml(values.controls)}</td>
      </tr>
      <tr>
        <td colspan="3" class="risk-field"><span class="risk-label">应急措施：</span>${escapeHtml(values.emergency)}</td>
      </tr>
      <tr>
        <td colspan="3" class="risk-field"><span class="risk-label">其他注意事项：</span>${escapeHtml(values.remarks)}</td>
      </tr>
      <tr>
        <td colspan="4" class="declaration">
          <div class="declaration-text">我方所有施工作业人员已明确知晓该作业项目的风险、危害、防范措施和其它注意事项。</div>
          <div class="handwriting-wrapper">${handwriting}</div>
          <div class="responsible-note">（作业方负责人手写上述内容）</div>
          <div class="accept-title">接受风险交底人签字：</div>
          <div class="accept-signatures">${peopleSignatures}</div>
          <div class="date-line">
            <span>${escapeHtml(disclosureDate.year)}</span>年
            <span>${escapeHtml(disclosureDate.month)}</span>月
            <span>${escapeHtml(disclosureDate.day)}</span>日
          </div>
        </td>
      </tr>
    </table>
  </main>
</body>
</html>`;
}

function renderTrainingSignInHtml(
  target: OnlineWorkFormTarget,
  draft: OnlineWorkFormDraft,
): string {
  const values = draft.values;
  const people = [...draft.people];
  const rows = Array.from({ length: 20 }, (_, index) => {
    const left = people[index];
    const right = people[index + 20];
    return `
      <tr>
        <td class="serial">${index + 1}</td>
        <td>${escapeHtml(left?.company || '')}</td>
        <td>${left ? renderPersonSignatureHtml(left.signature) : ''}</td>
        <td class="serial">${index + 21}</td>
        <td>${escapeHtml(right?.company || '')}</td>
        <td>${right ? renderPersonSignatureHtml(right.signature) : ''}</td>
      </tr>`;
  }).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(getOnlineWorkFormTitle(target))}</title>
  <style>
    body { margin: 0; background: #fff; color: #000; font-family: SimSun, "Microsoft YaHei", Arial, sans-serif; }
    .sheet { width: 488pt; margin: 18pt auto 0; background: #fff; padding: 0; }
    h1 { margin: 0 0 4pt; text-align: center; font-size: 16pt; font-weight: 700; letter-spacing: 0; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    td, th { border: 1pt solid #000; padding: 2pt 4pt; height: 22pt; vertical-align: middle; font-size: 10.5pt; line-height: 1.25; font-weight: 400; }
    th { text-align: center; font-weight: 700; }
    .label { width: 70pt; text-align: center; font-weight: 700; }
    .content { height: 50pt; vertical-align: top; white-space: pre-wrap; }
    .serial { width: 28pt; text-align: center; }
    .person-signature { display: block; max-width: 84pt; max-height: 20pt; object-fit: contain; margin: 0 auto; }
    @media print { body { background: #fff; } .sheet { margin: 0 auto; } }
  </style>
</head>
<body>
  <main class="sheet">
    <h1>培训签到表</h1>
    <table>
      <tr>
        <td class="label">课程名称</td>
        <td colspan="5">${escapeHtml(values.projectName || getOnlineWorkFormTitle(target))}</td>
      </tr>
      <tr>
        <td class="label">培训类别</td>
        <td colspan="2">${escapeHtml(values.trainingCategory || '线下')}</td>
        <td class="label">讲师</td>
        <td colspan="2">${escapeHtml(values.trainer)}</td>
      </tr>
      <tr>
        <td class="label">培训时间</td>
        <td colspan="2">${escapeHtml(formatDatetimeValue(values.startDate))}</td>
        <td class="label">培训地点</td>
        <td colspan="2">${escapeHtml(values.workLocation)}</td>
      </tr>
      <tr>
        <td class="label">主要内容</td>
        <td colspan="5" class="content">${escapeHtml(values.workContent)}</td>
      </tr>
      <tr>
        <th class="serial">序号</th>
        <th>单位</th>
        <th>签到</th>
        <th class="serial">序号</th>
        <th>单位</th>
        <th>签到</th>
      </tr>
      ${rows}
    </table>
  </main>
</body>
</html>`;
}

function renderWorkApplicationHtml(
  target: OnlineWorkFormTarget,
  draft: OnlineWorkFormDraft,
): string {
  const values = draft.values;
  const peopleBlock = renderWorkApplicationPeopleBlock(draft.people);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(getOnlineWorkFormTitle(target))}</title>
  <style>
    body { margin: 0; background: #f8fafc; color: #0f172a; font-family: "Microsoft YaHei", Arial, sans-serif; }
    .sheet { width: 980px; max-width: calc(100vw - 40px); margin: 24px auto; background: #fff; padding: 28px; box-shadow: 0 8px 30px rgba(15, 23, 42, .12); }
    h1 { margin: 0 0 14px; text-align: center; font-size: 24px; }
    .notice { border: 1px solid #d1d5db; padding: 10px 12px; margin-bottom: 14px; font-size: 13px; line-height: 1.8; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    td { border: 1px solid #000; padding: 7px 10px; min-height: 28px; vertical-align: top; font-size: 14px; line-height: 1.55; }
    .label { width: 145px; text-align: left; font-weight: 700; }
    .inline-cell { white-space: normal; }
    .full-line { white-space: normal; }
    .blank { display: inline; padding: 0 6px; font-weight: 400; line-height: 1.55; vertical-align: baseline; }
    .blank-short, .blank-wide, .blank-location { min-width: 0; }
    .people-freeform { min-height: 190px; padding-top: 8px; }
    .people-line { min-height: 25px; white-space: nowrap; }
    .people-field { display: inline-block; vertical-align: top; margin-right: 40px; }
    .people-name { width: 118px; }
    .people-id { width: 190px; }
    .people-cert { width: 220px; }
    .people-sign { width: 130px; margin-right: 0; }
    .people-line-empty { min-height: 25px; }
    .approval-cell { width: 33.33%; white-space: pre-wrap; vertical-align: middle; }
    .block { min-height: 120px; white-space: pre-wrap; }
    .material-block { min-height: 32px; white-space: pre-wrap; }
    .small { color: #475569; font-size: 12px; }
    .signature { max-width: 260px; max-height: 90px; object-fit: contain; }
    .person-signature { max-width: 110px; max-height: 28px; object-fit: contain; vertical-align: middle; }
    .footer { margin-top: 14px; text-align: center; color: #475569; font-size: 12px; line-height: 1.7; }
    @media print { body { background: #fff; } .sheet { width: auto; max-width: none; margin: 0; box-shadow: none; } }
  </style>
</head>
<body>
  <main class="sheet">
    <h1>南通集群作业申请单</h1>
    <div class="notice">
      <div>填写本表单时，请认真阅读以下信息：</div>
      <div>1、作业安全申请单适用于阿里IDC维修、维护、施工（含特殊作业），一切可能产生风险的现场操作；</div>
      <div>2、单张施工单对应一个施工项目，有效期最长15天；</div>
      <div>3、涉及特殊作业要办理对应的特殊作业许可证，有效期最长3天（临时用电有效期最长15天）；</div>
      <div>4、本申请单一式两份，一份交由施工方放置施工现场，一份交由阿里数据中心合作伙伴EHS工程师存档。</div>
    </div>
    <table>
      <colgroup>
        <col style="width:16.66%">
        <col style="width:16.66%">
        <col style="width:16.66%">
        <col style="width:16.66%">
        <col style="width:16.66%">
        <col style="width:16.7%">
      </colgroup>
      <tr><td class="label">作业项目</td><td colspan="5">${escapeHtml(values.projectName)}</td></tr>
      <tr><td class="label">作业日期</td><td colspan="5">${escapeHtml(formatChineseDateTime(values.startDate))} 至 ${escapeHtml(formatChineseDateTime(values.endDate))}</td></tr>
      <tr>
        <td colspan="6" class="full-line">作业单位：${renderInlineBlank(values.contractor, 'blank blank-wide')}</td>
      </tr>
      <tr>
        <td colspan="3" class="inline-cell">作业方负责人：${renderInlineBlank(values.workPartyLead, 'blank blank-wide')}</td>
        <td colspan="2" class="inline-cell">联系电话：${renderInlineBlank(values.workPartyPhone)}</td>
        <td class="inline-cell">施工人数：${renderInlineBlank(values.constructionCount, 'blank blank-short')}</td>
      </tr>
      <tr>
        <td colspan="3" class="inline-cell">现场示例人员019：${renderInlineBlank(values.siteResponsible, 'blank blank-wide')}</td>
        <td colspan="2" class="inline-cell">联系电话：${renderInlineBlank(values.siteResponsiblePhone)}</td>
        <td></td>
      </tr>
      <tr>
        <td colspan="6">
          <div>作业人员身份证号及资质证书（可另贴附件）：</div>
          <div class="people-freeform">${peopleBlock}</div>
        </td>
      </tr>
      <tr>
        <td colspan="6" class="full-line">作业地点：${renderInlineBlank(values.park, 'blank blank-short')}园区${renderInlineBlank(values.building, 'blank blank-short')}楼栋${renderInlineBlank(values.floor, 'blank blank-short')}楼层${renderInlineBlank(values.roomArea, 'blank blank-location')}房间或区域</td>
      </tr>
      <tr><td class="label">作业内容描述</td><td colspan="5" class="block">${escapeHtml(values.workContent)}</td></tr>
      <tr><td class="label">材料堆放点</td><td colspan="5" class="material-block">${escapeHtml(values.materialStackPoint)}</td></tr>
      <tr><td class="label">特殊作业</td><td colspan="5">${renderCheckboxMarks(values.specialWorks, ['临时用电作业', '有限空间作业', '高处作业', '动火作业', '消防系统关闭作业', '开挖动土作业', '吊装作业'])}<br><span class="small">注：如有则勾选</span></td></tr>
      <tr><td class="label">能源切断</td><td colspan="5">${renderCheckboxMarks(values.energyCuts, ['水', '电', '气'])}</td></tr>
      <tr><td class="label">停用设备</td><td colspan="2">${renderCheckboxMarks(values.equipmentDisabled, ['是', '否'])}</td><td class="label">停用设备</td><td colspan="2">${escapeHtml(values.disabledEquipment)}</td></tr>
      <tr>
        <td colspan="2" class="approval-cell" style="width:33.33%">作业现场负责人：${escapeHtml(values.siteOwner)}</td>
        <td colspan="2" class="approval-cell" style="width:33.33%">日期：${escapeHtml(values.siteOwnerDate)}</td>
        <td colspan="2" class="approval-cell" style="width:33.34%">意见：${escapeHtml(values.siteOwnerOpinion)}</td>
      </tr>
      <tr>
        <td colspan="2" class="approval-cell" style="width:33.33%">审核人：${escapeHtml(values.ehsReviewer)}</td>
        <td colspan="2" class="approval-cell" style="width:33.33%">日期：${escapeHtml(values.ehsReviewDate)}</td>
        <td colspan="2" class="approval-cell" style="width:33.34%">意见：${escapeHtml(values.ehsOpinion)}</td>
      </tr>
      <tr>
        <td colspan="2" class="approval-cell" style="width:33.33%">一级审批：${escapeHtml(values.levelOneApprover)}</td>
        <td colspan="2" class="approval-cell" style="width:33.33%">日期：${escapeHtml(values.levelOneDate)}</td>
        <td colspan="2" class="approval-cell" style="width:33.34%">意见：${escapeHtml(values.levelOneOpinion)}</td>
      </tr>
    </table>
    <div class="small" style="margin-top:10px;">说明：对于施工内容不涉及的角色，审批签字栏可留空。</div>
    <div class="footer">本文内容涉及阿里集团商业秘密，未经书面许可，不得以任何形式披露、传播或扩散。<br>ALIBABA CONFIDENTIAL</div>
  </main>
</body>
</html>`;
}

function renderKindRows(
  target: OnlineWorkFormTarget,
  values: Record<string, string>,
  measureRows: string,
): string {
  if (target.kind === 'workApplication') {
    return `
      <tr><td class="label">施工准备</td><td colspan="3" class="block">${escapeHtml(values.risks)}</td></tr>
      <tr><td class="label">安全措施</td><td colspan="3" class="block">${escapeHtml(values.controls)}</td></tr>
      <tr><td class="label">影响范围</td><td colspan="3" class="block">${escapeHtml(values.emergency)}</td></tr>`;
  }
  if (target.kind === 'riskDisclosure') {
    return `
      <tr><td class="label">风险点</td><td colspan="3" class="block">${escapeHtml(values.risks)}</td></tr>
      <tr><td class="label">控制措施</td><td colspan="3" class="block">${escapeHtml(values.controls)}</td></tr>
      <tr><td class="label">应急措施</td><td colspan="3" class="block">${escapeHtml(values.emergency)}</td></tr>`;
  }
  if (target.kind === 'trainingAssessment') {
    return `
      <tr><td class="label">考核主题</td><td>${escapeHtml(values.assessmentTopic)}</td><td class="label">考核结果</td><td>${escapeHtml(values.assessmentResult)}</td></tr>`;
  }
  if (target.kind === 'permit') {
    return `
      <tr><td class="label">安全措施</td><td colspan="3" class="measure">${measureRows}</td></tr>`;
  }
  return '';
}

function normalizeOnlineWorkFormPeopleForTarget(
  target: OnlineWorkFormTarget,
  _values: Record<string, string>,
  people: readonly OnlineWorkFormPerson[],
): OnlineWorkFormPerson[] {
  if (target.kind !== 'trainingSignIn') {
    return [...people];
  }
  return people.map((person) => ({ ...person }));
}

function getRiskDisclosureEligibleCrewMembers(
  workType: string,
  crewMembers: readonly OnlineWorkFormCrewMember[],
): OnlineWorkFormCrewMember[] {
  const keywords = getRiskDisclosureCertificateKeywords(workType);
  if (keywords.length === 0) {
    return [...crewMembers];
  }
  return crewMembers.filter((member) => {
    const certificateText = getCrewMemberCertificateText(member);
    return keywords.some((keyword) => certificateText.includes(keyword));
  });
}

function getRiskDisclosureCertificateRule(workType: string): string {
  const keywords = getRiskDisclosureCertificateKeywords(workType);
  if (keywords.length === 0) {
    return '未配置专门证书规则，可从同项目施工人员台账选择';
  }
  return `需包含 ${keywords.join(' / ')} 之一`;
}

function getRiskDisclosureCertificateKeywords(workType: string): string[] {
  if (workType.includes('临时用电')) {
    return ['高低压', '高压电工', '低压电工', '电工证', '电工'];
  }
  if (workType.includes('高处')) {
    return ['登高', '高处', '高空'];
  }
  if (workType.includes('动火')) {
    return ['焊接', '焊工', '切割'];
  }
  if (workType.includes('吊装')) {
    return ['起重', '吊装', '司索', '指挥'];
  }
  if (workType.includes('受限空间') || workType.includes('有限空间')) {
    return ['受限空间', '有限空间'];
  }
  if (workType.includes('开挖') || workType.includes('动土')) {
    return ['动土', '挖掘', '开挖'];
  }
  if (workType.includes('消防')) {
    return ['消防'];
  }
  return [];
}

function getCrewMemberCertificateText(
  member: OnlineWorkFormCrewMember,
): string {
  return [
    member.certificateSummary,
    member.complianceStatus,
    member.issueSummary,
    member.certificateNo,
  ]
    .filter(Boolean)
    .join('、');
}

function getOnlineWorkFormTitle(target: OnlineWorkFormTarget): string {
  if (target.kind === 'workApplication') {
    return '南通集群作业申请单';
  }
  if (target.kind === 'permit') {
    const permitTitleMap: Record<string, string> = {
      受限空间作业: '有限空间安全作业票',
      临时用电作业: '临时用电安全作业票',
      动火作业: '动火安全作业票',
      高处作业: '高处安全作业票',
      开挖动土作业: '开挖动土安全作业票',
      吊装作业: '吊装安全作业票',
      消防系统关闭作业: '消防系统关闭作业票',
    };
    return permitTitleMap[target.workType] || target.label;
  }
  return target.label;
}

function getWorkContentLabel(kind: OnlineWorkFormKind): string {
  if (kind === 'trainingSignIn') {
    return '培训内容';
  }
  if (kind === 'trainingAssessment') {
    return '考核内容';
  }
  return '作业内容';
}

function getPrimarySignerLabel(kind: OnlineWorkFormKind): string {
  if (kind === 'workApplication') {
    return '申请人';
  }
  if (kind === 'trainingSignIn') {
    return '培训人';
  }
  if (kind === 'riskDisclosure') {
    return '交底人';
  }
  return '审批人';
}

function getPrimarySignerValue(
  kind: OnlineWorkFormKind,
  values: Record<string, string>,
): string {
  if (kind === 'trainingSignIn') {
    return values.trainer;
  }
  if (kind === 'riskDisclosure') {
    return values.disclosurePerson;
  }
  return values.approver;
}

function createOnlineWorkFormFileName(target: OnlineWorkFormTarget): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${date}-${sanitizeFileName(target.workType)}-${sanitizeFileName(target.label)}.doc`;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '').trim() || '施工表单';
}

function formatDatetimeValue(value: string): string {
  return value ? value.replace('T', ' ') : '';
}

function formatChineseDateTime(value: string): string {
  if (!value) {
    return '';
  }
  const normalized = value.replace('T', ' ');
  const match = normalized.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):?(\d{0,2})/,
  );
  if (!match) {
    return normalized;
  }
  const [, year, month, day, hour, minute] = match;
  return `${year}年${month}月${day}日${hour}时${minute || '00'}分`;
}

function getNowDatetimeLocalValue(): string {
  return formatDateToDatetimeLocal(new Date());
}

function clampDatetimeLocalToNow(value: string): string {
  if (!value) {
    return '';
  }
  const now = getNowDatetimeLocalValue();
  return value > now ? now : value;
}

function formatDateToDatetimeLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function getChineseDateParts(value?: string): {
  year: string;
  month: string;
  day: string;
} {
  if (!value) {
    return { year: '', month: '', day: '' };
  }
  const normalized = value.replace('T', ' ');
  const match = normalized.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (match) {
    return { year: match[1], month: match[2], day: match[3] };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { year: '', month: '', day: '' };
  }
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1),
    day: String(date.getDate()),
  };
}

function formatGeneratedTime(value?: string): string {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString('zh-CN', { hour12: false });
}

function splitListValue(value: string): string[] {
  return String(value || '')
    .split(/[、,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderCheckboxMarks(value: string, options: string[]): string {
  const selected = new Set(splitListValue(value));
  return options
    .map((option) => `${selected.has(option) ? '☑' : '□'}${escapeHtml(option)}`)
    .join('&nbsp;&nbsp;&nbsp;');
}

function renderWorkApplicationPeopleBlock(
  people: readonly OnlineWorkFormPerson[],
): string {
  const lines = people
    .map((person, index) => {
      const signature = person.signature
        ? `<span class="people-field people-sign">签字：${renderPersonSignatureHtml(person.signature)}</span>`
        : '';
      return `<div class="people-line"><span class="people-field people-name">${index + 1}. ${escapeHtml(person.name)}</span><span class="people-field people-id">${escapeHtml(person.idCard)}</span><span class="people-field people-cert">${escapeHtml(person.role)}</span>${signature}</div>`;
    })
    .join('');
  const emptyLineCount = Math.max(0, 7 - people.length);
  const emptyLines = Array.from(
    { length: emptyLineCount },
    () => '<div class="people-line-empty">&nbsp;</div>',
  ).join('');
  return `${lines}${emptyLines}`;
}

function renderInlineBlank(value: string, className = 'blank'): string {
  return `<span class="${className}">${escapeHtml(value) || '&nbsp;'}</span>`;
}

function renderPersonSignatureHtml(value: string, fallback = ''): string {
  const signature = String(value || '').trim();
  if (isSignatureImage(signature)) {
    return `<img src="${signature}" alt="签名" class="person-signature" />`;
  }
  return escapeHtml(signature || fallback);
}

function isSignatureImage(value: string): boolean {
  return /^data:image\//i.test(String(value || '').trim());
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getCanvasPoint(
  canvas: HTMLCanvasElement,
  event: React.PointerEvent<HTMLCanvasElement>,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

export default OnlineWorkFormDialog;
