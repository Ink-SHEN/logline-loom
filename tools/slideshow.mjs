#!/usr/bin/env node
// tools/slideshow.mjs — 渲染步骤：把 c07_edit_decision（粗剪决策单）渲成真正的成片 MP4。
//
// 位置：⑦剪辑 Agent 的下游，流水线最后一道物理工序。剪辑 Agent 产出的是「决策单」不是成片——
//   final_output.sha256 是全 0 占位、size_bytes 是按源码率投影的估计值（agents/editor/run.js 组装时
//   在 notes 里点名回填责任方就是本工具），渲染完成后这些字段才存在真实值。见
//   docs/creation_notes/2026-09-08-editor-agent.md 设计 6 与 agents/README.md 第四节状态表。
//
// 职责（按 docs/agent_guide.md / 09-08 剪辑手记的约定，一行也不多揽）：
//   1. 消费一份 c07_edit_decision（envelope.contract 必须等于它；结构先过权威校验器）
//   2. 按 payload.timeline 逐条 trim（in/out_point_seconds 是源视频时间）→ 按转场组装：
//      cut/none = 硬切；dissolve = 本条自上一镜叠化入场（标记落在叠化两镜的【后一条】上——
//      它以新 run 的第一条身份把 timeline 切成 run：段内硬切、段间 xfade/acrossfade 叠化）；
//      fade_in/fade_out 语义按 ⑦剪辑 prompt 的规则 3
//      （第一条 fade_in = 全片从黑场淡入、最后一条 fade_out = 全片淡出到黑场，只认首尾两项，
//      中间误标只告警忽略，不改剪辑节奏——节奏是剪辑 Agent 的创作决定，渲染器不替它发明）
//   3. 烧 .ass 字幕（⑦剪辑 已把源时间平移到成片时间，路径在 compliance.evidence_paths 里找或 --ass 给）
//   4. 加 AI 生成标识卡（compliance.ai_label_position：opening_card / ending_card /
//      corner_persistent / opening_and_ending；这是主赛道硬要求，默认不允许跳过）
//   5. 按 payload.audio_mix 混音并 loudnorm 到 loudness_target_lufs（默认 -14 LUFS）
//   6. 渲染后**回填** final_output 的真实 sha256 / size_bytes / duration_seconds、
//      audio_mix.measured_loudness_lufs（⑦剪辑 的 LLM 被明确禁止输出它——那是渲染后实测值），
//      并用 gate 临时改成 approved 的副本复跑 contracts/validate_contract.py（c07 是强制人工关口之二，
//      真产物 gate 不动仍 pending，批准由人工填；与 agents/editor/run.js 的 validateC07Structure 同口径）
//
// 实现说明：
//   - 转场：全片按 dissolve 断点切成若干「run」（run 内全硬切，逐镜 trim + 统一 scale/fps 后
//     concat 成中间文件），最后一条命令里用 xfade / acrossfade 把 run 链起来——xfade 的 offset
//     按中间文件 ffprobe 实测时长精确计算，不依赖对 trim 帧对齐的猜测。
//   - 中间文件放 <仓库>/tmp/ 下（.gitignore 已忽略）：成功即删，失败保留供排查。
//   - 成片默认落到 c07 final_output.path 写的 deliverables/final_<时间戳>.mp4（.gitignore 已忽略交付物）。
//
// 一处诚实标注：audio_mix 的 dialogue/music/sfx 三路增益面向「分离音轨」。H3 原生输出是单条混合音轨
// （README 第五节：32 kHz 立体声），timeline 条目也没有给镜头标音轨角色，所以三路增益当前无法按轨施加——
// 本工具执行的是 audio_mix 里可直接实现的部分：loudness_target_lufs 归一（loudnorm）与实测回填。
// 若将来素材升级成分轨（或契约给 timeline 补音频角色），再回到这里按增益表调各轨。
//
// 运行前提：ffmpeg + ffprobe 在 PATH（或环境变量 LOOM_FFMPEG / LOOM_FFPROBE 指向具体二进制），
// 且 ffmpeg 带 libass（subtitles 滤镜）——烧字幕与 AI 标识都需要。烧中文需要渲染机装中文字体
// （docs/decisions/2026-09-07-editor-input-conventions.md 记的未实测项：渲染机字体缺失就是豆腐块，
// 本工具只告警不阻塞，真烧出来人要亲眼复核）。
//
// 用法：node tools/slideshow.mjs --edit <c07_edit_decision.json> [选项]（--help 全量）
// 可编程入口：import { renderEdit } from './tools/slideshow.mjs';

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'validate_contract.py');
const CONTRACT = 'c07_edit_decision';
const TMP_BASE = join(REPO_ROOT, 'tmp');

// 转场/标识的固定参数。它们不是创作决定，渲染器按定值执行；要改节奏参数（叠化多长、淡入淡出多长）
// 去 agents/editor/prompt.js 的规则 3 定口径，别在这里各改各的
const DISSOLVE_SECONDS = 0.5;    // dissolve = xfade/acrossfade 的叠化时长
const EDGE_FADE_SECONDS = 0.5;   // 首镜 fade_in / 末镜 fade_out 的淡入淡出时长
const FADE_START_MARGIN = 0.1;   // 尾淡出起点往左挪一点，防容器时长舍入导致淡出不完整
const AI_CARD_SECONDS = 3.0;     // 片头/片尾标识卡停留时长
const AI_CARD_START = 0.6;       // 片头卡起点（避开 0.5s 淡入，保证卡全程清晰）
const AI_CARD_END_OFFSET = 0.7;  // 片尾卡终点距片尾（避开 0.5s 淡出，但别盖住全黑）
const TARGET_TP_LUFS = -1.5;     // loudnorm 真峰值上限
const DEFAULT_AI_LABEL_TEXT = '本片由 AI 生成 · AI-Generated Content';
const DEFAULT_AI_LABEL_CORNER = 'AI 生成 · AI-Generated';
const DEFAULT_MIX_LUFS = -14;

