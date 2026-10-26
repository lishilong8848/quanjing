import { EyeOff, GripHorizontal, Minus, RotateCcw, Send } from 'lucide-react';
import { PanoramaAssistantLogo } from './PanoramaAssistantLogo';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { askNantongAssistant } from '@/api';
import type {
  NantongAssistantContext,
  NantongAssistantMessage,
} from '@shared/nantong-assistant.interface';
import './nantong-assistant.css';

const MAX_QUESTION_LENGTH = 2000;
const VIEWPORT_GAP = 8;
const DRAG_THRESHOLD = 5;

type AssistantPosition = { right: number; bottom: number };
type DragSession = AssistantPosition & {
  pointerId: number;
  startX: number;
  startY: number;
  width: number;
  height: number;
  moved: boolean;
};

function clamp(value: number, maximum: number): number {
  return Math.min(Math.max(value, VIEWPORT_GAP), Math.max(VIEWPORT_GAP, maximum));
}

function requestHistory(messages: NantongAssistantMessage[]): NantongAssistantMessage[] {
  const history: NantongAssistantMessage[] = [];
  let remaining = 8000;
  for (let index = messages.length - 1; index >= 0 && history.length < 12; index -= 1) {
    const message = messages[index];
    const limit = index === messages.length - 1 ? MAX_QUESTION_LENGTH : 1800;
    const content = message.content.slice(0, Math.min(limit, remaining));
    if (!content) break;
    history.unshift({ role: message.role, content });
    remaining -= content.length;
  }
  return history;
}

function readError(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error &&
    ['ECONNABORTED', 'ETIMEDOUT'].includes(String(error.code))) return '回答超时，请重试';
  const response = error && typeof error === 'object' && 'response' in error
    ? (error as { response?: { data?: { message?: unknown }; status?: number } }).response
    : undefined;
  if (response?.status === 401) return '登录状态已失效，请重新登录';
  if (response?.status === 403) return '当前账号没有问答权限';
  if (response?.status === 400) return '问题或对话过长，请缩短后重试';
  if (response?.status === 429) return '提问过于频繁，请稍后再试';
  if (response?.status === 504) return '回答超时，请重试';
  if (response?.status === 503 && response.data?.message === 'AI 尚未启用') return 'AI 尚未启用';
  return '暂时无法回答，请重试';
}

