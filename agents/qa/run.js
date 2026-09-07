#!/usr/bin/env node
// agents/qa/run.js — 「⑤质检」Agent 可执行入口（消费 c05_gen_result，产出 c06_qc_report）。
//
// 这一站的分界线是「可判定的事不许交给概率模型」：
//   客观 6 项（duration_in_range / fps_is_24 / has_video_stream / has_audio_stream / audio_32k_stereo /
//   resolution_matches_aspect_ratio）由 ffprobe 实测值 + 代码硬判，模型连判定权都拿不到；
//   主观 7 项只认三个来源，优先级从高到低：--review 侧清单（人真看过）> --vision（抽帧 + 视觉模型）
//   > skipped（未复核）。纯文本 LLM 只被允许判 no_red_line_violation——那一项比的是片约红线与
//   提示词/分镜描述的文字冲突，不需要看画面，是真能判的。
// 判不了的主观项不会伪装成 pass：按 --on-unreviewed（默认 human）分流，即契约说的「判不了的走 human」。
//
// 证据完整性：先按 c05.output.path 原样定位产物（只读不猜，见 docs/decisions/2026-09-07），
// 校 sha256 证明「这就是 ④ 当时测过的那个文件」；本机有 ffprobe 就重测一遍与 c05 对账，
// 对不上直接报错——那说明 c05 是手改的或产物被换过。本机没有 ffprobe 时降级采信 c05 的实测值
// 并大声告警（--require-ffprobe 可把降级变成阻塞）。
//
// 用法：node agents/qa/run.js --help

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENT_VERSION, QA, QA_TEXT_ONLY_ADDENDUM, QA_VISION_ADDENDUM } from './prompt.js';
import { LlmError, chat, extractJson, llmConfig } from './llm.js';
import { VisionError, describeFrames, extractFrames, findFfmpeg, framesToContent } from './vision.js';

export const AGENT_NAME = 'qc_agent';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'validate_contract.py');
const SHOTS_DIR = join(REPO_ROOT, 'shots');

const CANDIDATE_RE = /^S[0-9]{3}_c[0-9]{2}$/;

// 客观项：有仪器读数，代码判，模型不参与
const OBJECTIVE = [
  'duration_in_range', 'fps_is_24', 'has_video_stream', 'has_audio_stream',
  'audio_32k_stereo', 'resolution_matches_aspect_ratio',
];
// 主观项：必须有人（或视觉模型）真看过画面
const SUBJECTIVE = [
  'prompt_adherence', 'character_consistency', 'scene_consistency', 'motion_quality',
  'audio_matches_scene', 'no_visual_artifact', 'no_red_line_violation',
];
// 视觉通道能判的：静帧看得出构图/一致性/崩坏，看不出运动是否平滑，也听不到声音
const VISION_SCOPE = ['prompt_adherence', 'character_consistency', 'scene_consistency', 'no_visual_artifact', 'no_red_line_violation'];
// 纯文本通道能判的：只有这一项比的是文字
const TEXT_SCOPE = ['no_red_line_violation'];
// 主观硬伤：fail 即整条 fail，不给 pass_with_notes 的余地
const HARD_SUBJECTIVE = new Set(['prompt_adherence', 'character_consistency', 'no_red_line_violation']);
// c06 的 checks 排成这个固定次序（与 prompt.js 给模型的清单一致）。
// 客观项按依赖关系算（先看有没有视频流，再谈 fps 和分辨率），主观项按来源拼（复核清单先、moot 后），
// 不排序的话两份候选的 checks 次序会不一样，没法逐行对读，moot 项还会掉到数组末尾。
const CHECK_ORDER = [...OBJECTIVE, ...SUBJECTIVE];

const FPS_TOLERANCE = 0.5;
// 时长写 6 秒，下游 ComfyMathExpression 对齐到 17 的倍数（6s→141 帧 = 5.875s），
// 一个对齐步长 ≈ 17/24 = 0.708s，再加上容器时长取各流最大值（音轨常长几帧），所以容差取 0.75s。
// 用「时长×24」要求精确帧数一定误判，这个坑在 agents/generator/sample.js 的注释里有完整推导。
const DURATION_TOLERANCE = 0.75;
const ASPECT_TOLERANCE = 0.02;
const MEGAPIXEL_TOLERANCE = 0.15;
const DEFAULT_MAX_RETRIES = 3;
const SCORE_CAP_ON_OBJECTIVE_FAIL = 3.0; // 客观硬伤不该被主观高分掩盖（score 只用于多候选排序）

class UsageError extends Error {}

const rel = (p) => relative(REPO_ROOT, p).replaceAll('\\', '/');
const makeStamp = (d) => d.toISOString().slice(0, 19).replace(/[-:]/g, '');
const round = (n, k = 3) => Math.round(n * 10 ** k) / 10 ** k;

function usage() {
  console.log(`「⑤质检」Agent — 消费 c05_gen_result，逐候选产出 c06_qc_report

用法：
  node agents/qa/run.js --candidates S001_c01,S001_c02 [选项]
  node agents/qa/run.js --meta shots/S001_c01/meta.json [--meta <另一份>] [选项]

选项（定位待检产物，二选一，可混用）：
  --candidates <S001_c01,...>  候选 ID 列表，按 <shots-root>/<候选>/meta.json 定位
  --meta <路径>                c05 文件或目录，可重复（目录=收全部 meta.json / *.json）
  --shots-root <路径>          候选目录根，默认仓库的 shots/

选项（比对基准，都可选，给了判得更准）：
  --requests <路径>            ③提示词/⑥重试 产出的 c04（目录或文件，可重复）。
                               给才能判 prompt_adherence 的比对基准、时长/画幅/megapixels 的目标值，
                               并算出 retry_count（数同镜头里 retry_of 非空的 c04 有几份）
  --shotlist <路径>            ②分镜 的 c03。给才能拿到 consistency_group（scene/character_consistency 的分组依据）
  --brief <路径>               ①片约 的 c01。给才能逐条比对 red_lines（no_red_line_violation）

选项（主观项怎么判）：
  --review <路径>              人工/外部视觉模型的复核侧清单，格式见 agents/qa/sample_review.json。
                               优先级最高；清单里没写的项仍记 skipped，不会因为给了文件就默认全过
  --vision                     用 ffmpeg 抽帧 + 视觉模型判（需要 ffmpeg 与 LOOM_LLM_API_KEY）
  --vision-model <名称>        视觉模型名，默认 LOOM_LLM_VISION_MODEL 或 Qwen2.5-VL-72B-Instruct
  --frames <n>                 抽帧数，默认 4（按产物时长等间隔取每段中点）
  --on-unreviewed <human|edit> 主观项判不了时的分流，默认 human（契约：判不了的走 human）

选项（判定口径）：
  --max-retries <n>            重试上限，默认 3。retry_count 达到它就不再打回重试，改判 manual_intervention 转人工
  --retry-count <n>            手工指定本镜头已重试次数（没给 --requests 时用；给了就以数出来的为准）
  --trust-meta                 不重测 ffprobe，直接采信 c05 里的实测值（默认：有 ffprobe 且有产物就重测对账）
  --require-ffprobe            本机没有 ffprobe 时阻塞，不降级采信 c05（默认降级 + 大声告警）
  --require-video              产物文件不在本地时阻塞（默认：文件不在就只按 c05 的实测值判，--vision 一定阻塞）

选项（输出）：
  --out-dir <路径>             输出目录，默认 artifacts/qc_<时间戳>/，每候选一份 <candidate_id>.json
  --model <名称>               覆盖 LOOM_LLM_MODEL（纯文本通道用）
  --offline                    不调 LLM，主观项只认 --review，其余记 skipped
  --no-validate                跳过 python 契约校验（不建议）
  -h, --help                   显示本帮助`);
}

