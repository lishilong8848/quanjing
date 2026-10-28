const mockSlots: { value: any }[] = [];
let mockCursor = 0;
jest.mock('react', () => ({
  useState: (initial: any) => { const index = mockCursor++; mockSlots[index] ||= { value: typeof initial === 'function' ? initial() : initial }; return [mockSlots[index].value, (next: any) => { mockSlots[index].value = typeof next === 'function' ? next(mockSlots[index].value) : next; }]; },
  useRef: (initial: any) => { const index = mockCursor++; mockSlots[index] ||= { value: { current: initial } }; return mockSlots[index].value; },
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
}));
jest.mock('../../client/src/pages/SystemConfiguration/api', () => ({ loadConfiguration: jest.fn(), loadConfigurationPeople: jest.fn() }));
import { useConfiguration } from '../../client/src/pages/SystemConfiguration/model';
import { loadConfiguration, loadConfigurationPeople } from '../../client/src/pages/SystemConfiguration/api';

const render = () => { mockCursor = 0; return useConfiguration(); };
const configuration = { revision: 1, appId: 'synthetic-app', accounts: [], cardRules: [], audit: [] };
const directory = { appId: 'synthetic-app', people: [{ openId: 'ou_synthetic', name: '合成人员' }], accounts: [], snapshotAt: 1 };
describe('configuration people refresh coordination', () => {
  beforeEach(() => { mockSlots.length = 0; jest.clearAllMocks(); });
  it('joins concurrent refresh calls and publishes one successful result', async () => {
    let resolve!: (value: typeof directory) => void;
    (loadConfigurationPeople as jest.Mock).mockReturnValue(new Promise(done => { resolve = done; }));
    const state = render(), first = state.refreshPeople(), second = state.refreshPeople();
    expect(first).toBe(second); expect(loadConfigurationPeople).toHaveBeenCalledTimes(1);
    resolve(directory); await first;
    expect(render().people).toEqual(directory.people); expect(render().peopleLoading).toBe(false);
  });
  it('keeps successful configuration and people after a later read failure', async () => {
    (loadConfiguration as jest.Mock).mockResolvedValue(configuration);
    (loadConfigurationPeople as jest.Mock).mockResolvedValueOnce(directory).mockRejectedValueOnce(new Error('synthetic timeout'));
    const state = render(); await state.refresh(); await state.refreshPeople(); await render().refreshPeople();
    const current = render(); expect(current.data).toEqual(configuration); expect(current.people).toEqual(directory.people);
    expect(current.peopleError).toBe('synthetic timeout'); expect(current.peopleLoading).toBe(false);
  });
});
