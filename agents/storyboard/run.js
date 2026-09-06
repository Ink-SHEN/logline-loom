#!/usr/bin/env node
// agents/storyboard/run.js — 「②分镜」Agent 可执行入口（消费 c02_screenplay，产出 c03_shotlist）。
//
// 输入：①编剧产出的 c02_screenplay JSON（--screenplay 必填）。
//       payload.gate.status 不是 approved 时本 Agent 阻塞拒绝开工——剧本确认是强制人工关口，
//       人机边界由机器拦（agents/README.md 第六节），不是君子协定。
// 输出：c03_shotlist 镜头清单落盘 artifacts/。envelope、shot_id/order 编号、aspect_ratio、
//       needs_reference_assets、每镜 gate 占位与 batch_plan（GPU 分批）全部由代码确定性接管，
//       不交给概率模型；并自动过 contracts/validate_contract.py 结构校验。
// LLM：经 llm.js 的 OpenAI 兼容 API 接入；未配 Key 或调用失败时降级 sample.js，流水线不断。
//
// 用法：node agents/storyboard/run.js --help

import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENT_VERSION, STORYBOARD } from './prompt.js';
import { sampleShotList } from './sample.js';
import { LlmError, chat, extractJson, llmConfig } from './llm.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'validate_contract.py');

// 取值全部照抄 contracts/film_agent_contracts.json，不要在这里发明新值
const ASPECT_RATIOS = [
  '1:1 (Square)', '2:3 (Portrait Photo)', '3:2 (Photo)', '3:4 (Portrait Standard)',
  '4:3 (Standard)', '9:16 (Portrait Widescreen)', '16:9 (Widescreen)', '21:9 (Ultrawide)',
];
const SHOT_SIZES = ['extreme_close_up', 'close_up', 'medium', 'medium_wide', 'wide', 'extreme_wide'];
const CAMERA_MOVES = [
  'static', 'push_in', 'pull_out', 'pan_left', 'pan_right',
  'tilt_up', 'tilt_down', 'tracking', 'orbit', 'crane', 'handheld',
];
const WORKFLOW_TYPES = ['T2V', 'I2V', 'R2V'];

class UsageError extends Error {}

const rel = (p) => relative(REPO_ROOT, p).replaceAll('\\', '/');
const makeStamp = (d) => d.toISOString().slice(0, 19).replace(/[-:]/g, ''); // 20260906T043012

