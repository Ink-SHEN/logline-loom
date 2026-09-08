// tools/agent.mjs — 共享「Agent 调用管线」。agents/README.md 第二节、第四节指名的共享部分：
//
//   1. LLM 客户端（OpenAI Chat Completions 兼容，零第三方依赖，Node 18+ 原生 fetch）——
//      同一份代码可对接魔搭 API-Inference（默认）/ DashScope 兼容模式 / OpenAI / 本地 vLLM / Ollama。
//      这是 ①②③⑤⑦ 各自 agents/<slug>/llm.js 副本的**唯一正本**：五份 llm.js 现已改为
//      从这里再导出的薄壳（README 第四节「它入库后去重」已兑现；进 agents/* 前请改 tools/ 这边）。
//   2. runAgent()——通用「一次创作性 LLM 调用 + 结构回灌纠错 + 离线降级」管线，
//      给不落在七站之内的创意任务 / 未来新工位用（七站本体走各自的 run.js，逐站可独立执行）。
//   3. findPython() / pythonValidateDoc()——python 契约校验的共享助手（studio.mjs --approve 用）。
//      各 agents/*/run.js 里还各带一份自包含副本，语义与失败口径各异（⑤ 与 ④ 的 ffprobe 语义
//      相反、合不成一个模块的先例见 agents/qa/run.js:266），后续合并时以本站为准、逐站核对。
//
// 本文件不 import agents/* 的任何模块——agents/*/llm.js 的薄壳再导出它，反向依赖会成环。
//
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * content 既可以是字符串（纯文本比对），也可以是 OpenAI 视觉格式的分段数组
 * （[{type:'text'},{type:'image_url',image_url:{url:'data:image/jpeg;base64,...'}}]）——
 * ⑤质检 的 agents/qa/vision.js 抽帧后走后者，本客户端不需要为视觉另开一套。
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

// ——— runAgent()：通用创作性调用管线 ———

/**
 * 跑一次「人格 + 输入 → JSON 产物」的完整调用：先 chat()，再按 validate() 的清单
 * 回灌纠正一轮（结构不过别让同一份坏 JSON 进下游），仍不过时按 fallback 降级而不是崩。
 *
 * @param {object} options
 * @param {string} options.name          工位名（log 前缀，如 '提示词'）
 * @param {string} options.systemPrompt  prompt.js 导出的人格
 * @param {string|object|any[]} options.input  用户消息：对象/数组会自动 JSON.stringify，字符串原样
 * @param {function} [options.extract]   文本→JSON，默认 extractJson
 * @param {function} [options.validate]  (doc)=>string[]｜null：结构问题清单（契约检查），空=放行
 * @param {string|function} [options.sample]  离线示例（JSON 字符串或对象，或 () => 产物的函数）。
 *                                           未配 Key / --offline / 纠正仍不过时降级返回它
 * @param {string} [options.fallbackReason]  降级时写进日志与返回值的固定理由文案
 * @param {string} [options.model]       覆盖 LOOM_LLM_MODEL（只影响本次）
 * @param {number} [options.temperature] 覆盖默认温度
 * @param {number} [options.maxCorrections] 结构不过时的回灌纠正次数，默认 1
 * @param {boolean} [options.offline]    不调 LLM，直接用 sample 降级
 * @param {function} [options.log]       默认 console.log
 * @returns {Promise<{doc: object, text: string|null, usedFallback: boolean, reason: string|null,
 *                    retried: boolean, problems: string[]}>}
 */
