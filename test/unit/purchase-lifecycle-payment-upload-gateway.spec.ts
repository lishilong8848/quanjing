import { randomUUID } from 'node:crypto';
import { LifecyclePaymentUploadGatewayAdapter } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload-gateway';

describe('lifecycle payment upload gateway adapter', () => {
  const file = (name: string) => ({ originalname: name, mimetype: 'image/png', size: 3, buffer: Buffer.from('abc') });
  it('uses the existing app-scoped attachment API exactly once per file without printing credentials', async () => {
    const gateway = { getTenantAccessTokenAsApp: jest.fn().mockResolvedValue('synthetic-access-token'), uploadAttachment: jest.fn().mockResolvedValueOnce('file_one').mockResolvedValueOnce('file_two') };
    const result = await new LifecyclePaymentUploadGatewayAdapter(gateway as never).upload([file('a.png'), file('b.png')], randomUUID());
    expect(result).toEqual(['file_one', 'file_two']);
    expect(gateway.getTenantAccessTokenAsApp).toHaveBeenCalledTimes(1);
    expect(gateway.uploadAttachment).toHaveBeenCalledTimes(2);
  });
  it('never automatically retries a failed or partially successful remote batch', async () => {
    const gateway = { getTenantAccessTokenAsApp: jest.fn().mockResolvedValue('synthetic-access-token'), uploadAttachment: jest.fn().mockResolvedValueOnce('file_one').mockRejectedValueOnce(new Error('unknown remote outcome')) };
    await expect(new LifecyclePaymentUploadGatewayAdapter(gateway as never).upload([file('a.png'), file('b.png')], randomUUID())).rejects.toThrow();
    expect(gateway.uploadAttachment).toHaveBeenCalledTimes(2);
  });
  it('uploads only one file per persisted fence through uploadOne', async () => {
    const gateway = { getTenantAccessTokenAsApp: jest.fn().mockResolvedValue('synthetic-access-token'), uploadAttachment: jest.fn().mockResolvedValue('file_one') };
    expect(await new LifecyclePaymentUploadGatewayAdapter(gateway as never).uploadOne(file('a.png'), randomUUID())).toBe('file_one');
    expect(gateway.uploadAttachment).toHaveBeenCalledTimes(1);
  });
  it('fails before network calls on missing gateway, bad input or empty credentials', async () => {
    const gateway = { getTenantAccessTokenAsApp: jest.fn().mockResolvedValue(''), uploadAttachment: jest.fn() };
    const adapter = new LifecyclePaymentUploadGatewayAdapter(gateway as never);
    await expect(adapter.upload([file('a.png')], 'bad-attempt')).rejects.toThrow();
    await expect(adapter.upload([{ ...file('a.png'), size: 2 }], randomUUID())).rejects.toThrow();
    expect(gateway.getTenantAccessTokenAsApp).not.toHaveBeenCalled();
    await expect(adapter.upload([file('a.png')], randomUUID())).rejects.toThrow();
    expect(gateway.uploadAttachment).not.toHaveBeenCalled();
  });
});