function parseArgs(argv) {
  const out = { candidates: [], meta: [], validate: true, frames: 4, onUnreviewed: 'human' };
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
      case '--candidates': out.candidates.push(...list(need())); break;
      case '--meta': out.meta.push(need()); break;
      case '--shots-root': out.shotsRoot = need(); break;
      case '--requests': (out.requests ??= []).push(need()); break;
      case '--shotlist': out.shotlist = need(); break;
      case '--brief': out.brief = need(); break;
      case '--review': out.review = need(); break;
      case '--vision': out.vision = true; break;
      case '--vision-model': out.visionModel = need(); break;
      case '--frames': out.frames = Number(need()); break;
      case '--on-unreviewed': out.onUnreviewed = need(); break;
      case '--max-retries': out.maxRetries = Number(need()); break;
      case '--retry-count': out.retryCount = Number(need()); break;
      case '--trust-meta': out.trustMeta = true; break;
      case '--require-ffprobe': out.requireFfprobe = true; break;
      case '--require-video': out.requireVideo = true; break;
      case '--out-dir': out.outDir = need(); break;
      case '--model': out.model = need(); break;
      case '--offline': out.offline = true; break;
      case '--no-validate': out.validate = false; break;
      case '-h': case '--help': out.help = true; break;
      default: throw new UsageError(`未知参数 ${a}（见 --help）`);
    }
  }
  // 「必须给 --candidates 或 --meta」这条必填检查放在 runQa() 开头，不放在这里：
  // parseArgs 跑在 main() 的 args.help 判断之前，写在这儿会让 --help 变成报用法错误而不是打印帮助。
  for (const c of out.candidates) if (!CANDIDATE_RE.test(c)) throw new UsageError(`--candidates 条目须形如 S001_c01，收到：${c}`);
  if (!['human', 'edit'].includes(out.onUnreviewed)) throw new UsageError(`--on-unreviewed 只认 human / edit，收到：${out.onUnreviewed}`);
  if (!Number.isInteger(out.frames) || out.frames < 1 || out.frames > 16) throw new UsageError(`--frames 须为 1–16 的整数，收到：${out.frames}`);
  if (out.maxRetries !== undefined && (!Number.isInteger(out.maxRetries) || out.maxRetries < 1)) throw new UsageError(`--max-retries 须为 ≥1 的整数（契约 minimum: 1），收到：${out.maxRetries}`);
  if (out.retryCount !== undefined && (!Number.isInteger(out.retryCount) || out.retryCount < 0)) throw new UsageError(`--retry-count 须为非负整数，收到：${out.retryCount}`);
  return out;
}

// ——— 载入 ———

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UsageError(`无法读取/解析${what} ${rel(path)}：${e.message}`);
  }
}

function walkJson(dir, onlyMeta = false) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkJson(p, onlyMeta));
    else if (name.toLowerCase().endsWith('.json') && (!onlyMeta || name === 'meta.json')) out.push(p);
  }
  return out;
}

/** 收集待检的 c05：--meta 直接给文件/目录，--candidates 按 <shots-root>/<候选>/meta.json 定位。 */
function collectTargets(args) {
  const shotsRoot = args.shotsRoot ? resolve(args.shotsRoot) : SHOTS_DIR;
  const targets = [];
  const seen = new Set();
  const push = (file) => {
    const abs = resolve(file);
    if (seen.has(abs)) return;
    seen.add(abs);
    targets.push(abs);
  };
  for (const m of args.meta) {
    const p = resolve(m);
    if (!existsSync(p)) throw new UsageError(`--meta 路径不存在：${m}`);
    if (statSync(p).isDirectory()) {
      const files = walkJson(p);
      if (!files.length) throw new UsageError(`${rel(p)} 里没有任何 .json`);
      for (const f of files) push(f);
    } else push(p);
  }
  for (const cid of args.candidates) {
    const p = join(shotsRoot, cid, 'meta.json');
    if (!existsSync(p)) {
      throw new UsageError(`找不到 ${rel(p)}。候选目录名 = candidate_id（扁平口径，见 docs/decisions/2026-09-07-editor-input-conventions.md）；` +
        `产物在别处就用 --meta <路径> 直接指，或用 --shots-root 换根目录`);
    }
    push(p);
  }
  return targets;
}

/** c04 索引：candidate_id → 文档；同时数出每个镜头已重试几次。 */
function indexRequests(paths) {
  const byCandidate = new Map();
  const retriesByShot = new Map();
  for (const raw of paths ?? []) {
    const p = resolve(raw);
    if (!existsSync(p)) throw new UsageError(`--requests 路径不存在：${raw}`);
    const files = statSync(p).isDirectory() ? walkJson(p) : [p];
    for (const f of files) {
      const doc = readJson(f, '生成请求');
      const pl = doc?.payload?.generation ? doc.payload : doc?.generation ? doc : null;
      if (!pl) continue; // 目录里混了别的 JSON（例如提交计划）就跳过
      byCandidate.set(pl.candidate_id, { doc: doc.payload ? doc : { envelope: null, payload: doc }, file: f });
      if (pl.retry_of) retriesByShot.set(pl.shot_id, (retriesByShot.get(pl.shot_id) ?? 0) + 1);
    }
  }
  return { byCandidate, retriesByShot };
}

function loadReview(path) {
  const raw = readJson(resolve(path), '复核侧清单');
  const out = new Map();
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    if (!CANDIDATE_RE.test(k)) throw new UsageError(`复核侧清单的键 ${k} 不是 candidate_id（须形如 S001_c01）`);
    out.set(k, v);
  }
  return out;
}

// ——— 证据完整性 ———

function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

let cachedFfprobe;
function findFfprobe() {
  if (cachedFfprobe !== undefined) return cachedFfprobe;
  const r = spawnSync('ffprobe', ['-version'], { encoding: 'utf8', timeout: 20_000 });
  cachedFfprobe = !r.error && r.status === 0 ? 'ffprobe' : null;
  return cachedFfprobe;
}

/**
 * 重测一遍产物，只取客观 6 项要用的那几个数。
 * 与 agents/generator/ffprobe.js 是两份代码：按 docs/agent_guide.md 第三节「一个 Agent 一个文件夹」，
 * 各站自包含，tools/ 入库后再合并（llm.js 现在是同样的处理方式）。
 */
function remeasure(videoPath) {
  const cmd = findFfprobe();
  if (!cmd) return null;
  const r = spawnSync(cmd, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', videoPath], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    throw new Error(`重测 ${rel(videoPath)} 失败（ffprobe 退出码 ${r.status}）：${((r.stderr || '') + (r.stdout || '')).trim().slice(0, 400)}`);
  }
  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`ffprobe 输出不是合法 JSON：${e.message}`);
  }
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1) ?? null;
  const a = streams.find((s) => s.codec_type === 'audio') ?? null;
  const duration = Number(data.format?.duration ?? v?.duration ?? a?.duration);
  return {
    duration_seconds: Number.isFinite(duration) && duration > 0 ? round(duration) : null,
    video_stream: v ? {
      codec_name: String(v.codec_name ?? 'unknown'),
      width: Number(v.width) || 0,
      height: Number(v.height) || 0,
      avg_frame_rate: String(v.avg_frame_rate ?? '0/0'),
      ...(v.pix_fmt ? { pix_fmt: String(v.pix_fmt) } : {}),
    } : null,
    audio_stream: a ? { codec_name: String(a.codec_name ?? 'unknown'), sample_rate: String(a.sample_rate ?? '0'), channels: Number(a.channels) || 0 } : null,
  };
}

