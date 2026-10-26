export interface LatestRequestHandlers<T> {
  onSuccess(value: T): void;
  onError(error: unknown): void;
  onSettled(): void;
}

export interface LatestRequestCoordinator {
  run<T>(
    request: PromiseLike<T>,
    handlers: LatestRequestHandlers<T>,
  ): Promise<void>;
  invalidate(): void;
}

export function createLatestRequestCoordinator(): LatestRequestCoordinator {
  let generation = 0;

  return {
    async run<T>(
      request: PromiseLike<T>,
      handlers: LatestRequestHandlers<T>,
    ): Promise<void> {
      const requestGeneration = ++generation;
      try {
        const value = await request;
        if (requestGeneration === generation) {
          handlers.onSuccess(value);
        }
      } catch (error) {
        if (requestGeneration === generation) {
          handlers.onError(error);
        }
      } finally {
        if (requestGeneration === generation) {
          handlers.onSettled();
        }
      }
    },
    invalidate() {
      generation += 1;
    },
  };
}
