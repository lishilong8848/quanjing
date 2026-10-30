import { createHash } from 'node:crypto';

export interface SanitizedReadonlyCard {
  card: Record<string, unknown>;
  fingerprint: string;
  hasEnabledActions: boolean;
  entityKeys: string[];
  title: string;
}

const FOOTER = '只读抄送 · 审批、确认及其他办理请由原收件人操作';
const TRUNCATED = '内容已截取，完整内容请由原收件人查看。';
// Feishu limits a card to 30 KiB; reserve room for transport-side serialization.
export const READONLY_CARD_MAX_BYTES = 28 * 1024;
const MAX_TEXT = 12_000;
const MAX_NODES = 300;
const ENTITY_KEYS = new Set(['recordId', 'record_id', 'requestId', 'request_id', 'batchId', 'batch_id', 'workflowId', 'workflow_id', 'anomalyId', 'anomaly_id', 'approvalBatchId', 'approval_batch_id']);
const INTERACTIVE_TAGS = new Set(['button', 'overflow', 'select_static', 'multi_select_static', 'select_person', 'multi_select_person', 'input', 'textarea', 'date_picker', 'picker_time', 'picker_datetime', 'select_img', 'upload_img', 'upload_file', 'checker']);
const TEMPLATES = new Set(['blue', 'wathet', 'turquoise', 'green', 'yellow', 'orange', 'red', 'carmine', 'violet', 'purple', 'indigo', 'grey']);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Stable hashing does not depend on the property insertion order of card builders. */
export function canonicalCardJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalCardJson).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonicalCardJson(value[key])).join(',') + '}';
  return 'null';
}

/** Runtime boundary for persisted copies: only this display-only output grammar is accepted. */
export function isReadonlyDisplayCard(value: unknown): value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'config,elements,header' || !object(value.config) ||
    Object.keys(value.config).sort().join(',') !== 'update_multi,wide_screen_mode' || value.config.update_multi !== true || value.config.wide_screen_mode !== true ||
    !object(value.header) || Object.keys(value.header).sort().join(',') !== 'template,title' || !TEMPLATES.has(String(value.header.template)) || !plain(value.header.title) ||
    !Array.isArray(value.elements) || value.elements.length < 3 || value.elements.length > MAX_NODES + 2) return false;
  if (!value.elements.every(node => object(node) && (node.tag === 'hr' && Object.keys(node).length === 1 ||
    node.tag === 'div' && Object.keys(node).sort().join(',') === 'tag,text' && plain(node.text) ||
    node.tag === 'img' && Object.keys(node).sort().join(',') === 'alt,img_key,mode,preview,tag' && typeof node.img_key === 'string' && /^img(?:_v\d+)?_[A-Za-z0-9_-]{3,240}$/.test(node.img_key) && plain(node.alt) && node.mode === 'fit_horizontal' && node.preview === true))) return false;
  const last = value.elements.at(-1);
  return object(last) && object(last.text) && last.text.content === FOOTER && Buffer.byteLength(JSON.stringify(value), 'utf8') <= READONLY_CARD_MAX_BYTES;
}
function plain(value: unknown): boolean { return object(value) && Object.keys(value).sort().join(',') === 'content,tag' && value.tag === 'plain_text' && typeof value.content === 'string' && value.content.length <= MAX_TEXT && !/(?:https?:\/\/|lark:\/\/|feishu:\/\/|www\.)/i.test(value.content); }

/**
 * Rebuild a classic display card from allowlisted visible nodes. Never clone the
 * original schema: action capabilities may be hidden in otherwise innocuous keys.
 */
