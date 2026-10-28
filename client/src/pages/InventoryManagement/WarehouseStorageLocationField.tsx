import { useEffect, useId, useRef, useState } from 'react';
import { useAccess } from '@/access/AccessProvider';
import { businessBuildingsForAction } from '@shared/business-permissions';
import { Check, ChevronDown, Loader2, MapPinPlus, Search } from 'lucide-react';

import {
  createWarehouseStorageLocation,
  getWarehouseStorageLocations,
} from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type {
  WarehouseBuilding,
  WarehouseStorageLocation,
  WarehouseStorageLocationCategory,
  WarehouseStorageLocationCreateRequest,
} from '@shared/inventory-management.interface';

export interface WarehouseStorageLocationFieldProps {
  building: WarehouseBuilding;
  value: string;
  recordId?: string;
  disabled?: boolean;
  error?: string;
  onChange(item: WarehouseStorageLocation | null): void;
  onCreatingChange?(creating: boolean): void;
}

export interface StorageLocationCreateDraft {
  name: string;
  category: WarehouseStorageLocationCategory;
  clientMutationId?: string;
  error: string;
}

interface PreparedStorageLocationCreate {
  request: WarehouseStorageLocationCreateRequest;
  draft: StorageLocationCreateDraft;
}

export function createStorageLocationCreateDraft(): StorageLocationCreateDraft {
  return {
    name: '',
    category: '库内',
    clientMutationId: undefined,
    error: '',
  };
}

export function resetStorageLocationCreateDraft(): StorageLocationCreateDraft {
  return createStorageLocationCreateDraft();
}

export function changeStorageLocationCreateDraft(
  draft: StorageLocationCreateDraft,
  patch: Partial<Pick<StorageLocationCreateDraft, 'name' | 'category'>>,
): StorageLocationCreateDraft {
  const payloadChanged =
    (patch.name !== undefined && patch.name !== draft.name) ||
    (patch.category !== undefined && patch.category !== draft.category);
  return {
    ...draft,
    ...patch,
    ...(payloadChanged ? { clientMutationId: undefined, error: '' } : {}),
  };
}

export function prepareStorageLocationCreate({
  building,
  draft,
  creating,
  createClientMutationId,
}: {
  building: WarehouseBuilding;
  draft: StorageLocationCreateDraft;
  creating: boolean;
  createClientMutationId: () => string;
}): PreparedStorageLocationCreate | null {
  if (creating) return null;
  const name = normalizeLocationName(draft.name);
  if (!name) throw new Error('请填写存放位置名称');
  const clientMutationId =
    draft.clientMutationId?.trim() || createClientMutationId().trim();
  if (!clientMutationId) throw new Error('缺少客户端变更编号');
  return {
    request: {
      building,
      category: draft.category,
      name,
      clientMutationId,
    },
    draft: {
      ...draft,
      clientMutationId,
      error: '',
    },
  };
}

export function failStorageLocationCreate(
  draft: StorageLocationCreateDraft,
  error: string,
): StorageLocationCreateDraft {
  return { ...draft, error };
}

export function isLatestStorageLocationSearch(
  currentSequence: number,
  responseSequence: number,
): boolean {
  return currentSequence === responseSequence;
}

export function canApplyStorageLocationCreateResponse({
  currentCreateSequence,
  responseCreateSequence,
  currentBuilding,
  responseBuilding,
  currentSelectionSequence,
  startedSelectionSequence,
}: {
  currentCreateSequence: number;
  responseCreateSequence: number;
  currentBuilding: WarehouseBuilding;
  responseBuilding: WarehouseBuilding;
  currentSelectionSequence: number;
  startedSelectionSequence: number;
}): boolean {
  return (
    currentCreateSequence === responseCreateSequence &&
    currentBuilding === responseBuilding &&
    currentSelectionSequence === startedSelectionSequence
  );
}

