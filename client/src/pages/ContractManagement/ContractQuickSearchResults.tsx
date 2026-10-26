import { Download, Eye, LocateFixed, SearchX } from 'lucide-react';

import { getContractAttachmentDownloadUrl } from '@/api';
import type { ContractManagementItem } from '@shared/contract-management.interface';

interface ContractQuickSearchResultsProps {
  query: string;
  results: ContractManagementItem[];
  onLocate: (contract: ContractManagementItem) => void;
  onPreview: (request: { contract: ContractManagementItem }) => void;
}

export function ContractQuickSearchResults({
  query,
  results,
  onLocate,
  onPreview,
}: ContractQuickSearchResultsProps) {
  return (
    <div
      id="management-search-results"
      role="listbox"
      aria-label="合同模糊搜索结果"
      className="absolute right-0 top-full z-50 mt-2 w-full min-w-[min(92vw,28rem)] overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-900 shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 text-xs text-slate-500">
        <span>匹配“{query.trim()}”</span>
        <span>{results.length} 条</span>
      </div>
      {results.length ? (
        <div className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
          {results.map((contract) => {
            const firstAttachment = contract.attachments[0];
            return (
              <div
                key={contract.recordId}
                role="option"
                aria-selected="false"
                className="group flex items-center gap-2 px-3 py-3 hover:bg-blue-50"
              >
                <button
                  type="button"
                  onClick={() => onLocate(contract)}
                  className="min-w-0 flex-1 text-left focus-visible:outline-none"
                >
                  <span className="block truncate text-sm font-semibold text-slate-900">
                    {contract.code || '编号待补充'}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-slate-600">
                    {contract.name}
                  </span>
                  <span className="mt-1 block truncate text-[11px] text-slate-400">
                    {contract.supplier || '供应商待补充'} ·{' '}
                    {contract.owner || '跟进人待补充'}
                  </span>
                </button>
                <button
                  type="button"
                  title="定位到合同"
                  aria-label={`定位合同：${contract.name}`}
                  onClick={() => onLocate(contract)}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:border-blue-300 hover:bg-white hover:text-blue-700"
                >
                  <LocateFixed className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="在线阅览"
                  aria-label={`在线阅览：${contract.name}`}
                  disabled={!firstAttachment}
                  onClick={() => onPreview({ contract })}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
                {firstAttachment ? (
                  <a
                    href={getContractAttachmentDownloadUrl(
                      firstAttachment.accessId,
                    )}
                    title={`下载：${firstAttachment.name}`}
                    aria-label={`下载合同：${contract.name}`}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-blue-200 bg-blue-600 text-white hover:bg-blue-700"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </a>
                ) : (
                  <span
                    title="暂无附件"
                    aria-label="暂无附件可下载"
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-300"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-slate-500">
          <SearchX className="h-4 w-4" />
          未找到匹配合同
        </div>
      )}
    </div>
  );
}