/** c05 记的实测值与重测值对账。返回不一致清单（空 = 一致）。 */
function diffProbe(recorded, fresh) {
  const bad = [];
  const num = (x) => (typeof x === 'number' ? round(x, 2) : x);
  if (num(recorded.duration_seconds) !== num(fresh.duration_seconds)) {
    bad.push(`duration_seconds：c05 记 ${recorded.duration_seconds}，重测 ${fresh.duration_seconds}`);
  }
  const rv = recorded.video_stream ?? {};
  const fv = fresh.video_stream ?? {};
  for (const k of ['codec_name', 'width', 'height', 'avg_frame_rate']) {
    if (String(rv[k] ?? '') !== String(fv[k] ?? '')) bad.push(`video_stream.${k}：c05 记 ${JSON.stringify(rv[k] ?? null)}，重测 ${JSON.stringify(fv[k] ?? null)}`);
  }
  const ra = recorded.audio_stream;
  const fa = fresh.audio_stream;
  if ((ra === null) !== (fa === null)) {
    bad.push(`audio_stream：c05 记 ${ra === null ? '无音频流' : JSON.stringify(ra)}，重测 ${fa === null ? '无音频流' : JSON.stringify(fa)}`);
  } else if (ra && fa) {
    for (const k of ['codec_name', 'sample_rate', 'channels']) {
      if (String(ra[k] ?? '') !== String(fa[k] ?? '')) bad.push(`audio_stream.${k}：c05 记 ${JSON.stringify(ra[k])}，重测 ${JSON.stringify(fa[k])}`);
    }
  }
  return bad;
}

function parseRate(rate) {
  if (typeof rate !== 'string' || !rate.trim() || rate === '0/0') return null;
  const parts = rate.split('/');
  const a = Number(parts[0]);
  if (!Number.isFinite(a) || a === 0) return null;
  if (parts.length === 1) return a;
  const b = Number(parts[1]);
  if (!Number.isFinite(b) || b === 0) return null;
  return a / b;
}

/** "16:9 (Widescreen)" → 1.777…；解析不出返回 null。 */
function parseAspect(text) {
  const m = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/.exec(String(text ?? '').trim());
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : null;
}

// ——— 客观 6 项：代码硬判 ———

function objectiveChecks({ probe, targets, cid }) {
  const out = [];
  const v = probe.video_stream;
  const a = probe.audio_stream;

  // has_video_stream
  if (v && v.codec_name && v.width >= 64 && v.height >= 64) {
    out.push({ name: 'has_video_stream', status: 'pass', measured: `${v.codec_name} ${v.width}x${v.height}` });
  } else {
    out.push({ name: 'has_video_stream', status: 'fail', detail: v ? `视频流不完整（${JSON.stringify(v)}）` : '产物里没有视频流', measured: v ? `${v.codec_name} ${v.width}x${v.height}` : 'no video stream' });
  }

  // fps_is_24
  const fps = v ? parseRate(v.avg_frame_rate) : null;
  if (fps === null) {
    out.push({ name: 'fps_is_24', status: 'fail', detail: `帧率解析不出来（avg_frame_rate=${JSON.stringify(v?.avg_frame_rate ?? null)}）`, measured: String(v?.avg_frame_rate ?? '无') });
  } else if (Math.abs(fps - 24) <= FPS_TOLERANCE) {
    out.push({ name: 'fps_is_24', status: 'pass', measured: `${v.avg_frame_rate} = ${round(fps, 2)}fps` });
  } else {
    out.push({ name: 'fps_is_24', status: 'fail', detail: `H3 标称 24fps，实测 ${round(fps, 3)}fps（超出 ±${FPS_TOLERANCE} 容差）。fps 是模板常量，测出别的值说明图没填对或产物被转码过`, measured: `${v.avg_frame_rate} = ${round(fps, 3)}fps` });
  }

  // has_audio_stream / audio_32k_stereo
  if (a) {
    out.push({ name: 'has_audio_stream', status: 'pass', measured: `${a.codec_name} ${a.sample_rate}Hz ${a.channels}ch` });
    if (a.sample_rate === '32000' && a.channels === 2) {
      out.push({ name: 'audio_32k_stereo', status: 'pass', detail: '符合 H3 标称 32kHz 立体声', measured: `${a.sample_rate}Hz ${a.channels}ch` });
    } else {
      out.push({ name: 'audio_32k_stereo', status: 'fail', detail: `H3 标称 32000Hz 双声道，实测 ${a.sample_rate}Hz ${a.channels}ch`, measured: `${a.sample_rate}Hz ${a.channels}ch` });
    }
  } else {
    out.push({ name: 'has_audio_stream', status: 'fail', detail: '产物没有音频流。H3 是原生出声的，出不了声就是生成异常，不是「可选特性没开」', measured: 'no audio stream' });
    out.push({ name: 'audio_32k_stereo', status: 'skipped', detail: '无音频流，跳过' });
  }

  // duration_in_range
  const target = targets.durationSeconds;
  if (probe.duration_seconds === null) {
    out.push({ name: 'duration_in_range', status: 'fail', detail: '产物时长测不出来，文件可能没写完或被截断' });
  } else if (target === null) {
    // 没有 c04/c03 就没有「该多长」的基准，只能退到 H3 的物理区间；17 帧对齐会让实测略长于设定值
    const ok = probe.duration_seconds >= 4 && probe.duration_seconds <= 16;
    out.push({
      name: 'duration_in_range',
      status: ok ? 'pass' : 'fail',
      detail: ok
        ? `实测 ${probe.duration_seconds}s；没有 c04/c03 可比对目标时长，只确认它落在 H3 单次生成的 4–15s 区间（含对齐余量）`
        : `实测 ${probe.duration_seconds}s 落在 H3 单次生成 4–15s 之外`,
      measured: String(probe.duration_seconds),
    });
  } else {
    const diff = round(Math.abs(probe.duration_seconds - target), 3);
    if (diff <= DURATION_TOLERANCE) {
      out.push({ name: 'duration_in_range', status: 'pass', detail: `设定 ${target}s，实测 ${probe.duration_seconds}s，差 ${diff}s ≤ ${DURATION_TOLERANCE}s（一个 17 帧对齐步长）`, measured: String(probe.duration_seconds) });
    } else {
      out.push({ name: 'duration_in_range', status: 'fail', detail: `设定 ${target}s，实测 ${probe.duration_seconds}s，差 ${diff}s 超出 ±${DURATION_TOLERANCE}s`, measured: String(probe.duration_seconds) });
    }
  }

  // resolution_matches_aspect_ratio
  const wantAspect = targets.aspectRatio;
  const wantMp = targets.megapixels;
  if (!v || !v.width || !v.height) {
    out.push({ name: 'resolution_matches_aspect_ratio', status: 'skipped', detail: '没有可用的视频流宽高' });
  } else {
    const gotAspect = v.width / v.height;
    const gotMp = (v.width * v.height) / 1e6;
    const detail = [];
    let status = 'pass';
    if (wantAspect !== null && Math.abs(gotAspect - wantAspect) > wantAspect * ASPECT_TOLERANCE) {
      status = 'fail';
      detail.push(`画幅比要求 ${round(wantAspect, 4)}（${targets.aspectRatioText}），实测 ${round(gotAspect, 4)}（${v.width}x${v.height}）`);
    }
    if (typeof wantMp === 'number' && Math.abs(gotMp - wantMp) > wantMp * MEGAPIXEL_TOLERANCE) {
      status = 'fail';
      detail.push(`megapixels 要求 ${wantMp}，实测 ${round(gotMp, 4)}`);
    }
    if (status === 'pass') {
      detail.push(`${v.width}x${v.height} ≈ ${round(gotAspect, 3)}:1，megapixels ${round(gotMp, 3)}${wantMp === undefined ? '（没有 c04 可比对目标值，只核画幅比）' : ''}`);
    }
    out.push({ name: 'resolution_matches_aspect_ratio', status, detail: detail.join('；'), measured: `${v.width}x${v.height}` });
  }
  return out;
}