export function NantongAssistant({
  context,
  contextLabel,
  conversationKey,
}: {
  context?: NantongAssistantContext;
  contextLabel: string;
  conversationKey: string;
}) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [position, setPosition] = useState<AssistantPosition | null>(null);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<NantongAssistantMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const launcherRef = useRef<HTMLButtonElement>(null);
  const revealRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<AssistantPosition | null>(null);
  const dragRef = useRef<DragSession | null>(null);
  const suppressLauncherClickRef = useRef(false);
  const wasHiddenRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(false);
  const hasOpenedRef = useRef(false);
  const requestId = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (hidden) {
      wasHiddenRef.current = true;
      revealRef.current?.focus();
    } else if (open) {
      hasOpenedRef.current = true;
      inputRef.current?.focus();
    } else if (hasOpenedRef.current || wasHiddenRef.current) {
      launcherRef.current?.focus();
      wasHiddenRef.current = false;
    }
  }, [open, hidden]);

  useLayoutEffect(() => {
    if (!position || hidden) return;
    const root = rootRef.current;
    if (!root) return;
    const keepInView = (synchronous = false) => {
      const rect = root.getBoundingClientRect();
      const current = positionRef.current ?? position;
      const right = clamp(current.right, window.innerWidth - rect.width - VIEWPORT_GAP);
      const bottom = clamp(current.bottom, window.innerHeight - rect.height - VIEWPORT_GAP);
      root.style.right = `${right}px`;
      root.style.bottom = `${bottom}px`;
      if (right === current.right && bottom === current.bottom) return;
      positionRef.current = { right, bottom };
      if (synchronous) flushSync(() => setPosition({ right, bottom }));
      else setPosition({ right, bottom });
    };
    keepInView();
    const onResize = () => keepInView(true);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open, hidden, position]);

  useEffect(() => {
    if (open) feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [messages, pending, open]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  useEffect(() => {
    requestId.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    pendingRef.current = false;
    setPending(false);
    setMessages([]);
    setError('');
    setDraft('');
  }, [conversationKey]);

  const send = async (question: string, retry = false) => {
    if (pendingRef.current) return;
    const content = question.trim();
    if (!content || content.length > MAX_QUESTION_LENGTH) return;
    const next: NantongAssistantMessage[] = retry
      ? messages
      : [...messages, { role: 'user', content }];
    if (!retry) {
      setMessages(next);
      setDraft('');
    }
    setError('');
    setPending(true);
    pendingRef.current = true;
    const currentId = ++requestId.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const response = await askNantongAssistant({
        messages: requestHistory(next),
        context,
      }, controller.signal);
      if (requestId.current === currentId) {
        setMessages([...next, { role: 'assistant' as const, content: response.answer }].slice(-40));
      }
    } catch (cause) {
      if (requestId.current === currentId && !controller.signal.aborted) setError(readError(cause));
    } finally {
      if (requestId.current === currentId) {
        setPending(false);
        pendingRef.current = false;
        controllerRef.current = null;
      }
    }
  };

  const clear = () => {
    requestId.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    pendingRef.current = false;
    setPending(false);
    setMessages([]);
    setError('');
    setDraft('');
    inputRef.current?.focus();
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(draft);
    }
  };

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest('button:not(.nantong-assistant-drag-handle)') && event.currentTarget !== launcherRef.current) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.bottom,
      width: rect.width,
      height: rect.height,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return;
    drag.moved = true;
    const root = rootRef.current;
    if (!root) return;
    root.style.right = `${clamp(drag.right - deltaX, window.innerWidth - drag.width - VIEWPORT_GAP)}px`;
    root.style.bottom = `${clamp(drag.bottom - deltaY, window.innerHeight - drag.height - VIEWPORT_GAP)}px`;
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    if (!drag.moved || !rootRef.current) return;
    const next = {
      right: Number.parseFloat(rootRef.current.style.right),
      bottom: Number.parseFloat(rootRef.current.style.bottom),
    };
    positionRef.current = next;
    setPosition(next);
    suppressLauncherClickRef.current = true;
    window.setTimeout(() => { suppressLauncherClickRef.current = false; }, 0);
  };

  const moveWithKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    const steps: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const distance = event.shiftKey ? 32 : 12;
    const next = {
      right: clamp(window.innerWidth - rect.right - step[0] * distance, window.innerWidth - rect.width - VIEWPORT_GAP),
      bottom: clamp(window.innerHeight - rect.bottom - step[1] * distance, window.innerHeight - rect.height - VIEWPORT_GAP),
    };
    positionRef.current = next;
    setPosition(next);
  };

  const hide = () => {
    setOpen(false);
    setHidden(true);
  };

  if (hidden) return <button
    ref={revealRef}
    type="button"
    className="nantong-assistant-reveal"
    aria-label="显示全景小帮手"
    title="显示全景小帮手"
    onClick={() => setHidden(false)}
  ><PanoramaAssistantLogo /></button>;

  return <div ref={rootRef} className="nantong-assistant" style={position || undefined}>
    {!open ? <div className="nantong-assistant-launcher-row"><button
      ref={launcherRef}
      type="button"
      className="nantong-assistant-launcher"
      aria-label="打开全景小帮手"
      aria-expanded={false}
      aria-controls="nantong-assistant-panel"
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={moveWithKeyboard}
      onClick={() => {
        if (suppressLauncherClickRef.current) { suppressLauncherClickRef.current = false; return; }
        setOpen(true);
      }}
    >
      <span className="nantong-assistant-launcher-icon"><PanoramaAssistantLogo /></span>
      <span>全景小帮手</span>
    </button><button type="button" className="nantong-assistant-launcher-hide" aria-label="隐藏全景小帮手" title="隐藏全景小帮手" onClick={hide}>
      <EyeOff aria-hidden="true" />
    </button></div> : <section
      id="nantong-assistant-panel"
      className="nantong-assistant-panel"
      role="region"
      aria-label="全景小帮手对话"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <header className="nantong-assistant-header" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <span className="nantong-assistant-avatar"><PanoramaAssistantLogo /></span>
        <div className="nantong-assistant-heading">
          <strong><span className="nantong-assistant-heading-full">全景小帮手</span><span className="nantong-assistant-heading-short">小帮手</span></strong>
          <span>{contextLabel}</span>
        </div>
        <button type="button" className="nantong-assistant-icon-button nantong-assistant-drag-handle" aria-label="拖动小帮手，方向键移动" title="拖动小帮手" onKeyDown={moveWithKeyboard}>
          <GripHorizontal aria-hidden="true" />
        </button>
        <button type="button" className="nantong-assistant-icon-button" aria-label="新对话" title="新对话" onClick={clear}>
          <RotateCcw aria-hidden="true" />
        </button>
        <button type="button" className="nantong-assistant-icon-button" aria-label="收起小帮手" title="收起小帮手" onClick={() => setOpen(false)}>
          <Minus aria-hidden="true" />
        </button>
        <button type="button" className="nantong-assistant-icon-button" aria-label="隐藏小帮手" title="隐藏小帮手" onClick={hide}>
          <EyeOff aria-hidden="true" />
        </button>
      </header>

      <div ref={feedRef} className="nantong-assistant-feed" role="log" aria-live="polite" aria-relevant="additions">
        {messages.length === 0 ? <div className="nantong-assistant-welcome">
          <span className="nantong-assistant-welcome-icon"><PanoramaAssistantLogo /></span>
          <strong>{context ? '想了解哪些告警情况？' : '有什么想了解的？'}</strong>
          <span>{context ? '我会结合当前页面的告警汇总回答。' : '可以提问；没有当前页面数据时，我会明确说明。'}</span>
          <div className="nantong-assistant-suggestions">
            {(context
              ? ['打标异常有多少条？', '各楼栋告警分布如何？', '还有多少告警待处理？']
              : ['你能回答哪些问题？', '没有页面数据时如何回答？']
            ).map((question) =>
              <button key={question} type="button" onClick={() => void send(question)} disabled={pending}>
                {question}
              </button>,
            )}
          </div>
        </div> : messages.map((message, index) => <div
          key={`${index}-${message.role}`}
          className={`nantong-assistant-message is-${message.role}`}
        >
          <span className="nantong-assistant-speaker">{message.role === 'user' ? '我' : '全景小帮手'}</span>
          <div>{message.content}</div>
        </div>)}
        {pending && <div className="nantong-assistant-thinking" role="status">
          <span className="nantong-assistant-thinking-dots" aria-hidden="true"><i /><i /><i /></span>
          正在思考…
        </div>}
        {error && <div className="nantong-assistant-error" role="alert">
          <span>{error}</span>
          {messages.at(-1)?.role === 'user' && <button type="button" onClick={() => void send(messages.at(-1)!.content, true)}>重试</button>}
        </div>}
      </div>

      <form className="nantong-assistant-composer" onSubmit={(event) => { event.preventDefault(); void send(draft); }}>
        <label className="sr-only" htmlFor="nantong-assistant-question">向全景小帮手提问</label>
        <textarea
          ref={inputRef}
          id="nantong-assistant-question"
          value={draft}
          maxLength={MAX_QUESTION_LENGTH}
          rows={2}
          placeholder="输入问题，Enter 发送"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onInputKeyDown}
        />
        <button type="submit" aria-label="发送问题" title="发送问题" disabled={pending || !draft.trim()}>
          <Send aria-hidden="true" />
        </button>
      </form>
    </section>}
  </div>;
}
