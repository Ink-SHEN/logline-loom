#!/usr/bin/env node
// agents/screenwriter/run.js — 「①编剧」Agent 可执行入口（消费 c01_brief，产出 c02_screenplay）。
//
// 输入：一句 logline（必填）+ 可选 theme / 目标时长 / 画幅 / 视觉与声音风格 / 人物形象 / 红线，
//       或直接 --brief 指定一份现成的 c01_brief JSON。
// 输出：c02_screenplay 剧本 JSON 落盘 artifacts/，envelope 与 gate 由代码统一规范化，
//       并自动过 contracts/validate_contract.py 结构校验（gate 恒留 pending，批准是人的事）。
// LLM：经 llm.js 的 OpenAI 兼容 API 接入；未配 Key 或调用失败时降级 sample.js，流水线不断。
//
// 用法：node agents/screenwriter/run.js --help

import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENT_VERSION, SCREENWRITER } from './prompt.js';
import { sampleScript } from './sample.js';
import { LlmError, chat, extractJson, llmConfig } from './llm.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'validate_contract.py');

// 取值全部照抄 contracts/film_agent_contracts.json，不要在这里发明新值
const ASPECT_RATIOS = [
  '1:1 (Square)', '2:3 (Portrait Photo)', '3:2 (Photo)', '3:4 (Portrait Standard)',
  '4:3 (Standard)', '9:16 (Portrait Widescreen)', '16:9 (Widescreen)', '21:9 (Ultrawide)',
];
const TIME_ENUM = ['dawn', 'day', 'dusk', 'night', 'timeless'];
const LANG_ENUM = ['zh', 'en', 'none'];
const DEFAULT_RED_LINES = [
  '不得出现《黑客帝国》《银翼杀手2049》《2001太空漫游》《星际穿越》的角色、台词、造型、剧照与片名',
  '不得出现真实企业或机构的标识',
  '不得出现未成年人',
  '不得使用未授权的第三方素材',
];

class UsageError extends Error {}

const rel = (p) => relative(REPO_ROOT, p).replaceAll('\\', '/');
const makeStamp = (d) => d.toISOString().slice(0, 19).replace(/[-:]/g, ''); // 20260906T043012

function usage() {
  console.log(`「①编剧」Agent — 消费 c01_brief，产出 c02_screenplay

用法：
  node agents/screenwriter/run.js --logline "一句话故事（必填，20–400 字）" [选项]
  node agents/screenwriter/run.js --brief artifacts/brief_v1.json [选项]

选项：
  --logline <文本>         必填（除非 --brief）。一句话故事：一个人 + 一个空间 + 一件小事
  --theme <文本>           主题，默认「用 AI，提前看见未来」
  --duration <秒>          目标时长 60–300，默认 150
  --aspect-ratio <值>      画幅，默认 "16:9 (Widescreen)"（本项目已锁定），合法值见契约 aspect_ratio 枚举
  --visual-style <文本>    视觉风格锚点，下游镜头提示词向它对齐
  --audio-style <文本>     声音风格（H3 原生出声，声音叙事是强项，建议单独定调）
  --character <json|文本>  人物形象：JSON（name/appearance/want/obstacle）或纯文本（按 appearance 处理）
  --red-lines <a;b;c>      红线清单，分号分隔，默认为大赛已知硬红线
  --brief <路径>           直接指定现成 c01_brief JSON（envelope+payload 或裸 payload 均可）
  --out <路径>             剧本输出路径，默认 artifacts/screenplay_<时间戳>.json
  --model <名称>           覆盖 LOOM_LLM_MODEL
  --offline                不调 LLM，直接用 sample.js 离线示例
  --no-validate            跳过 python 契约校验（不建议）
  -h, --help               显示本帮助

LLM 接入（OpenAI 兼容 API，详见 llm.js）：
  LOOM_LLM_BASE_URL / LOOM_LLM_API_KEY / LOOM_LLM_MODEL
  未配 Key 或调用失败时自动降级离线示例，流水线不中断。`);
}