const DURATION_MIN = 60;        // 与 c07 schema 一致（主赛道 1–5 分钟）
const DURATION_MAX = 300;
const SIZE_LIMIT = 629145600;   // c07 final_output.size_bytes 上限（官网上传 600MB）
const SHA256_RE = /^[0-9a-f]{64}$/;
const TRANSITIONS = ['cut', 'dissolve', 'fade_in', 'fade_out', 'none'];
const AI_LABEL_POSITIONS = ['opening_card', 'ending_card', 'corner_persistent', 'opening_and_ending'];

class UsageError extends Error {}

const rel = (p) => relative(REPO_ROOT, p).replaceAll('\\', '/');
const makeStamp = (d) => d.toISOString().slice(0, 19).replace(/[-:]/g, ''); // 20260911T200000
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const dedupe = (arr) => [...new Set(arr)];

function usage() {
  console.log(`渲染步骤（tools/slideshow.mjs）— 消费 c07_edit_decision（粗剪决策单），产出成片 MP4 并回填真实哈希/大小/时长/实测响度

用法：
  node tools/slideshow.mjs --edit artifacts/edit_<时间戳>.json [选项]

选项：
  --edit <路径>           必填。⑦剪辑 产出的 c07_edit_decision（envelope.contract=c07_edit_decision）
  --root <目录>           素材相对路径的基准目录，默认仓库根（source_path 形如 shots/S001_c01/video.mp4，
                         是相对仓库根的路径，见 docs/decisions/2026-09-07-editor-input-conventions.md）
  --ass <路径>            字幕 .ass（可选）。缺省时在 compliance.evidence_paths 里找现存的 *.ass
  --out <路径>            成片输出路径。缺省用 c07 final_output.path（默认 deliverables/final_<时间戳>.mp4）；
                         给了 --out 会把 final_output.path 与 deliverables.upload_file_path 同步回填成它
  --ai-label-text <文本>  片头/片尾标识卡文字，默认「${DEFAULT_AI_LABEL_TEXT}」（多行用 \\n 分隔）
  --no-ai-label           不烧 AI 生成标识（默认不允许——主赛道硬要求；真用会把
                         compliance.ai_label_present 回填成 false，交上去是违规的）
  --keep-temp             保留中间文件（默认成功即删，失败自动保留在 tmp/slideshow_<时间戳>/ 供排查）
  --dry-run               只出渲染计划（镜头/段/转场/预计时长），不写任何文件
  --no-validate           跳过 python 契约校验（不建议）
  -h, --help              显示本帮助

运行前提：ffmpeg/ffprobe 在 PATH（或 LOOM_FFMPEG / LOOM_FFPROBE 环境变量指定），
         且 ffmpeg 带 libass（subtitles 滤镜）。烧中文字幕需要渲染机装有中文字体。

关口与回填：c07 是两处强制人工关口之二（粗剪确认）。本工具不要求 gate 已批——
         全组要先看到渲染出来的粗剪才能批（09-08 剪辑手记第六节 2、3 步），所以 gate 是
         pending 也照渲，日志里会说明；回填校验用 gate=approved 副本跑（真产物 gate 不动）。
         批准流程：全组看过成片 → 人工把 gate 改成 {status:"approved",reviewer,reviewed_at,reason}
         → python contracts/validate_contract.py --contract c07_edit_decision --file <回填后的文件> 才会 exit 0。`);
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
      case '--edit': out.edit = need(); break;
      case '--root': out.root = need(); break;
      case '--ass': out.ass = need(); break;
      case '--out': out.out = need(); break;
      case '--ai-label-text': out.aiLabelText = need(); break;
      case '--no-ai-label': out.noAiLabel = true; break;
      case '--keep-temp': out.keepTemp = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--no-validate': out.validate = false; break;
      case '-h': case '--help': out.help = true; break;
      default: throw new UsageError(`未知参数 ${a}（见 --help）`);
    }
  }
  return out;
}

function readJsonFile(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UsageError(`无法读取/解析${what} ${path}：${e.message}`);
  }
}

// ——— ffmpeg/ffprobe 工具定位与执行 ———

let _tools = null;
function tools() {
  if (_tools) return _tools;
  const probe = (envName, fallback) => {
    const fromEnv = process.env[envName];
    if (fromEnv) return fromEnv;
    const r = spawnSync(fallback, ['-version'], { encoding: 'utf8' });
    return r.error ? null : fallback;
  };
  const ffmpeg = probe('LOOM_FFMPEG', 'ffmpeg');
  const ffprobe = probe('LOOM_FFPROBE', 'ffprobe');
  if (!ffmpeg || !ffprobe) {
    throw new Error('找不到 ffmpeg/ffprobe（需在 PATH，或用环境变量 LOOM_FFMPEG / LOOM_FFPROBE 指定）——渲染是 ffmpeg 的活，没有它开不了工');
  }
  let hasSubtitles = false;
  const r = spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' });
  if (!r.error) hasSubtitles = /subtitles/.test(r.stdout);
  _tools = { ffmpeg, ffprobe, hasSubtitles };
  return _tools;
}

/** 执行命令并等它结束。stdout 按行回调（编码进度用），stderr 滚动保留末 80 行（失败时打印）。 */
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const stderrTail = [];
    let stderrBuf = '';
    const child = spawn(cmd, args, { cwd: opts.cwd, env: process.env });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) opts.onLine?.(line);
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk;
      const lines = stderrBuf.split(/\r?\n/);
      stderrBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        stderrTail.push(line);
        if (stderrTail.length > 80) stderrTail.shift();
      }
    });
    child.on('error', (e) => resolvePromise({ code: -1, stderr: [e.message] }));
    child.on('close', (code) => {
      if (stderrBuf.trim()) stderrTail.push(stderrBuf.trim());
      resolvePromise({ code: code ?? -1, stderr: stderrTail });
    });
  });
}

