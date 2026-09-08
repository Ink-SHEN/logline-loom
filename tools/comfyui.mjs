// tools/comfyui.mjs — ComfyUI HTTP API 客户端（共享正本，零第三方依赖，Node 18+ 原生 fetch）。
// ④生成 的 agents/generator/comfyui.js 已改为从这里再导出的薄壳（agents/README.md 第四节：
// 共享客户端落 tools/ 后去重），agents/generator/{run,index}.js 的既有 import 不用动。
//
// 只封装 docs/node_baseline.md 第七节列出的那几个接口，每个都对应流水线里一个真实动作：
//   GET  /system_stats      开工前确认隧道通、模型常驻（--highvram）
//   GET  /queue             提交前后各查一次（docs/gpu_protocol.md 第七节）；R2V 不许插进 FL2VA 批次
//   GET  /api/object_info/<class>  素材上传后重查 LoadImage.image 枚举，确认文件名真的在节点上
//   POST /upload/image      参考图 / 首帧上传（R2V、I2V 必经，否则报 Value not in list: image）
//   POST /prompt            提交生成（图是内联发送的）
//   GET  /history/<id>      轮询结果、取产物文件名、取 execution_start/success 时间戳与缓存节点数
//   GET  /view              把产物下载回仓库（ComfyUI 的 output/ 不在本仓库里）
//
// ComfyUI 完全没有鉴权，所以地址只走环境变量 / 命令行，绝不写进仓库（.gitignore 已排除 comfy_endpoint.txt）。

import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:8188';

/** 当前生效的节点地址。优先级：显式传入 > LOOM_COMFY_URL > 默认回环地址。 */
export function comfyEndpoint(override) {
  const url = override || process.env.LOOM_COMFY_URL || DEFAULT_ENDPOINT;
  return url.replace(/\/+$/, '');
}

export class ComfyError extends Error {
  constructor(message, { retryable = false, cause = null, status = null } = {}) {
    super(message);
    this.name = 'ComfyError';
    this.retryable = retryable;
    this.cause = cause;
    this.status = status;
  }
}

const TUNNEL_HINT = `连不上 ComfyUI。三件事按顺序查（docs/node_baseline.md 第二节）：
  1. 节点上服务在跑吗：python main.py --listen 127.0.0.1 --port 8188 --highvram --preview-method auto
  2. 隧道通吗：ssh -L 8188:127.0.0.1:8188 <节点>（断了的表现就是本地 curl 返回 000、netstat 里 8188 无监听，
     此时可能还残留一个不转发的 ssh.exe 进程，先杀掉再重连）
  3. 地址对吗：当前用的是 %URL%（可用 --endpoint 或 LOOM_COMFY_URL 覆盖）
  没有节点也能开工：加 --dry-run 只出「提交计划 + 填好的工作流图」，不 POST、不落 c05。`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(endpoint, path, { method = 'GET', body, headers, timeoutMs, raw = false } = {}) {
  const url = endpoint + path;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new ComfyError(
      timedOut
        ? `请求 ${url} 超时（${timeoutMs}ms）`
        : `请求 ${url} 失败：${e.message}\n${TUNNEL_HINT.replace('%URL%', endpoint)}`,
      { retryable: true, cause: e },
    );
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 600);
    throw new ComfyError(`HTTP ${res.status} ${url}：${detail}`, { status: res.status, retryable: res.status >= 500 });
  }
  if (raw) return res;
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ComfyError(`${url} 返回的不是合法 JSON：${text.slice(0, 300)}`);
  }
}

/** GET /system_stats：开工前确认节点活着，顺带拿统一内存余量（vram_total == ram_total 是正常表现）。 */
export async function getSystemStats(cfg) {
  return request(cfg.endpoint, '/system_stats', { timeoutMs: cfg.timeoutMs });
}

/** GET /queue：{ queue_running: [...], queue_pending: [...] }。 */
export async function getQueue(cfg) {
  const data = await request(cfg.endpoint, '/queue', { timeoutMs: cfg.timeoutMs });
  return {
    running: Array.isArray(data?.queue_running) ? data.queue_running : [],
    pending: Array.isArray(data?.queue_pending) ? data.queue_pending : [],
  };
}

/**
 * GET /api/object_info/<class>（旧版路由 /object_info/<class> 兜底，与 workflows/preflight.py 同一口径）。
 * 取不到时返回 null，不抛——调用方自己决定是阻塞还是告警。
 */
