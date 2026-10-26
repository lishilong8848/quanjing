import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import {
  extractDisplayText,
  fetchBitableRecords,
} from '../../common/feishu/bitable-direct-read';
import {
  buildPurchaseOrderCode,
  purchaseBuildingNumber,
} from './purchase-code.rules';

export interface PurchaseCodeAllocationInput {
  appToken: string;
  date: string;
  building: string;
  submissionTableId: string;
  executionTableId: string;
}

@Injectable()
export class PurchaseCodeService {
  private readonly allocationTails = new Map<string, Promise<void>>();
  private readonly allocatedSequences = new Map<string, number>();

  constructor(private readonly httpService: HttpService) {}

  async allocate(input: PurchaseCodeAllocationInput): Promise<string> {
    const buildingNumber = purchaseBuildingNumber(input.building);
    if (!buildingNumber) throw new Error(`采购楼栋不支持自动编码：${input.building}`);
    const key = `${input.date}:${buildingNumber}`;

    return this.runExclusively(key, async () => {
      const currentMaximum = await this.readCurrentMaximum(input, buildingNumber);
      const allocatedMaximum = this.allocatedSequences.get(key) ?? 0;
      const sequence = Math.max(currentMaximum, allocatedMaximum) + 1;
      const code = buildPurchaseOrderCode(input.date, input.building, sequence);
      this.allocatedSequences.set(key, sequence);
      return code;
    });
  }

  private async readCurrentMaximum(
    input: PurchaseCodeAllocationInput,
    buildingNumber: string,
  ): Promise<number> {
    const records = await Promise.all(
      [input.submissionTableId, input.executionTableId].map((tableId) =>
        fetchBitableRecords(this.httpService, {
          appToken: input.appToken,
          tableId,
          tableName: '采购记录',
          fieldNames: ['采购编码'],
          forceRefresh: true,
          cacheTtlMs: 0,
        }),
      ),
    );
    const datePart = input.date.slice(2).replaceAll('-', '');
    const pattern = new RegExp(`^CG${datePart}-${buildingNumber}(\\d{2})$`);
    let maximum = 0;
    for (const record of records.flat()) {
      const code = extractDisplayText(record.fields?.['采购编码']).trim();
      const match = pattern.exec(code);
      if (match) maximum = Math.max(maximum, Number(match[1]));
    }
    return maximum;
  }

  private async runExclusively<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.allocationTails.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.allocationTails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.allocationTails.get(key) === tail) {
        this.allocationTails.delete(key);
      }
    }
  }
}
