// agents/screenwriter/llm.js — 「设计好的 LLM API 接口」。
// OpenAI Chat Completions 兼容的 HTTP 客户端，零第三方依赖（Node 18+ 原生 fetch）。
// 同一套代码可对接：
//   - 魔搭 API-Inference（默认）：https://api-inference.modelscope.cn/v1
//   - 阿里云 DashScope 兼容模式：https://dashscope.aliyuncs.com/compatible-mode/v1
//   - OpenAI / 本地 vLLM / Ollama 等任何 OpenAI 兼容端点
//
// 环境变量（都可覆盖默认值）：
//   LOOM_LLM_BASE_URL    API 根地址（不带 /chat/completions）
//   LOOM_LLM_API_KEY     依次回退识别 MODELSCOPE_API_KEY / DASHSCOPE_API_KEY / OPENAI_API_KEY
//   LOOM_LLM_MODEL       模型名，默认 Qwen/Qwen2.5-72B-Instruct（魔搭 API-Inference 命名）
//   LOOM_LLM_TIMEOUT_MS  单次请求超时，默认 120000

export class LlmError extends Error {
  constructor(message, { retryable = false, cause = null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.retryable = retryable;
    this.cause = cause;
  }
}

const DEFAULTS = {
  baseUrl: 'https://api-inference.modelscope.cn/v1',
  model: 'Qwen/Qwen2.5-72B-Instruct',
  timeoutMs: 120_000,
  temperature: 0.7,
  retries: 2,          // 429/5xx/网络错误的额外重试次数
  backoffMs: 1_000,    // 第 n 次重试前等待 n * backoffMs
};

/** 解析当前生效的 LLM 配置。apiKey 为空表示未配置（调用方应走离线降级）。 */
export function llmConfig(overrides = {}) {
  const env = process.env;
  const apiKey = env.LOOM_LLM_API_KEY || env.MODELSCOPE_API_KEY || env.DASHSCOPE_API_KEY || env.OPENAI_API_KEY || '';
  return {
    baseUrl: env.LOOM_LLM_BASE_URL || DEFAULTS.baseUrl,
    model: env.LOOM_LLM_MODEL || DEFAULTS.model,
    timeoutMs: Number(env.LOOM_LLM_TIMEOUT_MS) || DEFAULTS.timeoutMs,
    temperature: DEFAULTS.temperature,
    retries: DEFAULTS.retries,
    backoffMs: DEFAULTS.backoffMs,
    apiKey,
    ...overrides,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 调一次 chat/completions，返回 assistant 消息文本。
 * 只对 429 / 5xx / 网络与超时错误重试；4xx（鉴权、参数错）直接抛出。
 */
export async function chat(messages, opts = {}) {
  const cfg = llmConfig(opts);
  if (!cfg.apiKey) {
    throw new LlmError('未配置 API Key（LOOM_LLM_API_KEY / MODELSCOPE_API_KEY / DASHSCOPE_API_KEY / OPENAI_API_KEY 任一）');
  }
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = JSON.stringify({ model: cfg.model, messages, temperature: cfg.temperature });

  let lastErr = null;
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    if (attempt > 0) await sleep(attempt * cfg.backoffMs);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (e) {
      lastErr = new LlmError(`请求 ${url} 失败：${e.message}`, { retryable: true, cause: e });
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new LlmError(`HTTP ${res.status}（${res.statusText || '服务端/限流错误'}）`, { retryable: true });
      continue;
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new LlmError(`HTTP ${res.status}：${detail}`);
    }
    const data = await res.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new LlmError(`响应缺少 choices[0].message.content：${JSON.stringify(data).slice(0, 300)}`);
    }
    return content;
  }
  throw lastErr ?? new LlmError('LLM 调用失败');
}

/**
 * 从模型回复里提取 JSON 对象：优先取 ```json 围栏，其次取首个 { 到末个 } 的片段。
 * 解析失败抛 LlmError（不可重试——同一文本再解析一次结果一样，由调用方决定是否找模型纠正）。
 */
export function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new LlmError('模型输出中找不到 JSON 对象');
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (e) {
    throw new LlmError(`JSON 解析失败：${e.message}`, { cause: e });
  }
}
