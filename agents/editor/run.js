#!/usr/bin/env node
// agents/editor/run.js — 「⑦剪辑」Agent 可执行入口（消费 c06_qc_report(pass) + c05(取 source_path) + c03(取播放顺序)，产出 c07_edit_decision）。
//
// 输入：
//   --qc        ⑤质检产出的 c06_qc_report（单个文件 / 数组 / {reports:[]} / 目录递归扫描，必填）
//   --shots-dir 各候选 c05 落盘目录，默认 shots/；选定候选的 source_path 原样取 shots/<candidate_id>/meta.json 的 output.path
//   --shotlist  ②分镜的 c03_shotlist（可选）：给成片播放顺序；缺省时按 shot_id 升序推断并告警
//   --subtitles 人工撰写字幕侧清单（可选，格式见 agents/editor/sample_subtitles.json）；缺省时所有 timeline[].subtitle=null
//   --brief     ①片约 c01_brief（可选）：交叉核对 target_duration_seconds、把 red_lines 记进合规说明
// 输出：c07_edit_decision 落盘 artifacts/edit_<时间戳>.json，字幕时序渲染成 subtitles_<时间戳>.ass，二者路径进 compliance.evidence_paths。
//
// 分工原则（与 ②③ 同一口径：能确定性判定/追溯的事不交给概率模型）——
//   LLM 只产出「怎么剪」这一层创作部分：{ timeline:[{candidate_id,in_point_seconds,out_point_seconds,transition}], audio_mix:{...} }；
//   候选选择（按 c06.score 在 verdict=pass/pass_with_notes 且 route_to=edit 的候选里取最高分）、source_path（原样取 c05，只读不猜）、
//   order（取 c03）、subtitle（人工侧清单，不走推断）、final_output、compliance、gate 全部由代码组装。
// c07 是两处强制人工关口之二（粗剪确认）：gate 有意留 {required:true,status:"pending"}，剪辑 Agent 不自批（docs/agent_guide.md 第七/九节）。
//   校验器 --file 模式会把 pending 关口判为不通过，故结构校验用一份 gate 临时改成 approved 的副本跑（把「结构」与「关口状态」分开，
//   与 validate_contract.py --selftest 的口径一致），真产物的 gate 仍是 pending。
// LLM：经 llm.js 的 OpenAI 兼容 API 接入；未配 Key 或调用失败时降级为「组装粗剪」（用满整段入出点 + 首尾淡入淡出/中间硬切 + 默认混音），
//   内容对应真实输入素材，流水线不断，产物 notes 里标明需人工复核。
//
// 用法：node agents/editor/run.js --help

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENT_VERSION, EDITOR } from './prompt.js';
import { LlmError, chat, extractJson, llmConfig } from './llm.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'validate_contract.py');
const DEFAULT_SHOTS_DIR = join(REPO_ROOT, 'shots');

// 取值全部照抄 contracts/film_agent_contracts.json 与 docs/decisions/2026-09-07-editor-input-conventions.md，不要在这里发明新值
const TRANSITIONS = ['cut', 'dissolve', 'fade_in', 'fade_out', 'none'];
const AI_LABEL_POSITIONS = ['opening_card', 'ending_card', 'corner_persistent', 'opening_and_ending'];
const VERDICTS = ['pass', 'pass_with_notes', 'fail'];
const ROUTES = ['retry', 'edit', 'human'];
const PASS_VERDICTS = ['pass', 'pass_with_notes']; // 只有这两档 + route_to=edit 的候选可进剪辑
const SIZE_LIMIT = 629145600;   // c07 final_output.size_bytes 上限（官网上传 600MB）
const DURATION_MIN = 60;        // c07 final_output.duration_seconds 主赛道硬要求 1–5 分钟
const DURATION_MAX = 300;
const SHOT_ID_RE = /^S[0-9]{3}$/;
const CANDIDATE_ID_RE = /^S[0-9]{3}_c[0-9]{2}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PLACEHOLDER_SHA256 = '0'.repeat(64); // 渲染前占位；真渲染后由 tools/slideshow.mjs / ffmpeg 回填真实哈希
const DEFAULT_MIX = { dialogue_gain_db: 0, music_gain_db: -6, sfx_gain_db: -3, loudness_target_lufs: -14 };
const DEFAULT_SUB_STYLE = { font: 'Noto Sans CJK SC', font_size_px: 40, margin_bottom_px: 60, max_chars_per_line: 18 };

class UsageError extends Error {}

const rel = (p) => relative(REPO_ROOT, p).replaceAll('\\', '/');
const makeStamp = (d) => d.toISOString().slice(0, 19).replace(/[-:]/g, ''); // 20260911T200000
const round1 = (n) => Math.round(n * 10) / 10;                               // 入出点最多一位小数
const dedupe = (arr) => [...new Set(arr)];

