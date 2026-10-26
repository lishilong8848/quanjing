import { EquipmentRepairSourceService } from '../../server/modules/equipment-lifecycle/equipment-repair-source.service';
import {
  fetchEquipmentRepairRecords,
  readPersistedRepairSnapshot,
} from '../../server/modules/equipment-lifecycle/equipment-repair-source.reader';
jest.mock(
  '../../server/modules/equipment-lifecycle/equipment-repair-source.reader',
  () => ({
    fetchEquipmentRepairRecords: jest.fn(),
    readPersistedRepairSnapshot: jest.fn(),
    persistRepairSnapshot: jest.fn(),
  }),
);
const fetchRows = jest.mocked(fetchEquipmentRepairRecords);
const persisted = jest.mocked(readPersistedRepairSnapshot);
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
describe('repair read state and recovery', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    persisted.mockResolvedValue(null);
  });
  it('returns cold loading without waiting and collapses simultaneous reads', async () => {
    let complete!: (value: []) => void;
    fetchRows.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const source = new EquipmentRepairSourceService({} as never);
    const states = await Promise.all([
      source.getState(),
      source.getState(),
      source.getState(),
    ]);
    expect(states.every((s) => !s.snapshot && s.refreshing)).toBe(true);
    expect(fetchRows).toHaveBeenCalledTimes(1);
    complete([]);
    await settle();
    expect((await source.getState()).snapshot?.records).toEqual([]);
  });
  it('ends errors, backs off, and retries explicitly', async () => {
    fetchRows.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);
    const source = new EquipmentRepairSourceService({} as never);
    await source.getState();
    await settle();
    const failed = await source.getState();
    expect(failed.refreshing).toBe(false);
    expect(failed.error).toBeTruthy();
    expect(fetchRows).toHaveBeenCalledTimes(1);
    await source.getState(true);
    await settle();
    expect((await source.getState()).error).toBe('');
  });
  it('keeps a persisted snapshot visible on a failed refresh, marked stale', async () => {
    persisted.mockResolvedValue({
      records: [{ record_id: 'r', fields: { 台账关联状态: '已关联' } }],
      fetchedAt: Date.now() - 5 * 3600000,
    } as never);
    fetchRows.mockRejectedValue(new Error('offline'));
    const source = new EquipmentRepairSourceService({} as never);
    const warm = await source.getState();
    expect(warm.snapshot?.records).toHaveLength(1);
    await settle();
    const state = await source.getState();
    expect(state.stale).toBe(true);
    expect(state.error).toBeTruthy();
    expect(state.refreshing).toBe(false);
  });
});