export async function getObjectInfo(cfg, classType) {
  for (const path of [`/api/object_info/${classType}`, `/object_info/${classType}`]) {
    try {
      const data = await request(cfg.endpoint, path, { timeoutMs: cfg.timeoutMs });
      if (data && data[classType]) return data[classType];
    } catch (e) {
      if (!(e instanceof ComfyError) || e.status !== 404) throw e;
    }
  }
  return null;
}

/**
 * 从 object_info 里取出某个输入的枚举可选值。
 * ComfyUI 的写法有三种（与 workflows/preflight.py 的 allowed_values 同一口径）：
 *   基本类型 ["STRING", {...}] / ["INT", {...}]（不是枚举，返回 null）
 *   旧枚举   [["optA","optB"], {...}]
 *   新枚举   ["COMBO", {"options": [...]}]
 * 注意选项里可能混有整数（CreateVideo.bit_depth = ["auto", 8, 10]），只筛字符串会把合法的 8 判成非法。
 */
export function allowedValues(spec) {
  if (!Array.isArray(spec) || !spec.length) return null;
  const head = spec[0];
  let opts = null;
  if (Array.isArray(head)) opts = head;
  else if (typeof head === 'string' && head.toUpperCase() === 'COMBO' && typeof spec[1] === 'object' && spec[1]) opts = spec[1].options;
  if (!Array.isArray(opts)) return null;
  const vals = opts.filter((x) => (typeof x === 'string' || typeof x === 'number') && typeof x !== 'boolean');
  return vals.length ? vals : null;
}

/** POST /upload/image：把素材传到节点 input/，返回 { name, subfolder, type }。 */
export async function uploadImage(cfg, filePath, { overwrite = true, type = 'input' } = {}) {
  let blob;
  try {
    blob = await openAsBlob(filePath);
  } catch (e) {
    throw new ComfyError(`读取素材失败 ${filePath}：${e.message}`, { cause: e });
  }
  const form = new FormData();
  form.append('image', blob, basename(filePath));
  form.append('overwrite', overwrite ? 'true' : 'false');
  form.append('type', type);
  return request(cfg.endpoint, '/upload/image', { method: 'POST', body: form, timeoutMs: cfg.uploadTimeoutMs });
}

/** POST /prompt：内联发送整张图，返回 { prompt_id, number, node_errors }。 */
export async function postPrompt(cfg, graph, { clientId } = {}) {
  const payload = { prompt: graph };
  if (clientId) payload.client_id = clientId;
  const data = await request(cfg.endpoint, '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: cfg.timeoutMs,
  });
  if (!data || typeof data.prompt_id !== 'string') {
    throw new ComfyError(`POST /prompt 没返回 prompt_id：${JSON.stringify(data).slice(0, 400)}`);
  }
  return data;
}

/** GET /history/<prompt_id>：还没跑完时返回 null（ComfyUI 对未知 id 返回 {}）。 */
export async function getHistoryRecord(cfg, promptId) {
  const data = await request(cfg.endpoint, `/history/${promptId}`, { timeoutMs: cfg.timeoutMs });
  const record = data && typeof data === 'object' ? data[promptId] : null;
  return record ?? null;
}

/**
 * 轮询到跑完为止。返回 { record, waitedMs, polls }。
 * 超时不删任务（它还在节点队列里），只抛错并给出 prompt_id 让人事后 GET /history 取回。
 */
export async function waitForHistory(cfg, promptId, { timeoutMs, pollMs, onPoll } = {}) {
  const started = Date.now();
  let polls = 0;
  for (;;) {
    const record = await getHistoryRecord(cfg, promptId);
    polls++;
    if (record) {
      const statusStr = record?.status?.status_str;
      if (statusStr === 'success' || statusStr === 'error' || record?.status?.completed === true) {
        return { record, waitedMs: Date.now() - started, polls };
      }
    }
    if (Date.now() - started > timeoutMs) {
      throw new ComfyError(
        `等待 ${promptId} 超时（${Math.round(timeoutMs / 1000)}s，轮询 ${polls} 次）。任务可能还在节点上跑：
  curl -s ${cfg.endpoint}/history/${promptId}     # 事后取回
  curl -s ${cfg.endpoint}/queue                  # 看还在不在队列
拿到结果后可用 --from-history ${promptId} 只补落盘与 c05，不必重新烧一轮 GPU。`,
        { retryable: true },
      );
    }
    if (onPoll) onPoll({ polls, waitedMs: Date.now() - started, record });
    await sleep(pollMs);
  }
}