function usage() {
  console.log(`「⑦剪辑」Agent — 消费 c06_qc_report(pass) + c05(取 source_path) + c03(取顺序)，产出 c07_edit_decision（粗剪决策单）

用法：
  node agents/editor/run.js --qc artifacts/qc_<时间戳>/ [选项]

选项：
  --qc <路径>            必填。⑤质检产出的 c06_qc_report。可以是：单个 c06 JSON、c06 数组、{"reports":[...]}，
                         或一个目录（递归扫描所有 .json，自动认出 envelope.contract=c06_qc_report 的那些）
  --shots-dir <路径>     各候选 c05 落盘目录，默认 shots/。选定候选的 source_path 原样取
                         <shots-dir>/<candidate_id>/meta.json 的 payload.output.path（只读不猜路径，
                         见 docs/decisions/2026-09-07-editor-input-conventions.md、shots/README.md 第四节）
  --shotlist <路径>      ②分镜的 c03_shotlist（envelope+payload 或裸 payload 均可）。给成片播放顺序 order；
                         缺省时按 shot_id 升序推断并告警。也用于要求「每个分镜镜头都得有通过质检的候选」
  --subtitles <路径>     人工撰写字幕侧清单（格式见 agents/editor/sample_subtitles.json）。缺省时所有
                         timeline[].subtitle=null，且不生成 .ass。给了就逐条校验，格式不对阻塞开工
  --brief <路径>         ①片约 c01_brief（可选）。交叉核对 target_duration_seconds，把 red_lines 记进合规说明
  --ai-label-position <值> AI 生成标识位置，默认 opening_and_ending（主赛道硬要求视频须标注 AI 生成）：
                         ${AI_LABEL_POSITIONS.join(' / ')}
  --out <路径>           c07 输出路径，默认 artifacts/edit_<时间戳>.json
  --ass-out <路径>       字幕 .ass 输出路径，默认与 --out 同目录的 subtitles_<时间戳>.ass（仅当给了 --subtitles）
  --model <名称>         覆盖 LOOM_LLM_MODEL
  --offline              不调 LLM，直接用「组装粗剪」（用满整段 + 首尾淡入淡出/中间硬切 + 默认混音，需人工复核节奏）
  --no-validate          跳过 python 契约校验（不建议）
  -h, --help             显示本帮助

LLM 接入（OpenAI 兼容 API，详见 llm.js）：
  LOOM_LLM_BASE_URL / LOOM_LLM_API_KEY / LOOM_LLM_MODEL
  未配 Key 或调用失败时自动降级组装粗剪，流水线不中断。

关口：c07 是两处强制人工关口之二（粗剪确认）。本 Agent 产出的 gate 一律 {required:true,status:"pending"}，
      批准由人工看过粗剪后填写——剪辑 Agent 不自批。`);
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
      case '--qc': out.qc = need(); break;
      case '--shots-dir': out.shotsDir = need(); break;
      case '--shotlist': out.shotlist = need(); break;
      case '--subtitles': out.subtitles = need(); break;
      case '--brief': out.brief = need(); break;
      case '--ai-label-position': out.aiLabelPosition = need(); break;
      case '--out': out.out = need(); break;
      case '--ass-out': out.assOut = need(); break;
      case '--model': out.model = need(); break;
      case '--offline': out.offline = true; break;
      case '--no-validate': out.validate = false; break;
      case '-h': case '--help': out.help = true; break;
      default: throw new UsageError(`未知参数 ${a}（见 --help）`);
    }
  }
  if (out.aiLabelPosition !== undefined && !AI_LABEL_POSITIONS.includes(out.aiLabelPosition)) {
    throw new UsageError(`--ai-label-position 须为 ${AI_LABEL_POSITIONS.join(' / ')}，收到：${out.aiLabelPosition}`);
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

// ——— 上游 c06_qc_report ———

function walkJson(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const name of readdirSync(d)) {
      const fp = join(d, name);
      let st;
      try { st = statSync(fp); } catch { continue; }
      if (st.isDirectory()) stack.push(fp);
      else if (name.endsWith('.json')) out.push(fp);
    }
  }
  return out.sort();
}

function isC06(doc) {
  if (doc?.envelope?.contract === 'c06_qc_report') return true;
  const p = doc?.payload;
  return !!(p && typeof p === 'object' && 'shot_id' in p && 'candidate_id' in p && 'verdict' in p && 'route_to' in p);
}

/** 读 c06：单文件 / 数组 / {reports:[]} / 目录递归，统一摊平成 [{doc,file}]。 */
function loadQcReports(qcPath) {
  if (!existsSync(qcPath)) throw new UsageError(`--qc 路径不存在：${qcPath}`);
  const files = statSync(qcPath).isDirectory() ? walkJson(qcPath) : [qcPath];
  const reports = [];
  const skipped = [];
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { skipped.push(`${rel(f)}：解析失败 ${e.message}`); continue; }
    const docs = Array.isArray(doc) ? doc : (Array.isArray(doc?.reports) ? doc.reports : [doc]);
    let kept = 0;
    for (const d of docs) if (isC06(d)) { reports.push({ doc: d, file: f }); kept++; }
    if (!kept) skipped.push(`${rel(f)}：不是 c06_qc_report`);
  }
  if (!reports.length) {
    throw new UsageError(`在 ${rel(qcPath)} 没找到任何 c06_qc_report（envelope.contract=c06_qc_report，或 payload 含 shot_id/candidate_id/verdict/route_to）${skipped.length ? `\n跳过：\n- ${skipped.join('\n- ')}` : ''}`);
  }
  return reports;
}

/** 摊平成规范化质检记录；结构性不合法（缺 shot_id / verdict 大小写错等）当场报错，别把脏数据带进剪辑。 */
function normalizeReports(reports) {
  const list = [];
  const problems = [];
  for (const { doc, file } of reports) {
    const p = doc.payload ?? {};
    const tag = rel(file);
    if (!SHOT_ID_RE.test(p.shot_id ?? '')) problems.push(`${tag}：payload.shot_id 缺失或不合法（须形如 S001）`);
    if (!CANDIDATE_ID_RE.test(p.candidate_id ?? '')) problems.push(`${tag}：payload.candidate_id 缺失或不合法（须形如 S001_c01）`);
    if (!VERDICTS.includes(p.verdict)) problems.push(`${tag}：payload.verdict 须为 ${VERDICTS.join(' / ')}（全小写），收到 ${JSON.stringify(p.verdict)}`);
    if (!ROUTES.includes(p.route_to)) problems.push(`${tag}：payload.route_to 须为 ${ROUTES.join(' / ')}，收到 ${JSON.stringify(p.route_to)}`);
    list.push({
      shot_id: p.shot_id,
      candidate_id: p.candidate_id,
      verdict: p.verdict,
      score: typeof p.score === 'number' ? p.score : null,
      route_to: p.route_to,
      artifact_id: doc.envelope?.artifact_id ?? null,
      checks: Array.isArray(p.checks) ? p.checks : [],
      rootCause: typeof p.root_cause === 'string' ? p.root_cause : '',
      file,
    });
  }
  if (problems.length) throw new Error(`c06_qc_report 不合法，⑦剪辑 拒绝开工（先让 ⑤质检 修上游）：\n- ${problems.join('\n- ')}`);
  return list;
}

// ——— 上游 c03_shotlist（可选，给播放顺序） ———

function loadShotlistFile(path) {
  const raw = readJsonFile(path, '镜头清单文件');
  if (raw?.payload?.shots) return { doc: raw, wrapped: false };
  if (raw?.shots) {
    return {
      doc: {
        envelope: {
          schema_version: '1.0', artifact_id: 'shotlist.file', contract: 'c03_shotlist',
          created_at: new Date().toISOString(), producer: { kind: 'agent', name: '外部镜头清单文件' },
          upstream_refs: [], notes: `来自 ${path}`,
        },
        payload: raw,
      },
      wrapped: true,
    };
  }
  throw new UsageError(`${path} 里没有 payload.shots，不是有效的 c03_shotlist`);
}

// ——— 上游 c01_brief（可选，交叉核对时长与红线） ———

