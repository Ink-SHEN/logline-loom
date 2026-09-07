#!/usr/bin/env node
// agents/retry/run.js — 「⑥重试」Agent 可执行入口（消费 c06_qc_report 的 fail 分支，产出新的 c04_gen_request）。
//
// 这一站一行 LLM 都不调。它的活是机械的：拿 ⑤ 的判定书，把上一次那份 c04 复制一份，
// 只改被授权改的字段，换一个没用过的 seed 和一个新的 candidate_id，写回 c04 的形状，交回 ④生成。
// 「不调模型」不代表「不是 Agent」——它有自己独立的契约边界（进 c06 fail 分支、出新 c04），
// 见 agents/README.md「Agent 的边界由契约定义，不由『是否调用大模型』定义」。
//
// 三条不能破的规矩，本站的自检就是在守这三条：
// 1. 不覆盖。新候选号 = 这个镜头已有候选的最大号 + 1，扫 --requests 与 shots/ 两处取最大值，
//    再确认 shots/<新号>/ 不存在。烧过的产物是证据，覆盖它等于销毁证据。
// 2. 不重样。ComfyUI 对完全相同的输入直接返回缓存（0 秒吐旧文件），所以新候选必须同时换掉
//    noise_seed 与 filename_prefix。seed 由本站分配：上一次的 seed + 1000003（质数，避开等差撞车），
//    再拿这个镜头用过的每一个 seed 查重——包括只存在于 shots/<候选>/meta.json 里的那些。
// 3. 不越权。c06 的 suggested_change.patch 只认 PATCH_TARGETS 白名单里的键，且每个键还各归一个动作管
//    （见 PATCH_ACTION）——action 与 patch 归属对不上就打回 ⑤质检 重开，⑥ 不猜哪个算数。
//    steps 根本不在白名单里：它由 turbo_enabled 派生，④生成 会硬卡两者自洽。
//    改提示词的创意内容、换参考图、换工作流类型都不是 ⑥ 能决定的事，遇到就阻塞，并把话原样交给该管的工位
//    （③提示词 / ②分镜 / 人），附上可直接复制的命令行。
//
// 用法：node agents/retry/run.js --help

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const AGENT_VERSION = '0.1.0';
export const AGENT_NAME = 'retry_agent';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'validate_contract.py');
const SHOTS_DIR = join(REPO_ROOT, 'shots');

const CANDIDATE_RE = /^S([0-9]{3})_c([0-9]{2})$/;
const SHOT_RE = /^S[0-9]{3}$/;
const TIMECODE_RE = /^\[([0-9]+)s-([0-9]+)s\]$/;
const PROMPT_TIMECODE_RE = /\[[0-9]+s-[0-9]+s\]/g;
const SEED_MAX = 9007199254740991;
// 质数步长：等差递增的 seed 在扩散不好的采样器上会呈现可见的规律，取质数让相邻重试落到不相关的区域。
const SEED_STEP = 1_000_003;
const DEFAULT_MAX_RETRIES = 3;
const MAX_CANDIDATE_INDEX = 99; // candidate_id 的 pattern 是 _c[0-9]{2}，只有两位
const DURATION_MIN = 4; // 契约写 1–15，但 H3 单次生成的实际下限是 4s，④生成 的 preCheck 也是按 4 卡的
const DURATION_MAX = 15;
const MEGAPIXELS_MIN = 0.1;
const MEGAPIXELS_MAX = 16;
const PROMPT_MIN_LENGTH = 30;
const WORKFLOW_FILE = { T2V: 'workflow_api_t2v.json', I2V: 'workflow_api_i2v.json', R2V: 'workflow_api_r2v.json' };
const TURBO_STEPS = { R2V: 4, default: 8 };
const NORMAL_STEPS = 20;

const ACTIONS = [
  'new_seed', 'rewrite_prompt', 'change_duration', 'change_reference_asset',
  'switch_workflow_type', 'raise_megapixels', 'enable_turbo', 'manual_intervention',
];

// ⑥ 被授权改的字段。键 = c06 的 suggested_change.patch 里可能出现的键，值 = 它在 c04 里的落点。
// 白名单之外的键一律拒绝并说明归谁管——那不是「补丁」，那是让 ⑥ 越过 ②③ 替它们做创意决定。
// steps 不在白名单里：它不是自由旋钮，④生成 会硬卡 steps 与 turbo_enabled 自洽（graph.js 的 wantSteps），
// 单独改 steps 只会产出一份 ④ 拒收的 c04。要改步数就开 action=enable_turbo，步数由本站按机型算。
const PATCH_TARGETS = {
  seed: ['payload', 'generation', 'seed'],
  duration_seconds: ['payload', 'generation', 'duration_seconds'],
  megapixels: ['payload', 'generation', 'megapixels'],
  prompt: ['payload', 'generation', 'prompt'],
  turbo_enabled: ['payload', 'workflow', 'turbo_enabled'],
};

// 白名单里的键各自归哪个动作管。seed 故意不在表里——每次重试都要换 seed，
// 那是本站自己的账，与 c06 开的是哪个动作无关。
const PATCH_ACTION = {
  duration_seconds: 'change_duration',
  megapixels: 'raise_megapixels',
  prompt: 'rewrite_prompt',
  turbo_enabled: 'enable_turbo',
};

// 常见的越权键，直接告诉对方该找谁，省一次来回
const PATCH_REFUSALS = {
  steps: 'steps 由 workflow.type 与 turbo_enabled 共同决定（R2V turbo 4 / 其余 turbo 8 / 不开 turbo 20），④生成 会硬卡两者自洽。要改步数请开 action=enable_turbo',
  aspect_ratio: '契约里是 const "16:9 (Widescreen)"，本项目已锁定，谁都不能改',
  fps: '契约里是 const 24，H3 标称帧率，谁都不能改',
  sampler_name: '契约里是 const "res_multistep"，谁都不能改',
  scheduler: '契约里是 const "simple"，谁都不能改',
  filename_prefix: '由本站按新 candidate_id 自动写成 shots/<候选>，不接受外部指定（写错会让产物归档到别处）',
  candidate_id: '由本站分配（已有最大号 + 1），不接受外部指定',
  type: 'workflow.type 是 ②分镜 定的（T2V/I2V/R2V），要换请打回 ②',
  api_json: '跟着 workflow.type 走，由 ②分镜 决定',
  node_ids: '节点 ID 映射来自 workflows/node_id_map.json，跟着 workflow.type 走，⑥ 不碰',
  first_frame: 'I2V 素材位归 ③提示词（它读 agents/prompt-writer/sample_assets.json），换图请打回 ③',
  ref_images: 'R2V 素材位归 ③提示词，且与提示词里的 <Picture N> 一一绑定，换图必须连提示词一起改',
  ref_videos: 'R2V 素材位归 ③提示词',
  ref_audios: 'R2V 素材位归 ③提示词',
  negative_prompt: 'H3 没有 negative_prompt（用 BasicGuider 而非 CFGGuider），这个键在本项目不存在',
  cfg: 'H3 没有 CFG，这个键在本项目不存在',
};

// 越权键归谁管。写在表里而不是从 refusal 文本里猜，是为了让转交对象稳定可测。
const PATCH_OWNER = {
  steps: '⑤质检',
  type: '②分镜 → ③提示词 → ④生成',
  api_json: '②分镜 → ③提示词 → ④生成',
  node_ids: '②分镜 → ③提示词 → ④生成',
  first_frame: '人工改素材清单 → ③提示词 → ④生成',
  ref_images: '人工改素材清单 → ③提示词 → ④生成',
  ref_videos: '人工改素材清单 → ③提示词 → ④生成',
  ref_audios: '人工改素材清单 → ③提示词 → ④生成',
};