/**
 * GET /view：把产物下载回本地。ComfyUI 的 output/ 目录不在本仓库里，
 * 归档口径是 shots/<candidate_id>/video.<ext>（docs/decisions/2026-09-07-editor-input-conventions.md）。
 */
export async function downloadView(cfg, { filename, subfolder = '', type = 'output' }, destPath) {
  const { writeFile } = await import('node:fs/promises');
  const qs = new URLSearchParams({ filename, subfolder, type });
  const res = await request(cfg.endpoint, `/view?${qs.toString()}`, { timeoutMs: cfg.downloadTimeoutMs, raw: true });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new ComfyError(`GET /view 返回空内容：${filename}`);
  await writeFile(destPath, buf);
  return buf.length;
}

/**
 * 从 /history 记录里解析出关键事实。全部按 docs/node_baseline.md 第六节的实测结构取，
 * 三个坑都躲开了：视频产物在 images 键下、images 是列表套字典、execution_cached 里会出现复合节点 ID。
 * 返回 { statusStr, completed, files:[{node,filename,subfolder,type}], cachedNodes:[], startMs, endMs, elapsedSeconds }
 */
export function parseHistoryRecord(record) {
  const out = {
    statusStr: record?.status?.status_str ?? null,
    completed: record?.status?.completed === true,
    files: [],
    cachedNodes: [],
    startMs: null,
    endMs: null,
    elapsedSeconds: null,
    messages: [],
  };
  const outputs = record?.outputs;
  if (outputs && typeof outputs === 'object') {
    for (const [nodeId, block] of Object.entries(outputs)) {
      if (!block || typeof block !== 'object') continue;
      // 视频也叫 images，而且是【列表】。按 isinstance(block, dict) and 'filename' in block 判断会全部漏掉
      for (const key of ['images', 'videos', 'gifs']) {
        const list = block[key];
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          if (item && typeof item === 'object' && typeof item.filename === 'string') {
            out.files.push({
              node: nodeId,
              filename: item.filename,
              subfolder: typeof item.subfolder === 'string' ? item.subfolder : '',
              type: typeof item.type === 'string' ? item.type : 'output',
            });
          }
        }
      }
    }
  }
  const messages = record?.status?.messages;
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!Array.isArray(m) || m.length < 2) continue;
      const [kind, data] = m;
      out.messages.push({ kind, data });
      if (kind === 'execution_start' && typeof data?.timestamp === 'number') out.startMs = data.timestamp;
      if (kind === 'execution_success' && typeof data?.timestamp === 'number') out.endMs = data.timestamp;
      if (kind === 'execution_cached' && Array.isArray(data?.nodes)) out.cachedNodes = data.nodes;
    }
  }
  // 耗时用节点侧时间戳差值，不用墙钟——不受时区与本机时钟影响（docs/gpu_protocol.md 第四节）
  if (out.startMs !== null && out.endMs !== null) out.elapsedSeconds = Math.round(((out.endMs - out.startMs) / 1000) * 10) / 10;
  return out;
}

/** epoch 毫秒 → 本地时区 ISO 字符串（c05 的 timing 字段要 date-time 格式）。 */
export function msToIso(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return new Date().toISOString();
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const local = new Date(d.getTime() + off * 60_000);
  return `${local.toISOString().slice(0, 19)}${sign}${pad(Math.floor(off / 60))}:${pad(off % 60)}`;
}

/** 解析并校验节点地址配置。timeoutMs 是普通请求，生成与下载各有更长的独立超时。 */
export function comfyConfig(options = {}) {
  return {
    endpoint: comfyEndpoint(options.endpoint),
    timeoutMs: options.timeoutMs ?? 30_000,
    uploadTimeoutMs: options.uploadTimeoutMs ?? 120_000,
    downloadTimeoutMs: options.downloadTimeoutMs ?? 300_000,
    pollMs: options.pollMs ?? 5_000,
    waitTimeoutMs: options.waitTimeoutMs ?? 45 * 60_000, // 冷启动 636s + 余量；见 docs/gpu_protocol.md 第四节
    clientId: options.clientId ?? null,
  };
}