function parseArgs(argv) {
  const out = { validate: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) throw new UsageError(`多余的位置参数：${a}（见 --help）`);
    const eq = a.indexOf('=');
    let key = a;
    let inline = null;
    if (eq !== -1) { key = a.slice(0, eq); inline = a.slice(eq + 1); }
    const need = () => {
      if (inline !== null) return inline;
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${key} 缺少参数值`);
      return v;
    };
    switch (key) {
      case '--logline': out.logline = need(); break;
      case '--theme': out.theme = need(); break;
      case '--duration': out.duration = Number(need()); break;
      case '--aspect-ratio': out.aspectRatio = need(); break;
      case '--visual-style': out.visualStyle = need(); break;
      case '--audio-style': out.audioStyle = need(); break;
      case '--character': out.character = need(); break;
      case '--red-lines': out.redLines = need(); break;
      case '--brief': out.brief = need(); break;
      case '--out': out.out = need(); break;
      case '--model': out.model = need(); break;
      case '--offline': out.offline = true; break;
      case '--no-validate': out.validate = false; break;
      case '-h': case '--help': out.help = true; break;
      default: throw new UsageError(`未知参数 ${a}（见 --help）`);
    }
  }
  if (!Number.isNaN(out.duration) && out.duration !== undefined && !(out.duration >= 60 && out.duration <= 300)) {
    throw new UsageError(`目标时长须在 60–300 秒之间（契约 c01 硬要求），收到：${out.duration}`);
  }
  return out;
}

function resolveAspect(v) {
  if (ASPECT_RATIOS.includes(v)) return v;
  const hits = ASPECT_RATIOS.filter((r) => r.startsWith(`${v} (`) || r.startsWith(`${v}(`));
  if (hits.length === 1) return hits[0]; // 允许只写 "16:9"，自动补全括号后缀
  throw new UsageError(`画幅不合法：${v}\n合法值：${ASPECT_RATIOS.join(' / ')}`);
}

function parseCharacter(v) {
  const s = v.trim();
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch { /* 不是 JSON，按纯文本处理 */ }
  return { name: '主角', appearance: s };
}

function parseRedLines(v) {
  const list = v.split(/[;；]/).map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_RED_LINES;
}

/** 从 CLI 字段构建 c01_brief（人工现场输入即源头产物），可选项缺省值按契约补齐。 */
function buildBriefDoc(args, stamp) {
  const logline = (args.logline ?? '').trim();
  if (!logline) throw new UsageError('缺少必填输入 --logline（一句话故事，契约要求 20–400 字），见 --help');
  if (logline.length < 20 || logline.length > 400) {
    throw new UsageError(`logline 长度 ${logline.length} 不满足契约 c01 的 20–400 字要求`);
  }
  const payload = {
    logline,
    theme: args.theme?.trim() || '用 AI，提前看见未来',
    target_duration_seconds: args.duration ?? 150,
    aspect_ratio: resolveAspect(args.aspectRatio || '16:9 (Widescreen)'),
    visual_style: args.visualStyle?.trim() || '冷色调电影质感，单一空间叙事，以屏幕辉光与光影变化为主要光源，特写与空镜为主',
    red_lines: args.redLines ? parseRedLines(args.redLines) : DEFAULT_RED_LINES,
  };
  if (args.audioStyle?.trim()) payload.audio_style = args.audioStyle.trim();
  if (args.character) payload.main_character = parseCharacter(args.character);
  return {
    envelope: {
      schema_version: '1.0',
      artifact_id: `brief.${stamp}`,
      contract: 'c01_brief',
      created_at: new Date().toISOString(),
      producer: { kind: 'human', name: 'CLI 人工输入（run.js 组装）' },
      upstream_refs: [],
      notes: '未提供的可选项由 run.js 按契约默认值补齐',
    },
    payload,
  };
}

function loadBriefFile(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UsageError(`无法读取/解析片约文件 ${path}：${e.message}`);
  }
  if (raw?.payload?.logline) return raw; // 完整 c01（envelope + payload）
  if (raw?.logline) {
    return { // 裸 payload，补一层 envelope 以便追溯
      envelope: {
        schema_version: '1.0',
        artifact_id: 'brief.file',
        contract: 'c01_brief',
        created_at: new Date().toISOString(),
        producer: { kind: 'human', name: '外部片约文件' },
        upstream_refs: [],
        notes: `来自 ${path}`,
      },
      payload: raw,
    };
  }
  throw new UsageError(`${path} 里没有 payload.logline，不是有效的 c01_brief`);
}

/** 全部 beat 都有 estimated_seconds 时重算加总；越界或缺数据时宁缺毋滥（该字段可选）。 */
function recalcTotal(payload) {
  const inRange = (n) => n >= 60 && n <= 300;
  const beats = (payload.scenes ?? []).flatMap((s) => s.beats ?? []);
  const timed = beats.filter((b) => typeof b.estimated_seconds === 'number');
  if (beats.length && timed.length === beats.length) {
    const sum = timed.reduce((acc, b) => acc + b.estimated_seconds, 0);
    if (inRange(sum)) payload.total_estimated_seconds = sum;
    else delete payload.total_estimated_seconds;
  } else if (typeof payload.total_estimated_seconds === 'number' && !inRange(payload.total_estimated_seconds)) {
    delete payload.total_estimated_seconds;
  }
}

/**
 * 规范化模型产物：envelope 五个必填项与 gate 由代码接管（确定性字段不交给概率模型），
 * 兼容模型只回 payload 层的情况。gate 一律落回 pending——剧本确认留给人点，
 * 模型写了 approved 也会被抹掉（docs/agent_guide.md 第七节的坑）。
 */
function normalize(raw, { briefId, stamp, notes = '' }) {
  let payload = null;
  if (raw && typeof raw === 'object') {
    payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : (Array.isArray(raw.scenes) ? raw : null);
  }
  if (!payload) throw new LlmError('输出缺少 payload（或顶层 scenes），无法规范化');
  recalcTotal(payload);
  payload.gate = {
    required: true,
    status: 'pending',
    reviewer: null,
    reviewed_at: null,
    reason: '剧本确认——强制人工关口，批准前②分镜 Agent 必须阻塞',
  };
  return {
    envelope: {
      schema_version: '1.0',
      artifact_id: `screenplay.${stamp}`,
      contract: 'c02_screenplay',
      created_at: new Date().toISOString(),
      producer: { kind: 'agent', name: 'screenwriter_agent', agent_version: AGENT_VERSION },
      upstream_refs: briefId ? [briefId] : [],
      notes,
    },
    payload,
  };
}

/** JS 侧结构自检（python 校验器不可用时的兜底；字段与 c02_screenplay 契约一一对应）。 */
function structuralCheck(doc) {
  const p = [];
  if (!doc || typeof doc !== 'object') return ['产物不是 JSON 对象'];
  if (!doc.envelope || !doc.payload) p.push('缺 envelope/payload 外壳');
  const payload = doc.payload;
  if (!payload) return p;
  if (!Array.isArray(payload.scenes) || !payload.scenes.length) {
    p.push('payload.scenes 必须是非空数组');
  } else {
    payload.scenes.forEach((s, i) => {
      if (!/^SC[0-9]{2}$/.test(s.scene_id ?? '')) p.push(`scenes[${i}].scene_id 须形如 SC01`);
      if (!s.location) p.push(`scenes[${i}].location 缺失`);
      if (!TIME_ENUM.includes(s.time_of_day)) p.push(`scenes[${i}].time_of_day 须为 ${TIME_ENUM.join('/')}`);
      if (!s.summary || s.summary.length < 5) p.push(`scenes[${i}].summary 缺失或少于 5 字`);
      if (!Array.isArray(s.characters)) p.push(`scenes[${i}].characters 须为数组（无人物给 []）`);
      if (!Array.isArray(s.beats) || !s.beats.length) p.push(`scenes[${i}].beats 必须是非空数组`);
      else s.beats.forEach((b, j) => {
        if (!Number.isInteger(b.order) || b.order < 1) p.push(`scenes[${i}].beats[${j}].order 须为 ≥1 的整数`);
        if (!b.action || b.action.length < 3) p.push(`scenes[${i}].beats[${j}].action 缺失或少于 3 字`);
        if (b.estimated_seconds != null && (b.estimated_seconds < 1 || b.estimated_seconds > 60)) {
          p.push(`scenes[${i}].beats[${j}].estimated_seconds 超出 1–60`);
        }
      });
    });
  }
  if (!Array.isArray(payload.emotion_curve) || payload.emotion_curve.length < 2) {
    p.push('emotion_curve 至少 2 项');
  } else {
    payload.emotion_curve.forEach((e, i) => {
      if (!e.beat) p.push(`emotion_curve[${i}].beat 缺失`);
      if (typeof e.intensity !== 'number' || e.intensity < 0 || e.intensity > 1) p.push(`emotion_curve[${i}].intensity 须为 0–1`);
    });
  }
  if (!LANG_ENUM.includes(payload.dialogue_language)) p.push(`dialogue_language 须为 ${LANG_ENUM.join('/')}`);
  if (payload.total_estimated_seconds != null && (payload.total_estimated_seconds < 60 || payload.total_estimated_seconds > 300)) {
    p.push('total_estimated_seconds 超出 60–300（该字段可选，越界应删除）');
  }
  if (!payload.gate || typeof payload.gate.required !== 'boolean' || !payload.gate.status) {
    p.push('payload.gate 缺失或不全（required + status 必填）');
  }
  return p;
}

let cachedPython;
function findPython() {
  if (cachedPython !== undefined) return cachedPython;
  cachedPython = null;
  for (const cmd of ['python', 'py', 'python3']) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) { cachedPython = cmd; break; }
  }
  return cachedPython;
}

/**
 * 调 contracts/validate_contract.py（唯一权威校验器，不在 JS 里复刻 Schema）。
 * 返回 null = 环境不可用；{code:0} 通过 / {code:1} 不通过 / {code:2} 用法或环境错。
 * --report 重定向到临时文件，避免覆盖 git 里已跟踪的 contracts/validate_report.txt。
 */
function pythonValidate(file, contract) {
  const py = findPython();
  if (!py) return null;
  const report = join(tmpdir(), `loom_report_${process.pid}_${Date.now()}.txt`);
  const r = spawnSync(py, [VALIDATOR, '--contract', contract, '--file', file, '--report', report], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  rmSync(report, { force: true });
  if (r.error || r.status === null) return null;
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

/**
 * 真实产物 gate 恒为 pending（直接校验必报「人工关口未通过」，这正是设计意图）。
 * 结构校验因此用一份 gate=approved 的临时副本做——与真实产物唯一差异是 gate.status，
 * 等价于校验器 --selftest 的 check_gates=False 语义。
 */
function validateShape(doc) {
  const copy = structuredClone(doc);
  if (copy.payload?.gate) copy.payload.gate.status = 'approved';
  const tmp = join(tmpdir(), `loom_shape_${process.pid}_${Date.now()}.json`);
  writeFileSync(tmp, JSON.stringify(copy, null, 2), 'utf8');
  try {
    return pythonValidate(tmp, 'c02_screenplay');
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** 调 LLM 生成剧本；结构不过时把问题清单回灌给模型纠正一次。 */
async function callLlm(briefDoc, { model, stamp }) {
  const briefId = briefDoc.envelope?.artifact_id;
  const chatOpts = model ? { model } : {};
  const messages = [
    { role: 'system', content: SCREENWRITER },
    {
      role: 'user',
      content: `片约（c01_brief，artifact_id=${briefId}）：\n${JSON.stringify(briefDoc.payload, null, 2)}\n\n请把它展开成完整剧本，按契约只输出一个 JSON 代码块。`,
    },
  ];
  const attempt = (text) => {
    const doc = normalize(extractJson(text), { briefId, stamp, notes: 'LLM 生成' });
    return { doc, problems: structuralCheck(doc) };
  };

  let text = await chat(messages, chatOpts);
  let first;
  try {
    first = attempt(text);
    if (!first.problems.length) return { doc: first.doc, retried: false };
  } catch (e) {
    first = { problems: [e.message] };
  }
  messages.push({ role: 'assistant', content: text });
  messages.push({
    role: 'user',
    content: `上一轮输出未通过结构校验：\n- ${first.problems.join('\n- ')}\n请按契约重新输出修正后的完整 JSON（仍只输出一个 JSON 代码块）。`,
  });
  text = await chat(messages, chatOpts);
  const second = attempt(text); // 解析失败直接抛，由调用方降级
  if (second.problems.length) {
    throw new LlmError(`纠正一轮后仍未通过结构校验：\n- ${second.problems.join('\n- ')}`);
  }
  return { doc: second.doc, retried: true };
}

/**
 * 编剧 Agent 主流程（可编程调用；CLI 只是它的一层壳）。
 * 返回 { briefPath, screenplayPath, doc, usedFallback, shapeCheck }。
 */
export async function runScreenwriter(options = {}) {
  const log = options.log ?? ((m) => console.log(m));
  const stamp = makeStamp(new Date());
  const artifactsDir = join(REPO_ROOT, 'artifacts');

  // 1) 片约：给定 c01 文件直接用；否则从 CLI 字段构建并落盘（保追溯链）
  let briefDoc;
  let briefPath;
  if (options.brief) {
    briefDoc = loadBriefFile(options.brief);
    briefPath = resolve(options.brief);
    log(`[编剧] 使用现成片约：${rel(briefPath)}（artifact_id=${briefDoc.envelope?.artifact_id}）`);
  } else {
    briefDoc = buildBriefDoc(options, stamp);
    mkdirSync(artifactsDir, { recursive: true });
    briefPath = join(artifactsDir, `brief_${stamp}.json`);
    writeFileSync(briefPath, JSON.stringify(briefDoc, null, 2) + '\n', 'utf8');
    log(`[编剧] 片约已构建并落盘：${rel(briefPath)}`);
  }
  const briefId = briefDoc.envelope?.artifact_id || 'brief.unknown';

  // 2) 上游校验：契约不过就不开工（agents/README.md 第六节——人机边界是机器拦的）
  if (options.validate !== false) {
    const r = pythonValidate(briefPath, 'c01_brief');
    if (r === null) log('[编剧] 警告：未找到可用的 python/jsonschema，跳过片约契约校验');
    else if (r.code === 1) throw new Error(`上游片约未通过 c01_brief 契约校验，编剧拒绝开工：\n${r.out}`);
    else if (r.code !== 0) log(`[编剧] 警告：片约校验未执行（退出码 ${r.code}）：\n${r.out}`);
  }

  // 3) 生成剧本：LLM → 纠正重试 → 失败降级离线示例（README 约定：保证流水线照常出片）
  let doc;
  let usedFallback = '';
  const cfg = llmConfig(options.model ? { model: options.model } : {});
  if (options.offline) {
    usedFallback = '按 --offline 要求不调用 LLM';
  } else if (!cfg.apiKey) {
    usedFallback = '未配置 LLM API Key';
  } else {
    try {
      const r = await callLlm(briefDoc, { model: options.model, stamp });
      log(`[编剧] LLM 生成成功（model=${cfg.model}${r.retried ? '，含一轮纠正重试' : ''}）`);
      doc = r.doc;
    } catch (e) {
      usedFallback = `LLM 调用失败：${e.message}`;
    }
  }
  if (usedFallback) {
    log(`[编剧] ${usedFallback}，降级使用离线示例 sample.js（内容不对应输入 logline，形状合规）`);
    doc = normalize(JSON.parse(sampleScript), { briefId, stamp, notes: `${usedFallback}；降级使用离线示例 sample.js` });
  }

  // 4) 终检 + 落盘
  const problems = structuralCheck(doc);
  if (problems.length) throw new Error(`最终产物未通过结构自检：\n- ${problems.join('\n- ')}`);
  const screenplayPath = options.out ? resolve(options.out) : join(artifactsDir, `screenplay_${stamp}.json`);
  mkdirSync(dirname(screenplayPath), { recursive: true });
  writeFileSync(screenplayPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  log(`[编剧] 剧本已落盘：${rel(screenplayPath)}（gate=pending）`);

  // 5) 权威结构校验（approved 副本，见 validateShape 注释）
  let shapeCheck = null;
  if (options.validate !== false) {
    shapeCheck = validateShape(doc);
    if (shapeCheck === null) log('[编剧] 警告：未找到可用的 python/jsonschema，只做了 JS 结构自检；提交前请手动跑 contracts/validate_contract.py');
    else if (shapeCheck.code === 1) throw new Error(`c02_screenplay 契约结构校验不通过：\n${shapeCheck.out}`);
    else if (shapeCheck.code !== 0) log(`[编剧] 警告：契约校验未执行（退出码 ${shapeCheck.code}）：\n${shapeCheck.out}`);
    else log('[编剧] c02_screenplay 契约结构校验通过');
  }

  return { briefPath, screenplayPath, doc, usedFallback: Boolean(usedFallback), shapeCheck };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[编剧] ${e.message}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) { usage(); return; }
  try {
    const result = await runScreenwriter(args);
    console.log(`[编剧] 完成：
  片约（c01_brief）：      ${rel(result.briefPath)}
  剧本（c02_screenplay）： ${rel(result.screenplayPath)}${result.usedFallback ? '\n  注意：本次为离线降级产物，仅形状合规，内容需人工重写或配好 LLM 后重跑' : ''}

[编剧] 下一步——c02 是强制人工关口（剧本确认）：
  1. 人工审阅剧本，不满意直接改文件或调整输入重跑
  2. 批准后把 payload.gate 改为 { "required": true, "status": "approved", "reviewer": "...", "reviewed_at": "...", "reason": "..." }
  3. 跑 python contracts/validate_contract.py --contract c02_screenplay --file ${rel(result.screenplayPath)} 看到 [通过]
  4. 通过后②分镜 Agent 方可消费该产物`);
  } catch (e) {
    console.error(`[编剧] ${e.message}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