class UsageError extends Error {}

const rel = (p) => relative(REPO_ROOT, p).replaceAll('\\', '/');
const makeStamp = (d) => d.toISOString().slice(0, 19).replace(/[-:]/g, '');
const clone = (x) => JSON.parse(JSON.stringify(x));
const pad2 = (n) => String(n).padStart(2, '0');

// envelope.notes 里放值的口径。change_duration 会把整段英文提示词的旧值与新值都记进去，
// 两条六百字符的文本挤在一行里没人读得下去，而完整的逐字段对照本来就打在控制台上。
// 所以长字符串只留开头，剩下指向 payload 与控制台。
const NOTES_MAX = 120;
const forNotes = (v) => (typeof v === 'string' && v.length > NOTES_MAX
  ? `"${v.slice(0, 60)}…"（原 ${v.length} 字符，全文见 payload，逐字段对照在控制台）`
  : JSON.stringify(v));

function usage() {
  console.log(`「⑥重试」Agent — 消费 c06_qc_report(fail)，逐份产出新的 c04_gen_request，交回 ④生成

用法：
  node agents/retry/run.js --qc artifacts/qc_<时间戳>/ --requests artifacts/genreq_<时间戳>/ [选项]

选项（输入）：
  --qc <路径>                ⑤质检 产出的 c06（文件或目录，可重复）。目录=收全部 c06，
                             只处理 route_to="retry" 的；pass/edit 的归 ⑦剪辑，human 的归人
  --requests <路径>          上一次那批 c04（文件或目录，可重复）。必填——⑥ 是打补丁不是重写，
                             没有原件就没有可复制的 workflow.node_ids 与 assets
  --shots-root <路径>        候选目录根，默认仓库的 shots/。用来读上一次的 c05（取 retry_of）、
                             扫已用过的候选号与 seed

选项（判定口径）：
  --max-retries <n>          覆盖 c06 里的 max_retries（默认沿用 c06，缺省 ${DEFAULT_MAX_RETRIES}）。
                             retry_count 达到它就不再打回，改写 needs_human.md 转人工
  --seed-step <n>            换种子的步长，默认 ${SEED_STEP}（质数）。撞车时按同样步长继续跳
  --skip-exhausted           已耗尽重试次数的镜头也照样出新 c04（默认阻塞）。
                             只在你确实要无视上限多烧一轮 GPU 时用，用了会在 envelope.notes 里记一笔

选项（输出）：
  --out-dir <路径>           输出目录，默认 artifacts/genreq_retry_<时间戳>/，每份 <新候选>.json
  --dry-run                  只打印将要改什么（逐字段 旧值 → 新值），不写文件
  --no-validate              跳过 python 契约校验（不建议）
  -h, --help                 显示本帮助

阻塞与转交（这些不是错误，是本站的权限边界）：
  rewrite_prompt 而 patch 里没给 prompt      → 打回 ③提示词（⑥ 不写创意文本）
  change_reference_asset / switch_workflow_type → 打回 ③提示词 / ②分镜
  action 与 patch 的键归属对不上             → 打回 ⑤质检 重开 c06
    （如 action=new_seed 却带 patch.megapixels：⑥ 既不悄悄丢方子，也不做没声明的事）
  change_duration 但新时长装不下原有分段数    → 打回 ③提示词（每段至少 1 秒；合并/删段是重写节奏）
  patch.steps                                → 拒收（steps 由 turbo_enabled 决定，要改就开 enable_turbo）
  manual_intervention / patch 键不在白名单     → 写进 needs_human.md
  retry_count 已达 max_retries               → 写进 needs_human.md（防无限烧 GPU）`);
}

function parseArgs(argv) {
  const out = { qc: [], requests: [], validate: true, dryRun: false, skipExhausted: false };
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
    const num = (v, min) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < min) throw new UsageError(`${key} 须为不小于 ${min} 的数字，收到 ${JSON.stringify(v)}`);
      return n;
    };
    switch (key) {
      case '--qc': out.qc.push(need()); break;
      case '--requests': out.requests.push(need()); break;
      case '--shots-root': out.shotsRoot = need(); break;
      case '--max-retries': out.maxRetries = Math.trunc(num(need(), 1)); break;
      case '--seed-step': out.seedStep = Math.trunc(num(need(), 1)); break;
      case '--out-dir': out.outDir = need(); break;
      case '--skip-exhausted': out.skipExhausted = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--no-validate': out.validate = false; break;
      case '-h': case '--help': out.help = true; break;
      default: throw new UsageError(`未知选项 ${key}（见 --help）`);
    }
  }
  return out;
}

// ——— 输入装载 ———

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

function readJson(file, what) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError(`无法解析 ${what} ${rel(file)}：${e.message}`);
  }
  return raw;
}

function collectFiles(paths, what) {
  const files = [];
  for (const raw of paths) {
    const p = resolve(raw);
    if (!existsSync(p)) throw new UsageError(`${what} 路径不存在：${raw}`);
    const found = statSync(p).isDirectory() ? walkJson(p) : [p];
    if (!found.length) throw new UsageError(`${what} 目录 ${rel(p)} 里没有任何 .json`);
    files.push(...found);
  }
  return [...new Set(files)];
}

/** 收 c06：按 candidate_id 去重，同一候选有多份时取 created_at 最新的那份（复检结论覆盖旧结论）。 */
function loadQcReports(paths, log, warnings) {
  const files = collectFiles(paths, '--qc');
  const byCandidate = new Map();
  for (const f of files) {
    const doc = readJson(f, 'c06');
    const pl = doc?.payload;
    if (!pl || typeof pl !== 'object' || !('route_to' in pl) || !('verdict' in pl)) continue; // 目录里混了别的 JSON（例如计划文件）
    if (doc.envelope?.contract && doc.envelope.contract !== 'c06_qc_report') {
      warnings.push(`${rel(f)} 的 envelope.contract 是 ${doc.envelope.contract}，不是 c06_qc_report，已跳过`);
      continue;
    }
    const cid = pl.candidate_id;
    if (!CANDIDATE_RE.test(cid ?? '')) { warnings.push(`${rel(f)} 里 candidate_id 不合契约 pattern（${JSON.stringify(cid)}），已跳过`); continue; }
    const prev = byCandidate.get(cid);
    if (prev) {
      const keep = String(doc.envelope?.created_at ?? '') > String(prev.doc.envelope?.created_at ?? '') ? { doc, file: f } : prev;
      warnings.push(`${cid}: 收到不止一份 c06（${rel(prev.file)} 与 ${rel(f)}），取 created_at 较新的 ${rel(keep.file)}——复检结论覆盖旧结论`);
      byCandidate.set(cid, keep);
      continue;
    }
    byCandidate.set(cid, { doc, file: f });
  }
  if (!byCandidate.size) throw new UsageError(`--qc 里没有找到任何 c06_qc_report（需含 payload.verdict 与 payload.route_to）`);
  log(`[重试] 收到 ${byCandidate.size} 份 c06_qc_report`);
  return byCandidate;
}

