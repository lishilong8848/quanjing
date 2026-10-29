import { PurchaseApplicationService } from '../../server/modules/purchase-inventory/purchase-application.service';
import type { PurchaseApplicationBatchRequest } from '../../shared/purchase-application.interface';
import { comparisonAttachmentIssue } from '../../shared/purchase-comparison-attachments';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/q3cAAAAASUVORK5CYII=', 'base64');
const file = (mimetype = 'image/png', buffer = png) => ({ originalname: 'synthetic.png', mimetype, buffer, size: buffer.length });
function request(channel = '线上', form = '三方比价'): PurchaseApplicationBatchRequest {
  return { shared: { applicantRecordId: 'recSynthetic', applicantOpenId: 'ou_synthetic', applicantName: '合成申请人',
    applicantEmployeeNo: 'TEST', applicantPosition: '值班员', applicantBuilding: 'H楼', building: 'H楼', specialty: '其他', purchaseMethod: '综合采购',
    purchaseChannel: channel, supplier: '合成供应商', onlineUrl: 'https://example.com/item', procurementForm: form, comparisonSatisfied: '是',
    singleReason: form === '单一采购' ? '原厂唯一供应' : '', requirementSummary: '测试', expectedDeliveryDate: '2026-11-01', immediateOutbound: false, notes: '' },
    items: [{ lineId: 'line-1', mode: 'new', catalogRecordId: '', sku: '', primaryCategory: 'D消耗类', secondaryCategory: '办公耗材D2',
      itemName: '合成物品', specification: '测试', brand: '', quantity: 1, unit: '个', unitPrice: 1, shippingFee: 0, discount: 0 }] } as PurchaseApplicationBatchRequest;
}
describe('comparison attachment acceptance', () => {
  const http = { axiosRef: { post: jest.fn(), get: jest.fn() } };
  const service = new PurchaseApplicationService(http as never, undefined, {} as never, {} as never);
  const validate = (files: ReturnType<typeof file>[], channel = '线上', form = '三方比价') =>
    (service as any).validateSubmission(request(channel, form), files, '2026-10-29');
  it.each(['线上', '线下'])('requires three images for %s', channel => {
    for (const count of [0, 1, 2]) expect(() => validate(Array.from({ length: count }, () => file()), channel)).toThrow('至少 3 张');
    for (const count of [3, 4, 5]) expect(() => validate(Array.from({ length: count }, () => file()), channel)).not.toThrow();
    expect(http.axiosRef.post).not.toHaveBeenCalled();
  });
  it('permits two optional PDFs but never counts them as required images', () => {
    const pdf = file('application/pdf', Buffer.from('%PDF-1.7 synthetic'));
    expect(() => validate([file(), file(), pdf])).toThrow('至少 3 张');
    expect(() => validate([file(), file(), file(), pdf, pdf])).not.toThrow();
    expect(() => validate([file(), file(), file(), pdf, pdf, pdf])).toThrow();
  });
  it('does not trust the MIME label of non-image bytes', () => {
    expect(() => validate([file(), file(), file('image/png', Buffer.from('%PDF fake png'))])).toThrow('至少 3 张');
    expect(() => validate([file(), file(), file('image/jpeg', png)])).toThrow('至少 3 张');
  });
  it('keeps single procurement attachment-free and client policy in agreement', () => {
    expect(() => validate([], '线下', '单一采购')).not.toThrow();
    expect(comparisonAttachmentIssue([{ type: 'image/png' }, { type: 'image/jpeg' }, { type: 'application/pdf' }])).toMatch('至少 3 张');
    expect(comparisonAttachmentIssue(Array.from({ length: 3 }, () => ({ type: 'image/png' })))).toBeNull();
  });
});
