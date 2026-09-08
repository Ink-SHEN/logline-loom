// studio.mjs — LOOM 主程序：一条命令串起 ①编剧→②分镜→③提示词→④⑤⑥生成回环→⑦剪辑→渲染成片。
// agents/README.md 第四节状态表末行指名的「主程序」；与 prompts.js / tools/agent.mjs /
// tools/samples.js / tools/comfyui.mjs 一并补齐后，clone 下来即可跑通全流水线。
//
// 设计口径（沿袭各站 run.js 与 docs/ 的既有约定，不新开一套）：
//   1. 编排只调各站的 runX()（可编程入口，CLI 只是它们各自的壳），产物路径一律以 runX 返回值
//      为准并打印出来——不自己拼 artifacts/ 命名，站与站之间的交接面 = 上一站返回的路径。
//   2. 两道强制人工关口（c02 剧本确认、c07 粗剪确认）由人点批，机器（含本主程序）绝不代批。
//      c07 是全组看过渲染出来的粗剪后才批的（tools/slideshow.mjs --help 的口径），所以 ⑦ 出
//      决策单后先渲一版「审阅粗剪」再停下等人批；批完 `--from render` 只做核验，不再重烧。
//   3. ④⑤⑥ 生成回环是**一次性单元**（一轮 = 提交 → 质检 → 失败的重试打回 ④）：
//      质检目录在整轮内累积，任何一轮通过（route_to=edit）的 c06 都留给 ⑦ 按分数选候选。
//      跨多次运行拼接请逐站直接跑（各站 run.js 都接受路径参数，这正是它们能独立执行的原因）。
//   4. GPU 干跑边界：④生成 收 --dry-run（不 POST、不落 c05），编排器随之停在该站——
//      没有产物就无从质检，这是离线自检全流水线 ①→③ + 提交计划的天然终点。
//   5. 深层参数没全透传：要细调某一站，直接跑那站的 run.js --help；本主程序管默认参数下的整线串接。
//   6. 退出码与全仓库 CLI 一致：0 正常（含关口停靠）/ 1 运行错 / 2 用法错。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runScreenwriter } from './agents/screenwriter/run.js';
import { runStoryboard } from './agents/storyboard/run.js';
import { runPromptWriter } from './agents/prompt-writer/run.js';
import { runGenerator } from './agents/generator/run.js';
import { runQa } from './agents/qa/run.js';
import { runRetry } from './agents/retry/run.js';
import { runEditor } from './agents/editor/run.js';
import { renderEdit } from './tools/slideshow.mjs';
import { pythonValidateDoc } from './tools/agent.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const rel = (p) => relative(REPO_ROOT, p).replaceAll('\\', '/');

class UsageError extends Error {}

/** 阶段表：1 编剧 → 2 分镜 → 3 提示词 → 4 生成回环（④⑤⑥ 是一个单元）→ 5 剪辑 → 6 渲染。 */
const STAGES = [
  { key: 'screenwriter', name: '①编剧', gate: null },
  { key: 'storyboard', name: '②分镜', gate: 'c02_screenplay' },
  { key: 'prompt-writer', name: '③提示词', gate: null },
  { key: 'gen-loop', name: '④⑤⑥生成回环', gate: null },
  { key: 'editor', name: '⑦剪辑', gate: 'c07_edit_decision' },
  { key: 'render', name: '渲染成片', gate: null },
];
const STAGE_BY_KEY = new Map(STAGES.map((s, i) => [s.key, i + 1]));
for (let i = 1; i <= 6; i++) STAGE_BY_KEY.set(String(i), i); // 数字 1..6 与档位通用（4 = 回环）
const DEFAULT_MAX_RETRIES = 3;
const MAX_LOOP_ROUNDS = 12;

