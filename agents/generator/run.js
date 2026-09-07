#!/usr/bin/env node
// agents/generator/run.js — 「④生成」Agent 可执行入口（消费 c04_gen_request，产出 c05_gen_result）。
//
// 这一站不调 LLM。它是全流水线唯一真的烧 GPU 的地方，所以纪律比别处更硬：
//   开工前把能判的都判完（契约校验、节点 ID 与映射表比对、素材文件是否存在、seed 是否互不相同、
//   filename_prefix 是否等于 shots/<candidate_id>），任何一条不过就不 POST——
//   填错一个节点等于白烧一整轮 GPU 才在 ComfyUI 里报错。
//   跑完把能记的都记下来（提交图、prompt_id、节点侧时间戳、缓存命中节点数、产物 sha256、ffprobe 原文），
//   这些是「可复现」的全部证据，事后补不回来。
//
// GPU 分批：FL2VA 批（T2V+I2V）连跑，Ref2VA 批（R2V）单独时段。两套权重不能同时常驻，
//   交替提交等于每镜头多付一次 21GB+ 重载（docs/gpu_protocol.md、README 第七节第 4 条）。
//
// 用法：node agents/generator/run.js --help

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ComfyError, comfyConfig, downloadView, getObjectInfo, allowedValues, getQueue, getSystemStats,
  getHistoryRecord, msToIso, parseHistoryRecord, postPrompt, uploadImage, waitForHistory,
} from './comfyui.js';
import {
  EXPECTED_UNET, MAP_KEY, buildGraph, checkUnetMatchesType, diffNodeIds, loadNodeIdMap, loadTemplate, readModelFiles,
} from './graph.js';
import { FfprobeError, describeProbe, findFfprobe, probeVideo } from './ffprobe.js';

export const AGENT_VERSION = '0.1.0';
export const AGENT_NAME = 'generation_agent';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'validate_contract.py');
const WORKFLOWS_DIR = join(REPO_ROOT, 'workflows');
const SHOTS_DIR = join(REPO_ROOT, 'shots');
const REGISTRY = join(REPO_ROOT, 'docs', 'task_registry.md');

const CANDIDATE_RE = /^S[0-9]{3}_c[0-9]{2}$/;
const SHOT_RE = /^S[0-9]{3}$/;
const PREFIX_RE = /^shots\/S[0-9]{3}(_c[0-9]{2})?$/;
const SEED_MAX = 9007199254740991;
// 提交顺序 = 权重分批顺序。FL2VA（T2V+I2V）先连跑，Ref2VA（R2V）单独一个时段
const BATCH_ORDER = { T2V: 0, I2V: 1, R2V: 2 };
const WEIGHT_FAMILY = { T2V: 'FL2VA', I2V: 'FL2VA', R2V: 'Ref2VA' };
const CONSECUTIVE_FAILURE_LIMIT = 3;

class UsageError extends Error {}

const rel = (p) => relative(REPO_ROOT, p).replaceAll('\\', '/');
const makeStamp = (d) => d.toISOString().slice(0, 19).replace(/[-:]/g, '');

function usage() {
  console.log(`「④生成」Agent — 消费 c04_gen_request，提交 ComfyUI，产出 c05_gen_result

用法：
  node agents/generator/run.js --requests artifacts/genreq_<时间戳>/ [选项]

选项：
  --requests <路径>      必填，可重复。③提示词产出的 c04（目录=收全部 *.json，文件=收单个）
  --endpoint <url>       ComfyUI 地址，默认 LOOM_COMFY_URL 或 http://127.0.0.1:8188
                         ComfyUI 没有鉴权，只能走 SSH 隧道，地址不要写进仓库
  --types <T2V,I2V>      只提交这些工作流类型（GPU 分批用：先 FL2VA 批，R2V 单独一次）
  --shots <S001,S002>    只提交这些镜头
  --candidates <S001_c01,...>  只提交这些候选（比 --shots 更细）
  --limit <n>            本次最多提交 n 个候选（分批排队时用）
  --dry-run              不 POST、不落 c05、不碰 GPU。只出提交计划 + 填好的工作流图
                         没有节点也能跑，是这一站唯一的离线自检方式
  --plan-dir <路径>      提交计划与实际提交的图落盘目录，默认 artifacts/genplan_<时间戳>/
                         正式跑时这里留的是「真提交的那张图」，复现时以它为准
  --from-history <id>    只补落盘：用已有 prompt_id 从 /history 取回产物并写 c05，不重新提交
                         （等待超时、或产物已在节点上时用，避免再烧一轮 GPU）
  --submitted-by <谁>    谁占的 GPU 时段，默认 LOOM_OPERATOR 或 git user.name
  --wait-timeout <秒>    单个候选最长等待，默认 2700（冷启动 636s + 余量）
  --poll <秒>            轮询间隔，默认 5
  --overwrite            目标 shots/<候选>/meta.json 已存在时重跑覆盖（默认跳过，不重复烧 GPU）
  --allow-cached         允许「全节点缓存命中」的结果通过（默认判为失败：那是上一次的旧文件）
  --force-queue          R2V 批次开工时队列非空也照提（默认阻塞：会打断在跑的 FL2VA 批次）
  --fail-fast            任一候选失败就停（默认继续，但连续 3 次失败会熔断）
  --no-registry          不往 docs/task_registry.md 追加记录
  --no-validate          跳过 python 契约校验（不建议）
  -h, --help             显示本帮助

环境变量：
  LOOM_COMFY_URL         ComfyUI 地址（等价于 --endpoint）
  LOOM_OPERATOR          默认 --submitted-by`);
}