export function WarehouseStorageLocationField({
  building,
  value,
  recordId,
  disabled = false,
  error,
  onChange,
  onCreatingChange,
}: WarehouseStorageLocationFieldProps) {
  const principal = useAccess();
  const canCreate = !principal.effectiveAuthorization || businessBuildingsForAction(principal, { module: 'inventory', action: 'create' }).includes(building as never);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<WarehouseStorageLocation[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState(
    createStorageLocationCreateDraft,
  );
  const [creating, setCreating] = useState(false);
  const createPanelId = useId();
  const searchSequenceRef = useRef(0);
  const createSequenceRef = useRef(0);
  const selectionSequenceRef = useRef(0);
  const createInFlightRef = useRef(false);
  const activeBuildingRef = useRef(building);
  const activeDisabledRef = useRef(disabled);
  activeBuildingRef.current = building;
  activeDisabledRef.current = disabled;

  useEffect(() => {
    searchSequenceRef.current += 1;
    createSequenceRef.current += 1;
    selectionSequenceRef.current += 1;
    createInFlightRef.current = false;
    setOpen(false);
    setQuery('');
    setOptions([]);
    setLoading(false);
    setSearchError('');
    setCreateOpen(false);
    setCreateDraft(resetStorageLocationCreateDraft());
    setCreating(false);
    onCreatingChange?.(false);
  }, [building, onCreatingChange]);

  useEffect(() => {
    if (!disabled) return;
    searchSequenceRef.current += 1;
    createSequenceRef.current += 1;
    createInFlightRef.current = false;
    setOpen(false);
    setCreateOpen(false);
    setLoading(false);
    setCreating(false);
    onCreatingChange?.(false);
  }, [disabled, onCreatingChange]);

  useEffect(
    () => () => {
      searchSequenceRef.current += 1;
      createSequenceRef.current += 1;
      selectionSequenceRef.current += 1;
      createInFlightRef.current = false;
      onCreatingChange?.(false);
    },
    [onCreatingChange],
  );

  useEffect(() => {
    if (!open || disabled) {
      searchSequenceRef.current += 1;
      setLoading(false);
      return;
    }

    const sequence = searchSequenceRef.current + 1;
    searchSequenceRef.current = sequence;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setSearchError('');
      try {
        const result = await getWarehouseStorageLocations({
          building,
          query: query.trim(),
          limit: 50,
        });
        if (
          isLatestStorageLocationSearch(searchSequenceRef.current, sequence) &&
          activeBuildingRef.current === building &&
          !activeDisabledRef.current
        ) {
          setOptions(result.filter((item) => item.building === building));
        }
      } catch (requestError) {
        if (
          isLatestStorageLocationSearch(searchSequenceRef.current, sequence) &&
          activeBuildingRef.current === building &&
          !activeDisabledRef.current
        ) {
          setSearchError(
            errorMessage(requestError, '存放位置加载失败，请稍后重试'),
          );
        }
      } finally {
        if (
          isLatestStorageLocationSearch(searchSequenceRef.current, sequence) &&
          activeBuildingRef.current === building &&
          !activeDisabledRef.current
        ) {
          setLoading(false);
        }
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [building, disabled, open, query]);

  function changeOpen(nextOpen: boolean) {
    if (creating && nextOpen) return;
    setOpen(nextOpen);
    if (!nextOpen) {
      searchSequenceRef.current += 1;
      setLoading(false);
      setSearchError('');
    }
  }

  function selectLocation(item: WarehouseStorageLocation) {
    if (disabled || creating) return;
    selectionSequenceRef.current += 1;
    onChange(item);
    setQuery(item.name);
    setSearchError('');
    changeOpen(false);
  }

  function changeQuery(nextQuery: string) {
    searchSequenceRef.current += 1;
    setQuery(nextQuery);
    setLoading(false);
    setSearchError('');
  }

  function openCreatePanel() {
    if (!canCreate || disabled || creating) return;
    setCreateOpen(true);
    setCreateDraft((current) =>
      current.name.trim() || !query.trim()
        ? current
        : changeStorageLocationCreateDraft(current, { name: query.trim() }),
    );
  }

  function closeCreatePanel() {
    if (creating) return;
    setCreateOpen(false);
    setCreateDraft(resetStorageLocationCreateDraft());
  }

  async function createLocation() {
    if (!canCreate || createInFlightRef.current) return;

    let prepared: PreparedStorageLocationCreate | null;
    try {
      prepared = prepareStorageLocationCreate({
        building,
        draft: createDraft,
        creating,
        createClientMutationId,
      });
    } catch (validationError) {
      setCreateDraft((current) =>
        failStorageLocationCreate(
          current,
          errorMessage(validationError, '请检查新增位置信息'),
        ),
      );
      return;
    }
    if (!prepared) return;

    createInFlightRef.current = true;
    const sequence = createSequenceRef.current + 1;
    createSequenceRef.current = sequence;
    const startedSelectionSequence = selectionSequenceRef.current;
    changeOpen(false);
    setCreateDraft(prepared.draft);
    setCreating(true);
    onCreatingChange?.(true);
    try {
      const response = await createWarehouseStorageLocation(prepared.request);
      if (
        !canApplyStorageLocationCreateResponse({
          currentCreateSequence: createSequenceRef.current,
          responseCreateSequence: sequence,
          currentBuilding: activeBuildingRef.current,
          responseBuilding: prepared.request.building,
          currentSelectionSequence: selectionSequenceRef.current,
          startedSelectionSequence,
        }) ||
        activeDisabledRef.current
      ) {
        return;
      }
      if (response.clientMutationId !== prepared.request.clientMutationId) {
        throw new Error('新增位置响应编号不一致，请使用原内容重试');
      }
      if (response.item.building !== prepared.request.building) {
        throw new Error('新增位置楼栋不一致，请使用原内容重试');
      }
      setOptions((current) => [
        response.item,
        ...current.filter((item) => item.recordId !== response.item.recordId),
      ]);
      onChange(response.item);
      setQuery(response.item.name);
      setCreateOpen(false);
      setCreateDraft(resetStorageLocationCreateDraft());
      changeOpen(false);
    } catch (requestError) {
      if (createSequenceRef.current === sequence) {
        setCreateDraft(
          failStorageLocationCreate(
            prepared.draft,
            errorMessage(
              requestError,
              '新增位置同步失败，当前内容已保留，请重试',
            ),
          ),
        );
      }
    } finally {
      if (createSequenceRef.current === sequence) {
        createInFlightRef.current = false;
        setCreating(false);
        onCreatingChange?.(false);
      }
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <Label className="text-xs font-semibold text-slate-600">
          存放位置<span className="ml-1 text-rose-500">*</span>
        </Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 border-slate-200 bg-slate-100 px-2 text-xs text-slate-600 hover:bg-slate-200"
          aria-controls={createPanelId}
          aria-expanded={createOpen}
          disabled={disabled || creating || !canCreate}
          onClick={openCreatePanel}
        >
          <MapPinPlus className="h-3.5 w-3.5" />
          新增位置
        </Button>
      </div>

      <Popover open={open} onOpenChange={changeOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-label="选择存放位置"
            aria-expanded={open}
            data-selected-record-id={recordId || undefined}
            disabled={disabled || creating}
            className="w-full justify-between border-slate-200 bg-white px-3 font-normal text-slate-700"
          >
            <span className={value ? 'truncate' : 'truncate text-slate-400'}>
              {value || '搜索并选择存放位置'}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)] p-2"
        >
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              autoFocus
              aria-label="搜索存放位置"
              value={query}
              className="pl-9 pr-9"
              placeholder={`搜索${building}存放位置`}
              onChange={(event) => changeQuery(event.target.value)}
            />
            {loading && (
              <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-blue-500" />
            )}
          </div>
          <div
            role="listbox"
            aria-label={`${building}存放位置`}
            className="mt-2 max-h-56 space-y-1 overflow-y-auto"
          >
            {options.map((item) => (
              <button
                key={item.recordId}
                type="button"
                role="option"
                aria-selected={recordId === item.recordId}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                onClick={() => selectLocation(item)}
              >
                <span className="min-w-0 flex-1">
                  <strong className="block truncate font-medium">
                    {item.name}
                  </strong>
                  <span className="block text-[11px] text-slate-400">
                    {item.category} · {item.building}
                  </span>
                </span>
                {recordId === item.recordId && (
                  <Check className="h-4 w-4 shrink-0 text-blue-600" />
                )}
              </button>
            ))}
            {!loading && !searchError && options.length === 0 && (
              <p className="px-3 py-5 text-center text-xs text-slate-400">
                当前楼栋没有匹配位置，可点击“新增位置”补录
              </p>
            )}
          </div>
          {searchError && (
            <p className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-600">
              {searchError}
              {options.length > 0 && '，当前展示上次成功结果'}
            </p>
          )}
        </PopoverContent>
      </Popover>

      {error && <p className="text-xs text-rose-600">{error}</p>}

      {createOpen && (
        <div
          id={createPanelId}
          aria-live="polite"
          className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <strong className="text-xs font-semibold text-slate-700">
              新增存放位置
            </strong>
            <span className="text-[11px] text-slate-400">
              所属公司：南通承宏
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="mb-1.5 text-[11px] text-slate-500">楼栋</Label>
              <Input value={building} disabled aria-label="新增位置楼栋" />
            </div>
            <div>
              <Label className="mb-1.5 text-[11px] text-slate-500">
                位置分类
              </Label>
              <NativeSelect
                className="w-full"
                aria-label="存放位置分类"
                value={createDraft.category}
                disabled={creating}
                onChange={(event) =>
                  setCreateDraft((current) =>
                    changeStorageLocationCreateDraft(current, {
                      category: event.target
                        .value as WarehouseStorageLocationCategory,
                    }),
                  )
                }
              >
                <NativeSelectOption value="库内">库内</NativeSelectOption>
                <NativeSelectOption value="库外">库外</NativeSelectOption>
              </NativeSelect>
            </div>
          </div>
          <div>
            <Label className="mb-1.5 text-[11px] text-slate-500">
              存放位置名称
            </Label>
            <Input
              aria-label="新增存放位置名称"
              value={createDraft.name}
              disabled={creating}
              maxLength={120}
              placeholder="例如：D-1F-101"
              onChange={(event) =>
                setCreateDraft((current) =>
                  changeStorageLocationCreateDraft(current, {
                    name: event.target.value,
                  }),
                )
              }
            />
          </div>
          {createDraft.error && (
            <p className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-600">
              {createDraft.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={creating}
              onClick={closeCreatePanel}
            >
              取消新增
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canCreate || creating || !createDraft.name.trim()}
              onClick={createLocation}
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              {creating ? '同步中' : '保存并选中'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function normalizeLocationName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function createClientMutationId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `storage-location-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown, fallback: string): string {
  const response =
    error && typeof error === 'object'
      ? (error as { response?: { data?: { message?: string } } }).response
      : undefined;
  return (
    response?.data?.message ||
    (error instanceof Error ? error.message : fallback)
  );
}