/** 收上一次的 c04（打补丁的原件）。同一 candidate_id 出现两份是硬错误：不知道以哪份为准。 */
function loadPrevRequests(paths) {
  const files = collectFiles(paths, '--requests');
  const byCandidate = new Map();
  for (const f of files) {
    const doc = readJson(f, 'c04');
    if (!doc?.payload?.generation || !doc?.envelope) continue;
    if (doc.envelope.contract && doc.envelope.contract !== 'c04_gen_request') continue;
    const cid = doc.payload.candidate_id;
    if (!CANDIDATE_RE.test(cid ?? '')) continue;
    if (byCandidate.has(cid)) {
      throw new Error(`candidate_id 重复：${cid} 同时出现在 ${rel(byCandidate.get(cid).file)} 与 ${rel(f)}。` +
        `⑥重试 要拿它当打补丁的原件，两份不一致就不知道该复制哪一份——请先删掉多余的那份`);
    }
    byCandidate.set(cid, { doc, file: f });
  }
  if (!byCandidate.size) throw new UsageError('--requests 里没有找到任何 c04_gen_request（需含 envelope 与 payload.generation）');
  return byCandidate;
}

/** shots/ 下已存在的候选目录（烧过的产物，是证据，不许覆盖）。 */
function listShotDirs(shotsRoot) {
  if (!existsSync(shotsRoot)) return [];
  return readdirSync(shotsRoot).filter((n) => CANDIDATE_RE.test(n) && statSync(join(shotsRoot, n)).isDirectory());
}

function readPrevC05(shotsRoot, cid) {
  const meta = join(shotsRoot, cid, 'meta.json');
  if (!existsSync(meta)) return null;
  const doc = readJson(meta, 'c05');
  if (doc?.envelope?.contract !== 'c05_gen_result') return null;
  return { doc, file: meta };
}

/** 这个镜头用过的每一个 seed。漏掉一个就可能撞上 ComfyUI 的缓存，白烧一轮 GPU 拿回同一个坏产物。 */
function usedSeedsFor(shotId, { prevRequests, shotsRoot, shotDirs, extra }) {
  const seeds = new Set();
  const where = [];
  const add = (seed, from) => {
    if (Number.isInteger(seed)) { seeds.add(seed); where.push({ seed, from }); }
  };
  for (const { doc, file } of prevRequests.values()) {
    if (doc.payload.shot_id !== shotId) continue;
    add(doc.payload.generation?.seed, rel(file));
  }
  for (const dir of shotDirs) {
    if (!dir.startsWith(`${shotId}_`)) continue;
    const c05 = readPrevC05(shotsRoot, dir);
    if (c05) add(c05.doc.payload.params_snapshot?.seed, `${rel(c05.file)} 实测快照`);
  }
  for (const s of extra.get(shotId) ?? []) add(s, '本次运行已分配');
  return { seeds, where };
}

function usedIndexesFor(shotId, { prevRequests, shotDirs, extra }) {
  let max = 0;
  const scan = (cid) => {
    const m = CANDIDATE_RE.exec(cid ?? '');
    if (m && m[1] === shotId.slice(1)) max = Math.max(max, Number(m[2]));
  };
  for (const { doc } of prevRequests.values()) scan(doc.payload.candidate_id);
  for (const dir of shotDirs) scan(dir);
  for (const cid of extra.get(shotId) ?? []) scan(cid);
  return max;
}

const wrapSeed = (n) => (n > SEED_MAX ? n % (SEED_MAX + 1) : n);

function allocateSeed({ prevSeed, used, step, cid }) {
  let s = wrapSeed(prevSeed + step);
  for (let i = 0; i < 1000; i++) {
    if (!used.has(s)) return { seed: s, bumped: i };
    s = wrapSeed(s + step);
  }
  throw new Error(`${cid}: 连跳 1000 次（步长 ${step}）都没避开这个镜头用过的 seed，used 集合大得不正常，请人工指定`);
}

// ——— retry_of：闭环证据的那一头 ———

function findRetryOf({ prevCid, shotsRoot, c06, warnings }) {
  const c05 = readPrevC05(shotsRoot, prevCid);
  if (c05) return { id: c05.doc.envelope.artifact_id, from: rel(c05.file) };
  const refs = c06.envelope?.upstream_refs ?? [];
  const guess = refs.find((r) => /^gen(res)?\./.test(String(r)));
  if (guess) {
    warnings.push(`${prevCid}: shots/${prevCid}/meta.json 不在本地，retry_of 退用 c06.envelope.upstream_refs 里的 ${guess}。` +
      `产物不入库是故意的（见 shots/README.md），但闭环证据的这一头就只剩 ⑤ 的转述了`);
    return { id: guess, from: 'c06.envelope.upstream_refs' };
  }
  return null;
}

// ——— change_duration：时间码等比重排 ———

function parseSegs(timecodes, cid) {
  const segs = [];
  for (const tc of timecodes) {
    const m = TIMECODE_RE.exec(String(tc));
    if (!m) throw new Error(`${cid}: generation.timecodes 里有不合契约 pattern 的项 ${JSON.stringify(tc)}（应为 [0s-3s] 这种）`);
    segs.push({ a: Number(m[1]), b: Number(m[2]), raw: tc });
  }
  return segs;
}

/**
 * 把时间码按新时长等比重排：首尾相接、从 0 开始、最后一段收在 ceil(新时长)。
 * 这是机械重排，不是创意重写——每一段演什么没变，只是节奏被拉长/压短了。
 * 原件的时间码若不是首尾相接，⑥ 不猜，直接打回 ③提示词。
 */
function rescaleTimecodes({ timecodes, prompt, oldDuration, newDuration, cid }) {
  const segs = parseSegs(timecodes, cid);
  if (!segs.length) throw new Error(`${cid}: generation.timecodes 是空的，change_duration 没有可重排的分段，请打回 ③提示词 重写`);
  if (segs[0].a !== 0) throw new Error(`${cid}: 时间码不是从 0 开始（首段 ${segs[0].raw}），⑥ 不猜原作者的意图，请打回 ③提示词`);
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].a !== segs[i - 1].b) {
      throw new Error(`${cid}: 时间码不是首尾相接（${segs[i - 1].raw} 之后是 ${segs[i].raw}），⑥ 不猜中间那段空档是什么，请打回 ③提示词`);
    }
  }
  const oldEnd = segs[segs.length - 1].b;
  if (!Number.isFinite(oldDuration) || Math.abs(oldEnd - Math.ceil(oldDuration)) > 1) {
    throw new Error(`${cid}: 时间码收在 ${oldEnd}s，但 duration_seconds 是 ${oldDuration}s，两者本来就对不上。先让 ③提示词 修一致，再谈改时长`);
  }

  const newEnd = Math.ceil(newDuration);
  // 新时长装不下这么多段（每段至少 1 秒）。硬压下去会让下面的 Math.min 反压过 Math.max，
  // 吐出 [0s-0s] 这种零长分段——它合契约 pattern、过得了本站自检，然后白烧一轮 GPU。
  // 合并分段或删段是创意决定，⑥ 不做，打回 ③提示词。
  if (newEnd < segs.length) {
    throw new Error(`${cid}: ${segs.length} 段时间码压不进 ${newDuration}s（每段至少 1 秒，需要 ${segs.length}s 以上）。` +
      `合并分段或删段是重写节奏，属于创意决定，⑥ 只做等比重排——请打回 ③提示词`);
  }
  const bounds = [0];
  for (let i = 1; i < segs.length; i++) {
    let b = Math.round((segs[i].a * newEnd) / oldEnd);
    b = Math.max(b, bounds[i - 1] + 1); // 每段至少 1 秒，否则时间码会退化成 [3s-3s]
    b = Math.min(b, newEnd - (segs.length - i));
    bounds.push(b);
  }
  bounds.push(newEnd);
  const next = [];
  for (let i = 0; i < segs.length; i++) next.push(`[${bounds[i]}s-${bounds[i + 1]}s]`);

  const inPrompt = prompt.match(PROMPT_TIMECODE_RE) ?? [];
  if (inPrompt.length !== segs.length) {
    throw new Error(`${cid}: generation.prompt 里有 ${inPrompt.length} 处时间码，generation.timecodes 里有 ${segs.length} 段，两者对不上。` +
      `只改一边的话，模型看到的分段与契约记录的分段会分家，⑥ 不做这种半截修改——请打回 ③提示词 重写`);
  }
  let k = 0;
  const nextPrompt = prompt.replace(PROMPT_TIMECODE_RE, () => next[k++]);
  return { timecodes: next, prompt: nextPrompt, oldEnd, newEnd };
}