function parseArgs(argv) {
  const out = { requests: [], validate: true, registry: true };
  const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
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
      case '--requests': out.requests.push(need()); break;
      case '--endpoint': out.endpoint = need(); break;
      case '--types': out.types = list(need()); break;
      case '--shots': out.shots = list(need()); break;
      case '--candidates': out.candidates = list(need()); break;
      case '--limit': out.limit = Number(need()); break;
      case '--dry-run': out.dryRun = true; break;
      case '--plan-dir': out.planDir = need(); break;
      case '--from-history': out.fromHistory = need(); break;
      case '--submitted-by': out.submittedBy = need(); break;
      case '--wait-timeout': out.waitTimeout = Number(need()); break;
      case '--poll': out.poll = Number(need()); break;
      case '--overwrite': out.overwrite = true; break;
      case '--allow-cached': out.allowCached = true; break;
      case '--force-queue': out.forceQueue = true; break;
      case '--fail-fast': out.failFast = true; break;
      case '--no-registry': out.registry = false; break;
      case '--no-validate': out.validate = false; break;
      case '-h': case '--help': out.help = true; break;
      default: throw new UsageError(`未知参数 ${a}（见 --help）`);
    }
  }
  if (out.limit !== undefined && (!Number.isInteger(out.limit) || out.limit < 1)) {
    throw new UsageError(`--limit 须为正整数，收到：${out.limit}`);
  }
  if (out.waitTimeout !== undefined && !(out.waitTimeout >= 10)) throw new UsageError(`--wait-timeout 须 ≥ 10 秒，收到：${out.waitTimeout}`);
  if (out.poll !== undefined && !(out.poll >= 1)) throw new UsageError(`--poll 须 ≥ 1 秒，收到：${out.poll}`);
  for (const t of out.types ?? []) {
    if (BATCH_ORDER[t] === undefined) throw new UsageError(`--types 只认 T2V / I2V / R2V，收到：${t}`);
  }
  for (const s of out.shots ?? []) if (!SHOT_RE.test(s)) throw new UsageError(`--shots 条目须形如 S001，收到：${s}`);
  for (const c of out.candidates ?? []) if (!CANDIDATE_RE.test(c)) throw new UsageError(`--candidates 条目须形如 S001_c01，收到：${c}`);
  return out;
}

// ——— 载入 c04 ———

function walkJson(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkJson(p));
    else if (name.toLowerCase().endsWith('.json')) out.push(p);
  }
  return out;
}

/** 完整 c04（envelope+payload）直接用；裸 payload 补一层 envelope，好让 upstream_refs 有东西可指。 */
function normalizeC04(raw, path) {
  if (raw?.payload?.generation && raw?.envelope) return { doc: raw, wrapped: false };
  if (raw?.generation) {
    return {
      doc: {
        envelope: {
          schema_version: '1.0',
          artifact_id: `genreq.${raw.candidate_id ?? 'unknown'}.file`,
          contract: 'c04_gen_request',
          created_at: new Date().toISOString(),
          producer: { kind: 'agent', name: '外部生成请求文件' },
          upstream_refs: [],
          notes: `来自 ${rel(path)}`,
        },
        payload: raw,
      },
      wrapped: true,
    };
  }
  return null;
}

function loadRequests(paths) {
  const docs = [];
  const seen = new Map();
  for (const raw of paths) {
    const p = resolve(raw);
    if (!existsSync(p)) throw new UsageError(`--requests 路径不存在：${raw}`);
    const files = statSync(p).isDirectory() ? walkJson(p) : [p];
    if (!files.length) throw new UsageError(`${rel(p)} 里没有任何 .json`);
    for (const f of files) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(f, 'utf8'));
      } catch (e) {
        throw new UsageError(`无法解析 ${rel(f)}：${e.message}`);
      }
      const n = normalizeC04(parsed, f);
      if (!n) continue; // 目录里混了别的 JSON（例如计划文件）就跳过，不当错误
      const cid = n.doc.payload.candidate_id;
      if (seen.has(cid)) throw new Error(`candidate_id 重复：${cid} 同时出现在 ${rel(seen.get(cid))} 与 ${rel(f)}`);
      seen.set(cid, f);
      docs.push({ doc: n.doc, file: f, wrapped: n.wrapped });
    }
  }
  if (!docs.length) throw new UsageError('--requests 里没有找到任何 c04_gen_request（需含 payload.generation）');
  return docs;
}

// ——— 开工前的确定性检查（全部不碰 GPU） ———

function refCountFor(c04) {
  const t = c04.payload.workflow.type;
  const a = c04.payload.assets ?? {};
  if (t === 'I2V') return a.first_frame ? 1 : 0;
  if (t === 'R2V') return Array.isArray(a.ref_images) ? a.ref_images.length : 0;
  return 0;
}

function collectAssets(c04) {
  const a = c04.payload.assets ?? {};
  const list = [];
  if (a.first_frame) list.push({ slot: 'first_frame', ref: a.first_frame });
  (Array.isArray(a.ref_images) ? a.ref_images : []).forEach((ref, i) => list.push({ slot: `ref_image_${i}`, ref }));
  return list;
}

