export interface ConstructionOptimisticLayer<T> {
  key: string;
  apply(value: T): T;
  matches(value: T): boolean;
}

export interface ConstructionMutationCoordinator<T> {
  begin(layer: ConstructionOptimisticLayer<T>): boolean;
  finish(key: string): void;
  has(key: string): boolean;
  applyPending(value: T): T;
  reconcile(value: T): { value: T; confirmedKeys: string[] };
  enqueue<R>(scopeKey: string, operation: () => Promise<R>): Promise<R>;
}

export function createConstructionMutationCoordinator<T>():
  ConstructionMutationCoordinator<T> {
  const layers = new Map<string, ConstructionOptimisticLayer<T>>();
  const tails = new Map<string, Promise<unknown>>();

  const applyLayers = (value: T): T =>
    [...layers.values()].reduce(
      (current, layer) => layer.apply(current),
      value,
    );

  return {
    begin(layer) {
      if (layers.has(layer.key)) return false;
      layers.set(layer.key, layer);
      return true;
    },
    finish(key) {
      layers.delete(key);
    },
    has(key) {
      return layers.has(key);
    },
    applyPending(value) {
      return applyLayers(value);
    },
    reconcile(value) {
      const confirmedKeys: string[] = [];
      layers.forEach((layer, key) => {
        if (layer.matches(value)) confirmedKeys.push(key);
      });
      confirmedKeys.forEach((key) => layers.delete(key));
      return {
        value: applyLayers(value),
        confirmedKeys,
      };
    },
    enqueue(scopeKey, operation) {
      const previous = tails.get(scopeKey);
      const current = previous
        ? previous.catch(() => undefined).then(operation)
        : Promise.resolve().then(operation);

      tails.set(scopeKey, current);
      void current.then(
        () => {
          if (tails.get(scopeKey) === current) tails.delete(scopeKey);
        },
        () => {
          if (tails.get(scopeKey) === current) tails.delete(scopeKey);
        },
      );

      return current;
    },
  };
}

export interface ConstructionRecordAliasRegistry {
  remember(scopeKey: string, recordId: string | null | undefined): void;
  resolve(
    scopeKey: string,
    candidateRecordId: string | null | undefined,
  ): string | null;
  clear(scopeKey?: string): void;
}

function normalizeRealConstructionRecordId(
  recordId: string | null | undefined,
): string | null {
  const normalized = recordId?.trim() || '';
  return normalized && !normalized.startsWith('optimistic:')
    ? normalized
    : null;
}

export function createConstructionRecordAliasRegistry():
  ConstructionRecordAliasRegistry {
  const aliases = new Map<string, string>();

  return {
    remember(scopeKey, recordId) {
      const normalizedScopeKey = scopeKey.trim();
      const normalizedRecordId =
        normalizeRealConstructionRecordId(recordId);
      if (normalizedScopeKey && normalizedRecordId) {
        aliases.set(normalizedScopeKey, normalizedRecordId);
      }
    },
    resolve(scopeKey, candidateRecordId) {
      const normalizedScopeKey = scopeKey.trim();
      const normalizedCandidate =
        normalizeRealConstructionRecordId(candidateRecordId);
      if (normalizedCandidate) {
        if (normalizedScopeKey) {
          aliases.set(normalizedScopeKey, normalizedCandidate);
        }
        return normalizedCandidate;
      }
      return normalizedScopeKey
        ? aliases.get(normalizedScopeKey) || null
        : null;
    },
    clear(scopeKey) {
      if (scopeKey === undefined) {
        aliases.clear();
        return;
      }
      const normalizedScopeKey = scopeKey.trim();
      if (normalizedScopeKey) {
        aliases.delete(normalizedScopeKey);
      }
    },
  };
}

export interface LatestConstructionRequestHandlers<T> {
  onSuccess(value: T): void;
  onError(error: unknown): void;
  onSettled(): void;
}

export function createLatestConstructionRequestCoordinator() {
  let generation = 0;

  return {
    async run<T>(
      request: PromiseLike<T>,
      handlers: LatestConstructionRequestHandlers<T>,
    ): Promise<void> {
      const current = ++generation;
      let value: T;
      try {
        value = await request;
      } catch (error) {
        if (current !== generation) return;
        try {
          handlers.onError(error);
        } finally {
          if (current === generation) handlers.onSettled();
        }
        return;
      }

      if (current !== generation) return;
      try {
        handlers.onSuccess(value);
      } finally {
        if (current === generation) handlers.onSettled();
      }
    },
    invalidate() {
      generation += 1;
    },
  };
}