// ——— 打补丁 ———

function setAt(doc, path, value) {
  let cur = doc;
  for (const k of path.slice(0, -1)) cur = cur[k];
  cur[path[path.length - 1]] = value;
}

function getAt(doc, path) {
  let cur = doc;
  for (const k of path) { if (cur == null) return undefined; cur = cur[k]; }
  return cur;
}

/** 把 c06 的 patch 键分成「白名单内」与「越权」两堆，越权的那堆连归谁管一起说清楚。 */
function triagePatch(patch) {
  const ok = [];
  const refused = [];
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (PATCH_TARGETS[k]) ok.push({ key: k, value: v, path: PATCH_TARGETS[k] });
    else refused.push({ key: k, value: v, why: PATCH_REFUSALS[k] ?? `不在 ⑥重试 的授权范围内（可改的只有 ${Object.keys(PATCH_TARGETS).join(' / ')}）` });
  }
  return { ok, refused };
}

// ——— 结构自检 ———

function structuralCheck(doc, { usedSeeds, newCid }) {
  const p = [];
  const pl = doc.payload;
  const g = pl.generation;
  const wf = pl.workflow;
  if (!CANDIDATE_RE.test(pl.candidate_id ?? '')) p.push('candidate_id 不合契约 pattern ^S[0-9]{3}_c[0-9]{2}$');
  if (!SHOT_RE.test(pl.shot_id ?? '')) p.push('shot_id 不合契约 pattern ^S[0-9]{3}$');
  if (!pl.candidate_id.startsWith(`${pl.shot_id}_`)) p.push('candidate_id 与 shot_id 不是同一个镜头');
  if (typeof pl.retry_of !== 'string' || !pl.retry_of) p.push('retry_of 必须是上一次 c05_gen_result 的 artifact_id（闭环证据），不能为空');

  // 规矩 2：seed 与 filename_prefix 必须同时换掉，否则 ComfyUI 直接吐缓存
  if (!Number.isInteger(g.seed) || g.seed < 0 || g.seed > SEED_MAX) p.push(`generation.seed 须为 0–${SEED_MAX} 的整数，实为 ${JSON.stringify(g.seed)}`);
  else if (usedSeeds.has(g.seed)) p.push(`generation.seed=${g.seed} 这个镜头已经用过（含上一次的 seed），ComfyUI 会直接返回缓存的旧产物（白烧一轮 GPU）`);
  if (g.filename_prefix !== `shots/${newCid}`) p.push(`generation.filename_prefix 须为 shots/${newCid}（与 candidate_id 同名），实为 ${JSON.stringify(g.filename_prefix)}`);

  if (typeof g.prompt !== 'string' || g.prompt.length < PROMPT_MIN_LENGTH) p.push(`generation.prompt 至少 ${PROMPT_MIN_LENGTH} 字符`);
  if (g.prompt_language !== 'en') p.push('generation.prompt_language 须为 "en"');
  if (!(g.duration_seconds >= DURATION_MIN && g.duration_seconds <= DURATION_MAX)) {
    p.push(`generation.duration_seconds=${g.duration_seconds} 超出 ${DURATION_MIN}–${DURATION_MAX}s（契约写 1–15，但 H3 单次生成的实际区间是 ${DURATION_MIN}–15，④生成 也按这个卡）`);
  }
  if (!(g.megapixels >= MEGAPIXELS_MIN && g.megapixels <= MEGAPIXELS_MAX)) p.push(`generation.megapixels=${g.megapixels} 超出契约的 ${MEGAPIXELS_MIN}–${MEGAPIXELS_MAX}`);
  if (g.aspect_ratio !== '16:9 (Widescreen)') p.push(`generation.aspect_ratio 须为 const "16:9 (Widescreen)"，实为 ${JSON.stringify(g.aspect_ratio)}`);
  if (g.fps !== 24) p.push(`generation.fps 须为 const 24，实为 ${JSON.stringify(g.fps)}`);

  if (!WORKFLOW_FILE[wf.type]) p.push(`workflow.type 须为 T2V / I2V / R2V，收到 ${JSON.stringify(wf.type)}`);
  else if (wf.api_json !== WORKFLOW_FILE[wf.type]) p.push(`workflow.api_json 须为 ${WORKFLOW_FILE[wf.type]}（跟着 workflow.type 走）`);

  const wantSteps = wf.turbo_enabled ? (TURBO_STEPS[wf.type] ?? TURBO_STEPS.default) : NORMAL_STEPS;
  if (g.steps !== wantSteps) p.push(`workflow.turbo_enabled=${wf.turbo_enabled} 时 generation.steps 应为 ${wantSteps}，实为 ${g.steps}`);

  // 时间码：首尾相接、从 0 开始、收在 ceil(duration_seconds)
  const tcs = g.timecodes;
  if (Array.isArray(tcs) && tcs.length) {
    const segs = tcs.map((tc) => TIMECODE_RE.exec(String(tc)));
    if (segs.some((m) => !m)) p.push('generation.timecodes 里有不合 ^\\[[0-9]+s-[0-9]+s\\]$ 的项');
    else {
      const nums = segs.map((m) => [Number(m[1]), Number(m[2])]);
      if (nums[0][0] !== 0) p.push('generation.timecodes 首段不是从 0 开始');
      for (let i = 1; i < nums.length; i++) if (nums[i][0] !== nums[i - 1][1]) p.push(`generation.timecodes 不首尾相接：${tcs[i - 1]} 之后是 ${tcs[i]}`);
      if (nums[nums.length - 1][1] !== Math.ceil(g.duration_seconds)) p.push(`generation.timecodes 收在 ${nums[nums.length - 1][1]}s，但 duration_seconds 是 ${g.duration_seconds}s`);
    }
    const inPrompt = (g.prompt.match(PROMPT_TIMECODE_RE) ?? []).length;
    if (inPrompt !== tcs.length) p.push(`generation.prompt 里有 ${inPrompt} 处时间码，timecodes 有 ${tcs.length} 段，两者必须一致`);
  }

  // 素材位与工作流类型必须对得上，否则白烧一整轮才在 ComfyUI 里报错
  const a = pl.assets ?? {};
  const hasAssets = Boolean(a.first_frame) || [a.ref_images, a.ref_videos, a.ref_audios].some((x) => Array.isArray(x) && x.length);
  if (wf.type === 'T2V' && hasAssets) p.push('workflow.type=T2V 不该带任何素材（契约的 allOf 会拦）');
  if (wf.type === 'I2V' && !a.first_frame) p.push('workflow.type=I2V 必须给 assets.first_frame');
  if (wf.type === 'R2V' && !(Array.isArray(a.ref_images) && a.ref_images.length)) p.push('workflow.type=R2V 必须给至少一张 assets.ref_images');

  const env = doc.envelope;
  if (env.contract !== 'c04_gen_request') p.push('envelope.contract 须为 c04_gen_request');
  if (env.producer?.name !== AGENT_NAME) p.push(`envelope.producer.name 须为 ${AGENT_NAME}`);
  if (!Array.isArray(env.upstream_refs) || !env.upstream_refs.length) p.push('envelope.upstream_refs 不能为空（至少要指回 c06 与上一份 c04）');
  return p;
}