export function sanitizeReadonlyCard(input: unknown): SanitizedReadonlyCard {
  let raw: unknown = input;
  if (typeof raw === 'string') {
    if (raw.length > 1_000_000) return unsupported();
    try { raw = JSON.parse(raw); } catch { return unsupported(); }
  }
  if (!object(raw)) return unsupported();
  const header = object(raw.header) ? raw.header : {};
  const title = visibleText(header.title).slice(0, 200) || '卡片通知';
  const entityKeys = new Set<string>();
  let hasEnabledActions = false, inspected = 0;
  const seen = new WeakSet<object>();
  const inspect = (value: unknown, depth = 0): void => {
    if (depth > 24 || inspected++ > 4000 || !value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { value.slice(0, 4000).forEach(item => inspect(item, depth + 1)); return; }
    const node = value as Record<string, unknown>;
    if ((INTERACTIVE_TAGS.has(String(node.tag)) || node.form_action_type || Array.isArray(node.behaviors) && node.behaviors.length || node.callback || node.url || node.multi_url || node.card_link) && node.disabled !== true) hasEnabledActions = true;
    // Only an action's explicit value is an identity source, never arbitrary content/URLs.
    if ((INTERACTIVE_TAGS.has(String(node.tag)) || object(node.action)) && object(node.value)) collectIdentity(node.value, entityKeys);
    if (object(node.action) && object(node.action.value)) collectIdentity(node.action.value, entityKeys);
    for (const key of ['elements', 'body', 'columns', 'fields', 'extra', 'actions', 'header', 'action']) if (Object.hasOwn(node, key)) inspect(node[key], depth + 1);
  };
  inspect(raw);
  const elements: Record<string, unknown>[] = [];
  let textBudget = MAX_TEXT, truncated = false;
  const addText = (value: unknown) => {
    if (elements.length >= MAX_NODES || textBudget <= 0) { truncated = true; return; }
    const visible = visibleText(value), content = visible.slice(0, textBudget).trim();
    if (visible.length > textBudget) truncated = true;
    const source = typeof value === 'string' ? value : object(value) ? value.content : null;
    if (typeof source === 'string' && source.length > MAX_TEXT) truncated = true;
    if (!content) return;
    textBudget -= content.length;
    elements.push({ tag: 'div', text: { tag: 'plain_text', content } });
  };
  const visited = new WeakSet<object>();
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 20 || elements.length >= MAX_NODES) { truncated = true; return; }
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) { if (value.length > MAX_NODES) truncated = true; value.slice(0, MAX_NODES).forEach(child => walk(child, depth + 1)); return; }
    const node = value as Record<string, unknown>, tag = String(node.tag || '');
    if (INTERACTIVE_TAGS.has(tag) || tag === 'action') {
      // Disabled buttons are still omitted: no value, token, URL, or submit action survives.
      return;
    }
    if (tag === 'div') {
      addText(node.text);
      if (Array.isArray(node.fields)) for (const field of node.fields.slice(0, MAX_NODES)) if (object(field)) addText(field.text);
      if (object(node.extra) && node.extra.tag === 'img') walk(node.extra, depth + 1);
      return;
    }
    if (tag === 'markdown' || tag === 'plain_text' || tag === 'lark_md') { addText(node); return; }
    if (tag === 'img') {
      if (typeof node.img_key === 'string' && /^img(?:_v\d+)?_[A-Za-z0-9_-]{3,240}$/.test(node.img_key)) elements.push({ tag: 'img', img_key: node.img_key, alt: { tag: 'plain_text', content: visibleText(node.alt).slice(0, 200) || '卡片图片' }, mode: 'fit_horizontal', preview: true });
      else addText('图片暂不可展示');
      return;
    }
    if (tag === 'hr') { elements.push({ tag: 'hr' }); return; }
    if (tag === 'column_set') { walk(node.columns, depth + 1); return; }
    if (['column', 'form', 'note', 'collapsible_panel', 'interactive_container'].includes(tag)) {
      if (tag === 'collapsible_panel' && object(node.header)) addText(node.header.title);
      walk(node.elements, depth + 1); return;
    }
    if (tag === 'table') {
      const columns = Array.isArray(node.columns) ? node.columns.filter(object) : [];
      if (Array.isArray(node.rows) && node.rows.length > 50) truncated = true;
      for (const row of Array.isArray(node.rows) ? node.rows.slice(0, 50) : []) if (object(row)) {
        const cells = columns.flatMap(column => typeof column.name === 'string' && Object.hasOwn(row, column.name) ? [`${visibleText(column.display_name) || column.name}：${visibleText(row[column.name])}`] : []);
        addText(cells.join(' · '));
      }
      return;
    }
    // Unknown nodes may contain capability data; never recursively expose their values.
  };
  const supported = raw.type !== 'template' && !raw.template_id && (Array.isArray(raw.elements) || raw.schema === '2.0' && object(raw.body) && Array.isArray(raw.body.elements));
  if (supported) walk(raw.schema === '2.0' ? (raw.body as Record<string, unknown>).elements : raw.elements);
  else addText('此卡片结构暂不支持完整只读展示，交互内容已隐藏。请联系原收件人查看。');
  if (!elements.length) addText('原卡片包含交互内容，已在只读副本中隐藏。');
  elements.push({ tag: 'hr' }, { tag: 'div', text: { tag: 'plain_text', content: FOOTER } });
  const card = fitCardByteBudget({ config: { wide_screen_mode: true, update_multi: true }, header: { template: typeof header.template === 'string' && TEMPLATES.has(header.template) ? header.template : 'blue', title: { tag: 'plain_text', content: title } }, elements }, truncated);
  return { card, fingerprint: createHash('sha256').update(canonicalCardJson(card)).digest('hex'), title, entityKeys: [...entityKeys].sort(), hasEnabledActions };
}