function usage() {
  console.log(`「②分镜」Agent — 消费 c02_screenplay（须已过剧本确认关口），产出 c03_shotlist

用法：
  node agents/storyboard/run.js --screenplay artifacts/screenplay_<时间戳>.json [选项]

选项：
  --screenplay <路径>      必填。①编剧产出的 c02_screenplay JSON（envelope+payload 或裸 payload 均可）。
                           payload.gate.status 不是 approved 时阻塞拒绝开工（强制人工关口）
  --aspect-ratio <值>      画幅，默认 "16:9 (Widescreen)"（本项目已锁定），写入每个镜头
  --candidates <n>         每镜头候选数 1–8，默认 3，写入 batch_plan.candidates_per_shot
  --out <路径>             镜头清单输出路径，默认 artifacts/shotlist_<时间戳>.json
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
      case '--screenplay': out.screenplay = need(); break;
      case '--aspect-ratio': out.aspectRatio = need(); break;
      case '--candidates': out.candidates = Number(need()); break;
      case '--out': out.out = need(); break;
      case '--model': out.model = need(); break;
      case '--offline': out.offline = true; break;
      case '--no-validate': out.validate = false; break;
      case '-h': case '--help': out.help = true; break;
      default: throw new UsageError(`未知参数 ${a}（见 --help）`);
    }
  }
  if (out.candidates !== undefined && (!Number.isInteger(out.candidates) || out.candidates < 1 || out.candidates > 8)) {
    throw new UsageError(`--candidates 须为 1–8 的整数（契约 batch_plan.candidates_per_shot），收到：${out.candidates}`);
  }
  return out;
}

function resolveAspect(v) {
  if (ASPECT_RATIOS.includes(v)) return v;
  const hits = ASPECT_RATIOS.filter((r) => r.startsWith(`${v} (`) || r.startsWith(`${v}(`));
  if (hits.length === 1) return hits[0]; // 允许只写 "16:9"，自动补全括号后缀
  throw new UsageError(`画幅不合法：${v}\n合法值：${ASPECT_RATIOS.join(' / ')}`);
}

/** 读上游剧本：完整 c02（envelope+payload）直接用；裸 payload 补一层 envelope 以便追溯。 */
function loadScreenplayFile(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UsageError(`无法读取/解析剧本文件 ${path}：${e.message}`);
  }
  if (raw?.payload?.scenes) return { doc: raw, wrapped: false };
  if (raw?.scenes) {
    return {
      doc: {
        envelope: {
          schema_version: '1.0',
          artifact_id: 'screenplay.file',
          contract: 'c02_screenplay',
          created_at: new Date().toISOString(),
          producer: { kind: 'agent', name: '外部剧本文件' },
          upstream_refs: [],
          notes: `来自 ${path}`,
        },
        payload: raw,
      },
      wrapped: true,
    };
  }
  throw new UsageError(`${path} 里没有 payload.scenes，不是有效的 c02_screenplay`);
}

/**
 * 人工关口 1（剧本确认）：gate.required=true 且 status != approved 时下游必须阻塞，
 * 禁止自动流转（contracts/film_agent_contracts.json 的 human_gate 定义）。缺 gate 同样视为未通过。
 */
function assertGateApproved(doc, path) {
  const gate = doc.payload?.gate;
  if (!gate) {
    throw new Error(`剧本确认关口缺失：${rel(path)} 没有 payload.gate。c02 契约要求 gate 必填，缺 gate 视为关口未通过，②分镜拒绝开工。`);
  }
  if (gate.required === true && gate.status !== 'approved') {
    throw new Error(`人工关口阻塞（剧本确认）：${rel(path)} 的 payload.gate.status = "${gate.status}"，不是 approved。
c02 是强制人工关口，批准前 ②分镜 禁止自动流转（agents/README.md 第六节——人机边界是机器拦的）。
下一步：
  1. 人工审阅剧本，不满意直接改文件或重跑 ①编剧
  2. 批准后把该文件的 payload.gate 改为 { "required": true, "status": "approved", "reviewer": "...", "reviewed_at": "...", "reason": "..." }
  3. 重新运行本命令`);
  }
}

/**
 * 规范化模型产物：envelope 与所有确定性字段由代码接管（能确定性判定的事不交给概率模型）——
 * shot_id/order 按数组顺序重编、aspect_ratio 锁定、needs_reference_assets 由 workflow_type 推导、
 * 每镜 gate 占位 not_required、batch_plan 按 FL2VA(T2V+I2V) / Ref2VA(R2V) 分批重算。
 * 兼容模型只回 payload 层（或顶层 shots）的情况。
 */
function normalize(raw, { screenplayId, stamp, aspectRatio, candidates, notes = '' }) {
  let payload = null;
  if (raw && typeof raw === 'object') {
    payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : (Array.isArray(raw.shots) ? raw : null);
  }
  if (!payload) throw new LlmError('输出缺少 payload（或顶层 shots），无法规范化');
  if (!Array.isArray(payload.shots) || !payload.shots.length) throw new LlmError('payload.shots 缺失或为空，无法规范化');

  payload.shots.forEach((s, i) => {
    s.shot_id = `S${String(i + 1).padStart(3, '0')}`;
    s.order = i + 1;
    s.aspect_ratio = aspectRatio;
    s.needs_reference_assets = s.workflow_type !== 'T2V';
    if (!s.reference_note) s.reference_note = '';
    s.gate = { required: false, status: 'not_required' };
  });
  payload.batch_plan = {
    fl2va_shots: payload.shots.filter((s) => s.workflow_type === 'T2V' || s.workflow_type === 'I2V').map((s) => s.shot_id),
    ref2va_shots: payload.shots.filter((s) => s.workflow_type === 'R2V').map((s) => s.shot_id),
    candidates_per_shot: candidates,
  };
  return {
    envelope: {
      schema_version: '1.0',
      artifact_id: `shotlist.${stamp}`,
      contract: 'c03_shotlist',
      created_at: new Date().toISOString(),
      producer: { kind: 'agent', name: 'storyboard_agent', agent_version: AGENT_VERSION },
      upstream_refs: screenplayId ? [screenplayId] : [],
      notes,
    },
    payload,
  };
}

/** JS 侧结构自检（python 校验器不可用时的兜底；字段与 c03_shotlist 契约一一对应）。 */
function structuralCheck(doc, screenplayPayload) {
  const p = [];
  if (!doc || typeof doc !== 'object') return ['产物不是 JSON 对象'];
  if (!doc.envelope || !doc.payload) p.push('缺 envelope/payload 外壳');
  const payload = doc.payload;
  if (!payload) return p;
  const sceneIds = new Set((screenplayPayload?.scenes ?? []).map((s) => s.scene_id));

  if (!Array.isArray(payload.shots) || !payload.shots.length) {
    p.push('payload.shots 必须是非空数组');
  } else {
    const seen = new Set();
    payload.shots.forEach((s, i) => {
      const tag = `shots[${i}]`;
      if (!/^S[0-9]{3}$/.test(s.shot_id ?? '')) p.push(`${tag}.shot_id 须形如 S001`);
      else if (seen.has(s.shot_id)) p.push(`${tag}.shot_id 重复：${s.shot_id}`);
      else seen.add(s.shot_id);
      if (!/^SC[0-9]{2}$/.test(s.scene_id ?? '')) p.push(`${tag}.scene_id 须形如 SC01`);
      else if (sceneIds.size && !sceneIds.has(s.scene_id)) p.push(`${tag}.scene_id ${s.scene_id} 不在剧本场次里（${[...sceneIds].join(' / ')}）`);
      if (!Number.isInteger(s.order) || s.order !== i + 1) p.push(`${tag}.order 须为 ${i + 1}（从 1 起按播放顺序递增）`);
      if (typeof s.duration_seconds !== 'number' || s.duration_seconds < 1 || s.duration_seconds > 15) {
        p.push(`${tag}.duration_seconds 须为 1–15 的秒数（写秒不写帧，分镜目标 4–8 秒）`);
      }
      if (!ASPECT_RATIOS.includes(s.aspect_ratio)) p.push(`${tag}.aspect_ratio 不合法（本项目锁定 16:9 (Widescreen)）`);
      if (!SHOT_SIZES.includes(s.shot_size)) p.push(`${tag}.shot_size 须为 ${SHOT_SIZES.join(' / ')}`);
      if (!CAMERA_MOVES.includes(s.camera_move)) p.push(`${tag}.camera_move 须为 ${CAMERA_MOVES.join(' / ')}`);
      if (typeof s.visual_description !== 'string' || s.visual_description.length < 10) p.push(`${tag}.visual_description 缺失或少于 10 字`);
      if (typeof s.audio_description !== 'string' || s.audio_description.length < 5) p.push(`${tag}.audio_description 缺失或少于 5 字`);
      if (!WORKFLOW_TYPES.includes(s.workflow_type)) {
        p.push(`${tag}.workflow_type 须为 T2V / I2V / R2V（大写）`);
      } else {
        const needsRef = s.workflow_type !== 'T2V';
        if (s.needs_reference_assets !== needsRef) p.push(`${tag}.needs_reference_assets 须为 ${needsRef}（${s.workflow_type}）`);
        if (needsRef && (typeof s.reference_note !== 'string' || !s.reference_note.trim())) {
          p.push(`${tag}.reference_note 缺失——I2V/R2V 必须写清需要什么参考素材`);
        }
      }
      if (s.consistency_group != null && typeof s.consistency_group !== 'string') p.push(`${tag}.consistency_group 须为字符串或 null`);
      if (!s.gate || typeof s.gate.required !== 'boolean' || !s.gate.status) p.push(`${tag}.gate 缺失或不全（required + status 必填）`);
    });
  }

  const bp = payload.batch_plan;
  if (!bp || typeof bp !== 'object') {
    p.push('payload.batch_plan 缺失（GPU 按 workflow_type 分批的依据）');
  } else {
    const shots = Array.isArray(payload.shots) ? payload.shots : [];
    const fl2va = shots.filter((s) => s.workflow_type === 'T2V' || s.workflow_type === 'I2V').map((s) => s.shot_id).join();
    const ref2va = shots.filter((s) => s.workflow_type === 'R2V').map((s) => s.shot_id).join();
    if (!Array.isArray(bp.fl2va_shots) || bp.fl2va_shots.join() !== fl2va) p.push('batch_plan.fl2va_shots 须等于 shots 中 T2V+I2V 的镜头号（按顺序）');
    if (!Array.isArray(bp.ref2va_shots) || bp.ref2va_shots.join() !== ref2va) p.push('batch_plan.ref2va_shots 须等于 shots 中 R2V 的镜头号（按顺序）');
    if (!Number.isInteger(bp.candidates_per_shot) || bp.candidates_per_shot < 1 || bp.candidates_per_shot > 8) p.push('batch_plan.candidates_per_shot 须为 1–8 的整数');
  }
  return p;
}

/** 软性提醒（不拦截）：总时长对不上剧本、单镜超出 4–8s 目标区间。 */
function durationWarnings(payload, screenplayPayload) {
  const w = [];
  const shots = payload.shots ?? [];
  const total = shots.reduce((acc, s) => acc + (typeof s.duration_seconds === 'number' ? s.duration_seconds : 0), 0);
  const target = screenplayPayload?.total_estimated_seconds;
  if (typeof target === 'number' && target > 0 && Math.abs(total - target) > target * 0.2) {
    w.push(`镜头总时长 ${total}s 偏离剧本 total_estimated_seconds ${target}s 超过 ±20%`);
  }
  const outside = shots.filter((s) => typeof s.duration_seconds === 'number' && (s.duration_seconds < 4 || s.duration_seconds > 8));
  if (outside.length) w.push(`${outside.length} 个镜头在 4–8s 分镜目标区间外（契约硬限 1–15s 内仍合法）：${outside.map((s) => s.shot_id).join(', ')}`);
  return w;
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

/** 调 LLM 生成镜头清单；结构不过时把问题清单回灌给模型纠正一次。 */
async function callLlm(screenplayDoc, { model, stamp, aspectRatio, candidates }) {
  const screenplayId = screenplayDoc.envelope?.artifact_id;
  const chatOpts = model ? { model } : {};
  const messages = [
    { role: 'system', content: STORYBOARD },
    {
      role: 'user',
      content: `剧本（c02_screenplay，artifact_id=${screenplayId}，剧本确认关口已批准）：\n${JSON.stringify(screenplayDoc.payload, null, 2)}\n\n画幅锁定 ${aspectRatio}。请把它拆成镜头清单，按契约只输出一个 JSON 代码块。`,
    },
  ];
  const attempt = (text) => {
    const doc = normalize(extractJson(text), { screenplayId, stamp, aspectRatio, candidates, notes: 'LLM 生成' });
    return { doc, problems: structuralCheck(doc, screenplayDoc.payload) };
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
 * 分镜 Agent 主流程（可编程调用；CLI 只是它的一层壳）。
 * 返回 { screenplayPath, shotlistPath, doc, usedFallback, shapeCheck }。
 */
export async function runStoryboard(options = {}) {
  const log = options.log ?? ((m) => console.log(m));
  const stamp = makeStamp(new Date());
  const artifactsDir = join(REPO_ROOT, 'artifacts');

  // 1) 剧本：必须给定 c02 文件（分镜的输入没法从 CLI 字段现场编）
  if (!options.screenplay) throw new UsageError('缺少必填输入 --screenplay <c02_screenplay JSON 路径>，见 --help');
  const screenplayPath = resolve(options.screenplay);
  const { doc: screenplayDoc, wrapped } = loadScreenplayFile(screenplayPath);
  log(`[分镜] 上游剧本：${rel(screenplayPath)}（artifact_id=${screenplayDoc.envelope?.artifact_id ?? '未知'}）`);

  // 2) 人工关口 1（剧本确认）：未 approved 就阻塞，这是机器强制的人机边界
  assertGateApproved(screenplayDoc, screenplayPath);
  log('[分镜] 剧本确认关口已批准（gate.status=approved），开工');

  // 3) 上游契约校验：c02 不过就不开工（裸 payload 用补壳后的临时副本校验）
  if (options.validate !== false) {
    let tmp = null;
    if (wrapped) {
      tmp = join(tmpdir(), `loom_c02_${process.pid}_${Date.now()}.json`);
      writeFileSync(tmp, JSON.stringify(screenplayDoc, null, 2), 'utf8');
    }
    let r;
    try {
      r = pythonValidate(tmp ?? screenplayPath, 'c02_screenplay');
    } finally {
      if (tmp) rmSync(tmp, { force: true });
    }
    if (r === null) log('[分镜] 警告：未找到可用的 python/jsonschema，跳过上游剧本契约校验');
    else if (r.code === 1) throw new Error(`上游剧本未通过 c02_screenplay 契约校验，分镜拒绝开工：\n${r.out}`);
    else if (r.code !== 0) log(`[分镜] 警告：上游剧本校验未执行（退出码 ${r.code}）：\n${r.out}`);
  }

  const aspectRatio = resolveAspect(options.aspectRatio || '16:9 (Widescreen)');
  const candidates = options.candidates ?? 3;
  const screenplayId = screenplayDoc.envelope?.artifact_id || 'screenplay.unknown';

  // 4) 生成镜头清单：LLM → 纠正重试 → 失败降级离线示例（README 约定：保证流水线照常出片）
  let doc;
  let usedFallback = '';
  const cfg = llmConfig(options.model ? { model: options.model } : {});
  if (options.offline) {
    usedFallback = '按 --offline 要求不调用 LLM';
  } else if (!cfg.apiKey) {
    usedFallback = '未配置 LLM API Key';
  } else {
    try {
      const r = await callLlm(screenplayDoc, { model: options.model, stamp, aspectRatio, candidates });
      log(`[分镜] LLM 生成成功（model=${cfg.model}${r.retried ? '，含一轮纠正重试' : ''}）`);
      doc = r.doc;
    } catch (e) {
      usedFallback = `LLM 调用失败：${e.message}`;
    }
  }
  if (usedFallback) {
    log(`[分镜] ${usedFallback}，降级使用离线示例 sample.js（内容不对应输入剧本，形状合规）`);
    doc = normalize(JSON.parse(sampleShotList), { screenplayId, stamp, aspectRatio, candidates, notes: `${usedFallback}；降级使用离线示例 sample.js` });
  }

  // 5) 终检 + 落盘
  const problems = structuralCheck(doc, screenplayDoc.payload);
  if (problems.length) throw new Error(`最终产物未通过结构自检：\n- ${problems.join('\n- ')}`);
  for (const w of durationWarnings(doc.payload, screenplayDoc.payload)) log(`[分镜] 警告：${w}`);
  const shotlistPath = options.out ? resolve(options.out) : join(artifactsDir, `shotlist_${stamp}.json`);
  mkdirSync(dirname(shotlistPath), { recursive: true });
  writeFileSync(shotlistPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');

  const shots = doc.payload.shots;
  const total = shots.reduce((acc, s) => acc + s.duration_seconds, 0);
  const count = (t) => shots.filter((s) => s.workflow_type === t).length;
  log(`[分镜] 镜头清单已落盘：${rel(shotlistPath)}`);
  log(`[分镜] ${shots.length} 镜 / 共 ${total}s ｜ T2V ${count('T2V')} · I2V ${count('I2V')} · R2V ${count('R2V')} ｜ FL2VA 批 ${doc.payload.batch_plan.fl2va_shots.length} 镜 · Ref2VA 批 ${doc.payload.batch_plan.ref2va_shots.length} 镜 · 每镜候选 ${candidates}`);

  // 6) 权威结构校验（c03 无强制人工关口，直接校验真实产物）
  let shapeCheck = null;
  if (options.validate !== false) {
    shapeCheck = pythonValidate(shotlistPath, 'c03_shotlist');
    if (shapeCheck === null) log('[分镜] 警告：未找到可用的 python/jsonschema，只做了 JS 结构自检；提交前请手动跑 contracts/validate_contract.py');
    else if (shapeCheck.code === 1) throw new Error(`c03_shotlist 契约结构校验不通过：\n${shapeCheck.out}`);
    else if (shapeCheck.code !== 0) log(`[分镜] 警告：契约校验未执行（退出码 ${shapeCheck.code}）：\n${shapeCheck.out}`);
    else log('[分镜] c03_shotlist 契约结构校验通过');
  }

  return { screenplayPath, shotlistPath, doc, usedFallback: Boolean(usedFallback), shapeCheck };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[分镜] ${e.message}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) { usage(); return; }
  try {
    const result = await runStoryboard(args);
    const bp = result.doc.payload.batch_plan;
    console.log(`[分镜] 完成：
  上游剧本（c02_screenplay）：${rel(result.screenplayPath)}
  镜头清单（c03_shotlist）：  ${rel(result.shotlistPath)}${result.usedFallback ? '\n  注意：本次为离线降级产物，仅形状合规，内容需人工重写或配好 LLM 后重跑' : ''}
  GPU 分批：FL2VA 批（T2V+I2V 连跑）${bp.fl2va_shots.join(', ') || '（空）'}
            Ref2VA 批（R2V 单独时段）${bp.ref2va_shots.join(', ') || '（空）'}

[分镜] 下一步——交给 ③提示词 Agent：
  1. 按 batch_plan 排 GPU 时段：FL2VA 与 Ref2VA 不能同时常驻，换批要重载 21GB+ 权重（见 docs/gpu_protocol.md）
  2. I2V/R2V 镜头先备齐 reference_note 写的素材，参考图须先 POST /upload/image 再引用
  3. ③提示词 Agent 消费本文件产出 c04_gen_request（节点 ID 从 workflows/node_id_map.json 查）`);
  } catch (e) {
    console.error(`[分镜] ${e.message}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