function preCheck(entry, map, { dryRun = false } = {}) {
  const problems = [];
  const warnings = [];
  const { doc, file } = entry;
  const pl = doc.payload;
  const cid = pl.candidate_id ?? rel(file);
  const type = pl.workflow?.type;

  if (!SHOT_RE.test(pl.shot_id ?? '')) problems.push(`${cid}: shot_id 须形如 S001，收到 ${JSON.stringify(pl.shot_id)}`);
  if (!CANDIDATE_RE.test(pl.candidate_id ?? '')) problems.push(`${cid}: candidate_id 须形如 S001_c01（目录名与它同名），收到 ${JSON.stringify(pl.candidate_id)}`);
  if (!String(pl.candidate_id ?? '').startsWith(`${pl.shot_id}_`)) problems.push(`${cid}: candidate_id 与 shot_id 不是同一个镜头`);
  if (BATCH_ORDER[type] === undefined) problems.push(`${cid}: workflow.type 须为 T2V / I2V / R2V，收到 ${JSON.stringify(type)}`);

  const g = pl.generation ?? {};
  // filename_prefix 决定产物落在节点 output/ 的哪个子目录；不等于 shots/<候选> 就没法按候选归档，
  // 而且两个候选撞同一个前缀会互相覆盖（docs/task_registry.md 第三节 ⑤ 的反面例子）
  if (g.filename_prefix !== `shots/${pl.candidate_id}`) {
    problems.push(`${cid}: generation.filename_prefix 须为 "shots/${pl.candidate_id}"，收到 ${JSON.stringify(g.filename_prefix)}（前缀撞车会让产物互相覆盖）`);
  } else if (!PREFIX_RE.test(g.filename_prefix)) {
    problems.push(`${cid}: filename_prefix 不合契约 pattern ${PREFIX_RE}`);
  }
  if (!Number.isInteger(g.seed) || g.seed < 0 || g.seed > SEED_MAX) problems.push(`${cid}: generation.seed 须为 0–${SEED_MAX} 的整数，收到 ${JSON.stringify(g.seed)}`);
  if (!(typeof g.duration_seconds === 'number' && g.duration_seconds >= 4 && g.duration_seconds <= 15)) {
    problems.push(`${cid}: duration_seconds 须在 4–15（写秒不写帧，H3 单次生成上限），收到 ${JSON.stringify(g.duration_seconds)}`);
  }
  if (typeof g.prompt !== 'string' || g.prompt.length < 30) problems.push(`${cid}: generation.prompt 缺失或少于 30 字符`);
  if (g.prompt_language !== 'en') problems.push(`${cid}: prompt_language 须为 "en"`);

  // <Picture N> 的 N 就是素材位接线顺序，提示词引用数与素材条目数不一致 = 指错图
  const refs = refCountFor(doc);
  if (typeof g.prompt === 'string') {
    for (let k = 1; k <= refs; k++) {
      if (!g.prompt.includes(`<Picture ${k}>`)) problems.push(`${cid}: prompt 里没有 <Picture ${k}>，但素材位 ${k - 1} 已接线（序号即接线顺序）`);
    }
    if (refs === 0 && g.prompt.includes('<Picture')) problems.push(`${cid}: ${type} 没有素材位，prompt 里不许出现 <Picture 引用`);
  }

  // 素材文件必须在本地存在，否则上传这一步才失败，白排一轮队
  for (const { slot, ref } of collectAssets(doc)) {
    const src = ref?.source_path;
    if (typeof src !== 'string' || !src) { problems.push(`${cid}: assets.${slot}.source_path 缺失，无从上传`); continue; }
    const abs = resolve(REPO_ROOT, src);
    if (!existsSync(abs)) {
      const msg = `${cid}: assets.${slot}.source_path 指向的文件不存在：${src}`;
      if (dryRun) warnings.push(`${msg}（dry-run 不上传素材所以放行；正式跑会阻塞）`);
      else problems.push(msg);
    }
    if (ref.license === 'unknown') warnings.push(`${cid}: assets.${slot}.license = unknown，可以生成但禁止进成片（⑦剪辑 的 compliance 会拦）`);
  }

  // 节点 ID 与当前映射表逐条比对：不一致说明模板重新导出过，按旧 ID 写值会写到别的节点上
  const mapEntry = map[MAP_KEY[type]];
  if (mapEntry) {
    const diff = diffNodeIds(pl.workflow?.node_ids, mapEntry);
    for (const d of diff) {
      problems.push(`${cid}: node_ids.${d}（模板可能重新导出过：先跑 python workflows/preflight.py 与 verify_map.py，再让 ③提示词 重出 c04）`);
    }
  }
  return { problems, warnings };
}

/** 跨候选检查：同 seed + 同 prompt = ComfyUI 直接返回旧文件，多候选就白做了。 */
function crossCheck(entries) {
  const problems = [];
  const seeds = new Map();
  const prefixes = new Map();
  for (const { doc } of entries) {
    const { seed, prompt, filename_prefix: prefix } = doc.payload.generation;
    const cid = doc.payload.candidate_id;
    const key = `${seed}|${prompt}`;
    if (seeds.has(key)) problems.push(`输入完全相同：${cid} 与 ${seeds.get(key)} 的 seed 与 prompt 都一样，ComfyUI 会 0 秒返回同一个旧文件`);
    else seeds.set(key, cid);
    if (prefixes.has(prefix)) problems.push(`filename_prefix 撞车：${cid} 与 ${prefixes.get(prefix)} 都是 ${prefix}，产物会互相覆盖`);
    else prefixes.set(prefix, cid);
  }
  return problems;
}

// ——— python 权威校验 ———

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

