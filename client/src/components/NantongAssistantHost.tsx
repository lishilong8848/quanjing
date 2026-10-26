import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useAccess } from '@/access/AccessProvider';
import type { NantongAssistantContext } from '@shared/nantong-assistant.interface';
import { NantongAssistant } from './NantongAssistant';

type PageSummary = { context?: NantongAssistantContext; label: string };
const PageSummarySetter = createContext<(summary: PageSummary | null) => void>(
  () => undefined,
);

export function useNantongAssistantPageSummary(
  context: NantongAssistantContext | undefined,
  label: string,
) {
  const setSummary = useContext(PageSummarySetter);
  useEffect(() => {
    setSummary({ context, label });
    return () => setSummary(null);
  }, [context, label, setSummary]);
}

export function NantongAssistantHost({
  children,
  visible = true,
}: {
  children: ReactNode;
  visible?: boolean;
}) {
  const [summary, setSummary] = useState<PageSummary | null>(null);
  const location = useLocation();
  const { role, principalFingerprint } = useAccess();
  const identity = `${role}:${principalFingerprint || ''}`;

  return (
    <PageSummarySetter.Provider value={setSummary}>
      {children}
      {visible && (
        <NantongAssistant
          key={identity}
          context={summary?.context}
          contextLabel={summary?.label || '当前页面'}
          conversationKey={`${location.pathname}:${summary?.label || ''}`}
        />
      )}
    </PageSummarySetter.Provider>
  );
}