function ffprobeJson(file) {
  const { ffprobe } = tools();
  const r = spawnSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

function durationOf(j) {
  // 优先视频流时长（容器 format.duration 常含封装 padding，叠化 offset 按流时长算更贴帧）
  const vs = (j.streams ?? []).find((s) => s.codec_type === 'video');
  const d = Number(vs?.duration ?? j.format?.duration);
  return Number.isFinite(d) ? d : null;
}

/** 探测一条素材：时长/分辨率/帧率/有无音轨/声道数。探不到当场失败——in/out 是源时间，源数据必须是真的 */
function probeClip(file) {
  const j = ffprobeJson(file);
  if (!j) throw new Error(`ffprobe 探测失败：${file}`);
  const vs = (j.streams ?? []).find((s) => s.codec_type === 'video');
  const as = (j.streams ?? []).find((s) => s.codec_type === 'audio');
  if (!vs) throw new Error(`${file} 没有视频流——这不是能进成片的素材`);
  const dur = durationOf(j);
  if (dur === null || dur <= 0) throw new Error(`${file} 探测不到时长`);
  const fpsRate = (vs.avg_frame_rate ?? vs.r_frame_rate ?? '').split('/');
  const fps = fpsRate.length === 2 && Number(fpsRate[1]) ? Number(fpsRate[0]) / Number(fpsRate[1]) : Number(fpsRate[0]);
  return {
    duration: round2(dur),
    width: vs.width, height: vs.height,
    fps: Number.isFinite(fps) ? round2(fps) : null,
    hasAudio: Boolean(as),
    channels: as?.channels ?? null,
  };
}

// ——— python 权威校验（与 agents/editor/run.js 同口径：c07 用 gate=approved 的副本跑，把关口状态与结构分开） ———

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

function tempDir(prefix) {
  const dir = join(prefix, `slideshow_${makeStamp(new Date())}_${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 用 gate.status 临时改成 approved 的副本跑权威校验（真产物 gate 不动）。
 *  返回 {code,out}：code=0 通过 / 1 不通过 / null 校验器不可用。 */
function validateDocStructure(doc) {
  const py = findPython();
  if (!py) return null;
  const dir = tempDir(tmpdir());
  const file = join(dir, 'c07_check.json');
  const copy = JSON.parse(JSON.stringify(doc));
  if (copy.payload?.gate) copy.payload.gate.status = 'approved';
  writeFileSync(file, JSON.stringify(copy, null, 2), 'utf8');
  const report = join(dir, 'report.txt');
  const r = spawnSync(py, [VALIDATOR, '--contract', CONTRACT, '--file', file, '--report', report], { encoding: 'utf8', cwd: REPO_ROOT });
  let reportText = '';
  try { reportText = readFileSync(report, 'utf8'); } catch { /* 校验器没写报告也认 stdout */ }
  rmSync(dir, { recursive: true, force: true });
  if (r.error || r.status === null) return null;
  return { code: r.status, out: ((reportText || r.stdout || '') + (r.stderr || '')).trim() };
}

// ——— JS 侧结构自检（python 校验器不可用时的兜底；只查渲染真正依赖的字段，别重复造契约） ———

function structuralCheck(doc) {
  const p = [];
  if (!doc || typeof doc !== 'object') return ['产物不是 JSON 对象'];
  if (doc.envelope?.contract !== CONTRACT) p.push(`envelope.contract 须为 "${CONTRACT}"`);
  const pl = doc.payload;
  if (!pl) return p;
  const tl = pl.timeline;
  if (!Array.isArray(tl) || !tl.length) p.push('payload.timeline 须为非空数组');
  else tl.forEach((seg, i) => {
    const tag = `timeline[${i}]`;
    if (!Number.isInteger(seg.order) || seg.order !== i + 1) p.push(`${tag}.order 须为 ${i + 1}（从 1 起按播放顺序递增）`);
    if (typeof seg.source_path !== 'string' || !seg.source_path) p.push(`${tag}.source_path 必填（原样取 c05 output.path）`);
    if (typeof seg.in_point_seconds !== 'number' || typeof seg.out_point_seconds !== 'number') p.push(`${tag}.in/out_point_seconds 须为数字`);
    else if (seg.out_point_seconds <= seg.in_point_seconds) p.push(`${tag}.out_point_seconds 须 > in_point_seconds`);
    if (seg.transition !== undefined && !TRANSITIONS.includes(seg.transition)) p.push(`${tag}.transition 须为 ${TRANSITIONS.join(' / ')}`);
  });
  const fo = pl.final_output ?? {};
  if (typeof fo.path !== 'string' || !fo.path) p.push('final_output.path 必填');
  if (typeof fo.duration_seconds !== 'number') p.push('final_output.duration_seconds 须为数字');
  if (typeof fo.sha256 !== 'string' || !SHA256_RE.test(fo.sha256)) p.push('final_output.sha256 须为 64 位小写十六进制（渲染前是占位，渲染后回填）');
  if (!Number.isInteger(fo.size_bytes)) p.push('final_output.size_bytes 须为整数');
  const cp = pl.compliance ?? {};
  if (!AI_LABEL_POSITIONS.includes(cp.ai_label_position)) p.push(`compliance.ai_label_position 须为 ${AI_LABEL_POSITIONS.join(' / ')}`);
  return p;
}

// ——— 渲染计划 ———

/** 按 dissolve 断点把 timeline 切成 run。dissolve 的语义是「本条自上一镜叠化入场」——标记落在
 *  叠化两镜的【后一条】上、以新 run 的第一条身份生效（与 sample.js 的 S004/S009 口径一致）：
 *  断点处前一条目收进当前 run、本条起新 run；段内硬切、段间由编码器 xfade。
 *  所以首条标 dissolve 没有前一条可叠化（误标告警忽略），末条标 dissolve 反而合法（叠进最后一镜）。
 *  fade_in/fade_out 只认首尾两条（⑦剪辑 prompt 规则 3：首淡入=全片从黑场进、尾淡出=全片出到黑场）。 */
function planRuns(timeline, warnings) {
  const runs = [];
  let cur = [];
  const push = () => { if (cur.length) runs.push(cur); cur = []; };
  timeline.forEach((seg, i) => {
    if (i > 0 && seg.transition === 'dissolve') push();
    cur.push(seg);
  });
  push();

  if (timeline[0]?.transition === 'dissolve') {
    warnings.push(`${timeline[0].candidate_id} 是第一条片段却标了 dissolve——没有前一条可叠化，按硬切处理`);
  }
  if (timeline[0]?.transition === 'fade_out') {
    warnings.push(`${timeline[0].candidate_id} 是第一条片段却标了 fade_out——淡出只在末条生效（末条 fade_out = 全片淡出到黑场），按硬切处理`);
  }
  if (timeline.length > 1 && timeline[timeline.length - 1]?.transition === 'fade_in') {
    warnings.push(`${timeline[timeline.length - 1].candidate_id} 是末条片段却标了 fade_in——淡入只在首条生效，按硬切处理`);
  }
  timeline.forEach((seg, i) => {
    if ((seg.transition === 'fade_in' || seg.transition === 'fade_out') && i !== 0 && i !== timeline.length - 1) {
      warnings.push(`${seg.candidate_id}(order ${seg.order}) 中间片段标了 ${seg.transition}——本工具只实现首淡入/尾淡出，中间误标忽略（节奏是 ⑦剪辑 的事）`);
    }
  });

  const len = timeline.length;
  const headFade = len === 1 ? true : timeline[0]?.transition === 'fade_in';
  const tailFade = len > 1 && timeline[len - 1]?.transition === 'fade_out';
  return { runs, headFade, tailFade };
}

/** .ass 时间格式（h:mm:ss.cc），与 agents/editor/run.js 的 assTime 同款 */
function assTime(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.min(99, Math.round((sec - Math.floor(sec)) * 100));
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** 生成 AI 生成标识卡的 .ass：与画面同 PlayRes 的独立字幕轨（和烧字幕用同一个 subtitles 滤镜，不引第三套字体机制）。 */
function buildAiLabelAss(w, h, position, filmDur, text) {
  const fsCard = Math.round(Math.min(w, h) * 0.08);    // 卡文字号 ≈ 画面短边 8%（768p → 61px）
  const fsCorner = Math.round(Math.min(w, h) * 0.045); // 角落常驻小一号
  const esc = (s) => s.replace(/\r?\n/g, '\\N');
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Label,Noto Sans CJK SC,${fsCard},&H00FFFFFF,&H0000FF,&H000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,5,40,40,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = [];
  const endBase = filmDur - AI_CARD_END_OFFSET;
  const ev = (start, end, override, t) => {
    const s = Math.max(0, start);
    const e = Math.max(s + 0.1, end);
    events.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Label,,0,0,0,,${override}${esc(t)}`);
  };
  const card = position === 'opening_card' || position === 'opening_and_ending';
  const ending = position === 'ending_card' || position === 'opening_and_ending';
  const corner = position === 'corner_persistent';
  if (card) ev(AI_CARD_START, AI_CARD_START + AI_CARD_SECONDS, '{\\an5}', text);
  if (ending) ev(endBase - AI_CARD_SECONDS, endBase, '{\\an5}', text);
  if (corner) {
    // 右上角常驻（\an9 顶右），字号小一号；对白字幕 Default 贴底边，互不打架
    ev(1.0, Math.max(1.1, endBase - 1.0), `{\\an9\\fs${fsCorner}}`, DEFAULT_AI_LABEL_CORNER);
  }
  return head + events.join('\n') + (events.length ? '\n' : '');
}