function usage() {
  console.log(`LOOM 主程序（studio.mjs）— 一条命令串起 ①编剧→②分镜→③提示词→④⑤⑥生成回环→⑦剪辑→渲染成片

用法：
  node studio.mjs [选项]                          # 从 ① 起步；到强制人工关口会停下等人批
  node studio.mjs --approve <c02/c07 文件> --reviewer <姓名> [--reason <理由>]   # 人工批准关口（只有人能跑）
  node studio.mjs --from <工位> [选项]             # 中途续跑（如批完 c02 后 --from 2）

档位（--from / --until 的取值，名字与数字 1–6 通用）：
  1/①编剧  2/②分镜  3/③提示词  4/④⑤⑥生成回环（④生成+⑤质检+⑥重试收敛，一次性单元）
  5/⑦剪辑  6/渲染成片

选项：
  --logline <一句话故事>     从 ① 起步时必填（20–400 字）；或 --brief <c01 JSON 路径>
  --theme / --duration / --aspect-ratio / --visual-style / --audio-style / --character / --red-lines
                              ①编剧 的可选项（缺省按 c01 契约默认值补齐，见 agents/screenwriter/run.js）
  --candidates <1-8>         每镜头候选数，默认 3（写进 c03 batch_plan，③ 自动照它走）
  --assets <素材清单>         ③提示词 的素材清单 JSON（人工侧输入；全 T2V 的片子不需要）
  --screenplay <c02 路径>     ② 的输入（缺省取 artifacts/ 里最新的 c02）
  --shotlist <c03 路径>       ③⑤⑦ 的输入（缺省取最新的 c03）
  --genreq <c04 目录>         从 4 续跑时给回环起点批次（必填，回环不猜目录）
  --qc-dir <目录>             质检报告累积目录（回环内轮次共用；跨运行拼接时给上次的）
  --edit <c07 路径>           从 6 续跑时给剪辑决策单（缺省取最新的 c07）
  --subtitles <字幕侧清单>     ⑦剪辑 用（格式见 agents/editor/sample_subtitles.json）
  --ai-label-position <值>    AI 生成标识位置，默认 opening_and_ending（见 agents/editor/run.js --help）
  --review <复核侧清单>        ⑤质检 用（人工/外部视觉模型复核，格式见 agents/qa/sample_review.json）
  --vision / --vision-model / --frames <n> / --on-unreviewed <human|edit>
                              ⑤质检 的抽帧视觉复核通道（需要 ffmpeg 与 API Key）
  --max-retries <n>           生成回环重试上限，默认 3（⑤⑥ 同一口径，防无限烧 GPU）
  --endpoint <url>            ④生成 的 ComfyUI 地址（默认 LOOM_COMFY_URL 或 http://127.0.0.1:8188，
                              无鉴权只能走 SSH 隧道，地址不要写进仓库）
  --wait-timeout <秒> / --poll <秒> / --overwrite / --allow-cached / --force-queue / --fail-fast
                              ④生成 的提交/轮询参数（含义见 agents/generator/run.js --help）
  --dry-run                 ④生成 只出提交计划不 POST（回环一轮后编排停靠——离线自检天然终点）
  --render-out <路径>         渲染输出路径（缺省按 c07 final_output.path，见 tools/slideshow.mjs --help）
  --model <名称>              覆盖 LOOM_LLM_MODEL（①②③⑤⑦ 共用）
  --offline                   全部 LLM 工位不调模型（①→③ 用离线示例，⑤ 主观项只认 --review）
  --no-validate               跳过各站 python 契约校验（不建议）
  --approve <路径>            关口批准模式（见上）；必配 --reviewer <姓名>，可加 --reason <理由>
  --reviewer <姓名>           批准人（写进 gate.reviewer）
  -h, --help                  显示本帮助

关口与回填：c02/c07 的 gate 只由人点批（--approve 写 gate.status=approved + reviewer/reviewed_at），
批准后跑 python contracts/validate_contract.py --file <文件> 才会 exit 0——那是机器拦的人机边界。
c07 还牵涉渲染回填（tools/slideshow.mjs 把 final_output 的 sha256/size_bytes/实测响度写回决策单）。`);
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
    const flag = () => {
      if (inline !== null) throw new UsageError(`${key} 不接受参数值`);
      return true;
    };
    switch (key) {
      // ①编剧 输入
      case '--logline': out.logline = need(); break;
      case '--brief': out.brief = need(); break;
      case '--theme': out.theme = need(); break;
      case '--duration': out.duration = Number(need()); break;
      case '--aspect-ratio': out.aspectRatio = need(); break;
      case '--visual-style': out.visualStyle = need(); break;
      case '--audio-style': out.audioStyle = need(); break;
      case '--character': out.character = need(); break;
      case '--red-lines': out.redLines = need(); break;
      // 上游产物路径（续跑）
      case '--screenplay': out.screenplay = need(); break;
      case '--shotlist': out.shotlist = need(); break;
      case '--genreq': out.genreq = need(); break;
      case '--qc-dir': out.qcDir = need(); break;
      case '--edit': out.edit = need(); break;
      // ②③ 选项
      case '--candidates': out.candidates = Number(need()); break;
      case '--assets': out.assets = need(); break;
      // ⑤ 选项
      case '--review': out.review = need(); break;
      case '--vision': out.vision = flag(); break;
      case '--vision-model': out.visionModel = need(); break;
      case '--frames': out.frames = Number(need()); break;
      case '--on-unreviewed': out.onUnreviewed = need(); break;
      case '--max-retries': out.maxRetries = Number(need()); break;
      // ④ 选项
      case '--endpoint': out.endpoint = need(); break;
      case '--dry-run': out.dryRun = flag(); break;
      case '--wait-timeout': out.waitTimeout = Number(need()); break;
      case '--poll': out.poll = Number(need()); break;
      case '--overwrite': out.overwrite = flag(); break;
      case '--allow-cached': out.allowCached = flag(); break;
      case '--force-queue': out.forceQueue = flag(); break;
      case '--fail-fast': out.failFast = flag(); break;
      // ⑦ 选项
      case '--subtitles': out.subtitles = need(); break;
      case '--ai-label-position': out.aiLabelPosition = need(); break;
      // 渲染
      case '--render-out': out.renderOut = need(); break;
      // 全局
      case '--model': out.model = need(); break;
      case '--offline': out.offline = flag(); break;
      case '--no-validate': out.validate = false; break;
      case '--from': out.from = need(); break;
      case '--until': out.until = need(); break;
      // 关口批准（只有人跑）
      case '--approve': out.approve = need(); break;
      case '--reviewer': out.reviewer = need(); break;
      case '--reason': out.reason = need(); break;
      case '-h': case '--help': out.help = true; break;
      default: throw new UsageError(`未知参数 ${a}（见 --help）`);
    }
  }
  // 校验
  if (out.logline !== undefined && (out.logline.length < 20 || out.logline.length > 400)) {
    throw new UsageError(`--logline 长度 ${out.logline.length} 不满足契约 c01 的 20–400 字要求`);
  }
  if (out.duration !== undefined && !Number.isNaN(out.duration) && !(out.duration >= 60 && out.duration <= 300)) {
    throw new UsageError(`--duration 须在 60–300 秒之间（契约 c01 硬要求），收到：${out.duration}`);
  }
  if (out.candidates !== undefined && (!Number.isInteger(out.candidates) || out.candidates < 1 || out.candidates > 8)) {
    throw new UsageError(`--candidates 须为 1–8 的整数，收到：${out.candidates}`);
  }
  if (out.frames !== undefined && (!Number.isInteger(out.frames) || out.frames < 1 || out.frames > 16)) {
    throw new UsageError(`--frames 须为 1–16 的整数，收到：${out.frames}`);
  }
  if (out.onUnreviewed !== undefined && !['human', 'edit'].includes(out.onUnreviewed)) {
    throw new UsageError(`--on-unreviewed 只认 human / edit，收到：${out.onUnreviewed}`);
  }
  if (out.maxRetries !== undefined && (!Number.isInteger(out.maxRetries) || out.maxRetries < 1)) {
    throw new UsageError(`--max-retries 须为 ≥1 的整数，收到：${out.maxRetries}`);
  }
  const resolveStage = (v, what) => {
    if (v === undefined) return null;
    const n = STAGE_BY_KEY.get(v);
    if (!n) throw new UsageError(`${what} 只认 ${STAGES.map((s) => `${s.key}/${s.name}`).join('、')}（或数字 1–6），收到：${v}`);
    return n;
  };
  out.fromN = resolveStage(out.from, '--from');
  out.untilN = resolveStage(out.until, '--until');
  if (out.fromN !== null && out.untilN !== null && out.fromN > out.untilN) {
    throw new UsageError(`--from ${out.from} 在 --until ${out.until} 之后，区间为空`);
  }
  if (out.approve !== undefined) {
    if (!out.reviewer) throw new UsageError('--approve 必须配 --reviewer <姓名>（批准人是谁要写进 gate.reviewer）');
    if (out.fromN !== null || out.untilN !== null || out.logline || out.brief) {
      throw new UsageError('--approve 是独立子命令，不要混运行参数（要跑流水线就别带 --approve）');
    }
  }
  return out;
}

