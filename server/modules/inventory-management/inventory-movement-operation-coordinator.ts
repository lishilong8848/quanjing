import { BadRequestException, Injectable } from '@nestjs/common';

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

@Injectable()
export class InventoryMovementOperationCoordinator {
  private readonly tailsByResource = new Map<string, Promise<void>>();

  run<T>(
    resourceKeys: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const keys = normalizeResourceKeys(resourceKeys);
    const predecessors = keys.map(
      (key) => this.tailsByResource.get(key) || Promise.resolve(),
    );
    const execution = Promise.all(
      predecessors.map((predecessor) => predecessor.catch(() => undefined)),
    ).then(operation);
    const tail = execution.then(
      () => undefined,
      () => undefined,
    );
    keys.forEach((key) => this.tailsByResource.set(key, tail));
    void tail.finally(() => {
      keys.forEach((key) => {
        if (this.tailsByResource.get(key) === tail) {
          this.tailsByResource.delete(key);
        }
      });
    });
    return execution;
  }
}

function normalizeResourceKeys(values: readonly string[]): string[] {
  if (!Array.isArray(values)) {
    throw new BadRequestException('库存业务资源锁格式无效');
  }
  const keys = [...new Set(values.map((value) => value.trim()))].sort();
  if (
    keys.length === 0 ||
    keys.some(
      (key) =>
        key.length === 0 ||
        key.length > 256 ||
        CONTROL_CHARACTER_PATTERN.test(key),
    )
  ) {
    throw new BadRequestException('库存业务资源锁标识无效');
  }
  return keys;
}