/** Keep a visible prefix; limits use serialized UTF-8 bytes, including JSON escaping. */
function fitCardByteBudget<T extends Record<string, unknown> & { elements: Record<string, unknown>[] }>(card: T, truncated: boolean): T {
  if (!truncated && Buffer.byteLength(JSON.stringify(card), 'utf8') <= READONLY_CARD_MAX_BYTES) return card;
  const suffix = [{ tag: 'div', text: { tag: 'plain_text', content: TRUNCATED } }, ...card.elements.slice(-2)];
  const body: Record<string, unknown>[] = [];
  let bytes = Buffer.byteLength(JSON.stringify({ ...card, elements: suffix }), 'utf8');
  for (const node of card.elements.slice(0, -2)) {
    if (body.length >= MAX_NODES - 1) break;
    const nodeBytes = Buffer.byteLength(JSON.stringify(node), 'utf8') + 1;
    if (bytes + nodeBytes <= READONLY_CARD_MAX_BYTES) { body.push(node); bytes += nodeBytes; continue; }
    if (node.tag === 'div' && object(node.text) && typeof node.text.content === 'string') {
      const characters = Array.from(node.text.content);
      let low = 0, high = characters.length;
      const candidate = (length: number) => ({ tag: 'div', text: { tag: 'plain_text', content: characters.slice(0, length).join('') } });
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (bytes + Buffer.byteLength(JSON.stringify(candidate(middle)), 'utf8') + 1 <= READONLY_CARD_MAX_BYTES) low = middle;
        else high = middle - 1;
      }
      if (low) body.push(candidate(low));
    }
    break;
  }
  return { ...card, elements: [...body, ...suffix] };
}

function collectIdentity(value: Record<string, unknown>, output: Set<string>): void {
  for (const [key, child] of Object.entries(value)) if (ENTITY_KEYS.has(key) && typeof child === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(child)) output.add(`${key}:${child}`);
}
function visibleText(value: unknown): string {
  let text = typeof value === 'string' ? value : object(value) && ['plain_text', 'lark_md', 'markdown'].includes(String(value.tag)) && typeof value.content === 'string' ? value.content : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  text = text.slice(0, MAX_TEXT * 2);
  text = withoutMarkdownDestinations(text).replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1');
  text = text.replace(/<(?:https?:\/\/|lark:\/\/|feishu:\/\/)[^>]*>/gi, '[链接已隐藏]').replace(/(?:https?:\/\/|lark:\/\/|feishu:\/\/|www\.)[^\s<>]+/gi, '[链接已隐藏]');
  text = text.replace(/<[^>]*>/g, '').replace(/&#(?:x[0-9a-f]+|\d+);/gi, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return text.slice(0, MAX_TEXT).trim();
}
function withoutMarkdownDestinations(text: string): string {
  let output = '', position = 0;
  while (position < text.length) {
    const open = text.indexOf('[', position), labelEnd = open < 0 ? -1 : text.indexOf('](', open + 1);
    if (open < 0 || labelEnd < 0 || text.slice(open, labelEnd).includes('\n')) return output + text.slice(position);
    output += text.slice(position, open) + text.slice(open + 1, labelEnd);
    let depth = 1, cursor = labelEnd + 2;
    for (; cursor < text.length && depth; cursor++) {
      if (text[cursor] === '\\') { cursor++; continue; }
      if (text[cursor] === '\n') break;
      if (text[cursor] === '(') depth++;
      if (text[cursor] === ')') depth--;
    }
    // Unclosed destinations are hidden through the line end as well.
    position = cursor;
  }
  return output;
}
function unsupported(): SanitizedReadonlyCard { return sanitizeReadonlyCard({ header: { title: { tag: 'plain_text', content: '卡片通知' } }, type: 'template' }); }
