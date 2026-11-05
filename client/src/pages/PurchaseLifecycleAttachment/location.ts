type Purpose = 'comparison' | 'payment' | 'receipt' | 'invoice';
export type PurchaseAttachmentLocation = { batchId: string; recordId: string; generation: number; purpose: Purpose; index: number };

/** The URL contains document identifiers, never a recipient, token or message ID. */
export function parsePurchaseAttachmentLocation(search: string): PurchaseAttachmentLocation | null {
  const params = new URLSearchParams(search);
  const keys = ['batchId', 'recordId', 'generation', 'purpose', 'index'];
  if ([...params.keys()].some(key => !keys.includes(key)) || keys.some(key => params.getAll(key).length !== 1)) return null;
  const batchId = params.get('batchId') || '', recordId = params.get('recordId') || '';
  const purpose = params.get('purpose') || '', generationText = params.get('generation') || '', indexText = params.get('index') || '';
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(batchId) || !/^[A-Za-z0-9_-]{1,100}$/.test(recordId) ||
    !/^[1-9]\d{0,8}$/.test(generationText) || !/^(0|[1-9]\d{0,3})$/.test(indexText) ||
    Number(indexText) >= 20 || !['comparison', 'payment', 'receipt', 'invoice'].includes(purpose)) return null;
  return { batchId, recordId, purpose: purpose as Purpose, generation: Number(generationText), index: Number(indexText) };
}