// ——— 小工具 ———

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`无法读取/解析${what} ${rel(path)}：${e.message}`);
  }
}

/** 只挑已定义的键构造站点的 options（undefined 与缺省等价，但语义更干净）。 */
function present(args, keys) {
  const o = {};
  for (const k of keys) if (args[k] !== undefined) o[k] = args[k];
  return o;
}

/** artifacts/ 下按文件名前缀找最新一份（站与站之间路径以返回值传递，这里只服务 --from 续跑）。 */
function latestArtifact(prefix, contract) {
  const dir = join(REPO_ROOT, 'artifacts');
  if (!existsSync(dir)) return null;
  const cands = readdirSync(dir)
    .filter((n) => n.startsWith(prefix) && n.endsWith('.json'))
    .map((n) => join(dir, n))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const p of cands) {
    try {
      const doc = JSON.parse(readFileSync(p, 'utf8'));
      if (doc?.envelope?.contract === contract) return p;
    } catch { /* 跳过坏文件 */ }
  }
  return null;
}

function hasFfmpeg() {
  if (process.env.LOOM_FFMPEG) return existsSync(process.env.LOOM_FFMPEG);
  for (const cand of ['ffmpeg', 'ffmpeg.exe']) {
    const hit = (process.env.PATH ?? '').split(';').find((d) => d && existsSync(join(d, cand)));
    if (hit) return true;
  }
  return false;
}