// ——— ffmpeg 图构建 ———

/** 中间文件 = 一个 run：逐镜 trim（in/out 是源时间）→ 统一 scale/fps/像素格式 → concat。
 *  没有音轨的素材用 anullsrc 垫静音（H3 原生带 32kHz 立体声，但质检可能放行过无音轨候选——
 *  concat 要求所有输入同构，垫静音比半路断音轨稳）。中间文件是无损级别的 x264(crf13)+pcm，双编码损失可忽略。
 *
 *  输入下标排布：所有素材 -i 先排（0..nSegs-1），lavfi 静音 -i 追加在后（nSegs..）——若边扫边插，
 *  静音出现的位置会把后面素材的下标顶漂，滤镜链引用就全错。concat 按 [v0][a0][v1][a1]… 交替认流，
 *  所以音频链数组与素材一一对位（静音 seg 的占位链在第二轮补上）。 */
function encodeRun(runSegs, clips, w, h, tmpFile, tmpDir) {
  const args = ['-y', '-hide_banner'];
  const nSegs = runSegs.length;
  const vChains = new Array(nSegs);
  const aChains = new Array(nSegs);
  runSegs.forEach((seg, i) => {
    const c = clips[seg.candidate_id];
    args.push('-i', c.file);
    vChains[i] =
      `[${i}:v]trim=start=${seg.in_point_seconds}:end=${seg.out_point_seconds},` +
      `setpts=PTS-STARTPTS,scale=${w}:${h}:flags=lanczos,fps=24,setsar=1,format=yuv420p[v${i}]`;
    if (c.probe.hasAudio) {
      // pan 兜底声道布局：单声道复制成双声，立体声直通；之后统一 s16/立体声/48k，保证 concat/acrossfade 同构
      const pan = c.probe.channels === 1 ? 'pan=stereo|c0=FC|c1=FC' : 'pan=stereo|c0=FL|c1=FR';
      aChains[i] =
        `[${i}:a]atrim=start=${seg.in_point_seconds}:end=${seg.out_point_seconds},` +
        `asetpts=PTS-STARTPTS,aresample=48000,${pan},aformat=sample_fmts=s16:channel_layouts=stereo[a${i}]`;
    }
  });
  let silenceCount = 0;
  runSegs.forEach((seg, i) => {
    if (aChains[i] !== undefined) return;
    const idx = nSegs + silenceCount++; // 第 k 个静音输入排在所有素材之后：下标 nSegs+k
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    aChains[i] =
      `[${idx}:a]atrim=start=0:end=${round2(seg.out_point_seconds - seg.in_point_seconds)},` +
      `asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo[a${i}]`;
  });
  const graph = [
    ...vChains, ...aChains,
    `${vChains.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${nSegs}:v=1:a=1[vout][aout]`,
  ].join(';\n');
  args.push('-filter_complex', graph, '-map', '[vout]', '-map', '[aout]');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '13', '-c:a', 'pcm_s16le', '-f', 'matroska', tmpFile);
  return runCmd(tools().ffmpeg, args, { cwd: tmpDir }).then((r) => {
    if (r.code !== 0) throw new Error(`ffmpeg 渲染中间段失败（退出码 ${r.code}）：\n${r.stderr.slice(-30).join('\n')}`);
  });
}