function defaultOperator() {
  if (process.env.LOOM_OPERATOR) return process.env.LOOM_OPERATOR;
  const r = spawnSync('git', ['config', 'user.name'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const name = !r.error && r.status === 0 ? r.stdout.trim() : '';
  return name || '未署名';
}

// ——— 产物落盘 ———

function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function shotDir(candidateId) {
  return join(SHOTS_DIR, candidateId);
}

/** 从「真提交的图」里回读 params_snapshot——记的是实际写进工作流的最终值，不是 c04 请求的值。 */
function snapshotFromWrites(writes, c04, probe) {
  const w = {};
  for (const item of writes) w[item.semantic] = item.value;
  const g = c04.payload.generation;
  const wf = c04.payload.workflow;
  const turbo = w.turbo_enabled ?? wf.turbo_enabled;
  const steps = w[wf.turbo_enabled ? 'steps_turbo' : 'steps_normal'] ?? g.steps;
  const snap = {
    prompt: w.prompt ?? g.prompt,
    seed: w.seed ?? g.seed,
    duration_seconds: w.duration_seconds ?? g.duration_seconds,
    megapixels: w.megapixels ?? g.megapixels,
    steps,
    turbo_enabled: Boolean(turbo),
    filename_prefix: w.filename_prefix ?? g.filename_prefix,
  };
  if (probe) {
    snap.width = probe.contract.video_stream.width;
    snap.height = probe.contract.video_stream.height;
    if (probe.frameCount !== null) snap.frame_count_actual = probe.frameCount;
  }
  return snap;
}

function assembleC05({ c04, probe, parsed, videoRel, sha256, sizeBytes, promptId, submittedAt, finishedAt, elapsedSeconds, queuePosition, writes, modelFiles, operator, notes, graphRel }) {
  const cid = c04.payload.candidate_id;
  return {
    envelope: {
      schema_version: '1.0',
      artifact_id: `genres.${cid}`,
      contract: 'c05_gen_result',
      created_at: new Date().toISOString(),
      producer: { kind: 'agent', name: AGENT_NAME, agent_version: AGENT_VERSION },
      upstream_refs: c04.envelope?.artifact_id ? [c04.envelope.artifact_id] : [],
      notes: [notes, graphRel ? `实际提交的工作流图：${graphRel}` : null].filter(Boolean).join('；') || undefined,
    },
    payload: {
      shot_id: c04.payload.shot_id,
      candidate_id: cid,
      comfy_prompt_id: promptId,
      output: { path: videoRel, sha256, size_bytes: sizeBytes },
      ffprobe: probe.contract,
      timing: {
        submitted_at: submittedAt,
        finished_at: finishedAt,
        elapsed_seconds: elapsedSeconds,
        ...(queuePosition === null || queuePosition === undefined ? {} : { queue_position_at_submit: queuePosition }),
      },
      params_snapshot: snapshotFromWrites(writes, c04, probe),
      model_files: modelFiles,
      submitted_by: operator,
    },
  };
}

/** c05 落盘前的 JS 结构自检（python 不可用时的兜底，字段与契约一一对应）。 */
function structuralCheck(doc, c04) {
  const p = [];
  if (!doc?.envelope || !doc?.payload) return ['缺 envelope/payload 外壳'];
  const pl = doc.payload;
  const cid = pl.candidate_id ?? '?';
  if (pl.shot_id !== c04.payload.shot_id) p.push(`${cid}: shot_id 与 c04 不一致`);
  if (pl.candidate_id !== c04.payload.candidate_id) p.push(`${cid}: candidate_id 与 c04 不一致`);
  if (doc.envelope.contract !== 'c05_gen_result') p.push(`${cid}: envelope.contract 须为 c05_gen_result`);
  if (!/^[A-Za-z0-9_.-]+$/.test(doc.envelope.artifact_id ?? '')) p.push(`${cid}: envelope.artifact_id 不合契约 pattern`);
  if (!(doc.envelope.upstream_refs ?? []).length) p.push(`${cid}: envelope.upstream_refs 为空，追溯链断了（应指向 c04 的 artifact_id）`);
  if (pl.output?.path !== `shots/${cid}/video${extname(pl.output?.path ?? '.mp4')}`) {
    p.push(`${cid}: output.path 须为 shots/${cid}/video.<ext>（扁平口径，见 docs/decisions/2026-09-07-editor-input-conventions.md）`);
  }
  if (!/^[0-9a-f]{64}$/.test(pl.output?.sha256 ?? '')) p.push(`${cid}: output.sha256 须为 64 位小写十六进制`);
  if (!Number.isInteger(pl.output?.size_bytes) || pl.output.size_bytes < 1) p.push(`${cid}: output.size_bytes 须为 ≥1 的整数`);
  const fp = pl.ffprobe ?? {};
  if (!(fp.duration_seconds > 0)) p.push(`${cid}: ffprobe.duration_seconds 须 > 0`);
  if (!fp.video_stream?.codec_name) p.push(`${cid}: ffprobe.video_stream 缺失`);
  if (!fp.audio_stream) p.push(`${cid}: ffprobe.audio_stream 为 null——H3 原生出声，没有音频流这个候选基本要判 fail（⑤质检 会拦）`);
  for (const k of ['submitted_at', 'finished_at']) {
    if (typeof pl.timing?.[k] !== 'string' || Number.isNaN(Date.parse(pl.timing[k]))) p.push(`${cid}: timing.${k} 不是合法 date-time`);
  }
  if (!(pl.timing?.elapsed_seconds >= 0)) p.push(`${cid}: timing.elapsed_seconds 须 ≥ 0`);
  const snap = pl.params_snapshot ?? {};
  if (snap.seed !== c04.payload.generation.seed) p.push(`${cid}: params_snapshot.seed 与 c04 请求的 seed 不一致（重试才会不同，这里不是重试）`);
  if (snap.prompt !== c04.payload.generation.prompt) p.push(`${cid}: params_snapshot.prompt 与提交进图的 prompt 不一致`);
  if (snap.turbo_enabled !== Boolean(c04.payload.workflow.turbo_enabled)) p.push(`${cid}: params_snapshot.turbo_enabled 与 c04 不一致`);
  if (snap.filename_prefix !== `shots/${cid}`) p.push(`${cid}: params_snapshot.filename_prefix 须为 shots/${cid}`);
  const mf = pl.model_files ?? {};
  if (mf.unet_name !== EXPECTED_UNET[c04.payload.workflow.type]) {
    p.push(`${cid}: model_files.unet_name=${mf.unet_name}，但 ${c04.payload.workflow.type} 该用 ${EXPECTED_UNET[c04.payload.workflow.type]}（这是判断跑了 FL2VA 还是 Ref2VA 的唯一依据，必须如实）`);
  }
  return p;
}

// ——— 登记表 ———

const REGISTRY_SECTION = '## 五、生成 Agent 自动追加的记录';
const REGISTRY_HEADER = `| 日期 | 谁 | 候选 ID | 类型 | prompt_id | filename_prefix | seed | 时长(秒) | megapixels | 实测秒数 | 缓存命中 | 产物 | 质检 | 备注 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`;

function registryRow({ doc, promptId, parsed, elapsedSeconds, submittedBy, note }) {
  const pl = doc.payload;
  const g = pl.generation;
  const d = new Date();
  const date = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const cached = parsed?.cachedNodes?.length ?? 0;
  const file = parsed?.files?.[0]?.filename ?? '（无产物）';
  return `| ${date} | ${submittedBy} | ${pl.candidate_id} | ${pl.workflow.type} | \`${String(promptId).slice(0, 8)}\` | \`${g.filename_prefix}\` | ${g.seed} | ${g.duration_seconds} | ${g.megapixels} | ${elapsedSeconds ?? '?'} | ${cached} | \`${file}\` | 待检 | ${note} |`;
}

/**
 * 追加一行到 docs/task_registry.md。以 prompt_id 前 8 位 + 候选 ID 幂等：
 * 补落盘（--from-history）或重跑时不会把同一件事记两遍。
 */
function appendRegistry(row, { promptId, candidateId }) {
  let text;
  try {
    text = readFileSync(REGISTRY, 'utf8');
  } catch (e) {
    return { ok: false, reason: `读不到 ${rel(REGISTRY)}：${e.message}` };
  }
  const stamp8 = `\`${String(promptId).slice(0, 8)}\``;
  const lines = text.split('\n');
  const sectionAt = lines.findIndex((l) => l.trim() === REGISTRY_SECTION);
  if (sectionAt === -1) {
    const block = `\n---\n\n${REGISTRY_SECTION}\n\n由 \`node agents/generator/run.js\` 自动追加，列的含义见第二节模板。\n**质检列先记「待检」**，⑤质检 跑完由人工或 Agent 改成 pass / fail。\n\n${REGISTRY_HEADER}\n${row}\n`;
    appendFileSync(REGISTRY, text.endsWith('\n') ? block.slice(1) : block, 'utf8');
    return { ok: true, skipped: false };
  }
  // 幂等：同一个 prompt_id + 同一个候选只记一次（补落盘或重跑不该把一件事记两遍）
  for (let i = sectionAt; i < lines.length; i++) {
    if (lines[i].startsWith('|') && lines[i].includes(stamp8) && lines[i].includes(candidateId)) {
      return { ok: true, skipped: true };
    }
  }
  let lastRow = sectionAt;
  for (let i = sectionAt; i < lines.length; i++) {
    if (lines[i].startsWith('|')) lastRow = i;
  }
  lines.splice(lastRow + 1, 0, row);
  writeFileSync(REGISTRY, lines.join('\n'), 'utf8');
  return { ok: true, skipped: false };
}

// ——— 主流程 ———

/**
 * ④生成 主流程（可编程调用；CLI 只是它的一层壳）。
 * 返回 { planDir, results, skipped, dryRun, submitted, failed }。
 * results 每项：{ candidateId, type, status: 'ok'|'skipped'|'error'|'planned', file?, doc?, message? }
 */
export async function runGenerator(options = {}) {
  const log = options.log ?? ((m) => console.log(m));
  const warnings = [];
  const stamp = makeStamp(new Date());

  // 1) 输入
  if (!options.requests?.length) throw new UsageError('缺少必填输入 --requests <c04 目录或文件>，见 --help');
  const entries = loadRequests(options.requests);
  log(`[生成] 收到 ${entries.length} 份 c04_gen_request`);

  // 2) 上游契约校验：c04 不过就不开工
  if (options.validate !== false) {
    const failures = [];
    let unavailable = false;
    for (const { doc, file, wrapped } of entries) {
      let target = file;
      let tmp = null;
      if (wrapped) {
        tmp = join(tmpdir(), `loom_c04_${process.pid}_${Date.now()}_${doc.payload.candidate_id}.json`);
        writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
        target = tmp;
      }
      let r;
      try {
        r = pythonValidate(target, 'c04_gen_request');
      } finally {
        if (tmp) rmSync(tmp, { force: true });
      }
      if (r === null) { unavailable = true; break; }
      if (r.code === 1) failures.push(`${rel(file)}：\n${r.out}`);
      else if (r.code !== 0) warnings.push(`${rel(file)} 契约校验未执行（退出码 ${r.code}）：${r.out}`);
    }
    if (unavailable) log('[生成] 警告：未找到可用的 python/jsonschema，跳过上游 c04 契约校验（只做 JS 自检）');
    else if (failures.length) throw new Error(`以下 c04 未通过 c04_gen_request 契约校验，④生成 拒绝开工：\n- ${failures.join('\n- ')}`);
    else log(`[生成] ${entries.length} 份 c04 全部通过契约结构校验`);
  }

  // 3) 节点 ID 映射（只查表，不硬编码）
  const map = loadNodeIdMap(WORKFLOWS_DIR);
  const templates = {};
  for (const t of ['T2V', 'I2V', 'R2V']) templates[t] = loadTemplate(WORKFLOWS_DIR, t).wf;
  log(`[生成] 节点 ID 映射与工作流模板已就位（${Object.keys(templates).join(' / ')}）`);

  // 4) 确定性预检 + 过滤
  const problems = [];
  for (const entry of entries) {
    const r = preCheck(entry, map, { dryRun: Boolean(options.dryRun) });
    problems.push(...r.problems);
    warnings.push(...r.warnings.map((w) => `${w}`));
  }
  problems.push(...crossCheck(entries));
  if (problems.length) {
    throw new Error(`开工前检查未通过，一份都没提交（填错节点等于白烧一整轮 GPU）：\n- ${problems.join('\n- ')}`);
  }

  let selected = entries;
  if (options.types?.length) selected = selected.filter((e) => options.types.includes(e.doc.payload.workflow.type));
  if (options.shots?.length) selected = selected.filter((e) => options.shots.includes(e.doc.payload.shot_id));
  if (options.candidates?.length) selected = selected.filter((e) => options.candidates.includes(e.doc.payload.candidate_id));
  if (!selected.length) throw new UsageError('过滤之后没有候选可提交（检查 --types / --shots / --candidates）');

  // 5) 分批排序：FL2VA 批（T2V→I2V）在前，Ref2VA 批（R2V）在后，同批内按候选 ID
  selected.sort((a, b) => {
    const pa = a.doc.payload;
    const pb = b.doc.payload;
    const d = BATCH_ORDER[pa.workflow.type] - BATCH_ORDER[pb.workflow.type];
    if (d) return d;
    return String(pa.candidate_id).localeCompare(String(pb.candidate_id));
  });

  // 6) 已有 meta.json 的候选默认跳过：重跑一次就是重烧一轮 GPU，还会覆盖掉当时的证据
  const skipped = [];
  if (!options.overwrite) {
    const keep = [];
    for (const e of selected) {
      const meta = join(shotDir(e.doc.payload.candidate_id), 'meta.json');
      if (existsSync(meta)) {
        skipped.push({ candidateId: e.doc.payload.candidate_id, type: e.doc.payload.workflow.type, status: 'skipped', message: `${rel(meta)} 已存在（要重跑加 --overwrite，会覆盖当时的证据）` });
        log(`[生成] 跳过 ${e.doc.payload.candidate_id}：${rel(meta)} 已存在`);
      } else keep.push(e);
    }
    selected = keep;
  }

  if (options.limit && selected.length > options.limit) {
    log(`[生成] --limit ${options.limit}：本次只提交前 ${options.limit} 个，其余 ${selected.length - options.limit} 个留到下一批`);
    selected = selected.slice(0, options.limit);
  }
  if (!selected.length) {
    log('[生成] 没有需要提交的候选（全部已存在或被过滤掉）');
    return { planDir: null, results: [], skipped, dryRun: Boolean(options.dryRun), submitted: 0, failed: 0 };
  }

  const byType = {};
  for (const e of selected) byType[e.doc.payload.workflow.type] = (byType[e.doc.payload.workflow.type] ?? 0) + 1;
  log(`[生成] 本批 ${selected.length} 个候选：${Object.entries(byType).map(([t, n]) => `${t} ${n}`).join(' · ')}（按 FL2VA→Ref2VA 排序提交）`);

  // 7) 逐候选填图（dry-run 也走到这一步：这是唯一能在没有节点时验的东西）
  const jobs = [];
  for (const entry of selected) {
    const c04 = entry.doc;
    const type = c04.payload.workflow.type;
    const mapEntry = map[MAP_KEY[type]];
    const apiJson = c04.payload.workflow.api_json;
    const template = apiJson ? loadTemplate(WORKFLOWS_DIR, type, apiJson).wf : templates[type];
    const built = buildGraph({ template, type, c04, mapEntry });
    if (built.problems.length) {
      throw new Error(`${c04.payload.candidate_id} 填图失败，未提交：\n- ${built.problems.join('\n- ')}`);
    }
    const mf = readModelFiles(built.graph, mapEntry, c04.payload.workflow.turbo_enabled === true);
    if (mf.problems.length) {
      throw new Error(`${c04.payload.candidate_id} 读不回权重清单：\n- ${mf.problems.join('\n- ')}`);
    }
    const unetProblems = checkUnetMatchesType(mf.model_files, type);
    if (unetProblems.length) throw new Error(`${c04.payload.candidate_id} 权重与工作流类型不匹配：\n- ${unetProblems.join('\n- ')}`);
    jobs.push({ entry, c04, type, mapEntry, graph: built.graph, writes: built.writes, imageWrites: built.imageWrites, modelFiles: mf.model_files, loraInGraph: mf.lora_in_graph, nodeCount: Object.keys(built.graph).length });
  }

  // 8) 落盘提交计划 / 实际提交的图
  const planDir = options.planDir ? resolve(options.planDir) : join(REPO_ROOT, 'artifacts', `genplan_${stamp}`);
  mkdirSync(planDir, { recursive: true });
  for (const job of jobs) {
    const cid = job.c04.payload.candidate_id;
    job.graphRel = rel(join(planDir, `${cid}.graph.json`));
    writeFileSync(join(planDir, `${cid}.graph.json`), JSON.stringify(job.graph, null, 2) + '\n', 'utf8');
  }

  const operator = options.submittedBy || defaultOperator();
  const cfg = comfyConfig({
    endpoint: options.endpoint,
    pollMs: (options.poll ?? 5) * 1000,
    waitTimeoutMs: (options.waitTimeout ?? 2700) * 1000,
  });

  // 9) dry-run：到此为止，绝不 POST，也绝不伪造 c05
  if (options.dryRun) {
    const planPath = join(planDir, 'plan.json');
    const plan = {
      created_at: new Date().toISOString(),
      mode: 'dry-run',
      endpoint: cfg.endpoint,
      submitted_by: operator,
      note: '未 POST 到 ComfyUI，未产出 c05。下面的图就是正式跑时会内联提交的那一份',
      batches: [],
    };
    let currentFamily = null;
    for (const job of jobs) {
      const family = WEIGHT_FAMILY[job.type];
      if (family !== currentFamily) {
        plan.batches.push({ weight_family: family, unet: EXPECTED_UNET[job.type], jobs: [] });
        currentFamily = family;
      }
      plan.batches[plan.batches.length - 1].jobs.push({
        candidate_id: job.c04.payload.candidate_id,
        shot_id: job.c04.payload.shot_id,
        workflow_type: job.type,
        graph_file: job.graphRel,
        node_count: job.nodeCount,
        model_files: job.modelFiles,
        writes: job.writes,
        image_writes: job.imageWrites,
        output_dir: rel(shotDir(job.c04.payload.candidate_id)),
      });
    }
    writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
    for (const w of [...new Set(warnings)]) log(`[生成] 警告：${w}`);
    log(`[生成] dry-run 完成：${jobs.length} 个候选的图已填好，未提交`);
    log(`[生成] 提交计划：${rel(planPath)}`);
    return {
      planDir, results: jobs.map((j) => ({ candidateId: j.c04.payload.candidate_id, type: j.type, status: 'planned', graphFile: j.graphRel })),
      skipped, dryRun: true, submitted: 0, failed: 0,
    };
  }

  // 10) 节点连通性
  if (options.fromHistory) {
    log(`[生成] --from-history ${options.fromHistory}：只补落盘，不提交新任务`);
    if (jobs.length !== 1) throw new UsageError(`--from-history 一次只补一个候选，当前选中 ${jobs.length} 个（用 --candidates 收窄）`);
  } else {
    try {
      const stats = await getSystemStats(cfg);
      const devices = stats?.devices ?? [];
      const mem = devices[0];
      log(`[生成] 节点已连通：${cfg.endpoint}${mem ? `（vram_total=${mem.vram_total}，与 ram_total 同值是这台机器的正常表现）` : ''}`);
    } catch (e) {
      throw new Error(`${e.message}\n\n没有节点时请加 --dry-run 只出提交计划。`);
    }
    if (!findFfprobe()) {
      throw new FfprobeError('本机没有 ffprobe。产物已生成但测不出硬指标，c05.ffprobe 就没法如实填——' +
        '与其先烧 GPU 再卡在落盘，不如现在停下。装法见 --help 上方说明，或先跑 --dry-run。');
    }
  }

  const results = [];
  let submitted = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let lastFamily = null;
  const uploaded = new Map(); // 本地路径 → 节点上的真实文件名
  let loadImageEnum; // undefined = 还没查过；null = 查了但取不到枚举；数组 = 可选文件名

  for (const job of jobs) {
    const cid = job.c04.payload.candidate_id;
    const family = WEIGHT_FAMILY[job.type];
    if (family !== lastFamily) {
      if (lastFamily !== null) {
        log(`[生成] —— 切换权重：${lastFamily} → ${family}（重载 21GB+，首个候选要付一次冷启动约 7 分钟）——`);
      } else {
        log(`[生成] —— 当前批次权重族：${family}（${EXPECTED_UNET[job.type]}）——`);
      }
      lastFamily = family;
      // R2V 批次开工前队列必须空：队列里还有 FL2VA 的活，换权重会把它们全打断
      if (!options.fromHistory) {
        try {
          const q = await getQueue(cfg);
          const busy = q.running.length + q.pending.length;
          if (busy > 0) {
            if (!options.forceQueue) {
              throw new Error(`切到 ${family} 批次时队列里还有 ${busy} 个任务（running ${q.running.length} / pending ${q.pending.length}）。` +
                `两套权重不能同时常驻，现在提交会把在跑的 ${lastFamily ?? 'FL2VA'} 任务打断。等队列清空，或加 --force-queue 明确接管。`);
            }
            warnings.push(`${cid}: 队列非空（${busy} 个）仍按 --force-queue 提交`);
          }
        } catch (e) {
          if (e instanceof ComfyError) throw new Error(`查不到队列状态，无法确认能否切权重：${e.message}`);
          throw e;
        }
      }
    }

    const startedAt = Date.now();
    try {
      // 素材上传：先传，再重查 LoadImage.image 枚举确认文件名真的在节点上
      const assets = collectAssets(job.c04);
      for (const { slot, ref } of assets) {
        const abs = resolve(REPO_ROOT, ref.source_path);
        if (uploaded.has(abs)) {
          if (uploaded.get(abs) !== ref.node_filename) {
            warnings.push(`${cid}: ${slot} 的 node_filename=${ref.node_filename}，但同一份文件上一次上传后叫 ${uploaded.get(abs)}，按实际名提交`);
          }
          continue;
        }
        const up = await uploadImage(cfg, abs);
        const actual = typeof up?.name === 'string' && up.name ? up.name : ref.node_filename;
        uploaded.set(abs, actual);
        if (actual !== ref.node_filename) {
          warnings.push(`${cid}: 素材 ${slot} 上传后节点文件名为 ${actual}，与 c04 写的 ${ref.node_filename} 不一致，已按实际名提交（请回头修 ③ 的素材清单）`);
          for (const w of job.imageWrites) {
            if (w.semantic === slot && w.value === ref.node_filename) w.value = actual;
          }
          const slotDef = (job.mapEntry.image_inputs ?? []).find((s) => s.role === slot);
          if (slotDef && job.graph[slotDef.node]) job.graph[slotDef.node].inputs[slotDef.key] = actual;
        }
      }
      if (assets.length) {
        if (loadImageEnum === undefined) {
          const info = await getObjectInfo(cfg, 'LoadImage');
          loadImageEnum = allowedValues(info?.input?.required?.image) ?? null;
          if (loadImageEnum === null) warnings.push(`${cid}: 取不到 LoadImage.image 枚举，无法确认素材已在节点上（POST 若报 Value not in list: image 就是这里）`);
        }
        if (Array.isArray(loadImageEnum)) {
          for (const { slot, ref } of assets) {
            const name = uploaded.get(resolve(REPO_ROOT, ref.source_path));
            if (name && !loadImageEnum.includes(name)) {
              throw new Error(`${cid}: 素材 ${slot} 的文件名 ${name} 不在 LoadImage.image 枚举里（上传后须重查 object_info；POST 会报 Value not in list: image）`);
            }
          }
        }
      }

      let promptId;
      let parsed;
      let queuePosition = null;

      if (options.fromHistory) {
        promptId = options.fromHistory;
        const record = await getHistoryRecord(cfg, promptId);
        if (!record) throw new Error(`/history 里没有 ${promptId}（ComfyUI 重启会清空 history，或 id 写错了）`);
        parsed = parseHistoryRecord(record);
      } else {
        try {
          queuePosition = (await getQueue(cfg)).pending.length;
        } catch { queuePosition = null; }
        const posted = await postPrompt(cfg, job.graph, {});
        promptId = posted.prompt_id;
        submitted++;
        log(`[生成] ${cid} 已提交：prompt_id=${promptId}${queuePosition === null ? '' : `（入队时前面还有 ${queuePosition} 个）`}`);
        const waited = await waitForHistory(cfg, promptId, {
          timeoutMs: cfg.waitTimeoutMs,
          pollMs: cfg.pollMs,
          onPoll: ({ polls, waitedMs }) => {
            if (polls % 6 === 1) log(`[生成] ${cid} 等待中… ${Math.round(waitedMs / 1000)}s（第 ${polls} 次轮询）`);
          },
        });
        parsed = parseHistoryRecord(waited.record);
      }

      if (parsed.statusStr === 'error') {
        const detail = parsed.messages.filter((m) => m.kind === 'execution_error').map((m) => JSON.stringify(m.data).slice(0, 400)).join('\n');
        throw new Error(`${cid}: ComfyUI 报执行失败（status_str=error）${detail ? `\n${detail}` : ''}`);
      }
      if (!parsed.files.length) throw new Error(`${cid}: /history 里没有产物文件（outputs 是空的；视频也在 "images" 键下，已按列表结构解析）`);

      // 缓存命中检测：全节点命中 = 输入与上一次完全相同，拿回来的是旧文件，不是新候选
      if (parsed.cachedNodes.length >= job.nodeCount && !options.allowCached) {
        throw new Error(`${cid}: ${parsed.cachedNodes.length}/${job.nodeCount} 个节点全部命中缓存，耗时 ${parsed.elapsedSeconds}s——` +
          `这是上一次的旧文件，不是新候选。多候选必须换 seed（docs/gpu_protocol.md 规则 2）。确认过就该这样，加 --allow-cached 放行。`);
      }
      if (parsed.cachedNodes.length > 0) {
        warnings.push(`${cid}: 缓存命中 ${parsed.cachedNodes.length}/${job.nodeCount} 个节点（部分命中正常，全命中就是撞输入了）`);
      }

      const video = parsed.files[0];
      if (parsed.files.length > 1) warnings.push(`${cid}: /history 返回了 ${parsed.files.length} 个产物，取第一个 ${video.filename}`);
      const dir = shotDir(cid);
      mkdirSync(dir, { recursive: true });
      const ext = extname(video.filename) || '.mp4';
      const dest = join(dir, `video${ext}`);
      const sizeBytes = await downloadView(cfg, video, dest);
      const buf = readFileSync(dest);
      const sha256 = sha256Of(buf);
      if (sha256Of(buf) !== sha256 || buf.length !== sizeBytes) {
        throw new Error(`${cid}: 落盘校验不一致（下载 ${sizeBytes} 字节 / 本地 ${buf.length} 字节），产物可能没写完`);
      }
      const videoRel = `shots/${cid}/video${ext}`;

      const probe = probeVideo(dest);
      writeFileSync(join(dir, 'ffprobe.txt'), probe.raw, 'utf8');
      if (!probe.contract.audio_stream) warnings.push(`${cid}: 产物没有音频流——H3 原生出声，这一项 ⑤质检 会判 fail`);
      log(`[生成] ${cid} 产物已落盘：${videoRel}（${describeProbe(probe.contract, probe.frameCount, probe.frameCountSource)}）`);

      const elapsed = parsed.elapsedSeconds ?? Math.round(((parsed.endMs ?? Date.now()) - (parsed.startMs ?? startedAt)) / 100) / 10;
      const doc = assembleC05({
        c04: job.c04, probe, parsed, videoRel, sha256, sizeBytes, promptId,
        submittedAt: msToIso(parsed.startMs ?? startedAt),
        finishedAt: msToIso(parsed.endMs ?? Date.now()),
        elapsedSeconds: elapsed,
        queuePosition,
        writes: job.writes,
        modelFiles: job.modelFiles,
        operator,
        notes: options.fromHistory ? `--from-history 补落盘（prompt_id 来自已有运行）` : '④生成 Agent 自动落盘',
        graphRel: job.graphRel,
      });
      const selfProblems = structuralCheck(doc, job.c04);
      if (selfProblems.length) throw new Error(`${cid}: c05 结构自检未通过：\n- ${selfProblems.join('\n- ')}`);

      const metaPath = join(dir, 'meta.json');
      writeFileSync(metaPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      if (options.validate !== false) {
        const r = pythonValidate(metaPath, 'c05_gen_result');
        if (r === null) warnings.push('未找到可用的 python/jsonschema，c05 只做了 JS 结构自检；提交前请手动跑 contracts/validate_contract.py');
        else if (r.code === 1) throw new Error(`${rel(metaPath)} 未通过 c05_gen_result 契约校验：\n${r.out}`);
        else if (r.code !== 0) warnings.push(`${rel(metaPath)} 契约校验未执行（退出码 ${r.code}）：${r.out}`);
      }

      if (options.registry !== false) {
        const note = options.fromHistory ? '--from-history 补落盘' : `权重族 ${family}`;
        const rr = appendRegistry(registryRow({ doc: job.c04, promptId, parsed, elapsedSeconds: elapsed, submittedBy: operator, note }), { promptId, candidateId: cid });
        if (!rr.ok) warnings.push(`登记表未追加：${rr.reason}`);
        else if (rr.skipped) log(`[生成] 登记表已有 ${cid} + ${String(promptId).slice(0, 8)} 的记录，跳过追加`);
      }

      results.push({ candidateId: cid, type: job.type, status: 'ok', file: metaPath, doc, elapsedSeconds: elapsed, promptId });
      consecutiveFailures = 0;
      log(`[生成] ${cid} 完成：耗时 ${elapsed}s，c05 已写入 ${rel(metaPath)}`);
    } catch (e) {
      failed++;
      consecutiveFailures++;
      results.push({ candidateId: cid, type: job.type, status: 'error', message: e.message });
      log(`[生成] ${cid} 失败：${e.message.split('\n')[0]}`);
      if (options.failFast) { log('[生成] --fail-fast：停止本批'); break; }
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        log(`[生成] 连续 ${consecutiveFailures} 个候选失败，熔断停止本批（剩下的很可能同一个原因，别继续烧 GPU）`);
        break;
      }
    }
  }

  for (const w of [...new Set(warnings)]) log(`[生成] 警告：${w}`);
  return { planDir, results, skipped, dryRun: false, submitted, failed };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[生成] ${e.message}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) { usage(); return; }
  try {
    const r = await runGenerator(args);
    const ok = r.results.filter((x) => x.status === 'ok');
    const bad = r.results.filter((x) => x.status === 'error');
    if (r.dryRun) {
      console.log(`[生成] dry-run 完成：
  提交计划：    ${rel(join(r.planDir, 'plan.json'))}
  填好的图：    ${rel(r.planDir)}/<候选>.graph.json（共 ${r.results.length} 份）
  未 POST、未产出 c05。正式跑去掉 --dry-run 即可，图与这里逐字节相同。`);
      return;
    }
    console.log(`[生成] 完成：
  提交：${r.submitted} 个候选 ｜ 成功 ${ok.length} ｜ 失败 ${bad.length} ｜ 跳过 ${r.skipped.length}
  提交的图：${rel(r.planDir)}/
  c05 与产物：${ok.map((x) => rel(dirname(x.file))).join('、') || '（无）'}${bad.length ? `\n  失败：${bad.map((x) => `${x.candidateId}（${x.message.split('\n')[0]}）`).join('；')}` : ''}

[生成] 下一步——交给 ⑤质检 Agent：
  node agents/qa/run.js --shots ${ok.map((x) => x.candidateId).join(',') || '<候选目录>'}
  客观项（时长/帧率/音视频流/32kHz 双声道/分辨率）由 ffprobe + 代码硬判，主观项交人工或视觉模型；
  fail 的候选带着 c06 去找 ⑥重试 Agent 换新 seed 重出 c04。`);
    if (bad.length) process.exitCode = 1;
  } catch (e) {
    console.error(`[生成] ${e.message}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