function banner(...lines) {
  const bar = '─'.repeat(72);
  console.log(`\n${bar}\n${lines.join('\n')}\n${bar}\n`);
}

// ——— 关口（c02 剧本确认 / c07 粗剪确认）———

function gateStatus(doc) {
  return doc?.payload?.gate?.status ?? null;
}

function assertGateApproved(doc, path, contract) {
  const st = gateStatus(doc);
  if (st !== 'approved') {
    throw new Error(`${contract} ${rel(path)} 的人工关口未批（gate.status=${JSON.stringify(st)}）。` +
      `批准是人的动作：node studio.mjs --approve ${rel(path)} --reviewer <姓名>`);
  }
}

/** --approve：人工批准一份 c02/c07。写 gate 后跑权威校验（结构校验用的就是这份已批准的真产物）。 */
function approveGate(path, reviewer, reason) {
  const abs = resolve(path);
  const doc = readJson(abs, '关口产物');
  const contract = doc?.envelope?.contract;
  if (!['c02_screenplay', 'c07_edit_decision'].includes(contract)) {
    throw new UsageError(`${rel(abs)} 的 envelope.contract=${JSON.stringify(contract)}，不是可批的关口产物（只批 c02_screenplay / c07_edit_decision）`);
  }
  const gate = doc.payload.gate;
  if (!gate) throw new Error(`${rel(abs)} 没有 payload.gate，不是带强制人工关口的契约产物`);
  if (gateStatus(doc) === 'approved') {
    console.log(`[编排] ${rel(abs)} 的 gate 早已 approved（reviewer=${JSON.stringify(gate.reviewer)}），未改动`);
    return true;
  }
  const reviewedAt = new Date().toISOString();
  doc.payload.gate = {
    required: gate.required !== false,
    status: 'approved',
    reviewer,
    reviewed_at: reviewedAt,
    ...(reason ? { reason } : {}),
  };
  writeFileSync(abs, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log(`[编排] gate 已批准：${rel(abs)}（reviewer=${reviewer}，reviewed_at=${reviewedAt}${reason ? `，reason=${reason}` : ''}）`);
  const v = pythonValidateDoc(abs, contract);
  if (v === null) {
    console.log('[编排] 警告：未找到可用的 python/jsonschema，没跑权威校验；结构与 gate 格式请人工核一眼');
    return true;
  }
  if (v.code !== 0) {
    console.log(`[编排] 权威校验未通过（批准已写入，但这份产物结构仍有问题，提交前必须修）：\n${v.out}`);
    return false;
  }
  console.log(`[编排] 权威校验通过：[通过] ${rel(abs)} 符合 ${contract}`);
  return true;
}

// ——— 各阶段 ———

async function stageScreenwriter(args) {
  banner('开始 ①编剧 —— 消费 c01，产出 c02_screenplay（强制人工关口，Agent 不自批）');
  if (!args.logline && !args.brief) {
    throw new UsageError('从 ① 起步必须给 --logline <一句话故事>（或 --brief <c01 JSON>），见 --help');
  }
  const r = await runScreenwriter(present(args, ['logline', 'brief', 'theme', 'duration', 'aspectRatio', 'visualStyle', 'audioStyle', 'character', 'redLines', 'model', 'offline', 'validate']));
  console.log(`[编排] ① 完成：${rel(r.screenplayPath)}（${r.usedFallback ? '离线示例降级，需人工复核' : 'LLM 生成'}）`);
  return r;
}

/** ② 的输入路径：显式 --screenplay > 上一站返回值 > artifacts/ 最新 c02。找不到返回 null（调用方友好停靠）。 */
function resolveInput(args, flag, prefix, contract, fallback) {
  if (flag) return resolve(flag);
  if (fallback && existsSync(fallback)) return fallback;
  return latestArtifact(prefix, contract);
}

async function stageStoryboard(args, screenplayPath) {
  banner('开始 ②分镜 —— 消费 c02（须人工关口已批），产出 c03_shotlist');
  const path = resolveInput(args, args.screenplay, 'screenplay_', 'c02_screenplay', screenplayPath);
  if (!path || !existsSync(path)) throw new Error('② 缺上游 c02：给 --screenplay <路径>，或先跑 ①（本机 artifacts/ 里没有 c02）');
  const doc = readJson(path, 'c02_screenplay');
  assertGateApproved(doc, path, 'c02_screenplay'); // 双重保险：主流程关口停靠后这里不该再触发
  const r = await runStoryboard({ screenplay: path, ...present(args, ['candidates', 'aspectRatio', 'model', 'offline', 'validate']) });
  console.log(`[编排] ② 完成：${rel(r.shotlistPath)}（${r.usedFallback ? '离线示例降级' : 'LLM 生成'}）`);
  return r;
}

async function stagePromptWriter(args, shotlistPath) {
  banner('开始 ③提示词 —— 消费 c03，产出 c04_gen_request（每镜头 × 每候选一份）');
  const path = resolveInput(args, args.shotlist, 'shotlist_', 'c03_shotlist', shotlistPath);
  if (!path || !existsSync(path)) throw new Error('③ 缺上游 c03：给 --shotlist <路径>，或先跑 ②（本机 artifacts/ 里没有 c03）');
  const r = await runPromptWriter({ shotlist: path, ...present(args, ['assets', 'candidates', 'model', 'offline', 'validate']) });
  console.log(`[编排] ③ 完成：${rel(r.outDir)}/（${r.files.length} 份 c04）${r.usedFallback ? '（离线机械拼装骨架，需人工复核）' : ''}`);
  return r;
}

/**
 * ④⑤⑥ 生成回环：一轮 = ④提交 → ⑤质检 → fail(retry) 的打回 ⑥ 出新 c04 → 下一轮只跑新候选。
 * 质检报告累积进同一个目录（qcDir），整轮通过（route_to=edit）的 c06 全部留给 ⑦ 选候选。
 * 返回 { qcDir, passCids, humanNotes, dryRunHalt, rounds }。
 */
async function runGenLoop(args, ctx) {
  banner(`开始 ④⑤⑥生成回环 —— ④生成 → ⑤质检 → ⑥重试收敛（qc 累积目录：${rel(ctx.qcDir)}）`);
  const maxRetries = args.maxRetries ?? DEFAULT_MAX_RETRIES;
  const genOpts = present(args, ['endpoint', 'dryRun', 'waitTimeout', 'poll', 'overwrite', 'allowCached', 'forceQueue', 'failFast', 'validate']);
  const qaBase = present(args, ['review', 'vision', 'visionModel', 'frames', 'onUnreviewed', 'trustMeta', 'model', 'offline', 'validate']);
  if (ctx.shotlistPath) qaBase.shotlist = ctx.shotlistPath;
  if (ctx.briefPath) qaBase.brief = ctx.briefPath;
  const out = { qcDir: ctx.qcDir, passCids: [], humanNotes: [], dryRunHalt: false, rounds: 0 };
  let roundDirs = [ctx.startC04Dir];

  for (let r = 0; r < MAX_LOOP_ROUNDS; r++) {
    out.rounds = r + 1;
    const c04Dir = roundDirs[r];
    console.log(`\n[编排] ——— 回环第 ${r + 1} 轮（${r === 0 ? '首批' : '重试批'}）：${rel(c04Dir)} ———`);

    // ④ 提交（轮内只交本轮的候选）
    const gen = await runGenerator({ ...genOpts, requests: [c04Dir] });
    if (gen.dryRun) {
      console.log('[编排] ④生成 是 --dry-run（只出提交计划，未 POST、未落 c05）——没有产物可质检，离线边界到此为止。');
      out.dryRunHalt = true;
      break;
    }
    const ok = gen.results.filter((x) => x.status === 'ok');
    for (const s of gen.skipped) console.log(`[编排] ${s.candidateId} 已存在，跳过（要重跑加 --overwrite）`);
    for (const e of gen.results.filter((x) => x.status === 'error')) {
      out.humanNotes.push(`${e.candidateId}: ④生成失败（${e.message?.split('\n')[0]}）`);
    }
    if (!ok.length) {
      console.log('[编排] 本轮没有成功产物——回环停止，交给人工');
      break;
    }

    // ⑤ 质检（只判本轮新候选；c04 全目录都给出，retry_count 与 seed 追溯才数得全）
    const qa = await runQa({
      ...qaBase,
      candidates: ok.map((x) => x.candidateId),
      requests: roundDirs,
      maxRetries,
      outDir: ctx.qcDir,
    });
    const byRoute = { edit: [], retry: [], human: [] };
    for (const x of qa.results) {
      const route = x.routeTo === 'edit' ? 'edit' : x.routeTo === 'retry' ? 'retry' : 'human';
      byRoute[route].push(x);
      if (route === 'edit') out.passCids.push(x.candidateId);
      if (route === 'human') out.humanNotes.push(`${x.candidateId}: 判 human（${x.message ?? '未复核或重试耗尽，见质检报告'}）`);
    }
    console.log(`[编排] ⑤ 质检：pass ${byRoute.edit.length} · retry ${byRoute.retry.length} · human ${byRoute.human.length}（累积 ${rel(ctx.qcDir)}）`);
    if (!byRoute.retry.length) break; // 没有要重试的，回环收敛

    // ⑥ 打回（只处理本轮 fail(retry)；目录里的非 retry 报告它会自己跳过）
    const retry = await runRetry({
      qc: [ctx.qcDir],
      requests: roundDirs,
      maxRetries,
      outDir: join(REPO_ROOT, 'artifacts', `genreq_retry_${ctx.stamp}_r${r + 1}`),
      validate: args.validate,
    });
    if (!retry.created.length) {
      out.humanNotes.push(`第 ${r + 1} 轮重试全部阻塞（${retry.blocked.length} 项转交上游/人工，见 ${rel(join(retry.outDir, 'needs_human.md'))}）`);
      break;
    }
    roundDirs.push(retry.outDir);
  }
  if (out.rounds >= MAX_LOOP_ROUNDS) {
    out.humanNotes.push(`回环超过 ${MAX_LOOP_ROUNDS} 轮仍没收敛——先查 ⑤ 的方子与 GPU 日志，别硬跑`);
  }
  return out;
}

async function stageEditor(args, { qcDir, shotlistPath, briefPath }) {
  banner('开始 ⑦剪辑 —— 消费 c06(pass) + c03(顺序) + c05(路径)，产出 c07_edit_decision（强制人工关口）');
  const qcPath = args.qcDir ? resolve(args.qcDir) : qcDir;
  if (!qcPath || !existsSync(qcPath)) {
    throw new Error('⑦ 缺上游质检目录：--from 5 续跑请给 --qc-dir <c06 目录>（回环内自动累积，不会缺）');
  }
  const dir = statSync(qcPath).isDirectory() ? qcPath : dirname(qcPath);
  let passCount = 0;
  let fileCount = 0;
  for (const n of readdirSync(dir)) {
    if (!n.endsWith('.json')) continue;
    fileCount++;
    try {
      if (JSON.parse(readFileSync(join(dir, n), 'utf8')).payload?.route_to === 'edit') passCount++;
    } catch { /* 非 c06 的 json 不计数 */ }
  }
  console.log(`[编排] 质检目录 ${rel(dir)}：${fileCount} 份报告，其中 ${passCount} 份 pass（route_to=edit）`);
  const r = await runEditor({
    qc: qcPath,
    ...(args.shotlist || shotlistPath ? { shotlist: args.shotlist ? resolve(args.shotlist) : shotlistPath } : {}),
    ...(args.brief || briefPath ? { brief: args.brief ? resolve(args.brief) : briefPath } : {}),
    ...present(args, ['subtitles', 'aiLabelPosition', 'model', 'offline', 'validate']),
  });
  console.log(`[编排] ⑦ 完成：${rel(r.outPath)}${r.assPath ? `（字幕 ${rel(r.assPath)}）` : ''}${r.usedFallback ? '（组装粗剪降级，需人工复核节奏）' : ''}`);
  return r;
}

async function stageRender(args, editPath) {
  banner('渲染成片 —— 消费已批准的 c07，产出 MP4 并回填 final_output/实测响度');
  const path = editPath ?? (args.edit ? resolve(args.edit) : latestArtifact('edit_', 'c07_edit_decision'));
  if (!path || !existsSync(path)) throw new Error('渲染缺 c07：给 --edit <路径>，或先跑 ⑦（本机 artifacts/ 里没有 c07）');
  const doc = readJson(path, 'c07_edit_decision');
  assertGateApproved(doc, path, 'c07_edit_decision');
  const fo = doc.payload?.final_output ?? {};
  const realSha = typeof fo.sha256 === 'string' && /^[0-9a-f]{64}$/.test(fo.sha256) && !/^0+$/.test(fo.sha256);
  const mp4 = typeof fo.path === 'string' && existsSync(resolve(REPO_ROOT, fo.path));
  if (realSha && mp4) {
    console.log(`[编排] 这份 c07 已渲染并回填（sha256=${fo.sha256.slice(0, 16)}…，${rel(fo.path)}）——批准后无需重烧，直接交付。`);
    return { skip: true, outFile: resolve(REPO_ROOT, fo.path) };
  }
  const renderOpts = { edit: path, validate: args.validate };
  if (args.renderOut) renderOpts.out = args.renderOut;
  const r = await renderEdit(renderOpts);
  console.log(`[编排] 成片已渲染：${rel(r.outFile)}（回填已写回 ${rel(r.backfillPath)}）`);
  return r;
}

function gate2Banner(ed, preview) {
  banner(
    '────────── 强制人工关口 2：粗剪确认（c07）──────────',
    `剪辑决策单：${rel(ed.outPath)}${ed.assPath ? `\n字幕 .ass：${rel(ed.assPath)}` : ''}`,
    preview ? `审阅粗剪：${rel(preview)}` : '（无预览视频，见上方说明）',
    '',
    '1. 全组看过粗剪（或决策单）→ 2. 满意就批准（只有人能批）：',
    `   node studio.mjs --approve ${rel(ed.outPath)} --reviewer <你的名字> --reason <一句话>`,
    '3. 批准后交付成片（校验已过、渲染已回填，不会再烧一遍）：',
    `   node studio.mjs --from render --edit ${rel(ed.outPath)}`,
    '不满意就改：把意见回给上游（换候选/换素材/改字幕），别在决策单上手工涂改。',
    '──────────────────────────────────────────────');
}

// ——— 主流程 ———

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[编排] ${e.message}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) { usage(); return; }

  // 关口批准模式：机器只提供「人点批」的通道，绝不代批
  if (args.approve !== undefined) {
    try {
      process.exitCode = approveGate(args.approve, args.reviewer, args.reason) ? 0 : 1;
    } catch (e) {
      console.error(`[编排] ${e.message}`);
      process.exitCode = e instanceof UsageError ? 2 : 1;
    }
    return;
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '');
  try {
    // 起始档位：--from 显式给定，否则按给出的上游路径反推（都没有 = 从 ① 起步）
    let from = args.fromN ?? 1;
    if (args.fromN === null) {
      if (args.edit) from = 6;
      else if (args.qcDir) from = 5;
      else if (args.genreq) from = 4;
      else if (args.shotlist || args.screenplay) from = 3;
    }
    const until = args.untilN ?? 6;
    console.log(`[编排] LOOM studio：档位 ${from}（${STAGES[from - 1].name}）→ ${until}（${STAGES[until - 1].name}）｜stamp=${stamp}｜${args.offline ? 'offline，LLM 工位全部离线降级' : 'LLM 在线'}${args.validate ? '' : '（跳过契约校验）'}`);

    let screenplayPath = null; // c02 文件（② 的输入；② 完成后回填）
    let shotlistPath = null;   // c03 文件（③ 输入；⑤⑦ 的比对/排序基准）
    let briefPath = null;      // c01 文件（⑤⑦ 的可选比对基准）
    let qcDir = args.qcDir ? resolve(args.qcDir) : null; // 质检累积目录（回环内建）
    let c04StartDir = null;    // 回环起点批次（③ 输出 / --from 4 续跑给定）
    const wantLoop = from <= 4 && until >= 4;

    // ①
    if (from <= 1 && until >= 1) {
      const r = await stageScreenwriter(args);
      briefPath = r.briefPath;
      screenplayPath = r.screenplayPath;
      console.log(`\n[编排] 下一站：②分镜 ── node agents/storyboard/run.js --screenplay ${rel(screenplayPath)}`);
    }
    // ②（c02 强制人工关口在这里生效：未批就停靠等人，批了才往下）
    if (from <= 2 && until >= 2) {
      const path = resolveInput(args, args.screenplay, 'screenplay_', 'c02_screenplay', screenplayPath);
      if (!path || !existsSync(path)) {
        if (from >= 2) throw new Error('② 缺上游 c02：给 --screenplay <路径>，或先跑 ①（本机 artifacts/ 里没有 c02）');
      } else {
        const doc = readJson(path, 'c02_screenplay');
        if (gateStatus(doc) !== 'approved') {
          banner(
            '────────── 强制人工关口 1：剧本确认（c02）──────────',
            `剧本：${rel(path)}`,
            '',
            '1. 读剧本 → 2. 满意就批准（只有人能批）：',
            `   node studio.mjs --approve ${rel(path)} --reviewer <你的名字> --reason <一句话>`,
            '3. 批准后从 ② 续跑：',
            `   node studio.mjs --from 2${args.screenplay ? ` --screenplay ${args.screenplay}` : ''}`,
            '不满意就改：把意见回给 ①编剧 改剧本，改完重新批准/重跑，别手工涂改 JSON。',
            '──────────────────────────────────────────────');
          return;
        }
        const r = await stageStoryboard(args, path);
        screenplayPath = r.screenplayPath;
        shotlistPath = r.shotlistPath;
        console.log(`\n[编排] 下一站：③提示词 ── node agents/prompt-writer/run.js --shotlist ${rel(shotlistPath)}`);
      }
    }
    // ③
    if (from <= 3 && until >= 3) {
      const r = await stagePromptWriter(args, shotlistPath);
      shotlistPath = r.shotlistPath;
      c04StartDir = r.outDir;
      console.log(`\n[编排] 下一站：④生成 ── node agents/generator/run.js --requests ${rel(c04StartDir)}`);
    }
    // ④⑤⑥ 回环
    if (wantLoop) {
      if (from <= 3) c04StartDir = c04StartDir; // ③ 刚产出（或 --until 3 时未产出，见下）
      if (!c04StartDir && args.genreq) c04StartDir = resolve(args.genreq);
      if (!c04StartDir || !existsSync(c04StartDir)) {
        if (until === 4) {
          console.log('[编排] 档位到 ③/回环边界为止（--until 4 且没有 ③ 的产物时无事可做，正常结束）');
          return;
        }
        throw new Error('④⑤⑥ 回环缺起点批次：--from 4 续跑请给 --genreq <c04 目录>（回环不猜目录）');
      }
      qcDir ??= join(REPO_ROOT, 'artifacts', `qc_${stamp}`);
      mkdirSync(qcDir, { recursive: true });
      const loop = await runGenLoop(args, { startC04Dir: c04StartDir, qcDir, stamp, shotlistPath, briefPath });
      if (loop.dryRunHalt) {
        banner(
          '离线自检到此为止：④生成 是 --dry-run，只出计划没出片，没有产物可质检。',
          `已落盘：${rel(c04StartDir)} 的提交计划与填好的图（在计划目录里）。`,
          '要真出片：确认 ComfyUI 隧道后去掉 --dry-run 重跑本命令（提交计划与图不变，逐字节相同）。');
        return;
      }
      if (loop.humanNotes.length) {
        console.log('\n[编排] 需要人工处理的项：');
        for (const h of loop.humanNotes) console.log(`  - ${h}`);
      }
      if (!loop.passCids.length) {
        banner(
          '回环结束但没有一条 pass（route_to=edit）——机器不敢往下走：⑦剪辑 在没有任何通过候选时',
          '本来就该阻塞。处理完上面的人工项后重跑回环（--from 4 --genreq <起点> [--qc-dir <累积目录>]）。');
        return;
      }
      console.log(`[编排] 回环收敛：${loop.passCids.length} 条 pass 候选（${loop.rounds} 轮），质检累积于 ${rel(qcDir)}`);
    }
    // ⑦（回环刚收出 pass，或 --from 5 直接给 --qc-dir 续跑）
    if (from <= 5 && until >= 5 && (wantLoop || from === 5)) {
      if (!wantLoop && !args.shotlist) {
        const latest = latestArtifact('shotlist_', 'c03_shotlist');
        if (latest) shotlistPath = latest; // ⑦ 缺 c03 时按 shot_id 升序推断并告警；给了更好
      }
      const ed = await stageEditor(args, { qcDir, shotlistPath, briefPath });
      // c07 人工关口：先渲「审阅粗剪」给人看，再停下等批（与 tools/slideshow.mjs 口径一致）
      if (gateStatus(ed.doc) === 'approved') {
        console.log('[编排] ⑦ 的 c07 竟然已批（续跑给了已批过的上游？）——直接进渲染段试试。');
      } else {
        let preview = null;
        if (hasFfmpeg()) {
          try {
            const rr = await renderEdit({ edit: ed.outPath, ...(ed.assPath ? { ass: ed.assPath } : {}), validate: args.validate });
            preview = rr.outFile;
          } catch (e) {
            console.log(`[编排] 审阅粗剪渲染失败（${e.message?.split('\n')[0]}）——可先按决策单审，批准后重试渲染`);
          }
        } else {
          console.log('[编排] 本机没有 ffmpeg，跳过审阅粗剪渲染——可按 c07 决策单审，批准后在有 ffmpeg 的机器上渲');
        }
        gate2Banner(ed, preview);
        return;
      }
    }
    // 渲染（正常只从 --from 6 进来；上面的关口停靠都已 return）
    if (from === 6 && until >= 6) {
      const r = await stageRender(args, args.edit ? resolve(args.edit) : null);
      if (r?.skip) console.log(`[编排] 交付完成：${rel(r.outFile)}`);
    }
  } catch (e) {
    console.error(`[编排] ${e.message}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((e) => {
    console.error(`[编排] ${e?.stack ?? e}`);
    process.exitCode = 1;
  });
}

// 可编程入口（与各站 run.js 同一口径）：import { main } from './studio.mjs' 不触发编排（见上面 isMain guard）。
export { main, usage, parseArgs, STAGES };