// ——— 权威校验 ———

let cachedPython;
function findPython() {
  if (cachedPython !== undefined) return cachedPython;
  for (const py of ['python', 'python3', 'py']) {
    const r = spawnSync(py, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) { cachedPython = py; return py; }
  }
  cachedPython = null;
  return null;
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
 * ⑥重试 主流程（可编程调用；CLI 只是它的一层壳）。
 * 返回 { outDir, created, blocked, files }。
 *   created 每项 { prevCid, newCid, shotId, action, seed, changes, file?, doc }
 *   blocked 每项 { prevCid, shotId, action, reason, routeBack, command? }
 */
export async function runRetry(options = {}) {
  const log = options.log ?? ((m) => console.log(m));
  const warnings = [];
  const args = options.parsed ?? options;
  const stamp = makeStamp(new Date());

  if (!args.qc?.length) throw new UsageError('必须给 --qc（⑤质检 产出的 c06）才能知道要重试什么，见 --help');
  if (!args.requests?.length) throw new UsageError('必须给 --requests（上一次那批 c04）——⑥重试 是打补丁不是重写，没有原件就复制不出 workflow.node_ids 与 assets');

  const shotsRoot = resolve(args.shotsRoot ?? SHOTS_DIR);
  const qc = loadQcReports(args.qc, log, warnings);
  const prevRequests = loadPrevRequests(args.requests);
  const shotDirs = listShotDirs(shotsRoot);
  log(`[重试] 上一批 c04：${prevRequests.size} 份｜shots/ 下已有候选目录：${shotDirs.length} 个（${rel(shotsRoot)}）`);

  const toRetry = [...qc.values()].filter((x) => x.doc.payload.route_to === 'retry');
  const skipped = [...qc.values()].filter((x) => x.doc.payload.route_to !== 'retry');
  for (const x of skipped) {
    const r = x.doc.payload.route_to;
    log(`[重试] 跳过 ${x.doc.payload.candidate_id}：route_to="${r}"（${r === 'edit' ? 'pass 的归 ⑦剪辑' : '归人'}，不归本站）`);
  }
  if (!toRetry.length) {
    throw new UsageError(`${qc.size} 份 c06 里没有一份 route_to="retry"，⑥重试 无事可做。` +
      `route_to="edit" 的请走 node agents/editor/run.js --qc <c06 目录>；"human" 的请人工处理`);
  }
  log(`[重试] 待处理 ${toRetry.length} 份 fail 判定`);

  const outDir = args.outDir ? resolve(args.outDir) : join(REPO_ROOT, 'artifacts', `genreq_retry_${stamp}`);
  if (!args.dryRun) mkdirSync(outDir, { recursive: true });

  const seedStep = args.seedStep ?? SEED_STEP;
  const allocatedCandidates = new Map(); // shotId -> [本次已分配的 candidate_id]
  const allocatedSeeds = new Map();      // shotId -> [本次已分配的 seed]
  const created = [];
  const blocked = [];

  for (const { doc: c06, file: qcFile } of toRetry) {
    const pl = c06.payload;
    const prevCid = pl.candidate_id;
    const shotId = pl.shot_id;
    log(`[重试] —— ${prevCid} ——`);

    if (args.validate !== false) {
      const r = pythonValidate(qcFile, 'c06_qc_report');
      if (r === null) warnings.push(`${prevCid}: 未找到可用的 python/jsonschema，跳过上游 c06 契约校验`);
      else if (r.code === 1) throw new Error(`${rel(qcFile)} 未通过 c06_qc_report 契约校验，⑥重试 拒绝照着它开工：\n${r.out}`);
      else if (r.code !== 0) warnings.push(`${prevCid}: 上游 c06 契约校验未执行（退出码 ${r.code}）：${r.out}`);
    }

    const block = (reason, routeBack, command, details) => {
      blocked.push({ prevCid, shotId, action: pl.suggested_change?.action ?? null, reason, routeBack, command: command ?? null, details: details ?? [], qcFile });
      log(`[重试] ${prevCid} 阻塞：${reason}`);
      const pad = (s) => s.split('\n').map((l) => `           ${l}`).join('\n');
      for (const d of details ?? []) log(pad(d));
      // command 存的是干净的多行文本（needs_human.md 要原样放进代码块），缩进只在这里加
      if (routeBack) log(`[重试] ${prevCid} → 转交 ${routeBack}${command ? `\n${pad(command)}` : ''}`);
      // 每阻塞一次就重写一遍转交清单。后面还有几处是整批 throw 的硬错误（自检不过、契约校验不过、
      // 盘上材料互相矛盾），真炸的时候这一批已经攒下的转交事项不会跟着一起丢。
      if (!args.dryRun) writeFileSync(join(outDir, 'needs_human.md'), renderNeedsHuman(blocked), 'utf8');
    };

    // 原件
    const prevEntry = prevRequests.get(prevCid);
    if (!prevEntry) {
      block(`--requests 里没有 ${prevCid} 这份 c04，没有原件可打补丁`, '③提示词',
        `node agents/prompt-writer/run.js --shotlist <c03> --assets agents/prompt-writer/sample_assets.json`);
      continue;
    }
    const prevDoc = prevEntry.doc;
    if (prevDoc.payload.shot_id !== shotId) {
      block(`c06 说这是 ${shotId}，但 ${rel(prevEntry.file)} 里的 shot_id 是 ${prevDoc.payload.shot_id}，两份材料对不上`, null);
      continue;
    }

    // 原件残缺就在动手之前打回。--requests 只按「有 envelope 与 payload.generation」收文件，
    // 不跑契约校验；缺了这三个字段，后面每一步都会读到 undefined（时间码重排要 prompt、
    // turbo 步数要 workflow.type、换种子要 seed），拖到自检里就是整批崩掉。
    const prevGen = prevDoc.payload.generation;
    const incomplete = [
      [typeof prevDoc.payload.workflow?.type === 'string', 'payload.workflow.type'],
      [typeof prevGen?.prompt === 'string', 'payload.generation.prompt'],
      [Number.isInteger(prevGen?.seed), 'payload.generation.seed'],
    ].filter(([ok]) => !ok).map(([, f]) => f);
    if (incomplete.length) {
      block(`原件 ${rel(prevEntry.file)} 不完整（缺 ${incomplete.join('、')}），没有可打补丁的底子`, '③提示词',
        `node agents/prompt-writer/run.js --shotlist <c03> --assets agents/prompt-writer/sample_assets.json --shots ${shotId}`);
      continue;
    }

    // 重试次数：c06 记的与 --requests 里数出来的取大值（保守，防止无限烧 GPU）
    const counted = [...prevRequests.values()].filter((x) => x.doc.payload.shot_id === shotId && x.doc.payload.retry_of != null).length;
    const claimed = Number.isInteger(pl.retry_count) ? pl.retry_count : 0;
    if (counted !== claimed) {
      warnings.push(`${prevCid}: c06 记的 retry_count=${claimed}，但 --requests 里 ${shotId} 有 ${counted} 份 retry_of 非空的 c04，取大值 ${Math.max(counted, claimed)}`);
    }
    const retryCount = Math.max(counted, claimed);
    const maxRetries = args.maxRetries ?? (Number.isInteger(pl.max_retries) ? pl.max_retries : DEFAULT_MAX_RETRIES);

    if (retryCount >= maxRetries && !args.skipExhausted) {
      block(`已重试 ${retryCount} 次，达到上限 ${maxRetries}。再烧一轮 GPU 只是重复同一个失败`, '人工',
        `要么改上游（②分镜 换工作流类型 / ③提示词 重写），要么放弃这一镜让 ⑦剪辑 用别的候选`);
      continue;
    }
    if (retryCount >= maxRetries) {
      warnings.push(`${prevCid}: 已重试 ${retryCount} 次达上限 ${maxRetries}，--skip-exhausted 要求继续，这一笔会记进 envelope.notes`);
    }

    const action = pl.suggested_change?.action ?? null;
    if (!action) { block('c06 没有 suggested_change.action，不知道要改什么', '⑤质检', `node agents/qa/run.js --candidates ${prevCid} --requests <c04 目录>`); continue; }
    if (!ACTIONS.includes(action)) { block(`c06 的 suggested_change.action="${action}" 不在契约的 8 个枚举值里`, '⑤质检', `node agents/qa/run.js --candidates ${prevCid} --requests <c04 目录>`); continue; }

    const patch = pl.suggested_change?.patch ?? {};
    const { ok: patchOk, refused } = triagePatch(patch);
    // 越权键作为附注挂在转交理由后面：人需要知道 ⑤ 开了什么本站做不到的方子
    const refusedDetails = refused.map((r) => `patch.${r.key}=${JSON.stringify(r.value)} 改不了：${r.why}`);
    const qaCommand = `node agents/qa/run.js --candidates ${prevCid} --requests <c04 目录>`;

    // 四个动作不归 ⑥ 管。先于补丁白名单判断：动作说的是意图，比单个越权键更能说明该找谁——
    // switch_workflow_type 带着 patch.type 时，「换工作流类型归 ②分镜」比「type 这个键越权」有用得多。
    if (action === 'manual_intervention') {
      block(pl.suggested_change?.rationale ?? 'c06 判定需要人工介入', '人工',
        `root_cause：${pl.root_cause ?? '（c06 未给）'}`, refusedDetails);
      continue;
    }
    if (action === 'switch_workflow_type') {
      block(`换工作流类型（T2V/I2V/R2V）是 ②分镜 的决定：它同时改掉 workflow.type、api_json、node_ids 与 assets 的整套结构，⑥ 只被授权动 ${Object.keys(PATCH_TARGETS).join(' / ')}`,
        '②分镜 → ③提示词 → ④生成',
        `node agents/storyboard/run.js --screenplay <c02>\nnode agents/prompt-writer/run.js --shotlist <新 c03> --assets agents/prompt-writer/sample_assets.json`,
        refusedDetails);
      continue;
    }
    if (action === 'change_reference_asset') {
      block('换参考素材要连提示词一起改（素材位与 <Picture N> 一一绑定），而素材清单 agents/prompt-writer/sample_assets.json 是人工维护的侧输入。⑥ 不碰 assets',
        '人工改素材清单 → ③提示词 → ④生成',
        `先改 agents/prompt-writer/sample_assets.json，再：\nnode agents/prompt-writer/run.js --shotlist <c03> --assets agents/prompt-writer/sample_assets.json --shots ${shotId}`,
        refusedDetails);
      continue;
    }
    if (action === 'rewrite_prompt' && typeof patch.prompt !== 'string') {
      block('c06 要求重写提示词但没给 patch.prompt。⑥重试 一行创意文本都不写——写提示词是 ③ 的活，⑥ 越权写出来的东西没人复核过',
        '③提示词 → ④生成',
        `node agents/prompt-writer/run.js --shotlist <c03> --assets agents/prompt-writer/sample_assets.json --shots ${shotId}`,
        [`⑤质检 的失败原因（可直接抄给 ③）：${pl.root_cause ?? '（c06 未给 root_cause）'}`, ...refusedDetails]);
      continue;
    }

    if (refused.length) {
      const owner = refused.map((r) => PATCH_OWNER[r.key]).find(Boolean) ?? '人工';
      block('c06 要求的补丁越权，⑥重试 不能改这些字段', owner, owner === '⑤质检' ? qaCommand : null, refusedDetails);
      continue;
    }

    // 白名单内的键也各有归属动作。action 说的是意图、patch 说的是细节，两者打架时 ⑥ 不猜哪个算数：
    // 照 action 走就是悄悄丢掉 ⑤ 开的方子（下一轮大概率照原样再失败一次），
    // 照 patch 走就是做一件 ⑤ 没声明要做的事——patch.duration_seconds 还会绕过时间码重排，
    // 产出一份 timecodes 与 duration_seconds 对不上的 c04。两条路都是本站越权，一律打回 ⑤质检。
    const stray = patchOk.filter((x) => PATCH_ACTION[x.key] && PATCH_ACTION[x.key] !== action);
    if (stray.length) {
      block(`c06 的 action=${action}，但 patch 里带了归别的动作管的键：${stray.map((x) => `patch.${x.key}（属 ${PATCH_ACTION[x.key]}）`).join('、')}。两者对不上，⑥ 不猜哪个算数`,
        '⑤质检', `${qaCommand}\n重开一份 c06：要么把 action 改成 ${[...new Set(stray.map((x) => PATCH_ACTION[x.key]))].join(' 或 ')}，要么把这些键从 patch 里去掉`,
        stray.map((x) => `patch.${x.key}=${JSON.stringify(x.value)}`));
      continue;
    }

    // 新候选号：已有最大号 + 1，且不许覆盖
    const newIdx = usedIndexesFor(shotId, { prevRequests, shotDirs, extra: allocatedCandidates }) + 1;
    if (newIdx > MAX_CANDIDATE_INDEX) {
      block(`${shotId} 的候选号已经排到 c${pad2(MAX_CANDIDATE_INDEX)}，pattern 只有两位，没有下一个号可用`, '人工', '这一镜该收手了：让 ⑦剪辑 从已有候选里挑，或者人工决定放弃');
      continue;
    }
    const newCid = `${shotId}_c${pad2(newIdx)}`;
    if (existsSync(join(shotsRoot, newCid))) {
      throw new Error(`${newCid}: shots/${newCid} 已经存在，但候选号扫描没算出它（可能是个文件而不是目录）——两处材料不一致，⑥重试 拒绝覆盖任何已有产物`);
    }
    const outFile = join(outDir, `${newCid}.json`);
    if (!args.dryRun && existsSync(outFile)) {
      throw new Error(`${rel(outFile)} 已经存在（同一个 --out-dir 跑过第二次？）。⑥重试 不覆盖已有产物，换一个 --out-dir，或先确认那一份可以删`);
    }

    // 新 seed：上一次的 + 步长，再对着这个镜头用过的每一个 seed 查重
    const { seeds: usedSeeds, where: usedWhere } = usedSeedsFor(shotId, { prevRequests, shotsRoot, shotDirs, extra: allocatedSeeds });
    const prevSeed = prevGen.seed;
    const explicitSeed = patchOk.find((x) => x.key === 'seed')?.value;
    let seed;
    let seedNote;
    if (explicitSeed !== undefined) {
      if (!Number.isInteger(explicitSeed) || explicitSeed < 0 || explicitSeed > SEED_MAX) {
        block(`c06 的 patch.seed=${JSON.stringify(explicitSeed)} 不是 0–${SEED_MAX} 的整数`, '⑤质检', qaCommand);
        continue;
      }
      if (usedSeeds.has(explicitSeed)) {
        const hit = usedWhere.filter((w) => w.seed === explicitSeed).map((w) => `${w.seed}（${w.from}）`).join('、');
        block(`c06 指定的 seed=${explicitSeed} 这个镜头已经用过（${hit}），ComfyUI 会直接返回缓存的旧产物`, '⑤质检',
          `${qaCommand}\n或者干脆别给 patch.seed：留给 ⑥ 分配更安全，本站会扫 shots/ 与全部 c04 查重`);
        continue;
      }
      seed = explicitSeed;
      seedNote = `c06 指定 seed=${seed}（已查重，这个镜头没用过）`;
    } else {
      const r = allocateSeed({ prevSeed, used: usedSeeds, step: seedStep, cid: prevCid });
      seed = r.seed;
      seedNote = `seed ${prevSeed} → ${seed}（步长 ${seedStep}${r.bumped ? `，撞车跳过 ${r.bumped} 次` : ''}）`;
    }

    // 复制原件，逐项改
    const doc = clone(prevDoc);
    const changes = [];
    const change = (path, to, why) => {
      const from = getAt(doc, path);
      setAt(doc, path, to);
      changes.push({ path: path.join('.'), from, to, why });
    };

    change(['payload', 'candidate_id'], newCid, `候选号 +1（已有最大号是 c${pad2(newIdx - 1)}），不覆盖任何已烧过的产物`);
    change(['payload', 'generation', 'filename_prefix'], `shots/${newCid}`, 'ComfyUI 对完全相同的输入直接返回缓存，filename_prefix 不换就等于要求它复现同一个坏产物');
    change(['payload', 'generation', 'seed'], seed, seedNote);

    const retryOf = findRetryOf({ prevCid, shotsRoot, c06, warnings });
    if (!retryOf) {
      block(`找不到上一次的 c05_gen_result：shots/${prevCid}/meta.json 不在本地，c06.envelope.upstream_refs 里也没有 genres.* 可退用，retry_of 填不出来，闭环证据断在这里`,
        '④生成', `node agents/generator/run.js --requests <c04 目录> --shots ${prevCid}  先把 c05 落盘`);
      continue;
    }
    change(['payload', 'retry_of'], retryOf.id, `闭环证据：指回 ${retryOf.from}`);

    // 动作专属改动
    if (action === 'raise_megapixels') {
      const mp = patchOk.find((x) => x.key === 'megapixels')?.value ?? 1.0;
      if (!(mp >= MEGAPIXELS_MIN && mp <= MEGAPIXELS_MAX)) { block(`c06 的 patch.megapixels=${mp} 超出契约的 ${MEGAPIXELS_MIN}–${MEGAPIXELS_MAX}`, '⑤质检', qaCommand); continue; }
      change(['payload', 'generation', 'megapixels'], mp, `c06 要求提分辨率（${pl.suggested_change?.rationale ?? '未给理由'}）。1.0 是 H3 标称 768p，耗时会上去`);
    } else if (action === 'enable_turbo') {
      if (patch.turbo_enabled !== undefined && patch.turbo_enabled !== true) {
        block(`c06 的 action=enable_turbo，但 patch.turbo_enabled=${JSON.stringify(patch.turbo_enabled)}。⑥ 不会把开关拨成与 patch 相反的方向`,
          '⑤质检', qaCommand);
        continue;
      }
      const want = TURBO_STEPS[prevDoc.payload.workflow.type] ?? TURBO_STEPS.default;
      change(['payload', 'workflow', 'turbo_enabled'], true, 'c06 要求开 turbo：ComfySwitchNode 会自动切到 turbo LoRA');
      change(['payload', 'generation', 'steps'], want, `turbo 下步数按机型换成 ${want}（R2V 20→4 约 5 倍，T2V/I2V 20→8 约 2.5 倍）`);
    } else if (action === 'change_duration') {
      const dur = patchOk.find((x) => x.key === 'duration_seconds')?.value;
      if (typeof dur !== 'number') {
        block('c06 要求改时长但 patch 里没给 duration_seconds，⑥ 不猜要多长', '⑤质检',
          `node agents/qa/run.js --candidates ${prevCid} --requests <c04 目录> --shotlist <c03>（给了 c03 才能按分镜目标时长开补丁）`);
        continue;
      }
      if (!(dur >= DURATION_MIN && dur <= DURATION_MAX)) { block(`c06 的 patch.duration_seconds=${dur} 超出 H3 单次生成的 ${DURATION_MIN}–${DURATION_MAX}s`, '⑤质检', qaCommand); continue; }
      let rs;
      try {
        rs = rescaleTimecodes({ timecodes: prevDoc.payload.generation.timecodes ?? [], prompt: prevDoc.payload.generation.prompt, oldDuration: prevDoc.payload.generation.duration_seconds, newDuration: dur, cid: prevCid });
      } catch (e) {
        block(e.message, '③提示词', `node agents/prompt-writer/run.js --shotlist <c03> --assets agents/prompt-writer/sample_assets.json --shots ${shotId}`);
        continue;
      }
      change(['payload', 'generation', 'duration_seconds'], dur, `c06 要求改时长（${pl.suggested_change?.rationale ?? '未给理由'}）。写秒不写帧，④生成 会让 ComfyMathExpression 对齐到 17 的倍数`);
      change(['payload', 'generation', 'timecodes'], rs.timecodes, `时间码按 ${rs.oldEnd}s → ${rs.newEnd}s 等比重排（每段至少 1 秒）`);
      change(['payload', 'generation', 'prompt'], rs.prompt, '提示词里的 [Xs-Ys] 分段标记同步重排，保持与 timecodes 一致');
      warnings.push(`${prevCid}: change_duration 是机械等比重排，每一段演什么没变、只是节奏被拉长/压短。要是这个镜头的节奏本来就是叙事重点，请让 ③提示词 重写而不是重排`);
    } else if (action === 'rewrite_prompt') {
      const np = patch.prompt;
      if (np.length < PROMPT_MIN_LENGTH) { block(`c06 给的 patch.prompt 只有 ${np.length} 字符，契约要求至少 ${PROMPT_MIN_LENGTH}`, '⑤质检', qaCommand); continue; }
      // 分段标记要逐一对上，不能只数个数：新提示词写 [0s-3s][3s-6s]、timecodes 却还是 [0s-2s][2s-5s] 时，
      // 个数一样、自检也只数个数，于是一份「模型看到的分段与契约记录的分段分家」的 c04 就混过去了——
      // 那正是 change_duration 分支宁可打回也不肯造的东西。
      const tcs = Array.isArray(doc.payload.generation.timecodes) ? doc.payload.generation.timecodes : [];
      const marks = np.match(PROMPT_TIMECODE_RE) ?? [];
      const badAt = tcs.findIndex((tc, i) => marks[i] !== tc);
      if (tcs.length && (marks.length !== tcs.length || badAt !== -1)) {
        const what = marks.length !== tcs.length
          ? `新提示词里有 ${marks.length} 处时间码，generation.timecodes 有 ${tcs.length} 段`
          : `新提示词第 ${badAt + 1} 处时间码是 ${marks[badAt]}，generation.timecodes 第 ${badAt + 1} 段是 ${tcs[badAt]}`;
        block(`${what}，两者对不上。⑥ 不做半截修改：真烧出来坏了也说不清是画面错还是分段错`,
          '③提示词', `node agents/prompt-writer/run.js --shotlist <c03> --assets agents/prompt-writer/sample_assets.json --shots ${shotId}`);
        continue;
      }
      change(['payload', 'generation', 'prompt'], np, 'c06 直接给了新提示词（⑥ 只是抄过来，创意内容归 ⑤/③ 负责）');
    }

    // 到这里白名单里的每个键都已被自己的动作分支处理完（seed 归本站，其余四个各归一个动作，
    // 归属对不上的在上面就被打回了），不需要再兜一个「其余键照抄」的循环。

    // envelope
    doc.envelope = {
      schema_version: '1.0',
      artifact_id: `genreq.${newCid}.${stamp}`,
      contract: 'c04_gen_request',
      created_at: new Date().toISOString(),
      producer: { kind: 'agent', name: AGENT_NAME, agent_version: AGENT_VERSION },
      upstream_refs: [...new Set([c06.envelope?.artifact_id, prevDoc.envelope?.artifact_id, retryOf.id].filter(Boolean))],
      notes: [
        `⑥重试 按 ${rel(qcFile)} 的判定打回：${prevCid} → ${newCid}（第 ${retryCount + 1} 次重试，上限 ${maxRetries}）`,
        `action=${action}`,
        changes.map((c) => `${c.path}: ${forNotes(c.from)} → ${forNotes(c.to)}`).join('；'),
        pl.failed_items?.length ? `⑤ 的失败项：${pl.failed_items.join('、')}` : null,
        pl.root_cause ? `⑤ 的归因：${pl.root_cause}` : null,
        args.skipExhausted && retryCount >= maxRetries ? `警告：已达重试上限 ${maxRetries}，本次由 --skip-exhausted 强制放行` : null,
        '提示词、素材位、工作流类型、节点 ID 映射全部原样沿用上一份 c04，⑥重试 不改创意内容',
      ].filter(Boolean).join('。'),
    };

    const problems = structuralCheck(doc, { usedSeeds, newCid });
    if (problems.length) throw new Error(`${prevCid} → ${newCid}: 新 c04 结构自检未通过：\n- ${problems.join('\n- ')}`);

    for (const c of changes) log(`[重试]   ${c.path}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}  ← ${c.why}`);

    let file = null;
    if (!args.dryRun) {
      file = outFile;
      writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      if (args.validate !== false) {
        const r = pythonValidate(file, 'c04_gen_request');
        if (r === null) warnings.push(`${newCid}: 未找到可用的 python/jsonschema，新 c04 只做了 JS 结构自检；提交前请手动跑 contracts/validate_contract.py`);
        else if (r.code === 1) {
          // 撤掉这份坏文件再抛：④生成 扫 --requests 下的每个 *.json，一份不合格就让整批被拒，
          // 留在盘上等于给下一轮埋雷。
          rmSync(file, { force: true });
          throw new Error(`${rel(file)} 未通过 c04_gen_request 契约校验，已删除该文件：\n${r.out}`);
        }
        else if (r.code !== 0) warnings.push(`${newCid}: 契约校验未执行（退出码 ${r.code}）：${r.out}`);
      }
    }

    if (!allocatedCandidates.has(shotId)) allocatedCandidates.set(shotId, []);
    allocatedCandidates.get(shotId).push(newCid);
    if (!allocatedSeeds.has(shotId)) allocatedSeeds.set(shotId, []);
    allocatedSeeds.get(shotId).push(seed);

    created.push({ prevCid, newCid, shotId, action, seed, retryCount: retryCount + 1, changes, file, doc });
    log(`[重试] ${prevCid} → ${newCid}（action=${action}，seed=${seed}，第 ${retryCount + 1}/${maxRetries} 次）${args.dryRun ? '［dry-run 未写文件］' : ''}`);
  }

  if (blocked.length && !args.dryRun) {
    log(`[重试] ${blocked.length} 项转交上游/人工，已写 ${rel(join(outDir, 'needs_human.md'))}`);
  }

  for (const w of [...new Set(warnings)]) log(`[重试] 警告：${w}`);
  return { outDir, created, blocked, files: created.map((c) => c.file).filter(Boolean) };
}

function renderNeedsHuman(blocked) {
  const lines = [
    '# ⑥重试 转交清单',
    '',
    `生成时间：${new Date().toISOString()}`,
    '',
    '下面这些 c06(fail) 本站处理不了。**不是出错，是权限边界**：',
    '⑥重试 只被授权改 seed / duration_seconds / megapixels / steps / prompt / turbo_enabled 这几个字段，',
    '其余的改动要么归上游工位，要么归人。逐条照着「转交」那一栏做，做完回 ④生成 重跑。',
    '',
  ];
  blocked.forEach((b, i) => {
    lines.push(`## ${i + 1}. ${b.prevCid}（镜头 ${b.shotId}）`, '');
    lines.push(`- **⑤ 建议的 action**：\`${b.action ?? '（c06 未给）'}\``);
    lines.push(`- **为什么 ⑥ 做不了**：${b.reason}`);
    for (const d of b.details ?? []) lines.push(`  - ${d}`);
    lines.push(`- **转交**：${b.routeBack ?? '人工判断'}`);
    if (b.command) lines.push('- **下一步**：', '', '  ```bash', ...b.command.split('\n').map((l) => `  ${l}`), '  ```');
    lines.push(`- **判定书原文**：\`${rel(b.qcFile)}\``, '');
  });
  return lines.join('\n') + '\n';
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[重试] ${e.message}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) { usage(); return; }
  try {
    const r = await runRetry(args);
    if (args.dryRun) {
      console.log(`[重试] dry-run 完成：将产出 ${r.created.length} 份新 c04${r.blocked.length ? `，另有 ${r.blocked.length} 项转交上游/人工` : ''}。没有写任何文件`);
      return;
    }
    console.log(`[重试] 完成：
  新 c04（c04_gen_request）：${rel(r.outDir)}/（共 ${r.files.length} 份）${r.blocked.length ? `\n  转交上游/人工：${r.blocked.length} 项 → ${rel(join(r.outDir, 'needs_human.md'))}` : ''}

[重试] 下一步：${r.created.length ? `
  回 ④生成 重跑这些新候选（它会换权重家族、上传素材、落盘到 shots/<新候选>/，不覆盖旧产物）：
    node agents/generator/run.js --requests ${rel(r.outDir)}
  跑完回 ⑤质检 复检：
    node agents/qa/run.js --candidates ${r.created.map((c) => c.newCid).join(',')}` : '没有可产出的新 c04，全部转交上游/人工，见 needs_human.md。'}`);
  } catch (e) {
    console.error(`[重试] ${e.message}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