// ——— 主观 7 项：三个合法来源 ———

function findingsFromReview(entry, cid, warnings) {
  if (!entry) return { findings: [], score: null, rootCause: null, source: null, reviewer: null };
  if (typeof entry !== 'object' || Array.isArray(entry)) {
    warnings.push(`${cid}: 复核侧清单的条目不是对象，已忽略`);
    return { findings: [], score: null, rootCause: null, source: null, reviewer: null };
  }
  const findings = [];
  for (const f of entry.findings ?? []) {
    if (!f?.name) { warnings.push(`${cid}: 复核清单有 findings 条目缺 name，已忽略`); continue; }
    if (OBJECTIVE.includes(f.name)) {
      warnings.push(`${cid}: 复核清单里写了客观项 ${f.name}，已忽略——那 6 项有仪器读数，人工结论不覆盖实测值（要推翻请先看 shots/${cid}/ffprobe.txt 原文）`);
      continue;
    }
    if (!SUBJECTIVE.includes(f.name)) { warnings.push(`${cid}: 复核清单里的 ${f.name} 不是 13 项检查之一，已忽略`); continue; }
    if (!['pass', 'fail'].includes(f.status)) { warnings.push(`${cid}: 复核清单 ${f.name}.status=${JSON.stringify(f.status)}，只认 pass / fail，已忽略`); continue; }
    findings.push({ name: f.name, status: f.status, ...(f.detail ? { detail: String(f.detail) } : {}), ...(f.measured ? { measured: String(f.measured) } : {}) });
  }
  const seenNames = new Set();
  for (const f of findings) {
    if (seenNames.has(f.name)) warnings.push(`${cid}: 复核清单里 ${f.name} 出现了不止一次，取第一条`);
    seenNames.add(f.name);
  }
  return {
    findings: dedupeFindings(findings),
    score: typeof entry.score === 'number' ? entry.score : null,
    rootCause: typeof entry.root_cause === 'string' ? entry.root_cause : null,
    source: 'review',
    reviewer: typeof entry.reviewer === 'string' ? entry.reviewer : null,
  };
}

function dedupeFindings(list) {
  const seen = new Set();
  return list.filter((f) => (seen.has(f.name) ? false : (seen.add(f.name), true)));
}

function checkIntermediate(raw, scope, cid) {
  const problems = [];
  const list = raw?.findings;
  if (!Array.isArray(list)) return { findings: null, problems: ['输出缺少 findings 数组（中间形状：{ "findings": [{ "name", "status", "detail"?, "measured"? }], "root_cause", "score" }）'] };
  const findings = [];
  for (const f of list) {
    if (!f?.name) { problems.push('findings 里有条目缺 name'); continue; }
    if (!scope.includes(f.name)) { problems.push(`${cid}: ${f.name} 不在本轮 in-scope 清单里（没看到的不许判）`); continue; }
    if (OBJECTIVE.includes(f.name)) { problems.push(`${cid}: ${f.name} 是客观项，由 ffprobe + 代码判，不许你输出`); continue; }
    if (!['pass', 'fail'].includes(f.status)) { problems.push(`${cid}: ${f.name}.status=${JSON.stringify(f.status)}，只认 pass / fail`); continue; }
    if (f.status === 'fail' && (typeof f.detail !== 'string' || f.detail.length < 8)) {
      problems.push(`${cid}: ${f.name} 判 fail 必须给可执行的 detail（哪一秒、画面哪个位置、什么东西不对）`);
    }
    findings.push({ name: f.name, status: f.status, ...(typeof f.detail === 'string' && f.detail ? { detail: f.detail } : {}), ...(typeof f.measured === 'string' && f.measured ? { measured: f.measured } : {}) });
  }
  const score = typeof raw?.score === 'number' && raw.score >= 0 && raw.score <= 10 ? round(raw.score, 1) : null;
  const rootCause = typeof raw?.root_cause === 'string' && raw.root_cause.trim() ? raw.root_cause.trim() : null;
  return { findings: problems.length ? null : { findings: dedupeFindings(findings), score, rootCause }, problems };
}

function describeTarget(c05, c04, shot, brief) {
  const g = c04?.payload?.generation ?? {};
  const lines = [
    `候选：${c05.payload.candidate_id}（镜头 ${c05.payload.shot_id}，${c04?.payload?.workflow?.type ?? '类型未知'}）`,
    `提交给模型的英文提示词（这就是要比对的东西）：`,
    g.prompt ?? c05.payload.params_snapshot.prompt,
  ];
  if (Array.isArray(g.timecodes) && g.timecodes.length) lines.push(`时间码分段：${g.timecodes.join(' ')}`);
  if (shot) {
    lines.push(`分镜原始描述：景别 ${shot.shot_size ?? '?'}，运镜 ${shot.camera_move ?? '?'}，一致性组 ${shot.consistency_group ?? '无'}`);
    if (shot.visual_description) lines.push(`  画面：${shot.visual_description}`);
    if (shot.audio_description) lines.push(`  声音：${shot.audio_description}`);
    if (shot.reference_note) lines.push(`  参考素材说明（<Picture N> 的语义顺序）：${shot.reference_note}`);
  }
  const red = brief?.payload?.red_lines;
  lines.push(Array.isArray(red) && red.length ? `片约 red_lines（逐条比对）：\n${red.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}` : '片约 red_lines：本轮未提供 c01，无法逐条比对——这一项不要输出');
  return lines.join('\n');
}

/** 视觉通道：抽帧 + 视觉模型。模型没看过视频，只看过静帧，所以运动/音频两项不给它。 */
async function judgeByVision({ c05, c04, shot, brief, scope, frames, cfgVision, log, cid }) {
  log(`[质检] ${cid} 抽帧 ${frames.length} 张（${describeFrames(frames)}），交视觉模型 ${cfgVision.model}`);
  const text = `${describeTarget(c05, c04, shot, brief)}

本轮 in-scope（只判这几项，其余一个都不要输出）：${scope.join('、')}
附上的是从产物里等间隔抽出的 ${frames.length} 张静帧，位置：${describeFrames(frames)}。
这是静帧不是视频：motion_quality（运动是否平滑）与 audio_matches_scene（音画匹配）你判不了，不要输出。`;
  const messages = [
    { role: 'system', content: `${QA}\n\n${QA_VISION_ADDENDUM}` },
    { role: 'user', content: framesToContent(text, frames) },
  ];
  return callWithCorrection(messages, scope, cid, { model: { model: cfgVision.model }, tag: '视觉' });
}

/** 纯文本通道：只判 no_red_line_violation，因为那是唯一比文字就能判的项。 */
async function judgeByText({ c05, c04, shot, brief, scope, args, log, cid }) {
  const red = brief?.payload?.red_lines;
  if (!scope.length || !Array.isArray(red) || !red.length) {
    return { findings: [], score: null, rootCause: null, source: null, note: 'no_red_line_violation 缺 c01 的 red_lines，纯文本通道无可判项' };
  }
  log(`[质检] ${cid} 走纯文本通道：只判 no_red_line_violation（比对 ${red.length} 条片约红线）`);
  const messages = [
    { role: 'system', content: `${QA}\n\n${QA_TEXT_ONLY_ADDENDUM}` },
    { role: 'user', content: `${describeTarget(c05, c04, shot, brief)}

本轮 in-scope（只判这一项）：${scope.join('、')}` },
  ];
  const r = await callWithCorrection(messages, scope, cid, { model: args.model ? { model: args.model } : {}, tag: '文本' });
  return { ...r, note: null };
}