function loadBriefFile(path) {
  const raw = readJsonFile(path, '片约文件');
  const payload = raw?.payload ?? (raw && typeof raw === 'object' && Array.isArray(raw.red_lines) ? raw : null);
  if (!payload) throw new UsageError(`${path} 里既没有 payload 也没有顶层 red_lines，不是有效的 c01_brief`);
  return { red_lines: Array.isArray(payload.red_lines) ? payload.red_lines : [], target_duration_seconds: payload.target_duration_seconds, artifact_id: raw?.envelope?.artifact_id ?? null };
}

// ——— 字幕侧清单（可选，人工撰写，不走推断） ———

function loadSubtitles(path) {
  const raw = readJsonFile(path, '字幕清单');
  const style = { ...DEFAULT_SUB_STYLE };
  const defStyle = raw?._默认;
  if (defStyle && typeof defStyle === 'object') {
    for (const k of ['font', 'font_size_px', 'margin_bottom_px', 'max_chars_per_line']) {
      if (defStyle[k] !== undefined) style[k] = defStyle[k];
    }
  }
  const byShot = new Map();
  const problems = [];
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (k.startsWith('_')) continue; // _说明 / _默认 等注释键跳过
    if (!SHOT_ID_RE.test(k)) { problems.push(`字幕键 "${k}" 不是合法 shot_id（须形如 S001）`); continue; }
    let lines = [];
    if (typeof v === 'string') {
      if (v.trim()) lines = [{ at_seconds: 0, text: v }];
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        const tag = `字幕 ${k}[${i}]`;
        if (!item || typeof item !== 'object') { problems.push(`${tag} 须为对象（含 at_seconds / text）`); return; }
        if (typeof item.text !== 'string' || !item.text.trim()) { problems.push(`${tag}.text 缺失或为空`); return; }
        if (typeof item.at_seconds !== 'number' || item.at_seconds < 0) { problems.push(`${tag}.at_seconds 须为 ≥0 的数字（源视频时间）`); return; }
        if (item.until_seconds !== undefined && (typeof item.until_seconds !== 'number' || item.until_seconds <= item.at_seconds)) {
          problems.push(`${tag}.until_seconds 须为 > at_seconds 的数字`); return;
        }
        lines.push({ at_seconds: item.at_seconds, until_seconds: item.until_seconds, text: item.text });
      });
    } else {
      problems.push(`字幕 ${k} 的值须为字符串（整镜一条）或数组（多行逐条给时刻）`);
    }
    lines.sort((a, b) => a.at_seconds - b.at_seconds);
    if (lines.length) byShot.set(k, lines);
  }
  if (problems.length) throw new Error(`字幕清单不合法（照 agents/editor/sample_subtitles.json 的格式修）：\n- ${problems.join('\n- ')}`);
  return { byShot, style };
}

// ——— 选定候选 → 读 c05（source_path 唯一来源，只读不猜） ———

function fpsFromRate(rate) {
  if (typeof rate !== 'string') return null;
  const m = rate.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (!m) { const n = Number(rate); return Number.isFinite(n) ? n : null; }
  const den = Number(m[2]);
  return den === 0 ? null : Number(m[1]) / den;
}

function loadC05For(entry, shotsDir) {
  const metaPath = join(shotsDir, entry.candidate_id, 'meta.json');
  if (!existsSync(metaPath)) return { err: `期望 ${rel(metaPath)} 不存在` };
  let meta;
  try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch (e) { return { err: `${rel(metaPath)} 解析失败：${e.message}` }; }
  const p = meta?.payload;
  const sourcePath = p?.output?.path;
  if (typeof sourcePath !== 'string' || !sourcePath) return { err: `${rel(metaPath)} 缺 payload.output.path` };
  const dur = p?.ffprobe?.duration_seconds;
  if (typeof dur !== 'number' || dur <= 0) return { err: `${rel(metaPath)} 的 payload.ffprobe.duration_seconds 非法` };
  const vs = p?.ffprobe?.video_stream ?? {};
  return {
    c05: {
      sourcePath, duration: dur,
      width: Number.isInteger(vs.width) ? vs.width : null,
      height: Number.isInteger(vs.height) ? vs.height : null,
      fps: fpsFromRate(vs.avg_frame_rate),
      sizeBytes: Number.isInteger(p?.output?.size_bytes) ? p.output.size_bytes : 0,
      file: metaPath,
    },
  };
}

// ——— 创作部分：LLM 决定入出点/转场/混音；离线降级组装粗剪 ———

function paceOffline(entries) {
  const map = {};
  const last = entries.length - 1;
  entries.forEach((e, i) => {
    const dur = round1(e.c05.duration);
    const transition = i === 0 ? 'fade_in' : (i === last ? 'fade_out' : 'cut');
    map[e.candidate_id] = { in_point_seconds: 0, out_point_seconds: dur, transition };
  });
  return map;
}

function checkCreative(raw, entries) {
  const problems = [];
  const list = raw?.timeline ?? raw?.payload?.timeline ?? null;
  if (!Array.isArray(list) || !list.length) {
    return { map: null, mix: null, problems: ['输出缺少 timeline 数组（中间形状：{ "timeline":[{candidate_id,in_point_seconds,out_point_seconds,transition}], "audio_mix":{...} }）'] };
  }
  const byCand = {};
  for (const item of list) {
    if (!item?.candidate_id) { problems.push('timeline 有条目缺 candidate_id'); continue; }
    if (byCand[item.candidate_id]) problems.push(`candidate_id ${item.candidate_id} 出现了不止一次`);
    byCand[item.candidate_id] = item;
  }
  const want = new Set(entries.map((e) => e.candidate_id));
  for (const cid of Object.keys(byCand)) if (!want.has(cid)) problems.push(`${cid} 不在选定片段里，不许发明片段`);

  const map = {};
  for (const e of entries) {
    const it = byCand[e.candidate_id];
    if (!it) { problems.push(`缺 ${e.candidate_id} 的剪辑决定（每条选定片段都要有且只有一条）`); continue; }
    const dur = e.c05.duration;
    const inP = it.in_point_seconds;
    const outP = it.out_point_seconds;
    if (typeof inP !== 'number' || typeof outP !== 'number') { problems.push(`${e.candidate_id}.in/out_point_seconds 须为数字`); continue; }
    if (inP < 0 || outP > dur + 1e-6 || outP <= inP) { problems.push(`${e.candidate_id} 入出点须满足 0 ≤ in(${inP}) < out(${outP}) ≤ 源时长(${dur})`); continue; }
    if (!TRANSITIONS.includes(it.transition)) { problems.push(`${e.candidate_id}.transition 须为 ${TRANSITIONS.join(' / ')}，收到 ${JSON.stringify(it.transition)}`); continue; }
    let a = round1(inP);
    let b = round1(Math.min(outP, dur));
    if (b <= a) b = Math.min(round1(a + 0.1), round1(dur)); // 防止四舍五入到一位小数后 in==out
    if (b <= a) { problems.push(`${e.candidate_id} 源时长 ${dur}s 太短，无法裁出合法入出点`); continue; }
    map[e.candidate_id] = { in_point_seconds: a, out_point_seconds: b, transition: it.transition };
  }

  const mix = {};
  const am = raw?.audio_mix ?? raw?.payload?.audio_mix ?? null;
  if (!am || typeof am !== 'object') problems.push('缺 audio_mix 对象');
  else for (const k of ['dialogue_gain_db', 'music_gain_db', 'sfx_gain_db', 'loudness_target_lufs']) {
    if (typeof am[k] !== 'number') problems.push(`audio_mix.${k} 须为数字`);
    else mix[k] = am[k];
  }

  return problems.length ? { map: null, mix: null, problems } : { map, mix, problems };
}