/** 最终成片：run 文件按 xfade/acrossfade 链起（offset 用 run 实测时长算）→ 首尾淡入淡出 →
 *  烧对白字幕 .ass → 烧 AI 标识 .ass → loudnorm 到目标响度。 */
function encodeFinal(runDurs, filmDur, headFade, tailFade, dialogueAss, labelAss, targetLufs, outFile, tmpDir) {
  const args = ['-y', '-hide_banner'];
  const n = runDurs.length;
  for (let i = 0; i < n; i++) args.push('-i', `run_${i}.mkv`);
  const graph = [];
  let vIn = '[0:v]';
  let aIn = '[0:a]';
  if (n > 1) {
    // 第 t 次叠化（t=1..n-1，连接 run t 与 run t+1）的 offset = Σ(前 t 段实测时长) − t×叠化时长：
    // 每叠一次输出时间线就少 DISSOLVE_SECONDS，所以是 t×D 而不是 D（一次只叠一个 run 是错的）
    let acc = runDurs[0];
    for (let t = 1; t < n; t++) {
      const vx = `[vx${t}]`;
      const ax = `[ax${t}]`;
      graph.push(`${vIn}[${t}:v]xfade=transition=fade:duration=${DISSOLVE_SECONDS}:offset=${round2(acc - t * DISSOLVE_SECONDS)}${vx}`);
      graph.push(`${aIn}[${t}:a]acrossfade=d=${DISSOLVE_SECONDS}${ax}`);
      vIn = vx;
      aIn = ax;
      acc += runDurs[t];
    }
  }
  const vOps = [];
  const aOps = [];
  if (headFade) { vOps.push(`fade=t=in:st=0:d=${EDGE_FADE_SECONDS}`); aOps.push(`afade=t=in:st=0:d=${EDGE_FADE_SECONDS}`); }
  if (tailFade) {
    const st = round2(Math.max(0, filmDur - EDGE_FADE_SECONDS - FADE_START_MARGIN));
    vOps.push(`fade=t=out:st=${st}:d=${EDGE_FADE_SECONDS}`);
    aOps.push(`afade=t=out:st=${st}:d=${EDGE_FADE_SECONDS}`);
  }
  if (vOps.length) { graph.push(`${vIn}${vOps.join(',')}[vf]`); vIn = '[vf]'; }
  if (aOps.length) { graph.push(`${aIn}${aOps.join(',')}[af]`); aIn = '[af]'; }
  // 烧字幕轨（若有）：.ass 已拷进 tmpDir 且用固定文件名，躲开 filter 参数里冒号/逗号的转义
  const burns = [];
  if (dialogueAss) burns.push('subtitles=subtitle_dialogue.ass');
  if (labelAss) burns.push('subtitles=subtitle_label.ass');
  if (burns.length) { graph.push(`${vIn}${burns.join(',')}[vb]`); vIn = '[vb]'; }
  graph.push(`${vIn}format=yuv420p[vout]`);
  // 音频：混音 = loudnorm 到目标响度（audio_mix 的三路增益无分离音轨可施加，见文件头诚实标注）
  const lufs = Number.isFinite(targetLufs) ? targetLufs : DEFAULT_MIX_LUFS;
  graph.push(`${aIn}loudnorm=I=${lufs}:TP=${TARGET_TP_LUFS}:LRA=11,aresample=48000[aout]`);
  args.push('-filter_complex', graph.join(';\n'), '-map', '[vout]', '-map', '[aout]');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '192k');
  args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', outFile);
  return runCmd(tools().ffmpeg, args, {
    cwd: tmpDir,
    onLine: (line) => {
      if (!line.startsWith('out_time_us=')) return;
      const sec = Math.floor(Number(line.slice('out_time_us='.length)) / 1e6);
      if (Number.isFinite(sec) && sec >= 0) progressLog(`[渲染] 编码进度 ${fmtDur(sec)} / 约 ${fmtDur(filmDur)}`);
    },
  }).then((r) => {
    if (r.code !== 0) throw new Error(`ffmpeg 渲染成片失败（退出码 ${r.code}）：\n${r.stderr.slice(-30).join('\n')}`);
  });
}

let _lastProgress = '';
function progressLog(line) {
  if (line === _lastProgress) return; // 同秒只打一次（out_time_us 高频刷新）
  _lastProgress = line;
  console.log(line);
}

const fmtDur = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// ——— 成片度量与回填 ———

function sha256File(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const st = createReadStream(file);
    st.on('data', (d) => hash.update(d));
    st.on('end', () => resolvePromise(hash.digest('hex')));
    st.on('error', reject);
  });
}

