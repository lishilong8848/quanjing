import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { assertProfessionalBitableRecord, assertProfessionalRecordScope, recordProfessionalSpecialty } from '../../common/access/professional-record-scope';
import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  ContractEditOptionsResponse,
  ContractEditRequest,
  ContractEditResponse,
} from '../../../shared/contract-management.interface';
import { ContractCreationGateway } from './contract-creation.gateway';
import {
  buildContractEditFields,
  buildContractPartialEditFields,
  readContractEditValues,
  readLinkedRecordId,
} from './contract-creation.rules';
import { ContractCreationService } from './contract-creation.service';
import { assertKnownPersonFieldValues } from './contract-person-validation';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { assertCurrentContractMutation } from './contract-current-authority';

@Injectable()
export class ContractEditService {
  constructor(
    private readonly gateway: ContractCreationGateway,
    private readonly contractCreation: ContractCreationService,
    private readonly accessConfiguration: AccessConfigurationService,
  ) {}

  async authorize(recordId: string, principal?: AccessPrincipal): Promise<void> {
    if (!isProfessionalBusinessPrincipal(principal)) return;
    assertProfessionalBitableRecord(principal, await this.gateway.getRecord('execution', normalizeRecordId(recordId)));
  }

  async getOptions(recordId: string): Promise<ContractEditOptionsResponse> {
    const normalizedRecordId = normalizeRecordId(recordId);
    const [record, options] = await Promise.all([
      this.gateway.getRecord('execution', normalizedRecordId),
      this.contractCreation.getOptions('execution'),
    ]);
    const fields = options.fields.filter(
      (field) => field.control !== 'attachment',
    );
    const recordFields = record.fields || {};
    return {
      contract: {
        recordId: normalizedRecordId,
        code: displayText(recordFields['合同编号']),
        name: displayText(recordFields['合同名称']),
      },
      fields,
      values: readContractEditValues(recordFields, fields),
      suppliers: options.suppliers,
      people: options.people,
      supplierRecordId: readLinkedRecordId(recordFields['供应商']),
    };
  }

  async update(
    recordId: string,
    request: ContractEditRequest,
    principal?: AccessPrincipal,
  ): Promise<ContractEditResponse> {
    const normalizedRecordId = normalizeRecordId(recordId);
    const options = await this.contractCreation.getOptions('execution');
    const supplierChanged = Object.prototype.hasOwnProperty.call(
      request || {},
      'supplierRecordId',
    );
    const requestedSupplierRecordId = supplierChanged
      ? String(request?.supplierRecordId || '').trim()
      : '';
    if (
      supplierChanged &&
      (!requestedSupplierRecordId ||
        !options.suppliers.some(
          (item) => item.recordId === requestedSupplierRecordId,
        ))
    ) {
      throw new BadRequestException('请选择有效的供应商');
    }
    assertKnownPersonFieldValues(
      request?.fields,
      options.fields,
      options.people.map((person) => person.openId),
    );

    let fields: Record<string, unknown>;
    try {
      fields = buildContractPartialEditFields(request?.fields, options.fields);
    } catch (error) {
      throw new BadRequestException(safeMessage(error));
    }

    const currentRecord = await this.gateway.getRecord(
      'execution',
      normalizedRecordId,
    );
    assertProfessionalBitableRecord(principal, currentRecord);
    assertProfessionalBitableRecord(principal, { ...currentRecord, fields: { ...currentRecord.fields, ...fields } });
    const currentRecordFields = currentRecord.fields || {};
    const currentValues = readContractEditValues(
      currentRecordFields,
      options.fields,
    );
    const supplierRecordId = supplierChanged
      ? requestedSupplierRecordId
      : readLinkedRecordId(currentRecordFields['供应商']);
    try {
      buildContractEditFields(
        { ...currentValues, ...request.fields },
        options.fields,
        supplierRecordId,
      );
    } catch (error) {
      throw new BadRequestException(safeMessage(error));
    }
    if (supplierChanged) fields['供应商'] = [supplierRecordId];
    if (!Object.keys(fields).length) {
      throw new BadRequestException('合同信息未发生变化');
    }
    assertCurrentContractMutation(this.accessConfiguration, principal, 'update', currentRecord, { ...currentRecord, fields: { ...currentRecord.fields, ...fields } });
    await this.gateway.updateRecord('execution', normalizedRecordId, fields);
    return {
      ok: true,
      recordId: normalizedRecordId,
      message: '合同信息已同步至多维表',
    };
  }
}

function normalizeRecordId(value: unknown): string {
  const recordId = typeof value === 'string' ? value.trim() : '';
  if (
    !recordId ||
    recordId.length > 128 ||
    recordId.includes('/') ||
    recordId.includes('\\')
  ) {
    throw new BadRequestException('合同记录标识无效');
  }
  return recordId;
}

function displayText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value))
    return value.map(displayText).filter(Boolean).join('、');
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  for (const key of ['text', 'name', 'value']) {
    const result = displayText(item[key]);
    if (result) return result;
  }
  return '';
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : '合同字段无效';
}
