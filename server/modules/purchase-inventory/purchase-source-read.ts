import type { HttpService } from '@nestjs/axios';
import {
  fetchBitableRecords,
  type FetchBitableRecordsOptions,
} from '../../common/feishu/bitable-direct-read';

/** Retry only rejected snapshots. External business writes are never replayed. */
export async function readPurchaseSource(
  httpService: HttpService,
  options: FetchBitableRecordsOptions,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchBitableRecords(httpService, options);
    } catch (error) {
      if (!(error instanceof Error) ||
          error.message !== '数据在读取期间已变更，请重新读取' || attempt >= 2) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 100 : 300));
    }
  }
}