/** 一次调用 + 结构不过回灌纠正一轮（与 ②③⑦ 同一口径）。 */
async function callWithCorrection(messages, scope, cid, { model, tag }) {
  const attempt = (text) => checkIntermediate(extractJson(text), scope, cid);
  let text = await chat(messages, model ?? {});
  let first = attempt(text);
  if (!first.problems.length) return { ...first.findings, source: `${tag}-llm` };
  messages = [...messages, { role: 'assistant', content: text }, {
    role: 'user',
    content: `上一轮输出未通过结构校验：\n- ${first.problems.join('\n- ')}\n请按 system prompt 的中间形状重新输出修正后的完整 JSON（仍只输出一个 JSON 代码块）。`,
  }];
  text = await chat(messages, model ?? {});
  const second = attempt(text);
  if (second.problems.length) throw new LlmError(`${tag}通道纠正一轮后仍未通过结构校验：\n- ${second.problems.join('\n- ')}`);
  return { ...second.findings, source: `${tag}-llm` };
}

// ——— 分流决策（代码判，不由一次采样决定要不要再烧一轮 GPU） ———

function pickAction({ objective, subjective, targets }) {
  const failed = (name) => [...objective, ...subjective].some((c) => c.name === name && c.status === 'fail');
  const resCheck = [...objective].find((c) => c.name === 'resolution_matches_aspect_ratio');
  const resDetail = resCheck?.status === 'fail' ? resCheck.detail ?? '' : '';
  if (failed('no_red_line_violation')) {
    return { action: 'manual_intervention', patch: {}, rationale: '片约红线命中。换种子不会让红线消失，改哪一层（剧本/分镜/提示词）必须人来定，不许自动重试' };
  }
  if (failed('has_video_stream') || failed('has_audio_stream') || failed('audio_32k_stereo')) {
    return { action: 'new_seed', patch: {}, rationale: 'H3 原生出画出声，缺流或音频规格不对属生成异常而非提示词问题，换种子重试最省（⑥重试 会另取一个没用过的 seed）' };
  }
  if (failed('fps_is_24')) {
    return { action: 'manual_intervention', patch: {}, rationale: 'fps 是工作流模板常量 24，实测不是 24 说明图没填对或产物被转码过——这是管线问题，重试同样会错' };
  }
  if (resCheck?.status === 'fail' && /画幅比/.test(resDetail)) {
    return { action: 'manual_intervention', patch: {}, rationale: `画幅比与要求不符（${resDetail}）。aspect_ratio 写的是常量 16:9，实测不符说明模板或节点 ID 映射有问题，先跑 python workflows/preflight.py 与 verify_map.py` };
  }
  if (failed('duration_in_range')) {
    return { action: 'change_duration', patch: targets.durationSeconds === null ? {} : { duration_seconds: targets.durationSeconds }, rationale: `实测时长超出设定值 ±${DURATION_TOLERANCE}s，按分镜目标时长重设（写秒不写帧，下游自动对齐 17 的倍数）` };
  }
  if (resCheck?.status === 'fail') {
    return { action: 'raise_megapixels', patch: { megapixels: 1.0 }, rationale: `分辨率与 megapixels 目标不符（${resDetail}）。试错档 0.4 提到 H3 标称的 1.0，耗时会上去，成片批次本来也要提` };
  }
  if (failed('prompt_adherence')) {
    return { action: 'rewrite_prompt', patch: {}, rationale: '画面没跟上提示词。⑥重试 改不了提示词（它只被授权动 payload.generation 的白名单字段），会据此打回 ③提示词 重写；这里不代填 patch.prompt' };
  }
  if (failed('character_consistency')) {
    return { action: 'change_reference_asset', patch: {}, rationale: '角色与参考图不一致。素材位与提示词里的 <Picture N> 一一绑定，换图必须连提示词一起改，⑥重试 会据此打回 ③提示词' };
  }
  const soft = subjective.filter((c) => c.status === 'fail');
  if (soft.some((c) => c.name === 'no_visual_artifact') && targets.megapixels !== undefined && targets.megapixels < 1.0) {
    return {
      action: 'raise_megapixels',
      patch: { megapixels: 1.0 },
      rationale: `画面伪影出现在 megapixels=${targets.megapixels}（试错档约 480p）——细小纹理在这个分辨率下本来就不稳定，换种子只是换一个同样糊的采样。先按 H3 标称的 1.0 复核一次，再决定要不要换种子`,
    };
  }
  if (soft.length) {
    return { action: 'new_seed', patch: {}, rationale: `失败项 ${soft.map((c) => c.name).join('、')} 都属观感类，换种子最可能改善，成本也最低` };
  }
  return { action: 'new_seed', patch: {}, rationale: '未定位到具体机制，按最低成本先换种子' };
}

function decide({ objective, subjective, unreviewed, retryCount, maxRetries, onUnreviewed, targets }) {
  const objFails = objective.filter((c) => c.status === 'fail');
  const hardFails = subjective.filter((c) => c.status === 'fail' && HARD_SUBJECTIVE.has(c.name));
  const softFails = subjective.filter((c) => c.status === 'fail' && !HARD_SUBJECTIVE.has(c.name));
  const exhausted = retryCount >= maxRetries;

  if (objFails.length || hardFails.length) {
    return {
      verdict: 'fail',
      route_to: exhausted ? 'human' : 'retry',
      failed_items: [...objFails, ...hardFails, ...softFails].map((c) => c.name),
      exhausted,
      suggested_change: exhausted
        ? { action: 'manual_intervention', patch: {}, rationale: `已重试 ${retryCount} 次（上限 ${maxRetries}）仍 fail。再烧 GPU 只是重复同一个失败，转人工决定：改剧本/分镜、换工作流类型，还是放弃这个镜头` }
        : pickAction({ objective, subjective, targets }),
    };
  }
  if (softFails.length) {
    return {
      verdict: 'pass_with_notes',
      route_to: unreviewed.length ? onUnreviewed : 'edit',
      failed_items: softFails.map((c) => c.name),
      exhausted: false,
      suggested_change: pickAction({ objective, subjective, targets }),
    };
  }
  if (unreviewed.length) {
    return {
      verdict: 'pass_with_notes',
      route_to: onUnreviewed,
      failed_items: [],
      exhausted: false,
      suggested_change: { action: 'manual_intervention', patch: {}, rationale: `客观项全过，但 ${unreviewed.join('、')} 没人真看过画面，未复核。要判就补 --review 侧清单或加 --vision；直接放行进剪辑用 --on-unreviewed edit` },
    };
  }
  return { verdict: 'pass', route_to: 'edit', failed_items: [], exhausted: false, suggested_change: null };
}

// ——— 结构自检 + 权威校验 ———