/** 实测文件综合响度（loudnorm print_format=json 的 input_i）。无音轨/静音（-inf）返回 null。 */
function measureLoudness(file, targetLufs) {
  const ff = tools().ffmpeg;
  const r = spawnSync(ff, ['-hide_banner', '-i', file, '-af', `loudnorm=I=${targetLufs}:TP=${TARGET_TP_LUFS}:LRA=11:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const m = /"input_i"\s*:\s*"?(-?[\d.]+)"?/.exec(r.stdout + r.stderr);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? round2(v) : null;
}

/**
 * 渲染主流程（可编程调用；CLI 只是它的一层壳）。
 * 返回 { editPath, outFile, backfillPath, filmDur, measuredLoudness, dryRun, warnings }。
 */
export async function renderEdit(options = {}) {
  const log = options.log ?? ((m) => console.log(m));
  const warnings = [];

  // 1) 输入与工具前提
  if (!options.edit) throw new UsageError('缺少必填输入 --edit <c07_edit_decision.json>，见 --help');
  const root = options.root ? resolve(options.root) : REPO_ROOT;
  const editPath = resolve(options.edit);
  const doc = readJsonFile(editPath, '剪辑决策单');
  const problems = structuralCheck(doc);
  if (problems.length) throw new Error(`c07_edit_decision 结构不合法，渲染拒绝开工：\n- ${problems.join('\n- ')}`);
  tools(); // ffmpeg/ffprobe 前提，缺了当场报
  log(`[渲染] 决策单：${rel(editPath)}（envelope.contract=${doc.envelope?.contract}，${doc.payload?.timeline?.length ?? 0} 镜）`);

  if (options.validate !== false) {
    const v = validateDocStructure(doc);
    if (v === null) log('[渲染] 警告：未找到可用的 python/jsonschema，只做 JS 结构自检；提交前请手动跑 contracts/validate_contract.py');
    else if (v.code === 1) throw new Error(`c07_edit_decision 契约结构校验不通过：\n${v.out}`);
    else if (v.code !== 0) log(`[渲染] 警告：契约校验未执行（退出码 ${v.code}）：\n${v.out}`);
    else log('[渲染] c07_edit_decision 契约结构校验通过（gate 状态单独看，见下）');
  }

  const pl = doc.payload;
  const timeline = pl.timeline;
  const gate = pl.gate ?? {};
  if (gate.status === 'approved') log('[渲染] gate 已 approved——本片已过人工粗剪确认，渲染的是放行版');
  else log(`[渲染] gate 未批（status=${JSON.stringify(gate.status)}）——渲染的是给人工关口 2 审阅的粗剪版；批准由人改 gate，见 --help`);

  // 2) 素材路径解析（source_path 原样取 c05，渲染器不拼路径；相对 --root）与探测
  const missing = [];
  const resolved = timeline.map((seg) => {
    const file = resolve(root, seg.source_path);
    if (!existsSync(file)) missing.push(`${seg.candidate_id}：${rel(file)}`);
    return { seg, file };
  });
  if (missing.length) {
    throw new Error(`以下 timeline 素材不存在（source_path 相对 ${rel(root)}；素材在别处就用 --root 指对目录）：\n- ${missing.join('\n- ')}`);
  }
  const clips = {};
  for (const { seg, file } of resolved) {
    const p = probeClip(file);
    if (seg.out_point_seconds > p.duration + 0.05) {
      throw new Error(`${seg.candidate_id} 出点 ${seg.out_point_seconds}s 超出源时长 ${p.duration}s（${rel(file)}）——in/out 是源视频时间，剪辑时已校验过，素材被换过吗？`);
    }
    if (p.hasAudio && p.channels !== null && p.channels > 2) {
      throw new Error(`${seg.candidate_id}（${rel(file)}）是 ${p.channels} 声道素材——本工具只处理单/双声道（H3 原生 32kHz 立体声），这条素材要回 ⑤质检 查`);
    }
    clips[seg.candidate_id] = { file, probe: p };
  }
  const dimSet = dedupe(Object.values(clips).map((c) => `${c.probe.width}x${c.probe.height}`));
  if (dimSet.length > 1) warnings.push(`素材分辨率不一致（${dimSet.join(' / ')}），统一缩放到成片目标分辨率`);
  const offFps = Object.entries(clips).filter(([, c]) => c.probe.fps !== null && Math.abs(c.probe.fps - 24) > 0.05).map(([cid, c]) => `${cid}=${c.probe.fps}fps`);
  if (offFps.length) warnings.push(`${offFps.length} 条素材源帧率不是 24fps（${offFps.slice(0, 3).join(' / ')}…），已统一 fps=24 重定时`);
  const noAudio = Object.entries(clips).filter(([, c]) => !c.probe.hasAudio).map(([cid]) => cid);
  if (noAudio.length) warnings.push(`${noAudio.length} 条素材没有音轨（${noAudio.slice(0, 3).join(' / ')}…），该段垫静音——成片该段无声`);

  // 3) 成片目标规格：分辨率取 c07 final_output.resolution（剪辑侧已记为首镜值），缺省用首条素材实测值
  const [tw, th] = (pl.final_output.resolution ?? '').split('x').map((n) => Number(n));
  const firstProbe = clips[timeline[0].candidate_id].probe;
  const w = Number.isFinite(tw) && tw > 0 ? tw : firstProbe.width;
  const h = Number.isFinite(th) && th > 0 ? th : firstProbe.height;
  if (!Number.isInteger(w) || !Number.isInteger(h)) throw new Error('解析不出成片目标分辨率（final_output.resolution 缺且素材探测不出宽高）');

  // 4) 字幕轨：--ass 优先，其次 compliance.evidence_paths 里现存的 .ass（⑦剪辑 把路径写进了 evidence_paths）
  let dialogueAss = null;
  if (options.ass) {
    dialogueAss = resolve(options.ass);
    if (!existsSync(dialogueAss)) throw new Error(`--ass 指定的字幕文件不存在：${dialogueAss}`);
  } else {
    for (const p of pl.compliance?.evidence_paths ?? []) {
      if (!String(p).toLowerCase().endsWith('.ass')) continue;
      const cand = resolve(root, p);
      if (existsSync(cand)) { dialogueAss = cand; break; }
    }
  }
  if (dialogueAss) log(`[渲染] 字幕轨：${rel(dialogueAss)}`);
  else if (timeline.some((s) => s.subtitle)) warnings.push('timeline 有镜头挂了字幕但找不到 .ass（evidence_paths 里没有现成的，也没给 --ass），字幕不烧录——先跑 ⑦剪辑 生成 .ass');

  // 5) AI 生成标识（主赛道硬要求；compliance.ai_label_present=true 是剪辑侧的承诺，渲染器负责兑现）
  const wantLabel = pl.compliance?.ai_label_present === true && !options.noAiLabel;
  if (pl.compliance?.ai_label_present === true && options.noAiLabel) {
    warnings.push('--no-ai-label 把 AI 标识关掉了——回填时 compliance.ai_label_present 会改成 false，这不是能提交主赛道的状态');
  }
  const aiLabelText = options.aiLabelText ?? DEFAULT_AI_LABEL_TEXT;
  if (wantLabel && !aiLabelText) throw new UsageError('--ai-label-text 不能为空');

  // 6) 渲染计划：切 run、算预计时长（成片真实时长 ≈ Σ各段(out−in) − dissolve 数 × 叠化时长，须落在 60–300）
  const { runs, headFade, tailFade } = planRuns(timeline, warnings);
  const dissolveCount = runs.length - 1;
  const sumSegs = round2(timeline.reduce((a, s) => a + (s.out_point_seconds - s.in_point_seconds), 0));
  const plannedDur = round2(sumSegs - dissolveCount * DISSOLVE_SECONDS);
  log(`[渲染] ${timeline.length} 镜 → ${runs.length} 段（${dissolveCount} 处 dissolve 断点，段内硬切）；首淡入=${headFade}，尾淡出=${tailFade}`);
  if (plannedDur < DURATION_MIN + 0.15 || plannedDur > DURATION_MAX - 0.15) {
    throw new Error(`成片预计时长 ${plannedDur}s 不在 ${DURATION_MIN}–${DURATION_MAX}s（1–5 分钟；${dissolveCount} 处叠化各占 ${DISSOLVE_SECONDS}s）——c07 的 final_output.duration_seconds 契约硬约束它。
  本片 ${timeline.length} 镜，各镜 (out−in)：${timeline.map((s) => `${s.shot_id}=${round1(s.out_point_seconds - s.in_point_seconds)}s`).join(', ')}。
  下一步：${plannedDur < DURATION_MIN ? '时长不足——回 ⑦剪辑 放宽入出点，或回 ②分镜 补镜头' : '片子过长——回 ⑦剪辑 收紧入出点或精简'}，再重跑。`);
  }
  if (plannedDur < DURATION_MIN + 0.5) warnings.push(`成片预计时长 ${plannedDur}s 贴近 60s 下限——叠化重叠与帧对齐可能再吃掉零点几秒`);

  // 7) 输出路径：默认 c07 final_output.path（剪辑侧写的是相对仓库根的 deliverables/final_<stamp>.mp4）
  const outFile = options.out ? resolve(options.out) : resolve(root, pl.final_output.path);
  const outRel = relative(REPO_ROOT, outFile).replaceAll('\\', '/');
  const targetLufs = Number.isFinite(pl.audio_mix?.loudness_target_lufs) ? pl.audio_mix.loudness_target_lufs : DEFAULT_MIX_LUFS;
  log(`[渲染] 成片输出：${rel(outFile)}（预计 ${plannedDur}s，目标 ${w}x${h}@24fps，loudnorm ${targetLufs} LUFS）`);

  // 8) dry-run：到此为止，只出计划不写文件
  if (options.dryRun) {
    log(`[渲染] --dry-run 计划（未执行任何编码）：
  - 素材：${timeline.length} 镜，${missing.length === 0 ? '全部存在' : `缺 ${missing.length} 个`}
  - 段：${runs.length} 段（dissolve ${dissolveCount} 处 × ${DISSOLVE_SECONDS}s；首尾淡入淡出各 ${EDGE_FADE_SECONDS}s）
  - 字幕轨：${dialogueAss ? rel(dialogueAss) : '无'}
  - AI 标识：${wantLabel ? `${pl.compliance.ai_label_position}（「${aiLabelText}」）` : '不烧（--no-ai-label）'}
  - 混音：loudnorm ${targetLufs} LUFS（TP ${TARGET_TP_LUFS} dBTP）
  - 预计时长 ${plannedDur}s；编码后回填 final_output 实测 sha256/size_bytes/duration_seconds 与 measured_loudness_lufs`);
    return { editPath, outFile, doc, filmDur: plannedDur, measuredLoudness: null, dryRun: true, warnings };
  }

  // 9) 开渲：中间文件放 tmp/（已 gitignore）；成功即删，失败保留供排查
  const tmpDir = tempDir(TMP_BASE);
  log(`[渲染] 中间文件目录：${rel(tmpDir)}（${options.keepTemp ? '--keep-temp 保留' : '成功即删，失败自动保留'}）`);
  try {
    // 9a) 逐段渲染中间文件（静音垫底 + 统一规格已含在 encodeRun 里）
    const runDurs = [];
    for (let i = 0; i < runs.length; i++) {
      const runFile = join(tmpDir, `run_${i}.mkv`);
      log(`[渲染] 中间段 ${i + 1}/${runs.length}（${runs[i].length} 镜硬切）…`);
      await encodeRun(runs[i], clips, w, h, runFile, tmpDir);
      const dur = durationOf(ffprobeJson(runFile));
      if (dur === null || dur <= 0) throw new Error(`中间段 run_${i}.mkv 探测不出时长`);
      runDurs.push(round2(dur));
    }
    const sumRuns = round2(runDurs.reduce((a, b) => a + b, 0));
    const filmDur = round2(sumRuns - dissolveCount * DISSOLVE_SECONDS);
    if (filmDur < DURATION_MIN || filmDur > DURATION_MAX) {
      throw new Error(`中间段实测合计 ${sumRuns}s（叠化重叠后约 ${filmDur}s）不在 ${DURATION_MIN}–${DURATION_MAX}s——渲染中止，回 ⑦剪辑 调入出点后重跑`);
    }
    log(`[渲染] ${runs.length} 段中间文件就绪（各 ${runDurs.join('s / ')}s，叠化重叠后成片约 ${filmDur}s）`);

    // 9b) 字幕/AI 标识 .ass 落进中间目录（固定文件名，躲开 filter 参数里的转义）
    const dialogueName = dialogueAss ? join(tmpDir, 'subtitle_dialogue.ass') : null;
    const labelName = wantLabel ? join(tmpDir, 'subtitle_label.ass') : null;
    if (dialogueName) writeFileSync(dialogueName, readFileSync(dialogueAss, 'utf8'), 'utf8');
    if (labelName) writeFileSync(labelName, buildAiLabelAss(w, h, pl.compliance.ai_label_position, filmDur, aiLabelText), 'utf8');
    if (!tools().hasSubtitles && (dialogueName || labelName)) {
      throw new Error(`ffmpeg 没有 subtitles 滤镜（libass）——烧字幕/AI 标识需要它，当前 ffmpeg 做不到（${tools().ffmpeg}）`);
    }

    // 9c) 最终成片
    mkdirSync(dirname(outFile), { recursive: true });
    await encodeFinal(runDurs, filmDur, headFade, tailFade, dialogueName, labelName, targetLufs, outFile, tmpDir);

    // 10) 成片实测：时长/分辨率/帧率/响度 + sha256/size（这些才是回填值）
    const probe = probeClip(outFile);
    const realDur = probe.duration;
    const realSha = await sha256File(outFile);
    const realSize = statSync(outFile).size;
    const measuredLoudness = probe.hasAudio ? measureLoudness(outFile, targetLufs) : null;
    if (measuredLoudness !== null && Math.abs(measuredLoudness - targetLufs) > 1.0) {
      warnings.push(`成片实测响度 ${measuredLoudness} LUFS，偏离目标 ${targetLufs} LUFS 超过 1 LU——loudnorm 没打正，混音链路要查`);
    }
    log(`[渲染] 成片就绪：${rel(outFile)} ｜ 实测 ${realDur}s ｜ ${probe.width}x${probe.height}@${probe.fps ?? '?'}fps ｜ ${realSize} 字节 ｜ sha256=${realSha.slice(0, 16)}… ｜ 响度 ${measuredLoudness ?? '无音轨/无法测量'} LUFS`);

    // 11) 回填 final_output / audio_mix / compliance，落盘（默认就地回填 --edit 那份 c07）
    const backfilled = JSON.parse(JSON.stringify(doc));
    const fo = backfilled.payload.final_output;
    fo.duration_seconds = realDur;
    fo.sha256 = realSha;
    fo.size_bytes = realSize;
    if (options.out) {
      fo.path = outRel;
      if (backfilled.payload.deliverables) backfilled.payload.deliverables.upload_file_path = outRel;
    }
    if (backfilled.payload.audio_mix) {
      backfilled.payload.audio_mix = {
        ...backfilled.payload.audio_mix,
        ...(measuredLoudness !== null ? { measured_loudness_lufs: measuredLoudness } : {}),
      };
    }
    const cp = backfilled.payload.compliance;
    cp.duration_in_range = realDur >= DURATION_MIN && realDur <= DURATION_MAX;
    cp.size_under_limit = realSize <= SIZE_LIMIT;
    if (options.noAiLabel) cp.ai_label_present = false;
    const renderNote = `【渲染后回填】tools/slideshow.mjs @ ${new Date().toISOString()}：成片 ${outRel}（实测 ${realDur}s · ${realSize} 字节 · sha256=${realSha}${measuredLoudness !== null ? ` · 实测响度 ${measuredLoudness} LUFS（目标 ${targetLufs}）` : ''}）；此前的 sha256 全 0 占位与 size_bytes 投影值已替换为真实值。`;
    backfilled.envelope.notes = [backfilled.envelope.notes, renderNote].filter(Boolean).join(' ');
    const backfillPath = editPath;
    writeFileSync(backfillPath, JSON.stringify(backfilled, null, 2) + '\n', 'utf8');
    log(`[渲染] 已回填并落盘：${rel(backfillPath)}（gate 保持原状 ${JSON.stringify(gate.status)}，final_output 已是真实值）`);

    // 12) 回填后的权威校验（gate=approved 副本口径；真产物 gate 仍由人批）
    if (options.validate !== false) {
      const v = validateDocStructure(backfilled);
      if (v === null) log(`[渲染] 警告：未找到可用的 python/jsonschema，回填后的结构校验没跑；提交前手动跑 contracts/validate_contract.py --contract c07_edit_decision --file ${rel(backfillPath)}`);
      else if (v.code === 1) throw new Error(`回填后的 c07 契约校验不通过（文件已落盘，修好再验）：\n${v.out}`);
      else if (v.code !== 0) log(`[渲染] 警告：契约校验未执行（退出码 ${v.code}）`);
      else log('[渲染] 回填后 c07 契约结构校验通过（gate=approved 副本口径）');
    }

    // 13) 清理中间文件
    if (!options.keepTemp) {
      rmSync(tmpDir, { recursive: true, force: true });
      log(`[渲染] 中间文件已清理：${rel(tmpDir)}`);
    }
    for (const wmsg of dedupe(warnings)) log(`[渲染] 警告：${wmsg}`);
    log(`[渲染] 完成：${rel(outFile)}`);
    return { editPath, outFile, backfillPath, doc: backfilled, filmDur: realDur, measuredLoudness, dryRun: false, warnings };
  } catch (e) {
    if (!options.keepTemp && existsSync(tmpDir)) {
      log(`[渲染] 失败——中间文件保留在 ${rel(tmpDir)} 供排查（rm -rf 可清理）`);
    }
    throw e;
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[渲染] ${e.message}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) { usage(); return; }
  try {
    const r = await renderEdit(args);
    if (r.dryRun) return;
    const docPath = r.backfillPath ?? r.editPath;
    console.log(`[渲染] 完成：
  剪辑决策单（c07_edit_decision，已回填）：${rel(docPath)}
  成片：${rel(r.outFile)} ｜ ${r.filmDur}s${r.measuredLoudness !== null && r.measuredLoudness !== undefined ? ` ｜ 实测响度 ${r.measuredLoudness} LUFS` : ''} ｜ sha256/size_bytes/duration_seconds 已回填真实值

[渲染] 下一步——★关口 2（粗剪确认）：
  1. 全组看 ${rel(r.outFile)}（成片时间码 → c07.timeline[].source_path → shots/<cid>/meta.json → params_snapshot(seed/prompt) → upstream_refs，整条追溯链可反查）。
  2. 认可后人工把 c07 的 gate 改成 {status:"approved",reviewer,reviewed_at,reason}（在 ${rel(docPath)} 上改），
     然后 python contracts/validate_contract.py --contract c07_edit_decision --file ${rel(docPath)} 才会 exit 0——这是机器拦的，不能自动流转。
  3. 不满意 → 回 ⑦剪辑 调节奏（LLM 或 --offline 重跑 node agents/editor/run.js），再重新渲染。`);
  } catch (e) {
    console.error(`[渲染] ${e.message}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