export async function runAgent(options = {}) {
  const log = options.log ?? ((m) => console.log(m));
  const name = options.name ?? 'Agent';
  const offline = options.offline === true;
  const extract = options.extract ?? extractJson;
  const maxCorrections = Number.isInteger(options.maxCorrections) ? options.maxCorrections : 1;

  /** 解析降级产物：sample 可以是 JSON 字符串 / 对象 / 返回其一或 null 的函数（null=无降级物）。 */
  const resolveSample = () => {
    if (options.sample === undefined) return null;
    const v = typeof options.sample === 'function' ? options.sample() : options.sample;
    if (typeof v === 'string') return JSON.parse(v);
    return v;
  };

  const reason = offline
    ? (options.fallbackReason ?? '按 --offline 要求不调用 LLM')
    : null;
  if (offline) {
    const doc = resolveSample();
    log(`[${name}] ${reason}`);
    if (doc === null) throw new LlmError('runAgent: --offline 且没有 sample 可降级');
    return { doc, text: null, usedFallback: true, reason, retried: false, problems: [] };
  }

  const cfg = llmConfig({ model: options.model, temperature: options.temperature });
  if (!cfg.apiKey) {
    const doc = resolveSample();
    log(`[${name}] 未配置 API Key，降级使用离线示例（sample.js）；配置后重跑可拿真实产物`);
    if (doc === null) throw new LlmError('未配置 API Key，且没有 sample 可降级');
    return { doc, text: null, usedFallback: true, reason: '未配置 API Key', retried: false, problems: [] };
  }

  const input =
    typeof options.input === 'string' ? options.input : JSON.stringify(options.input, null, 2);
  const messages = [
    { role: 'system', content: options.systemPrompt },
    { role: 'user', content: input },
  ];

  let text = null;
  let doc = null;
  let problems = [];
  let corrected = false; // 出过至少一轮「结构不过 → 回灌纠正」
  for (let attempt = 0; attempt <= maxCorrections; attempt++) {
    text = await chat(messages, { model: options.model, temperature: options.temperature });
    doc = extract(text);
    problems = options.validate ? (options.validate(doc) ?? []) : [];
    if (!problems.length) break;
    log(`[${name}] 结构不过（第 ${attempt + 1} 次）：${problems[0]}${problems.length > 1 ? ` 等 ${problems.length} 处` : ''}`);
    if (attempt < maxCorrections) {
      corrected = true;
      messages.push(
        { role: 'assistant', content: text },
        { role: 'user', content: `你的输出结构不合法：\n- ${problems.join('\n- ')}\n\n只输出修正后的完整 JSON，不要解释。` },
      );
    }
  }

  if (problems.length) {
    const doc = resolveSample();
    const why = `结构纠正 ${maxCorrections} 轮仍不过：${problems.join('；')}`;
    if (doc === null) throw new LlmError(`${why}（且没有 sample 可降级）`);
    log(`[${name}] ${why}，降级使用离线示例（sample.js）`);
    return { doc, text, usedFallback: true, reason: why, retried: corrected, problems };
  }
  return { doc, text, usedFallback: false, reason: null, retried: corrected, problems: [] };
}

// ——— python 契约校验（studio.mjs --approve 用；各 run.js 的副本语义见文件头） ———

/** 仓库根：与各 agents 下 run.js 里的 REPO_ROOT 同一定义。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let cachedPython = null;
function findPython() {
  if (cachedPython !== null) return cachedPython;
  for (const cand of ['python', 'py', 'python3']) {
    try {
      const r = spawnSync(cand, ['--version'], { encoding: 'utf8', timeout: 10_000 });
      if (!r.error && r.status === 0) {
        cachedPython = cand;
        return cand;
      }
    } catch { /* 试下一个 */ }
  }
  return null;
}

/**
 * 跑权威校验器校验一份契约产物。
 * 返回 null = python/jsonschema 不可用（调用方决定降级策略）；
 * 否则 { code: 0|1|2, out }——与 validate_contract.py 的退出码口径一致（0 通过 / 1 不通过 / 2 用法错）。
 */
export function pythonValidateDoc(path, contract) {
  const py = findPython();
  if (!py) return null;
  const r = spawnSync(py, ['contracts/validate_contract.py', '--contract', contract, '--file', path], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error) return null;
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}
