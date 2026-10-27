import {
  chunkBitableRecordUpdates,
  dropMissingOptionalBitableField,
  getBitableAxiosErrorMessage,
  getMissingBitableFieldName,
  isSameFieldPayload,
  shouldRetryBitableWriteResponse,
  shouldRetryBitableUpdateWithFieldNames,
  toBitableFieldNamePayload,
} from '../../server/modules/duty-schedule/bitable-record-update';

describe('bitable record update helpers', () => {
  it('chunks record updates at the Feishu 1000-record batch limit', () => {
    const updates = Array.from({ length: 1001 }, (_, index) => ({
      record_id: `rec${index}`,
      fields: { '值班人员（实际）程序修改': '张三' },
    }));

    const chunks = chunkBitableRecordUpdates(updates);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(1000);
    expect(chunks[1]).toEqual([updates[1000]]);
  });

  it('rejects invalid batch sizes', () => {
    expect(() => chunkBitableRecordUpdates([], 0)).toThrow(
      '批量更新大小必须在 1 到 1000 之间',
    );
    expect(() => chunkBitableRecordUpdates([], 1001)).toThrow(
      '批量更新大小必须在 1 到 1000 之间',
    );
  });

  it('detects Feishu FieldNameNotFound responses for field-id payloads', () => {
    expect(
      shouldRetryBitableUpdateWithFieldNames(
        {
          code: 1254045,
          msg: 'FieldNameNotFound',
          error: {
            message:
              "Invalid request parameter: 'fields.fldDelayStart'. Correct format : field_name not found.",
          },
        },
        { fldDelayStart: 1779296400000 },
      ),
    ).toBe(true);

    expect(
      shouldRetryBitableUpdateWithFieldNames(
        { code: 1254045, msg: 'FieldNameNotFound' },
        { 'Delay Start': 1779296400000 },
      ),
    ).toBe(false);
  });

  it('retries Feishu data-not-ready write responses', () => {
    expect(
      shouldRetryBitableWriteResponse({
        code: 1254607,
        msg: 'Data not ready, please try again later',
      }),
    ).toBe(true);
    expect(
      shouldRetryBitableWriteResponse({
        code: 1254291,
        msg: 'Write conflict, please retry this request',
      }),
    ).toBe(true);
    expect(
      shouldRetryBitableWriteResponse({
        code: 1254290,
        msg: 'TooManyRequest',
      }),
    ).toBe(true);
    expect(
      shouldRetryBitableWriteResponse({
        code: 1254608,
        msg: 'Duplicate',
      }),
    ).toBe(true);
    expect(
      shouldRetryBitableWriteResponse({
        code: 1255006,
        msg: 'Client token conflict',
      }),
    ).toBe(false);
    expect(
      shouldRetryBitableWriteResponse({
        code: 0,
        msg: 'success',
      }),
    ).toBe(false);
  });

  it('maps known field ids to field names and keeps existing field names', () => {
    const payload = toBitableFieldNamePayload(
      {
        fldDelayStart: 1779296400000,
        ExistingName: 'keep',
      },
      [
        {
          field_id: 'fldDelayStart',
          field_name: 'Delay Start',
        },
      ],
    );

    expect(payload).toEqual({
      'Delay Start': 1779296400000,
      ExistingName: 'keep',
    });
    expect(isSameFieldPayload({ fldDelayStart: 1 }, payload)).toBe(false);
  });

  it('extracts Feishu response details from Axios errors', () => {
    const error = new Error('Request failed with status code 400') as Error & {
      response?: {
        status: number;
        data: Record<string, unknown>;
      };
    };
    error.response = {
      status: 400,
      data: {
        code: 1254007,
        msg: 'Invalid request parameter',
        error: {
          message: 'fields.挂牌与隔离照片 invalid',
        },
      },
    };

    expect(getBitableAxiosErrorMessage(error)).toBe(
      'Invalid request parameter: 1254007: fields.挂牌与隔离照片 invalid',
    );
  });

  it('extracts missing field names from Feishu FieldNameNotFound responses', () => {
    expect(
      getMissingBitableFieldName({
        code: 1254045,
        msg: 'FieldNameNotFound',
        error: {
          message:
            "Invalid request parameter: 'fields.质保金协议'. Correct format : field_name not found.",
        },
      }),
    ).toBe('质保金协议');

    expect(
      getMissingBitableFieldName({
        code: 1254045,
        msg: 'FieldNameNotFound',
        error: {
          message:
            'Invalid request parameter: fields.是否完成: Correct format : field_name not found.',
        },
      }),
    ).toBe('是否完成');

    expect(
      getMissingBitableFieldName({
        code: 1254045,
        msg: 'FieldNameNotFound',
        error: {
          message:
            'Invalid request parameter: fields.AI审核结果-临时用电作业许可证: Correct format : field_name not found.',
        },
      }),
    ).toBe('AI审核结果-临时用电作业许可证');
  });

  it('drops only configured optional missing fields', () => {
    expect(
      dropMissingOptionalBitableField(
        { 施工总览: ['rec'], 是否完成: '是' },
        '是否完成',
        ['是否完成'],
      ),
    ).toEqual({ 施工总览: ['rec'] });

    expect(
      dropMissingOptionalBitableField(
        { 施工总览: ['rec'], 是否完成: '是' },
        '施工总览',
        ['是否完成'],
      ),
    ).toBeNull();

    expect(
      dropMissingOptionalBitableField(
        {
          施工总览: ['rec'],
          'AI审核结果-临时用电作业许可证': 'AI审核：待人工复核',
        },
        'AI审核结果-临时用电作业许可证',
        ['AI审核结果-临时用电作业许可证'],
      ),
    ).toEqual({ 施工总览: ['rec'] });
  });
});