async function callLlm(entries, opts) {
  const chatOpts = opts.model ? { model: opts.model } : {};
  const slim = entries.map((e) => {
    const o = {
      order: e.order, shot_id: e.shot_id, candidate_id: e.candidate_id,
      source_duration_seconds: e.c05.duration, qc_score: e.c06.score, qc_note: e.c06.rootCause || '',
    };
    if (e.shot) {
      o.shot_size = e.shot.shot_size; o.camera_move = e.shot.camera_move;
      o.visual_description = e.shot.visual_description; o.audio_description = e.shot.audio_description;
    }
    return o;
  });
  const messages = [
    { role: 'system', content: EDITOR },
    {
      role: 'user',
      content: `已选定、已通过质检的有序片段清单（共 ${slim.length} 条，order 即成片播放顺序，不可改；每条 candidate_id 原样照抄回输出、只出现一次）：
${JSON.stringify(slim, null, 2)}

请为每条片段决定入点/出点/转场，并给全片一套混音。按 system prompt 的中间形状只输出一个 JSON 代码块。`,
    },
  ];
  const attempt = (text) => checkCreative(extractJson(text), entries);

  let text = await chat(messages, chatOpts);
  let first;
  try {
    first = attempt(text);
    if (!first.problems.length) return { map: first.map, mix: first.mix, retried: false };
  } catch (e) {
    first = { problems: [e.message] };
  }
  messages.push({ role: 'assistant', content: text });
  messages.push({
    role: 'user',
    content: `上一轮输出未通过结构校验（问题定位到候选）：\n- ${first.problems.join('\n- ')}\n请按契约重新输出修正后的完整 JSON（仍只输出一个 JSON 代码块，覆盖全部片段）。`,
  });
  text = await chat(messages, chatOpts);
  const second = attempt(text); // 解析失败直接抛，由调用方降级
  if (second.problems.length) throw new LlmError(`纠正一轮后仍未通过结构校验：\n- ${second.problems.join('\n- ')}`);
  return { map: second.map, mix: second.mix, retried: true };
}

// ——— 组装 c07（确定性字段全部由代码接管） ———

function assembleDoc({ entries, creativeMap, mix, ctx }) {
  const timeline = [];
  let filmDur = 0;
  for (const e of entries) {
    const c = creativeMap[e.candidate_id];
    filmDur += c.out_point_seconds - c.in_point_seconds;
    timeline.push({
      order: e.order,
      shot_id: e.shot_id,
      candidate_id: e.candidate_id,
      source_path: e.c05.sourcePath, // 原样取 c05 的 output.path，剪辑侧不拼路径
      in_point_seconds: c.in_point_seconds,
      out_point_seconds: c.out_point_seconds,
      transition: c.transition,
      subtitle: e.subtitle,          // string | null（来自人工侧清单，多行按 \n 连接）
    });
  }
  filmDur = round1(filmDur);

  const dims = entries.map((e) => (e.c05.width && e.c05.height ? `${e.c05.width}x${e.c05.height}` : null)).filter(Boolean);
  const resolution = dims.length ? dims[0] : undefined;

  const totalSrcBytes = entries.reduce((a, e) => a + (e.c05.sizeBytes || 0), 0);
  const totalSrcDur = entries.reduce((a, e) => a + (e.c05.duration || 0), 0);
  const bps = totalSrcDur > 0 ? totalSrcBytes / totalSrcDur : 0;
  const projectedRaw = Math.round(filmDur * bps);
  const sizeUnderLimit = projectedRaw <= SIZE_LIMIT;
  const sizeBytes = Math.max(1, Math.min(SIZE_LIMIT, projectedRaw || 1)); // 投影值，渲染后回填真实大小

  const redOk = entries.every((e) => e.c06.checks.some((c) => c.name === 'no_red_line_violation' && c.status === 'pass'));

  const evidence = [];
  for (const e of entries) { evidence.push(rel(e.c06.file)); evidence.push(rel(e.c05.file)); }
  if (ctx.assPath) evidence.push(rel(ctx.assPath));
  if (ctx.shotlistPath) evidence.push(rel(ctx.shotlistPath));
  if (ctx.briefPath) evidence.push(rel(ctx.briefPath));

  const notes = [
    `候选选择：每镜按 c06.score 在 verdict∈{pass,pass_with_notes} 且 route_to=edit 的候选里取最高分（同分取 candidate_id 较小者）。`,
    `source_path 原样取自各候选 c05 的 output.path（只读不猜）。`,
    ctx.usedFallback ? `节奏为离线降级：${ctx.usedFallback}；入出点用满整段、首尾淡入淡出/中间硬切、默认混音，交渲染前建议人工复核或配好 LLM 重跑。` : `节奏（入出点/转场/混音）由 LLM 生成。`,
    `final_output.sha256 为渲染前全 0 占位、size_bytes=${sizeBytes} 为按选定候选源码率投影的估计值——真渲染（tools/slideshow.mjs 或 ffmpeg）后须回填真实哈希与大小。`,
    redOk ? `红线自查：${entries.length} 个选定候选的 c06 均含 no_red_line_violation=pass。` : `红线自查未全部通过：有选定候选的 c06 缺 no_red_line_violation=pass，red_line_self_check 记为 false，须人工复核。`,
    ctx.brief && Array.isArray(ctx.brief.red_lines) && ctx.brief.red_lines.length ? `片约 red_lines ${ctx.brief.red_lines.length} 条已记录，逐条比对见 evidence_paths。` : '',
  ].filter(Boolean).join(' ');

  return {
    envelope: {
      schema_version: '1.0',
      artifact_id: `edit.roughcut.${ctx.stamp}`,
      contract: 'c07_edit_decision',
      created_at: new Date().toISOString(),
      producer: { kind: 'agent', name: 'editing_agent', agent_version: AGENT_VERSION },
      upstream_refs: entries.map((e) => e.c06.artifact_id).filter(Boolean),
      notes,
    },
    payload: {
      timeline,
      audio_mix: mix,
      final_output: {
        path: `deliverables/final_${ctx.stamp}.mp4`,
        container: 'mp4',
        duration_seconds: filmDur,
        ...(resolution ? { resolution } : {}),
        fps: 24,
        sha256: PLACEHOLDER_SHA256,
        size_bytes: sizeBytes,
      },
      compliance: {
        ai_label_present: true,
        ai_label_position: ctx.aiLabelPosition,
        red_line_self_check: redOk,
        duration_in_range: filmDur >= DURATION_MIN && filmDur <= DURATION_MAX,
        size_under_limit: sizeUnderLimit,
        evidence_paths: dedupe(evidence),
      },
      deliverables: {
        platform_url: '',
        studio_url: '',
        blog_url: '',
        upload_file_path: `deliverables/final_${ctx.stamp}.mp4`,
      },
      gate: {
        required: true,
        status: 'pending',
        reviewer: null,
        reviewed_at: null,
        reason: '粗剪确认——两处强制人工关口之二，剪辑 Agent 不自批，待全组看过粗剪后人工填写 status/reviewer/reviewed_at',
      },
    },
  };
}

