type SessionCommitCoordinatorModule = {
  createSessionCommitCoordinator?: () => SessionCommitCoordinator;
  isConfirmedLoginSession?: (
    submitted: LoginSessionSnapshot,
    confirmed: LoginSessionSnapshot,
  ) => boolean;
};

type LoginSessionSnapshot = {
  role: string;
  purchaseBuilding: string | null;
  principalFingerprint: string | null;
};

type SessionCommitCoordinator = {
  captureRefresh(): number;
  beginMutation(): number;
  commitMutation(token: number): number | null;
  canCommit(token: number): boolean;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((settle) => {
      resolve = settle;
    }),
    resolve,
  };
}

function requireCoordinator(): SessionCommitCoordinator {
  const coordinator =
    loadCoordinatorModule().createSessionCommitCoordinator?.();
  if (!coordinator)
    throw new Error('session commit coordinator is unavailable');
  return coordinator;
}

async function applyRefresh(
  coordinator: SessionCommitCoordinator,
  state: { value: string },
  pendingSession: Promise<string>,
): Promise<void> {
  const refreshToken = coordinator.captureRefresh();
  const nextSession = await pendingSession;
  if (coordinator.canCommit(refreshToken)) state.value = nextSession;
}

async function applyMutation(
  coordinator: SessionCommitCoordinator,
  state: { value: string },
  pendingSession: Promise<string>,
): Promise<void> {
  const mutationToken = coordinator.beginMutation();
  const nextSession = await pendingSession;
  const committedToken = coordinator.commitMutation(mutationToken);
  if (committedToken !== null && coordinator.canCommit(committedToken)) {
    state.value = nextSession;
  }
}

const MUTATION_CASES = [
  {
    label: 'login',
    initialSession: 'guest',
    committedSession: 'admin',
    staleRefreshSession: 'guest',
  },
  {
    label: 'logout',
    initialSession: 'admin',
    committedSession: 'guest',
    staleRefreshSession: 'admin',
  },
] as const;

function loadCoordinatorModule(): SessionCommitCoordinatorModule {
  try {
    return require('../../client/src/access/session-commit-coordinator') as SessionCommitCoordinatorModule;
  } catch {
    return {};
  }
}

describe('unified access session commit coordinator', () => {
  it('provides a coordinator for refresh and session mutation commits', () => {
    expect(loadCoordinatorModule().createSessionCommitCoordinator).toEqual(
      expect.any(Function),
    );
  });

  it('exposes refresh snapshots and mutation commit tokens', () => {
    const coordinator =
      loadCoordinatorModule().createSessionCommitCoordinator?.();

    expect(coordinator).toEqual(
      expect.objectContaining({
        captureRefresh: expect.any(Function),
        beginMutation: expect.any(Function),
        commitMutation: expect.any(Function),
        canCommit: expect.any(Function),
      }),
    );
  });

  it.each(MUTATION_CASES)(
    'does not let a refresh captured before $label overwrite its committed session',
    async ({ initialSession, committedSession, staleRefreshSession }) => {
      const coordinator = requireCoordinator();
      const state = { value: initialSession };
      const refreshDeferred = createDeferred<string>();
      const mutationDeferred = createDeferred<string>();
      const refreshResult = applyRefresh(
        coordinator,
        state,
        refreshDeferred.promise,
      );
      const mutationResult = applyMutation(
        coordinator,
        state,
        mutationDeferred.promise,
      );

      mutationDeferred.resolve(committedSession);
      await mutationResult;
      expect(state.value).toBe(committedSession);

      refreshDeferred.resolve(staleRefreshSession);
      await refreshResult;
      expect(state.value).toBe(committedSession);
    },
  );

  it.each(MUTATION_CASES)(
    'does not let a refresh started during $label overwrite its committed session',
    async ({ initialSession, committedSession, staleRefreshSession }) => {
      const coordinator = requireCoordinator();
      const state = { value: initialSession };
      const refreshDeferred = createDeferred<string>();
      const mutationDeferred = createDeferred<string>();
      const mutationResult = applyMutation(
        coordinator,
        state,
        mutationDeferred.promise,
      );
      const refreshResult = applyRefresh(
        coordinator,
        state,
        refreshDeferred.promise,
      );

      mutationDeferred.resolve(committedSession);
      await mutationResult;
      expect(state.value).toBe(committedSession);

      refreshDeferred.resolve(staleRefreshSession);
      await refreshResult;
      expect(state.value).toBe(committedSession);
    },
  );

  it('only confirms a login after the server session has the same principal', () => {
    const confirmation = loadCoordinatorModule().isConfirmedLoginSession;

    expect(confirmation).toEqual(expect.any(Function));
    expect(
      confirmation!(
        {
          role: 'purchase_applicant',
          purchaseBuilding: 'E楼',
          principalFingerprint: 'purchase-e',
        },
        {
          role: 'purchase_applicant',
          purchaseBuilding: 'E楼',
          principalFingerprint: 'purchase-e',
        },
      ),
    ).toBe(true);
  });

  it.each([
    {
      label: 'the server still reports guest',
      confirmed: {
        role: 'guest',
        purchaseBuilding: null,
        principalFingerprint: null,
      },
    },
    {
      label: 'the role differs',
      confirmed: {
        role: 'purchase_admin',
        purchaseBuilding: null,
        principalFingerprint: 'purchase-e',
      },
    },
    {
      label: 'the purchase building differs',
      confirmed: {
        role: 'purchase_applicant',
        purchaseBuilding: 'A楼',
        principalFingerprint: 'purchase-e',
      },
    },
    {
      label: 'the principal fingerprint differs',
      confirmed: {
        role: 'purchase_applicant',
        purchaseBuilding: 'E楼',
        principalFingerprint: 'purchase-a',
      },
    },
  ])('does not confirm a login when $label', ({ confirmed }) => {
    const confirmation = loadCoordinatorModule().isConfirmedLoginSession;
    const submitted = {
      role: 'purchase_applicant',
      purchaseBuilding: 'E楼',
      principalFingerprint: 'purchase-e',
    };

    expect(confirmation).toEqual(expect.any(Function));
    expect(confirmation!(submitted, confirmed)).toBe(false);
  });
});
