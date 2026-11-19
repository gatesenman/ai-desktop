import type { ChatMessage, Settings } from '../shared/types';

export function aiConfigured(s: Settings): boolean {
  const { baseURL, apiKey, model } = s.ai;
  if (!baseURL || !model) return false;
  return !!apiKey || /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseURL);
}

function endpoint(s: Settings): string {
  let base = s.ai.baseURL.trim().replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  return base + '/chat/completions';
}

function headers(s: Settings): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (s.ai.apiKey) h.Authorization = `Bearer ${s.ai.apiKey.trim()}`;
  return h;
}

export class AIError extends Error {}

export async function chatComplete(s: Settings, messages: ChatMessage[], opts: { json?: boolean; timeoutMs?: number } = {}): Promise<string> {
  if (!aiConfigured(s)) throw new AIError('未配置 AI：请在「设置」中填写 API 地址、Key 和模型');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60000);
  try {
    const body: any = { model: s.ai.model, messages, temperature: s.ai.temperature, stream: false };
    const res = await fetch(endpoint(s), { method: 'POST', headers: headers(s), body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new AIError(`AI 接口错误 ${res.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    return data?.choices?.[0]?.message?.content ?? '';
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new AIError('AI 请求超时');
    if (e instanceof AIError) throw e;
    throw new AIError('AI 请求失败：' + (e?.message ?? String(e)));
  } finally {
    clearTimeout(timer);
  }
}

export async function chatStream(
  s: Settings,
  messages: ChatMessage[],
  onDelta: (d: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!aiConfigured(s)) throw new AIError('未配置 AI：请在「设置」中填写 API 地址、Key 和模型');
  const res = await fetch(endpoint(s), {
    method: 'POST',
    headers: headers(s),
    body: JSON.stringify({ model: s.ai.model, messages, temperature: s.ai.temperature, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '');
    throw new AIError(`AI 接口错误 ${res.status}: ${t.slice(0, 300)}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    // server ignored stream=true
    const data: any = await res.json();
    onDelta(data?.choices?.[0]?.message?.content ?? '');
    return;
  }
  const reader = (res.body as any).getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const j = JSON.parse(payload);
        const d = j?.choices?.[0]?.delta?.content;
        if (d) onDelta(d);
      } catch {
        /* ignore partial */
      }
    }
  }
}

/** Extract the first JSON object/array from an LLM reply (handles ```json fences). */
export function extractJSON<T = any>(text: string): T | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fence?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.search(/[[{]/);
    if (start < 0) continue;
    const open = c[start];
    const close = open === '{' ? '}' : ']';
    const end = c.lastIndexOf(close);
    if (end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {
      /* try next */
    }
  }
  return null;
}

/** OpenAI-compatible /embeddings (Ollama, SiliconFlow, OpenAI…). Returns one vector per input. */
export async function embed(s: Settings, model: string, input: string[], timeoutMs = 30000): Promise<number[][]> {
  if (!aiConfigured(s) || !model) throw new AIError('未配置向量模型');
  const base = s.ai.baseURL.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base + '/embeddings', { method: 'POST', headers: headers(s), body: JSON.stringify({ model, input }), signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new AIError(`向量接口错误 ${res.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    return (data?.data ?? []).map((d: any) => d.embedding as number[]);
  } finally {
    clearTimeout(timer);
  }
}