// ——— 字幕 .ass 渲染（源视频时间 → 成片时间，按 in_point 与时间线累计偏移平移） ———

function assTime(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.min(99, Math.round((sec - Math.floor(sec)) * 100));
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function buildAss(timeline, subs, resW, resH, warnings) {
  const style = subs.style;
  const events = [];
  let filmStart = 0;
  for (const seg of timeline) {
    const lines = subs.byShot.get(seg.shot_id);
    if (lines && lines.length) {
      lines.forEach((ln, i) => {
        const at = ln.at_seconds;
        if (at < seg.in_point_seconds - 1e-6 || at >= seg.out_point_seconds - 1e-6) {
          warnings.push(`${seg.shot_id} 字幕「${ln.text}」at_seconds=${at} 落在所用片段 [${seg.in_point_seconds}, ${seg.out_point_seconds}) 之外，已跳过（未进 .ass）`);
          return;
        }
        const nextAt = i + 1 < lines.length ? lines[i + 1].at_seconds : seg.out_point_seconds;
        const until = typeof ln.until_seconds === 'number' ? ln.until_seconds : Math.min(nextAt, seg.out_point_seconds);
        const start = filmStart + (at - seg.in_point_seconds);
        const end = filmStart + (Math.min(until, seg.out_point_seconds) - seg.in_point_seconds);
        if (end <= start + 0.05) { warnings.push(`${seg.shot_id} 字幕「${ln.text}」时长过短（${(end - start).toFixed(2)}s），已跳过`); return; }
        if (style.max_chars_per_line && ln.text.length > style.max_chars_per_line) {
          warnings.push(`${seg.shot_id} 字幕「${ln.text}」${ln.text.length} 字 > max_chars_per_line ${style.max_chars_per_line}，烧录可能顶到画面边`);
        }
        events.push({ start, end, text: ln.text.replace(/\r?\n/g, '\\N') });
      });
    }
    filmStart += seg.out_point_seconds - seg.in_point_seconds;
  }
  events.sort((a, b) => a.start - b.start || a.end - b.end);
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${resW}
PlayResY: ${resH}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.font},${style.font_size_px},&H00FFFFFF,&H0000FF,&H000000,&H80000000,0,0,0,0,100,100,0,0,1,1,0,2,20,20,${style.margin_bottom_px},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const body = events.map((e) => `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},Default,,0,0,0,,${e.text}`).join('\n');
  return head + body + (body ? '\n' : '');
}

// ——— JS 侧结构自检（python 校验器不可用时的兜底；字段与 c07_edit_decision 契约一一对应） ———