function structuralCheck(doc, c05) {
  const p = [];
  if (!doc?.envelope || !doc?.payload) return ['缺 envelope/payload 外壳'];
  const pl = doc.payload;
  const cid = pl.candidate_id ?? '?';
  if (pl.shot_id !== c05.payload.shot_id) p.push(`${cid}: shot_id 与 c05 不一致`);
  if (pl.candidate_id !== c05.payload.candidate_id) p.push(`${cid}: candidate_id 与 c05 不一致`);
  if (!CANDIDATE_RE.test(pl.candidate_id ?? '')) p.push(`${cid}: candidate_id 不合契约 pattern`);
  if (!['pass', 'pass_with_notes', 'fail'].includes(pl.verdict)) p.push(`${cid}: verdict 须为 pass / pass_with_notes / fail`);
  if (!['retry', 'edit', 'human'].includes(pl.route_to)) p.push(`${cid}: route_to 须为 retry / edit / human`);
  if (pl.score !== undefined && !(pl.score >= 0 && pl.score <= 10)) p.push(`${cid}: score 须在 0–10`);
  if (!Array.isArray(pl.checks) || !pl.checks.length) p.push(`${cid}: checks 须为非空数组`);
  const names = new Set();
  for (const c of pl.checks ?? []) {
    if (!OBJECTIVE.includes(c.name) && !SUBJECTIVE.includes(c.name)) p.push(`${cid}: checks 里有未知项 ${c.name}`);
    if (names.has(c.name)) p.push(`${cid}: checks 里 ${c.name} 出现了不止一次`);
    names.add(c.name);
    if (!['pass', 'fail', 'skipped'].includes(c.status)) p.push(`${cid}: ${c.name}.status 须为 pass / fail / skipped`);
    if (OBJECTIVE.includes(c.name) && c.status === 'skipped' && c.name !== 'audio_32k_stereo' && c.name !== 'resolution_matches_aspect_ratio') {
      p.push(`${cid}: 客观项 ${c.name} 不许 skipped——它有仪器读数，测不出来就是 fail`);
    }
  }
  for (const n of OBJECTIVE) if (!names.has(n)) p.push(`${cid}: 缺客观项 ${n}`);
  const fails = (pl.checks ?? []).filter((c) => c.status === 'fail').map((c) => c.name).sort();
  const declared = (pl.failed_items ?? []).slice().sort();
  if (fails.join(',') !== declared.join(',')) {
    p.push(`${cid}: failed_items 须与 checks 里 status=fail 的项完全一致（实际 ${JSON.stringify(fails)}，声明 ${JSON.stringify(declared)}）`);
  }
  // 分流必须自洽：这是「人机边界是机器会拦的东西」在 ⑤ 的体现
  if (pl.verdict === 'fail' && pl.route_to === 'edit') p.push(`${cid}: verdict=fail 却 route_to=edit，坏镜头不许直接进剪辑`);
  if (pl.verdict === 'pass' && pl.route_to === 'retry') p.push(`${cid}: verdict=pass 却 route_to=retry，没有失败项就不该再烧一轮 GPU`);
  if (pl.route_to === 'retry' && pl.retry_count >= pl.max_retries) {
    p.push(`${cid}: retry_count=${pl.retry_count} 已达上限 max_retries=${pl.max_retries}，必须转 human（防止无限烧 GPU）`);
  }
  if (pl.route_to === 'retry' && !pl.suggested_change?.action) p.push(`${cid}: route_to=retry 必须给可执行的 suggested_change.action`);
  if (pl.suggested_change && !['new_seed', 'rewrite_prompt', 'change_duration', 'change_reference_asset', 'switch_workflow_type', 'raise_megapixels', 'enable_turbo', 'manual_intervention'].includes(pl.suggested_change.action)) {
    p.push(`${cid}: suggested_change.action=${pl.suggested_change.action} 不在契约枚举里`);
  }
  if (pl.gate?.required !== false || pl.gate?.status !== 'not_required') {
    p.push(`${cid}: c06 不是强制人工关口，gate 须为 { required: false, status: "not_required" }`);
  }
  if (!(doc.envelope.upstream_refs ?? []).includes(c05.envelope?.artifact_id)) {
    p.push(`${cid}: envelope.upstream_refs 必须含 c05 的 artifact_id（${c05.envelope?.artifact_id}），否则追溯链断了`);
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

function pythonValidate(file, contract) {
  const py = findPython();
  if (!py) return null;
  const report = join(tmpdir(), `loom_report_${process.pid}_${Date.now()}.txt`);
  const r = spawnSync(py, [VALIDATOR, '--contract', contract, '--file', file, '--report', report], { encoding: 'utf8', cwd: REPO_ROOT });
  rmSync(report, { force: true });
  if (r.error || r.status === null) return null;
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

// ——— 主流程 ———

/**
 * ⑤质检 主流程（可编程调用；CLI 只是它的一层壳）。
 * 返回 { outDir, results, files }。results 每项 { candidateId, verdict, routeTo, failedItems, unreviewed, status, file?, message? }
 */
export async function runQa(options = {}) {
  const log = options.log ?? ((m) => console.log(m));
  const warnings = [];
  const stamp = makeStamp(new Date());

  const args = options.parsed ?? options;
  if (!args.candidates?.length && !args.meta?.length) throw new UsageError('必须给 --candidates 或 --meta 之一来定位待检产物，见 --help');
  const targets = collectTargets(args);
  log(`[质检] 待检 ${targets.length} 份 c05_gen_result`);

  // 比对基准
  const { byCandidate: c04s, retriesByShot } = indexRequests(args.requests);
  const shotlistDoc = args.shotlist ? readJson(resolve(args.shotlist), '镜头清单') : null;
  const briefDoc = args.brief ? readJson(resolve(args.brief), '片约') : null;
  const shotsById = new Map((shotlistDoc?.payload?.shots ?? []).map((s) => [s.shot_id, s]));
  const review = args.review ? loadReview(args.review) : null;
  if (shotlistDoc) log(`[质检] 镜头清单：${rel(resolve(args.shotlist))}（${shotsById.size} 镜）`);
  if (briefDoc) log(`[质检] 片约：${rel(resolve(args.brief))}（red_lines ${briefDoc.payload?.red_lines?.length ?? 0} 条）`);
  if (c04s.size) log(`[质检] 生成请求：${c04s.size} 份 c04（prompt_adherence 的比对基准 + retry_count 的来源）`);
  if (review) log(`[质检] 复核侧清单：${rel(resolve(args.review))}（${review.size} 个候选有人真看过）`);

  // LLM 通道
  const cfgText = llmConfig(args.model ? { model: args.model } : {});
  const cfgVision = llmConfig({ model: args.visionModel || process.env.LOOM_LLM_VISION_MODEL || 'Qwen2.5-VL-72B-Instruct' });
  const llmOn = !args.offline && Boolean(cfgText.apiKey);
  if (args.offline) log('[质检] --offline：不调 LLM，主观项只认 --review，其余记 skipped');
  else if (!cfgText.apiKey && !review) log('[质检] 未配置 LLM API Key 且没有 --review：主观项全部记 skipped（未复核），按 --on-unreviewed 分流');

  const ffprobeOk = Boolean(findFfprobe());
  if (!ffprobeOk) {
    const msg = '本机没有 ffprobe，无法重测产物与 c05 对账';
    if (args.requireFfprobe) throw new Error(`${msg}（--require-ffprobe 已把降级变成阻塞）。装法见 agents/generator/ffprobe.js 顶部`);
    warnings.push(`${msg}，降级采信 c05 里 ④生成 记下的实测值。这不是等价替代：c05 可能是手改的，重测才是对账`);
  }

  const maxRetries = args.maxRetries ?? DEFAULT_MAX_RETRIES;
  const outDir = args.outDir ? resolve(args.outDir) : join(REPO_ROOT, 'artifacts', `qc_${stamp}`);
  mkdirSync(outDir, { recursive: true });

  const results = [];
  const files = [];

  for (const metaPath of targets) {
    const c05 = readJson(metaPath, 'c05');
    if (!c05?.payload?.candidate_id) throw new UsageError(`${rel(metaPath)} 里没有 payload.candidate_id，不是有效的 c05_gen_result`);
    const cid = c05.payload.candidate_id;
    log(`[质检] —— ${cid} ——`);

    // 上游 c05 必须自己就合规，否则后面的判定都建在沙上
    if (args.validate !== false) {
      const r = pythonValidate(metaPath, 'c05_gen_result');
      if (r === null) warnings.push(`${cid}: 未找到可用的 python/jsonschema，跳过上游 c05 契约校验`);
      else if (r.code === 1) throw new Error(`${rel(metaPath)} 未通过 c05_gen_result 契约校验，⑤质检 拒绝开工：\n${r.out}`);
      else if (r.code !== 0) warnings.push(`${cid}: 上游 c05 契约校验未执行（退出码 ${r.code}）：${r.out}`);
    }

    const c04Entry = c04s.get(cid);
    const c04 = c04Entry?.doc ?? null;
    const shot = shotsById.get(c05.payload.shot_id) ?? null;
    if (!c04) warnings.push(`${cid}: 没有对应的 c04（用 --requests 给），prompt_adherence 缺比对基准、时长/画幅/megapixels 只能用 c05 的 params_snapshot 当目标值`);

    // 产物：按 c05.output.path 原样定位，不猜别的口径
    const videoPath = resolve(REPO_ROOT, c05.payload.output.path);
    const videoExists = existsSync(videoPath);
    let probeSource = 'c05';
    if (!videoExists) {
      const msg = `${cid}: 产物不在本地 ${rel(videoPath)}（视频不入库是故意的，见 shots/README.md）`;
      if (args.requireVideo) throw new Error(`${msg}。--require-video 已把这种情况变成阻塞`);
      if (args.vision) throw new Error(`${msg}。--vision 要抽帧，必须有文件`);
      warnings.push(`${msg}，只按 c05 记下的实测值判客观项，且无法重测对账`);
    } else {
      const sha = sha256OfFile(videoPath);
      if (sha !== c05.payload.output.sha256) {
        throw new Error(`${cid}: 产物 sha256 与 c05 记的不一致（c05 ${c05.payload.output.sha256.slice(0, 16)}… / 实测 ${sha.slice(0, 16)}…）。` +
          `文件不是 ④ 当时测过的那一个——被覆盖过或换过。证据链断了，⑤质检 拒绝在这个文件上出结论`);
      }
      const size = statSync(videoPath).size;
      if (size !== c05.payload.output.size_bytes) {
        throw new Error(`${cid}: 产物字节数与 c05 记的不一致（c05 ${c05.payload.output.size_bytes} / 实测 ${size}），但 sha256 相同——这不可能同时成立，请检查 c05 是不是手改过`);
      }
      if (!args.trustMeta && ffprobeOk) {
        const fresh = remeasure(videoPath);
        if (!fresh) throw new Error(`${cid}: 重测 ${rel(videoPath)} 没有得到任何流信息`);
        const bad = diffProbe(c05.payload.ffprobe, fresh);
        if (bad.length) {
          throw new Error(`${cid}: 重测结果与 c05 记录的实测值不一致，c05 可能是手改的或产物被换过（sha256 相同却测出别的值，说明 c05 那份不是从这个文件测的）：\n- ${bad.join('\n- ')}\n原始输出在 shots/${cid}/ffprobe.txt，以它为准对账。确认过 c05 无误、只是本机 ffprobe 版本差异，可加 --trust-meta 跳过重测`);
        }
        probeSource = 'c05（已重测对账一致）';
        log(`[质检] ${cid} sha256 与重测均与 c05 一致，证据链完好`);
      } else if (args.trustMeta) {
        probeSource = 'c05（已校 sha256，--trust-meta 主动跳过重测）';
      } else {
        probeSource = 'c05（已校 sha256，本机无 ffprobe 所以没重测）';
      }
    }

    const targetsForChecks = {
      durationSeconds: c04?.payload?.generation?.duration_seconds ?? shot?.duration_seconds ?? c05.payload.params_snapshot?.duration_seconds ?? null,
      aspectRatioText: c04?.payload?.generation?.aspect_ratio ?? briefDoc?.payload?.aspect_ratio ?? null,
      aspectRatio: parseAspect(c04?.payload?.generation?.aspect_ratio ?? briefDoc?.payload?.aspect_ratio),
      megapixels: c04?.payload?.generation?.megapixels ?? c05.payload.params_snapshot?.megapixels,
    };
    const objective = objectiveChecks({ probe: c05.payload.ffprobe, targets: targetsForChecks, cid });

    // 客观项已经把某些主观项变成无从判起：没有视频流就没画面可看，没有音频流就没声音可听。
    // 这些记 skipped 并写明原因，但【不算未复核】——让去看一个没有视频流的文件是噪音，
    // 而把它们混进 unreviewed 会把真实原因（产物缺流）藏起来。
    const objFailed = (name) => objective.some((c) => c.name === name && c.status === 'fail');
    const moot = new Map();
    if (objFailed('has_video_stream')) {
      for (const n of ['prompt_adherence', 'character_consistency', 'scene_consistency', 'motion_quality', 'no_visual_artifact']) {
        moot.set(n, '产物没有可用视频流，无画面可判（has_video_stream 已 fail）');
      }
    }
    if (objFailed('has_audio_stream')) {
      moot.set('audio_matches_scene', '产物没有音频流，无声音可判（has_audio_stream 已 fail）');
    }

    // 主观项
    const reviewed = findingsFromReview(review?.get(cid), cid, warnings);
    const subjective = [];
    const unreviewed = [];
    let channel = reviewed.source ?? null;
    let score = reviewed.score;
    let llmRootCause = reviewed.rootCause;
    const reviewer = reviewed.reviewer;
    const covered = new Set();
    for (const f of reviewed.findings) {
      if (moot.has(f.name)) {
        warnings.push(`${cid}: 复核清单给了 ${f.name}=${f.status}，但该项已因客观缺流无从判起，按 skipped 记（没有画面/声音时的 pass 不是证据）`);
        continue;
      }
      subjective.push({ ...f, by: 'review' });
      covered.add(f.name);
    }
    for (const [name, why] of moot) {
      subjective.push({ name, status: 'skipped', detail: `无从判起：${why}`, by: 'moot' });
      covered.add(name);
    }
    const remaining = SUBJECTIVE.filter((n) => !covered.has(n));

    if (remaining.length && llmOn) {
      const wantVision = Boolean(args.vision);
      const scope = (wantVision ? VISION_SCOPE : TEXT_SCOPE).filter((n) => remaining.includes(n));
      if (scope.length) {
        try {
          let frames = null;
          if (wantVision) {
            if (!findFfmpeg()) {
              throw new VisionError('--vision 需要 ffmpeg 抽帧，本机没有。装法与替代方案（--review 侧清单）见 agents/qa/vision.js 顶部的报错文本', { available: false });
            }
            frames = extractFrames(videoPath, { count: args.frames, durationSeconds: c05.payload.ffprobe.duration_seconds });
          }
          const r = wantVision
            ? await judgeByVision({ c05, c04, shot, brief: briefDoc, videoPath, scope, frames, cfgVision, log, cid })
            : await judgeByText({ c05, c04, shot, brief: briefDoc, scope, args, log, cid });
          if (r.source) channel = channel ? `${channel}+${r.source}` : r.source;
          for (const f of r.findings ?? []) {
            if (covered.has(f.name)) continue;
            subjective.push({ ...f, by: r.source ?? 'llm' });
            covered.add(f.name);
          }
          if (score === null && typeof r.score === 'number') score = r.score;
          if (!llmRootCause && r.rootCause) llmRootCause = r.rootCause;
          if (r.note) warnings.push(`${cid}: ${r.note}`);
        } catch (e) {
          warnings.push(`${cid}: ${wantVision ? '视觉' : '文本'}通道失败（${e.message.split('\n')[0]}），相关主观项记 skipped 未复核`);
        }
      } else if (wantVision) {
        warnings.push(`${cid}: --vision 的 in-scope 项已被复核清单覆盖，未调用视觉模型`);
      }
    } else if (remaining.length && args.vision && !llmOn) {
      warnings.push(`${cid}: --vision 需要 LOOM_LLM_API_KEY，未配置，视觉通道未启用`);
    }

    for (const name of SUBJECTIVE) {
      if (covered.has(name)) continue;
      const why = name === 'motion_quality' && args.vision ? '视觉通道只看静帧，运动是否平滑判不了'
        : name === 'audio_matches_scene' && args.vision ? '视觉通道听不到音频'
          : '没有复核结论，也没有可用的判定通道';
      subjective.push({ name, status: 'skipped', detail: `未复核：${why}`, by: 'unreviewed' });
      unreviewed.push(name);
    }

    const retryCount = args.retryCount ?? retriesByShot.get(c05.payload.shot_id) ?? 0;
    if (args.retryCount === undefined && !args.requests?.length) {
      warnings.push(`${cid}: 没有 --requests，无法数出本镜头已重试几次，retry_count 记 0。要准确就用 --requests 给 c04，或 --retry-count 手工指定`);
    }

    const decision = decide({
      objective, subjective, unreviewed, retryCount, maxRetries,
      onUnreviewed: args.onUnreviewed ?? 'human', targets: targetsForChecks,
    });

    const objFails = objective.filter((c) => c.status === 'fail');
    const rootParts = [];
    if (objFails.length) {
      rootParts.push(`客观硬指标不合格：${objFails.map((c) => `${c.name}（${c.detail ?? c.measured ?? '见 measured'}）`).join('；')}`);
    }
    if (llmRootCause) rootParts.push(llmRootCause);
    const softFails = subjective.filter((c) => c.status === 'fail' && !HARD_SUBJECTIVE.has(c.name));
    if (!objFails.length && !llmRootCause && softFails.length) {
      rootParts.push(`观感类不合格：${softFails.map((c) => `${c.name}（${c.detail ?? ''}）`).join('；')}`);
    }
    if (unreviewed.length) {
      rootParts.push(`${unreviewed.length} 项主观检查未复核（${unreviewed.join('、')}）——不是判过没问题，是没人真看过画面`);
    }

    if (score !== null && objFails.length && score > SCORE_CAP_ON_OBJECTIVE_FAIL) {
      warnings.push(`${cid}: score ${score} 被压到 ${SCORE_CAP_ON_OBJECTIVE_FAIL}（客观硬伤不该被主观高分掩盖，score 只用于多候选排序）`);
      score = SCORE_CAP_ON_OBJECTIVE_FAIL;
    }

    const notes = [
      `客观项数据来源：${probeSource}${videoExists ? '' : '（产物不在本地，未校 sha256）'}`,
      `主观项通道：${channel ?? '无（全部未复核）'}`,
      reviewer ? `复核人：${reviewer}` : null,
      unreviewed.length ? `未复核 ${unreviewed.length} 项，按 --on-unreviewed ${args.onUnreviewed ?? 'human'} 分流` : null,
    ].filter(Boolean).join('；');

    const upstream = [c05.envelope?.artifact_id, c04?.envelope?.artifact_id].filter(Boolean);
    const doc = {
      envelope: {
        schema_version: '1.0',
        artifact_id: `qc.${cid}`,
        contract: 'c06_qc_report',
        created_at: new Date().toISOString(),
        producer: { kind: 'agent', name: AGENT_NAME, agent_version: AGENT_VERSION },
        upstream_refs: [...new Set(upstream)],
        notes,
      },
      payload: {
        shot_id: c05.payload.shot_id,
        candidate_id: cid,
        verdict: decision.verdict,
        ...(score === null ? {} : { score }),
        checks: [...objective, ...subjective]
          .map(({ by, ...c }) => c)
          .sort((a, b) => CHECK_ORDER.indexOf(a.name) - CHECK_ORDER.indexOf(b.name)),
        ...(decision.failed_items.length ? { failed_items: decision.failed_items } : {}),
        ...(rootParts.length ? { root_cause: rootParts.join('。') } : {}),
        ...(decision.suggested_change ? { suggested_change: decision.suggested_change } : {}),
        retry_count: retryCount,
        max_retries: maxRetries,
        route_to: decision.route_to,
        gate: { required: false, status: 'not_required' },
      },
    };

    const selfProblems = structuralCheck(doc, c05);
    if (selfProblems.length) throw new Error(`${cid}: c06 结构自检未通过：\n- ${selfProblems.join('\n- ')}`);

    const file = join(outDir, `${cid}.json`);
    writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    files.push(file);
    if (args.validate !== false) {
      const r = pythonValidate(file, 'c06_qc_report');
      if (r === null) warnings.push(`${cid}: 未找到可用的 python/jsonschema，c06 只做了 JS 结构自检；提交前请手动跑 contracts/validate_contract.py`);
      else if (r.code === 1) throw new Error(`${rel(file)} 未通过 c06_qc_report 契约校验：\n${r.out}`);
      else if (r.code !== 0) warnings.push(`${cid}: 契约校验未执行（退出码 ${r.code}）：${r.out}`);
    }

    results.push({
      candidateId: cid, shotId: c05.payload.shot_id, status: 'ok', file, doc,
      verdict: decision.verdict, routeTo: decision.route_to,
      failedItems: decision.failed_items, unreviewed, retryCount,
      action: decision.suggested_change?.action ?? null,
    });
    log(`[质检] ${cid} → ${decision.verdict} / 转 ${decision.route_to}` +
      `${decision.failed_items.length ? `（失败：${decision.failed_items.join('、')}）` : ''}` +
      `${unreviewed.length ? `（未复核 ${unreviewed.length} 项）` : ''}`);
  }

  for (const w of [...new Set(warnings)]) log(`[质检] 警告：${w}`);
  return { outDir, results, files };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[质检] ${e.message}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) { usage(); return; }
  try {
    const r = await runQa(args);
    const toRetry = r.results.filter((x) => x.routeTo === 'retry');
    const toEdit = r.results.filter((x) => x.routeTo === 'edit');
    const toHuman = r.results.filter((x) => x.routeTo === 'human');
    console.log(`[质检] 完成：
  质检报告（c06_qc_report）：${rel(r.outDir)}/（每候选一份，共 ${r.files.length} 份）
  转 ⑥重试 ${toRetry.length} ｜ 转 ⑦剪辑 ${toEdit.length} ｜ 转人工 ${toHuman.length}${toHuman.length ? `\n  转人工：${toHuman.map((x) => `${x.candidateId}（${x.verdict}，已重试 ${x.retryCount} 次${x.unreviewed.length ? `，${x.unreviewed.length} 项未复核` : ''}）`).join('；')}` : ''}

[质检] 下一步：${toRetry.length ? `
  打回 ⑥重试 Agent（它会换没用过的 seed、追加候选号，不覆盖已有产物）：
    node agents/retry/run.js --qc ${toRetry.map((x) => rel(x.file)).join(' --qc ')} --requests <c04 目录>
  拿到新的 c04 之后回 ④生成 重跑，再回本站复检。` : '没有需要打回的候选。'}${toEdit.length ? `
  可以进 ⑦剪辑 Agent：
    node agents/editor/run.js --candidates ${toEdit.map((x) => x.candidateId).join(',')}` : ''}`);
  } catch (e) {
    console.error(`[质检] ${e.message}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
