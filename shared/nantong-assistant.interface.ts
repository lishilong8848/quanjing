export interface NantongAssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface NantongAssistantContext {
  scope: 'today' | 'monthly';
  start: string;
  end: string;
  total: number;
  pending: number;
  tagAnomalies: number;
  buildings: Array<{ name: string; total: number; anomalies: number }>;
  review: { state: string; reviewed: number; total: number };
}

export interface NantongAssistantChatRequest {
  messages: NantongAssistantMessage[];
  context?: NantongAssistantContext;
}

export interface NantongAssistantChatResponse {
  answer: string;
}