function structuralCheck(doc) {
  const p = [];
  if (!doc || typeof doc !== 'object') return ['产物不是 JSON 对象'];
  if (!doc.envelope || !doc.payload) p.push('缺 envelope/payload 外壳');
  if (doc.envelope?.contract !== 'c07_edit_decision') p.push('envelope.contract 须为 "c07_edit_decision"');
  const pl = doc.payload;
  if (!pl) return p;

  const tl = pl.timeline;
  if (!Array.isArray(tl) || !tl.length) p.push('payload.timeline 须为非空数组');
  else tl.forEach((seg, i) => {
    const tag = `timeline[${i}]`;
    if (!Number.isInteger(seg.order) || seg.order !== i + 1) p.push(`${tag}.order 须为 ${i + 1}（从 1 起按播放顺序递增）`);
    if (!SHOT_ID_RE.test(seg.shot_id ?? '')) p.push(`${tag}.shot_id 须形如 S001`);
    if (!CANDIDATE_ID_RE.test(seg.candidate_id ?? '')) p.push(`${tag}.candidate_id 须形如 S001_c01`);
    if (typeof seg.source_path !== 'string' || !seg.source_path) p.push(`${tag}.source_path 必填（原样取 c05 output.path）`);
    if (typeof seg.in_point_seconds !== 'number' || seg.in_point_seconds < 0) p.push(`${tag}.in_point_seconds 须为 ≥0 的数字`);
    if (typeof seg.out_point_seconds !== 'number' || seg.out_point_seconds <= 0) p.push(`${tag}.out_point_seconds 须为 >0 的数字`);
    if (typeof seg.in_point_seconds === 'number' && typeof seg.out_point_seconds === 'number' && seg.out_point_seconds <= seg.in_point_seconds) p.push(`${tag}.out_point_seconds 须 > in_point_seconds`);
    if (seg.transition !== undefined && !TRANSITIONS.includes(seg.transition)) p.push(`${tag}.transition 须为 ${TRANSITIONS.join(' / ')}`);
    if (seg.subtitle !== undefined && seg.subtitle !== null && typeof seg.subtitle !== 'string') p.push(`${tag}.subtitle 须为字符串或 null`);
  });

  const fo = pl.final_output ?? {};
  if (typeof fo.path !== 'string' || !fo.path) p.push('final_output.path 必填');
  if (fo.container !== 'mp4') p.push('final_output.container 须为常量 "mp4"');
  if (typeof fo.duration_seconds !== 'number' || fo.duration_seconds < DURATION_MIN || fo.duration_seconds > DURATION_MAX) p.push(`final_output.duration_seconds 须在 ${DURATION_MIN}–${DURATION_MAX}（主赛道 1–5 分钟）`);
  if (fo.fps !== 24) p.push('final_output.fps 须为常量 24');
  if (typeof fo.sha256 !== 'string' || !SHA256_RE.test(fo.sha256)) p.push('final_output.sha256 须为 64 位小写十六进制');
  if (!Number.isInteger(fo.size_bytes) || fo.size_bytes < 1 || fo.size_bytes > SIZE_LIMIT) p.push(`final_output.size_bytes 须为 1–${SIZE_LIMIT} 的整数`);
  if (fo.resolution !== undefined && typeof fo.resolution !== 'string') p.push('final_output.resolution 须为字符串（如 "1344x768"）');

  const cp = pl.compliance ?? {};
  for (const k of ['ai_label_present', 'red_line_self_check', 'duration_in_range', 'size_under_limit']) {
    if (typeof cp[k] !== 'boolean') p.push(`compliance.${k} 须为布尔`);
  }
  if (!AI_LABEL_POSITIONS.includes(cp.ai_label_position)) p.push(`compliance.ai_label_position 须为 ${AI_LABEL_POSITIONS.join(' / ')}`);
  if (!Array.isArray(cp.evidence_paths) || !cp.evidence_paths.length) p.push('compliance.evidence_paths 须为非空数组（每项自查的证据文件）');

  const g = pl.gate;
  if (!g || typeof g.required !== 'boolean' || !g.status) p.push('payload.gate 缺失或不全（required + status 必填，c07 是强制人工关口）');
  else if (g.required !== true || g.status !== 'pending') p.push('剪辑 Agent 产出的 gate 须为 {required:true, status:"pending"}（不自批，批准由人工填）');

  if (Array.isArray(tl) && tl.length && typeof fo.duration_seconds === 'number') {
    const sum = round1(tl.reduce((a, s) => a + ((typeof s.out_point_seconds === 'number' && typeof s.in_point_seconds === 'number') ? s.out_point_seconds - s.in_point_seconds : 0), 0));
    if (Math.abs(sum - fo.duration_seconds) > 0.05) p.push(`final_output.duration_seconds(${fo.duration_seconds}) 须等于时间线各片段 (out-in) 之和(${sum})`);
  }
  return p;
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

function pythonValidate(file, contract) {
  const py = findPython();
  if (!py) return null;
  const report = join(tmpdir(), `loom_report_${process.pid}_${Date.now()}.txt`);
  const r = spawnSync(py, [VALIDATOR, '--contract', contract, '--file', file, '--report', report], { encoding: 'utf8', cwd: REPO_ROOT });
  rmSync(report, { force: true });
  if (r.error || r.status === null) return null;
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

/**
 * c07 是强制人工关口，真产物 gate 有意留 pending；校验器 --file 模式会把 pending 判为不通过。
 * 为把「结构」与「关口状态」分开（与 validate_contract.py --selftest 的口径一致），
 * 用一份 gate.status 临时改成 approved 的副本跑权威结构校验；真产物的 gate 不动，仍是 pending。
 */
function validateC07Structure(doc) {
  const tmp = join(tmpdir(), `loom_c07_${process.pid}_${Date.now()}.json`);
  const copy = JSON.parse(JSON.stringify(doc));
  if (copy.payload?.gate) copy.payload.gate.status = 'approved';
  writeFileSync(tmp, JSON.stringify(copy, null, 2), 'utf8');
  try {
    return pythonValidate(tmp, 'c07_edit_decision');
  } finally {
    rmSync(tmp, { force: true });
  }
}

// ——— 主流程 ———

/**
 * 剪辑 Agent 主流程（可编程调用；CLI 只是它的一层壳）。
 * 返回 { qcPath, outPath, assPath, doc, entries, usedFallback, shapeCheck }。
 */
export async function runEditor(options = {}) {
  const log = options.log ?? ((m) => console.log(m));
  const warnings = [];
  const stamp = makeStamp(new Date());

  // 1) c06 质检报告（必填）：摊平 → 规范化
  if (!options.qc) throw new UsageError('缺少必填输入 --qc <c06_qc_report 文件或目录>，见 --help');
  const qcPath = resolve(options.qc);
  const reportList = normalizeReports(loadQcReports(qcPath));
  const byShot = new Map();
  for (const r of reportList) {
    if (!byShot.has(r.shot_id)) byShot.set(r.shot_id, []);
    byShot.get(r.shot_id).push(r);
  }
  log(`[剪辑] 上游质检报告：${rel(qcPath)}（${reportList.length} 份 c06，覆盖 ${byShot.size} 个镜头）`);

  // 2) 播放顺序与「本片镜头集合」：优先取 c03 shotlist 的 order，缺省按 shot_id 升序推断
  const shotsDir = options.shotsDir ? resolve(options.shotsDir) : DEFAULT_SHOTS_DIR;
  let filmShotIds;
  const orderMap = new Map();
  const shotById = new Map();
  let shotlistPath = null;
  let shotlistDoc = null;
  if (options.shotlist) {
    shotlistPath = resolve(options.shotlist);
    const loaded = loadShotlistFile(shotlistPath);
    shotlistDoc = loaded.doc;
    const shots = shotlistDoc.payload.shots;
    if (!Array.isArray(shots) || !shots.length) throw new Error(`${rel(shotlistPath)} 的 payload.shots 为空`);
    for (const s of shots) shotById.set(s.shot_id, s);
    filmShotIds = [...shots].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((s) => s.shot_id);
    filmShotIds.forEach((id, i) => orderMap.set(id, i + 1)); // 重排成 1..N 连续，保证 timeline.order 合法
    const stray = [...byShot.keys()].filter((id) => !shotById.has(id));
    if (stray.length) warnings.push(`c06 里的镜头 ${stray.join(', ')} 不在 --shotlist 中，已忽略（不进成片）`);
    log(`[剪辑] 播放顺序取自 c03_shotlist：${rel(shotlistPath)}（${filmShotIds.length} 镜）`);
  } else {
    filmShotIds = [...byShot.keys()].sort();
    filmShotIds.forEach((id, i) => orderMap.set(id, i + 1));
    warnings.push('未提供 --shotlist，播放顺序按 shot_id 升序推断；建议传 c03_shotlist 用分镜定好的 order');
  }

  // 3) 每镜选定候选：verdict∈{pass,pass_with_notes} 且 route_to=edit，取最高分（同分取 candidate_id 较小者）
  const selected = new Map();
  const notReady = [];
  for (const id of filmShotIds) {
    const cands = (byShot.get(id) ?? []).filter((r) => PASS_VERDICTS.includes(r.verdict) && r.route_to === 'edit');
    if (!cands.length) { notReady.push(id); continue; }
    cands.sort((a, b) => ((b.score ?? -1) - (a.score ?? -1)) || a.candidate_id.localeCompare(b.candidate_id));
    selected.set(id, cands[0]);
  }
  if (notReady.length) {
    throw new Error(`以下镜头没有「通过质检、可进剪辑」的候选（需 verdict∈{pass,pass_with_notes} 且 route_to=edit），⑦剪辑 拒绝开工——成片不能缺镜：
- ${notReady.join('\n- ')}
下一步：
  1. 这些镜头多半还在 ⑤质检 / ⑥重试 环节（route_to=retry 或 human），先跑完拿到 pass 的 c06
  2. 或确认 --qc（当前 ${rel(qcPath)}）里确实包含这些镜头的 c06_qc_report
  3. 补齐后重跑本命令`);
  }

  // 4) 读选定候选的 c05：source_path 原样取 output.path（只读不猜）
  const entries = [];
  const missingC05 = [];
  for (const id of filmShotIds) {
    const r = selected.get(id);
    const res = loadC05For(r, shotsDir);
    if (res.err) { missingC05.push({ cid: r.candidate_id, err: res.err }); continue; }
    entries.push({ order: orderMap.get(id), shot_id: id, candidate_id: r.candidate_id, shot: shotById.get(id) ?? null, c06: r, c05: res.c05, subtitle: null });
  }
  if (missingC05.length) {
    throw new Error(`以下选定候选读不到 c05（<shots-dir>/<candidate_id>/meta.json），⑦剪辑 拒绝开工——source_path 的唯一来源是 c05 的 output.path，剪辑侧不拼路径（docs/decisions/2026-09-07-editor-input-conventions.md、shots/README.md 第四节）：
${missingC05.map((m) => `  - ${m.cid}：${m.err}`).join('\n')}
下一步：确认 ④生成 已为这些候选落盘 meta.json（c05_gen_result 实例），或用 --shots-dir 指到正确目录（当前 ${rel(shotsDir)}/），再重跑。`);
  }
  entries.sort((a, b) => a.order - b.order);

  // 源分辨率 / 帧率一致性提醒（成片需统一；final_output.resolution 记首个选定候选的值）
  const dimSet = dedupe(entries.map((e) => (e.c05.width && e.c05.height ? `${e.c05.width}x${e.c05.height}` : 'unknown')));
  if (dimSet.length > 1) warnings.push(`选定候选源分辨率不一致（${dimSet.join(' / ')}），成片渲染需统一缩放；final_output.resolution 记为首个选定候选的值`);
  const offFps = entries.filter((e) => e.c05.fps !== null && Math.abs(e.c05.fps - 24) > 0.05);
  if (offFps.length) warnings.push(`${offFps.length} 个选定候选源帧率不是 24fps（如 ${offFps[0].candidate_id}=${offFps[0].c05.fps}），c07 final_output.fps 锁定 24，渲染时需重定时`);

  // 5) 上游 c06 权威校验（只校验选定候选，逐份过 validate_contract.py）
  if (options.validate !== false) {
    let pyMissing = false;
    for (const e of entries) {
      const r = pythonValidate(e.c06.file, 'c06_qc_report');
      if (r === null) { pyMissing = true; break; }
      if (r.code === 1) throw new Error(`选定候选 ${e.candidate_id} 的 c06 未通过契约校验，⑦剪辑 拒绝开工：\n${r.out}`);
      if (r.code !== 0) { warnings.push(`${e.candidate_id} 的 c06 校验未执行（退出码 ${r.code}）：${r.out}`); }
    }
    if (pyMissing) warnings.push('未找到可用的 python/jsonschema，跳过上游 c06 契约校验');
  }

  // 6) 字幕侧清单（可选）：给了就逐条校验，并把每镜多行文本按 \n 连接进 timeline[].subtitle
  let subs = null;
  if (options.subtitles) {
    subs = loadSubtitles(resolve(options.subtitles));
    for (const e of entries) {
      const lines = subs.byShot.get(e.shot_id);
      if (lines && lines.length) e.subtitle = lines.map((l) => l.text).join('\n');
    }
    for (const sid of subs.byShot.keys()) if (!orderMap.has(sid)) warnings.push(`字幕清单里的 ${sid} 不在本片镜头中，已忽略`);
    log(`[剪辑] 字幕清单：${rel(resolve(options.subtitles))}（${subs.byShot.size} 个镜头挂了字幕）`);
  } else {
    warnings.push('未提供 --subtitles，所有 timeline[].subtitle=null 且不生成 .ass；字幕只在 c07 出现，别塞进 c03（docs/agent_guide.md 第七节）');
  }

  // 7) 片约（可选）：交叉核对目标时长
  let brief = null;
  let briefPath = null;
  if (options.brief) {
    briefPath = resolve(options.brief);
    brief = loadBriefFile(briefPath);
  }

  // 8) 输出路径（.ass 路径要先定，好进 compliance.evidence_paths）
  const outPath = options.out ? resolve(options.out) : join(REPO_ROOT, 'artifacts', `edit_${stamp}.json`);
  const assPath = subs ? (options.assOut ? resolve(options.assOut) : join(dirname(outPath), `subtitles_${stamp}.ass`)) : null;

  // 9) 创作部分：LLM 调节奏 → 纠正重试 → 失败降级组装粗剪（README 约定：保证流水线照常出片）
  let creativeMap;
  let mix;
  let usedFallback = '';
  const cfg = llmConfig(options.model ? { model: options.model } : {});
  if (options.offline) usedFallback = '按 --offline 要求不调用 LLM';
  else if (!cfg.apiKey) usedFallback = '未配置 LLM API Key';
  else {
    try {
      const r = await callLlm(entries, { model: options.model });
      log(`[剪辑] LLM 生成成功（model=${cfg.model}${r.retried ? '，含一轮纠正重试' : ''}）`);
      creativeMap = r.map;
      mix = r.mix;
    } catch (e) {
      usedFallback = `LLM 调用失败：${e.message}`;
    }
  }
  if (usedFallback) {
    log(`[剪辑] ${usedFallback}，降级为组装粗剪（用满整段入出点 + 首尾淡入淡出/中间硬切 + 默认混音，内容对应真实素材，交渲染前建议人工复核节奏或配好 LLM 重跑）`);
    creativeMap = paceOffline(entries);
    mix = { ...DEFAULT_MIX };
  }

  // 10) 成片时长硬闸门：不在 60–300s 就无法产出合法 c07，提前拦下并给诊断
  const totalDur = round1(entries.reduce((a, e) => { const c = creativeMap[e.candidate_id]; return a + (c.out_point_seconds - c.in_point_seconds); }, 0));
  if (totalDur < DURATION_MIN || totalDur > DURATION_MAX) {
    throw new Error(`成片时长 ${totalDur}s 不在主赛道要求的 ${DURATION_MIN}–${DURATION_MAX}s（1–5 分钟）内，c07 的 final_output.duration_seconds 契约硬约束 ${DURATION_MIN}–${DURATION_MAX}，无法产出合法决策单。
本片选定 ${entries.length} 镜，各镜源时长：${entries.map((e) => `${e.shot_id}=${e.c05.duration}s`).join(', ')}。
下一步：${totalDur < DURATION_MIN ? '镜头/时长不足——回 ②分镜 补镜头，或放宽入出点用满整段（当前可能裁太短）' : '片子过长——回 ②分镜 / ⑤质检 精简镜头，或收紧入出点'}，再重跑。`);
  }
  if (brief && typeof brief.target_duration_seconds === 'number' && brief.target_duration_seconds > 0 && Math.abs(totalDur - brief.target_duration_seconds) > brief.target_duration_seconds * 0.2) {
    warnings.push(`成片时长 ${totalDur}s 偏离片约 target_duration_seconds ${brief.target_duration_seconds}s 超过 ±20%`);
  }

  // 11) 组装 c07
  const ctx = {
    stamp, usedFallback, assPath, shotlistPath, briefPath, brief,
    aiLabelPosition: options.aiLabelPosition ?? 'opening_and_ending',
  };
  const doc = assembleDoc({ entries, creativeMap, mix, ctx });

  // 12) JS 结构自检
  const problems = structuralCheck(doc);
  if (problems.length) throw new Error(`最终产物未通过结构自检：\n- ${problems.join('\n- ')}`);

  // 13) 落盘 c07
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');

  // 14) 字幕 .ass（源时间 → 成片时间平移）
  if (subs && assPath) {
    const [rw, rh] = (doc.payload.final_output.resolution ?? '1920x1080').split('x').map((n) => Number(n));
    const ass = buildAss(doc.payload.timeline, subs, Number.isFinite(rw) ? rw : 1920, Number.isFinite(rh) ? rh : 1080, warnings);
    mkdirSync(dirname(assPath), { recursive: true });
    writeFileSync(assPath, ass, 'utf8');
    log(`[剪辑] 字幕已渲染：${rel(assPath)}（源视频时间按 in_point 与时间线累计偏移平移到成片时间）`);
  }

  // 15) python 权威结构校验（用 gate=approved 的副本，把关口状态与结构分开）
  let shapeCheck = null;
  if (options.validate !== false) {
    shapeCheck = validateC07Structure(doc);
    if (shapeCheck === null) log('[剪辑] 警告：未找到可用的 python/jsonschema，只做了 JS 结构自检；提交前请手动跑 contracts/validate_contract.py');
    else if (shapeCheck.code === 1) throw new Error(`c07_edit_decision 契约结构校验不通过：\n${shapeCheck.out}`);
    else if (shapeCheck.code !== 0) log(`[剪辑] 警告：契约校验未执行（退出码 ${shapeCheck.code}）：\n${shapeCheck.out}`);
    else log('[剪辑] c07_edit_decision 契约结构校验通过（gate 有意留 pending，等人工粗剪确认——关口 2）');
  }

  for (const w of dedupe(warnings)) log(`[剪辑] 警告：${w}`);
  const fo = doc.payload.final_output;
  log(`[剪辑] 已落盘剪辑决策单：${rel(outPath)}`);
  log(`[剪辑] ${entries.length} 镜粗剪 ｜ 成片 ${fo.duration_seconds}s ｜ 分辨率 ${fo.resolution ?? '未知'} ｜ 转场 ${dedupe(doc.payload.timeline.map((t) => t.transition)).join('/')} ｜ 字幕 ${entries.filter((e) => e.subtitle).length} 镜 ｜ AI 标识 ${doc.payload.compliance.ai_label_position}`);

  return { qcPath, outPath, assPath, doc, entries, usedFallback: Boolean(usedFallback), shapeCheck };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[剪辑] ${e.message}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) { usage(); return; }
  try {
    const result = await runEditor(args);
    const fo = result.doc.payload.final_output;
    console.log(`[剪辑] 完成：
  上游质检报告（c06_qc_report）：${rel(result.qcPath)}
  剪辑决策单（c07_edit_decision）：${rel(result.outPath)}${result.assPath ? `\n  字幕（.ass）：              ${rel(result.assPath)}` : ''}${result.usedFallback ? '\n  注意：本次节奏为离线组装粗剪，仅形状合规，交渲染前请人工复核或配好 LLM 后重跑' : ''}
  成片：${fo.duration_seconds}s · ${fo.resolution ?? '未知'} · 24fps · ${fo.size_bytes} 字节（sha256/size 为渲染前占位/投影，渲染后须回填）

[剪辑] 下一步——★关口 2（粗剪确认）与渲染：
  1. c07 的 gate 现为 {required:true,status:"pending"}——这是两处强制人工关口之二，剪辑 Agent 不自批。
     全组看过粗剪后，人工把 gate 改成 {status:"approved",reviewer,reviewed_at,reason}，才算放行成片。
  2. 渲染交给 tools/slideshow.mjs / ffmpeg：按 timeline 逐条 trim+concat、烧 .ass 字幕、加 AI 生成标识卡、按 audio_mix 混音并 loudnorm 到 -14 LUFS。
  3. 渲染后回填 final_output 的真实 sha256 / size_bytes / duration_seconds，并复跑 contracts/validate_contract.py --contract c07_edit_decision。
  4. 可追溯链：成片时间码 → c07.timeline[].source_path → shots/<cid>/meta.json → params_snapshot(seed/prompt) → upstream_refs(c04→c03→c02→c01)。`);
  } catch (e) {
    console.error(`[剪辑] ${e.message}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
