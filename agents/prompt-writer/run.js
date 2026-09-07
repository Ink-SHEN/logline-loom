#!/usr/bin/env node
// agents/prompt-writer/run.js — 「③提示词」Agent 可执行入口（消费 c03_shotlist，产出 c04_gen_request）。
//
// 输入：②分镜产出的 c03_shotlist JSON（--shotlist 必填）+ 素材清单（--assets，I2V/R2V 镜头必须）。
// 输出：每镜头 × 每候选一份 c04_gen_request，落盘 artifacts/genreq_<时间戳>/<candidate_id>.json，
//       并逐份过 contracts/validate_contract.py 结构校验。
//
// 分工原则（与 ②分镜 同一口径）：能确定性判定的事不交给概率模型——
//   LLM 只产出创作部分：{ shots: [{ shot_id, prompt, timecodes }] }（英文提示词 + 时间码 + <Picture N>）；
//   envelope、candidate_id、seed（每候选必换，防 ComfyUI 缓存命中）、node_ids（只从
//   workflows/node_id_map.json 查，禁止硬编码）、duration/画幅/megapixels/fps/steps/filename_prefix、
//   assets 素材位，全部由代码组装。
// I2V/R2V 镜头缺素材时开工前阻塞：填错素材位会白烧一整轮 GPU 才在 ComfyUI 里报错。
// LLM：经 llm.js 的 OpenAI 兼容 API 接入；未配 Key 或调用失败时降级为「机械拼装提示词骨架」
//   （内容对应真实输入镜头，仅未经润色），流水线不断，产物 notes 里会标明需人工复核。
//
// 用法：node agents/prompt-writer/run.js --help

import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENT_VERSION, PROMPT_WRITER } from './prompt.js';
import { LlmError, chat, extractJson, llmConfig } from './llm.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'validate_contract.py');
const NODE_ID_MAP_PATH = join(REPO_ROOT, 'workflows', 'node_id_map.json');

// 取值全部照抄 contracts/film_agent_contracts.json 与 workflows/node_id_map.json，不要在这里发明新值
const WORKFLOW_FILE = { T2V: 'workflow_api_t2v.json', I2V: 'workflow_api_i2v.json', R2V: 'workflow_api_r2v.json' };
const MAP_KEY = { T2V: 't2v', I2V: 'i2v', R2V: 'r2v' };
// c04 的 workflow.node_ids 必须携带的语义键（前 7 项是契约 node_id_map_ref 的 required，后 3 项对齐 examples.json）
const NODE_ID_FIELDS = [
  'prompt', 'seed', 'duration_seconds', 'aspect_ratio', 'megapixels', 'filename_prefix',
  'fps', 'turbo_enabled', 'steps_normal', 'steps_turbo',
];
const ASPECT_RATIO = '16:9 (Widescreen)'; // 本项目已锁定（contracts 的 c04 generation.aspect_ratio 是 const）
const LICENSES = ['self_generated', 'self_shot', 'cc0', 'licensed', 'unknown'];
const SEED_MAX = 9007199254740991;
const TIMECODE_RE = /^\[(\d+)s-(\d+)s\]$/;
const CJK_RE = /[\u4e00-\u9fff]/;

const SHOT_SIZE_PHRASE = {
  extreme_close_up: 'extreme close-up', close_up: 'close-up shot', medium: 'medium shot',
  medium_wide: 'medium wide shot', wide: 'wide shot', extreme_wide: 'extreme wide establishing shot',
};
const CAMERA_MOVE_PHRASE = {
  static: 'static locked-off camera', push_in: 'slow deliberate push-in', pull_out: 'slow pull-out',
  pan_left: 'pan left', pan_right: 'pan right', tilt_up: 'tilt up', tilt_down: 'tilt down',
  tracking: 'tracking shot', orbit: 'orbiting camera', crane: 'crane move', handheld: 'handheld camera',
};

class UsageError extends Error {}

const rel = (p) => relative(REPO_ROOT, p).replaceAll('\\', '/');
const makeStamp = (d) => d.toISOString().slice(0, 19).replace(/[-:]/g, ''); // 20260907T043012

function usage() {
  console.log(`「③提示词」Agent — 消费 c03_shotlist，逐镜头 × 逐候选产出 c04_gen_request

用法：
  node agents/prompt-writer/run.js --shotlist artifacts/shotlist_<时间戳>.json [选项]

选项：
  --shotlist <路径>      必填。②分镜产出的 c03_shotlist JSON（envelope+payload 或裸 payload 均可）
  --assets <路径>        素材清单（assets manifest）。镜头清单里存在 I2V/R2V 镜头时必填，
                         缺条目会阻塞开工并列出缺什么。格式见 agents/prompt-writer/sample_assets.json：
                         键 = shot_id（优先）或 consistency_group 组名；I2V 给 first_frame，
                         R2V 给 ref_images（当前模板只接 2 个图位，最多 2 张）
  --candidates <n>       每镜头候选数 1–8，默认取镜头清单 batch_plan.candidates_per_shot（缺省 3）。
                         多候选靠换 seed，不靠改提示词（同镜头各候选 prompt 相同、seed 不同）
  --megapixels <值>      0.1–16，默认 0.4（试错阶段约 480p）；成片批次调 1.0 才是 H3 标称 768p
  --seed-base <整数>     种子基数，默认 1000。seed = 基数 + 镜头序号×100 + 候选号，全程可复现
  --style <英文句子>     全片风格锚点（c01 brief 的 visual_style 译成英文），每条 prompt 以它开头
  --turbo                置 workflow.turbo_enabled=true（FL2VA 20→8 步 / Ref2VA 20→4 步），试错提速用
  --out-dir <路径>       输出目录，默认 artifacts/genreq_<时间戳>/，每候选一份 <candidate_id>.json
  --model <名称>         覆盖 LOOM_LLM_MODEL
  --offline              不调 LLM，提示词用机械拼装骨架（对应输入镜头，需人工复核）
  --no-validate          跳过 python 契约校验（不建议）
  -h, --help             显示本帮助

LLM 接入（OpenAI 兼容 API，详见 llm.js）：
  LOOM_LLM_BASE_URL / LOOM_LLM_API_KEY / LOOM_LLM_MODEL
  未配 Key 或调用失败时自动降级机械拼装骨架，流水线不中断。`);
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
      case '--shotlist': out.shotlist = need(); break;
      case '--assets': out.assets = need(); break;
      case '--candidates': out.candidates = Number(need()); break;
      case '--megapixels': out.megapixels = Number(need()); break;
      case '--seed-base': out.seedBase = Number(need()); break;
      case '--style': out.style = need(); break;
      case '--turbo': out.turbo = true; break;
      case '--out-dir': out.outDir = need(); break;
      case '--model': out.model = need(); break;
      case '--offline': out.offline = true; break;
      case '--no-validate': out.validate = false; break;
      case '-h': case '--help': out.help = true; break;
      default: throw new UsageError(`未知参数 ${a}（见 --help）`);
    }
  }
  if (out.candidates !== undefined && (!Number.isInteger(out.candidates) || out.candidates < 1 || out.candidates > 8)) {
    throw new UsageError(`--candidates 须为 1–8 的整数（契约 batch_plan.candidates_per_shot 同口径），收到：${out.candidates}`);
  }
  if (out.megapixels !== undefined && !(out.megapixels >= 0.1 && out.megapixels <= 16)) {
    throw new UsageError(`--megapixels 须在 0.1–16（契约 generation.megapixels），收到：${out.megapixels}`);
  }
  if (out.seedBase !== undefined && (!Number.isInteger(out.seedBase) || out.seedBase < 0)) {
    throw new UsageError(`--seed-base 须为非负整数，收到：${out.seedBase}`);
  }
  return out;
}

/** 读上游镜头清单：完整 c03（envelope+payload）直接用；裸 payload 补一层 envelope 以便追溯。 */
function loadShotlistFile(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UsageError(`无法读取/解析镜头清单文件 ${path}：${e.message}`);
  }
  if (raw?.payload?.shots) return { doc: raw, wrapped: false };
  if (raw?.shots) {
    return {
      doc: {
        envelope: {
          schema_version: '1.0',
          artifact_id: 'shotlist.file',
          contract: 'c03_shotlist',
          created_at: new Date().toISOString(),
          producer: { kind: 'agent', name: '外部镜头清单文件' },
          upstream_refs: [],
          notes: `来自 ${path}`,
        },
        payload: raw,
      },
      wrapped: true,
    };
  }
  throw new UsageError(`${path} 里没有 payload.shots，不是有效的 c03_shotlist`);
}

function loadNodeIdMap() {
  let map;
  try {
    map = JSON.parse(readFileSync(NODE_ID_MAP_PATH, 'utf8'));
  } catch (e) {
    throw new Error(`无法读取 workflows/node_id_map.json：${e.message}（节点 ID 只能从映射表查，缺了它 ③提示词 无法开工；若模板重新导出过，先跑 python workflows/preflight.py 与 verify_map.py）`);
  }
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const hash = !r.error && r.status === 0 ? r.stdout.trim() : 'nogit';
  return { map, source: `workflows/node_id_map.json@${hash}` };
}

/** 从映射表拼 c04 的 workflow.node_ids：{语义: [节点ID, 键名]}，禁止硬编码节点 ID。 */
function buildNodeIds(map, type, source) {
  const fields = map[MAP_KEY[type]]?.fields;
  if (!fields) throw new Error(`node_id_map.json 里没有 ${MAP_KEY[type]}.fields，映射表版本不对`);
  const ids = { source };
  for (const name of NODE_ID_FIELDS) {
    const f = fields[name];
    if (!f?.node || !f?.key) throw new Error(`node_id_map.json 的 ${MAP_KEY[type]}.fields 缺 ${name}，映射表版本不对`);
    ids[name] = [f.node, f.key];
  }
  return ids;
}

function loadAssetsManifest(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UsageError(`无法读取/解析素材清单 ${path}：${e.message}`);
  }
  const manifest = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith('_')) manifest[k] = v;
  }
  return manifest;
}

/** 校验单个 asset_ref（契约 $defs/asset_ref：node_filename / source_path / license 必填）。 */
function checkAssetRef(ref, tag, warnings) {
  const p = [];
  if (!ref || typeof ref !== 'object') return [`${tag} 缺失或不是对象`];
  if (typeof ref.node_filename !== 'string' || !ref.node_filename) {
    p.push(`${tag}.node_filename 必填（ComfyUI input/ 下的文件名，须先 POST /upload/image 上传并确认出现在 LoadImage.image 枚举里）`);
  }
  if (typeof ref.source_path !== 'string' || !ref.source_path) p.push(`${tag}.source_path 必填`);
  if (!LICENSES.includes(ref.license)) p.push(`${tag}.license 须为 ${LICENSES.join(' / ')}`);
  else if (ref.license === 'unknown') warnings.push(`${tag}.license = unknown——unknown 的素材禁止进成片（⑦剪辑 的 compliance 会查）`);
  return p;
}

/**
 * 为每个镜头解析素材位：shot_id 精确匹配优先，其次 consistency_group 组内共用。
 * 返回 { perShot: [{shot, assets}], missing: [...], problems: [...] }——missing/problems 非空则阻塞开工。
 */
function resolveAssets(shots, manifest) {
  const perShot = [];
  const missing = [];
  const problems = [];
  const warnings = [];
  for (const shot of shots) {
    const t = shot.workflow_type;
    if (t === 'T2V') {
      if (manifest && (manifest[shot.shot_id] || (shot.consistency_group && manifest[shot.consistency_group]))) {
        warnings.push(`${shot.shot_id}：T2V 镜头在素材清单里有条目，已忽略（契约：T2V 不该带任何素材）`);
      }
      perShot.push({ shot, assets: {} });
      continue;
    }
    const key = manifest?.[shot.shot_id] ? shot.shot_id
      : (shot.consistency_group && manifest?.[shot.consistency_group] ? shot.consistency_group : null);
    const entry = key ? manifest[key] : null;
    if (!entry) {
      missing.push(shot);
      perShot.push({ shot, assets: null });
      continue;
    }
    let assets;
    if (t === 'I2V') {
      problems.push(...checkAssetRef(entry.first_frame, `${shot.shot_id}.first_frame`, warnings));
      assets = { first_frame: entry.first_frame };
    } else {
      if (!Array.isArray(entry.ref_images) || !entry.ref_images.length) {
        problems.push(`${shot.shot_id}：R2V 素材缺 ref_images（必填，1–2 张）`);
      } else if (entry.ref_images.length > 2) {
        problems.push(`${shot.shot_id}：ref_images 有 ${entry.ref_images.length} 张，当前 R2V 模板只接了 2 个参考图位（ref_image_0/1），要更多须在画布加线重导（node_id_map.json warnings）`);
      } else {
        entry.ref_images.forEach((a, i) => problems.push(...checkAssetRef(a, `${shot.shot_id}.ref_images[${i}]`, warnings)));
      }
      if (entry.ref_image_size !== undefined && !['match', 'max'].includes(entry.ref_image_size)) {
        problems.push(`${shot.shot_id}：ref_image_size 须为 match / max`);
      }
      assets = { ref_images: entry.ref_images ?? [], ref_image_size: entry.ref_image_size ?? 'match' };
    }
    if (entry.ref_videos || entry.ref_audios) {
      problems.push(`${shot.shot_id}：素材清单里的 ref_videos / ref_audios 当前三份模板未接线，请移除（c04 契约允许这些位，但模板没接，POST 会失败）`);
    }
    perShot.push({ shot, assets });
  }
  return { perShot, missing, problems, warnings };
}

function missingAssetsError(missing, assetsPath) {
  const lines = missing.map((s) =>
    `  - ${s.shot_id}（${s.workflow_type}，consistency_group=${s.consistency_group ?? 'null'}）：${s.reference_note || '（分镜未写 reference_note）'}`);
  return new Error(`以下 I2V/R2V 镜头缺参考素材，③提示词 拒绝开工（素材位填错会白烧一整轮 GPU 才在 ComfyUI 里报错）：
${lines.join('\n')}

下一步：
  1. 按 reference_note 备齐素材，先 POST /upload/image 传到 ComfyUI input/，重查 object_info 确认文件名出现在 LoadImage.image 枚举里
  2. 写一份素材清单（格式见 agents/prompt-writer/sample_assets.json）：键 = shot_id 或 consistency_group 组名，
     I2V 给 first_frame，R2V 给 ref_images（≤2 张，对应 ref_image_0/1）${assetsPath ? `\n  3. 当前清单 ${rel(assetsPath)} 里补齐上述条目` : '\n  3. 用 --assets <清单路径> 传入'}
  4. 重新运行本命令`);
}

// ——— 离线降级：机械拼装提示词骨架（对应真实输入镜头，未经 LLM 润色） ———

function fallbackTimecodes(duration) {
  const end = Math.max(1, Math.ceil(duration));
  if (end <= 3) return [`[0s-${end}s]`];
  const half = Math.ceil(end / 2);
  return [`[0s-${half}s]`, `[${half}s-${end}s]`];
}

function fallbackPrompt(shot, assets, style) {
  const tcs = fallbackTimecodes(shot.duration_seconds);
  const size = SHOT_SIZE_PHRASE[shot.shot_size] ?? shot.shot_size;
  const move = CAMERA_MOVE_PHRASE[shot.camera_move] ?? shot.camera_move;
  const parts = [];
  if (style) parts.push(style);
  if (shot.workflow_type === 'I2V') {
    parts.push('<Picture 1> provides the first frame; the shot continues from it.');
  } else if (shot.workflow_type === 'R2V') {
    const n = assets?.ref_images?.length ?? 0;
    const refs = Array.from({ length: n }, (_, k) => `<Picture ${k + 1}>`).join(' and ');
    if (refs) parts.push(`${refs} provide the character and scene references, in the order of the shot's reference note.`);
  }
  parts.push(`${tcs[0]} ${size}, ${move}. ${shot.visual_description}`);
  if (tcs[1]) parts.push(`${tcs[1]} the action continues, ${move}, lighting unchanged.`);
  parts.push(`Audio: ${shot.audio_description}`);
  return parts.join(' ');
}

// ——— 组装 c04（确定性字段全部由代码接管） ———

function assembleDoc({ shot, creative, assets, nodeIds, ctx, shotIdx, candIdx, notes }) {
  const candidateId = `${shot.shot_id}_c${String(candIdx).padStart(2, '0')}`;
  const turbo = Boolean(ctx.turbo);
  const steps = turbo ? (shot.workflow_type === 'R2V' ? 4 : 8) : 20;
  const seed = ctx.seedBase + shotIdx * 100 + candIdx;
  if (!Number.isInteger(seed) || seed < 0 || seed > SEED_MAX) {
    throw new Error(`seed 超出契约范围 0–${SEED_MAX}：${seed}（调小 --seed-base 或镜头数）`);
  }
  return {
    envelope: {
      schema_version: '1.0',
      artifact_id: `genreq.${candidateId}.${ctx.stamp}`,
      contract: 'c04_gen_request',
      created_at: new Date().toISOString(),
      producer: { kind: 'agent', name: 'prompt_agent', agent_version: AGENT_VERSION },
      upstream_refs: ctx.shotlistId ? [ctx.shotlistId] : [],
      notes,
    },
    payload: {
      shot_id: shot.shot_id,
      candidate_id: candidateId,
      retry_of: null,
      workflow: {
        type: shot.workflow_type,
        api_json: WORKFLOW_FILE[shot.workflow_type],
        node_ids: nodeIds,
        turbo_enabled: turbo,
      },
      generation: {
        prompt: creative.prompt,
        prompt_language: 'en',
        timecodes: creative.timecodes,
        duration_seconds: shot.duration_seconds,
        seed,
        aspect_ratio: ASPECT_RATIO,
        megapixels: ctx.megapixels,
        multiple: 32,
        fps: 24,
        bit_depth: 8,
        color_space: 'sRGB',
        steps,
        sampler_name: 'res_multistep',
        scheduler: 'simple',
        filename_prefix: `shots/${candidateId}`,
      },
      assets,
    },
  };
}

function assembleAll(perShot, creativeMap, nodeIdsByType, ctx, notes) {
  const docs = [];
  perShot.forEach(({ shot, assets }, shotIdx) => {
    const creative = creativeMap[shot.shot_id];
    for (let candIdx = 1; candIdx <= ctx.candidates; candIdx++) {
      docs.push({
        doc: assembleDoc({ shot, creative, assets, nodeIds: nodeIdsByType[shot.workflow_type], ctx, shotIdx, candIdx, notes }),
        ctx: { shot, assets, allowCjk: ctx.allowCjk },
      });
    }
  });
  return docs;
}

// ——— 结构自检（python 校验器不可用时的兜底；字段与 c04_gen_request 契约一一对应） ———

function checkTimecodes(g, duration, tag) {
  const p = [];
  const tcs = g.timecodes;
  if (!Array.isArray(tcs) || !tcs.length) {
    p.push(`${tag}.generation.timecodes 须为非空数组`);
    return p;
  }
  const end = Math.max(1, Math.ceil(duration));
  let prev = 0;
  for (const tc of tcs) {
    const m = TIMECODE_RE.exec(tc ?? '');
    if (!m) { p.push(`${tag}.timecodes 条目 "${tc}" 不合契约格式 ^[[0-9]+s-[0-9]+s]$`); continue; }
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a !== prev) p.push(`${tag}.timecode ${tc} 与上一段不接（须从 ${prev}s 开始、段段相接不重叠）`);
    if (b <= a) p.push(`${tag}.timecode ${tc} 结束秒须大于开始秒`);
    prev = b;
  }
  if (prev !== end) p.push(`${tag}.timecodes 最后一段须收在 ${end}s（ceil(duration_seconds)=${end}），实际收在 ${prev}s`);
  if (typeof g.prompt === 'string') {
    for (const tc of tcs) if (!g.prompt.includes(tc)) p.push(`${tag}.prompt 里没有逐字出现时间码 ${tc}`);
  }
  return p;
}

function structuralCheck(doc, ctx) {
  const p = [];
  if (!doc || typeof doc !== 'object') return ['产物不是 JSON 对象'];
  if (!doc.envelope || !doc.payload) p.push('缺 envelope/payload 外壳');
  const pl = doc.payload;
  if (!pl) return p;
  const { shot, assets, allowCjk } = ctx;
  const tag = pl.candidate_id || shot.shot_id;

  if (pl.shot_id !== shot.shot_id) p.push(`${tag}.shot_id 须等于镜头清单的 ${shot.shot_id}`);
  if (!/^S[0-9]{3}_c[0-9]{2}$/.test(pl.candidate_id ?? '')) p.push(`${tag}.candidate_id 须形如 ${shot.shot_id}_c01`);
  if (pl.retry_of != null && typeof pl.retry_of !== 'string') p.push(`${tag}.retry_of 须为字符串或 null`);

  const wf = pl.workflow ?? {};
  if (wf.type !== shot.workflow_type) p.push(`${tag}.workflow.type 须等于镜头清单的 ${shot.workflow_type}`);
  if (wf.api_json !== WORKFLOW_FILE[shot.workflow_type]) p.push(`${tag}.workflow.api_json 须为 ${WORKFLOW_FILE[shot.workflow_type]}`);
  if (typeof wf.turbo_enabled !== 'boolean') p.push(`${tag}.workflow.turbo_enabled 须为布尔`);
  const ni = wf.node_ids ?? {};
  if (typeof ni.source !== 'string' || !ni.source.includes('node_id_map.json')) {
    p.push(`${tag}.workflow.node_ids.source 须标明 workflows/node_id_map.json@版本`);
  }
  for (const k of NODE_ID_FIELDS) {
    const e = ni[k];
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || typeof e[1] !== 'string') {
      p.push(`${tag}.node_ids.${k} 须为 [节点ID, 键名] 两元组`);
    }
  }

  const g = pl.generation ?? {};
  if (typeof g.prompt !== 'string' || g.prompt.length < 30) p.push(`${tag}.generation.prompt 缺失或少于 30 字符`);
  if (g.prompt_language !== 'en') p.push(`${tag}.generation.prompt_language 须为常量 "en"`);
  p.push(...checkTimecodes(g, shot.duration_seconds, tag));
  if (g.duration_seconds !== shot.duration_seconds) {
    p.push(`${tag}.generation.duration_seconds 须等于镜头清单的 ${shot.duration_seconds}（写秒不写帧）`);
  }
  if (!Number.isInteger(g.seed) || g.seed < 0 || g.seed > SEED_MAX) p.push(`${tag}.generation.seed 须为 0–${SEED_MAX} 的整数`);
  if (g.aspect_ratio !== ASPECT_RATIO) p.push(`${tag}.generation.aspect_ratio 须为常量 "${ASPECT_RATIO}"`);
  if (!(typeof g.megapixels === 'number' && g.megapixels >= 0.1 && g.megapixels <= 16)) p.push(`${tag}.generation.megapixels 须在 0.1–16`);
  if (g.multiple !== 32) p.push(`${tag}.generation.multiple 须为 32（模板默认）`);
  if (g.fps !== 24) p.push(`${tag}.generation.fps 须为常量 24`);
  if (g.bit_depth !== 8 && g.bit_depth !== 10 && g.bit_depth !== 'auto') p.push(`${tag}.generation.bit_depth 须为 auto / 8 / 10`);
  if (g.color_space !== 'sRGB' && g.color_space !== 'HDR' && g.color_space !== 'HDR PQ') p.push(`${tag}.generation.color_space 须为 sRGB / HDR / HDR PQ`);
  const wantSteps = wf.turbo_enabled ? (shot.workflow_type === 'R2V' ? 4 : 8) : 20;
  if (g.steps !== wantSteps) p.push(`${tag}.generation.steps 须为 ${wantSteps}（turbo_enabled=${Boolean(wf.turbo_enabled)}）`);
  if (g.sampler_name !== 'res_multistep') p.push(`${tag}.generation.sampler_name 须为常量 "res_multistep"`);
  if (g.scheduler !== 'simple') p.push(`${tag}.generation.scheduler 须为常量 "simple"`);
  if (g.filename_prefix !== `shots/${pl.candidate_id}` || !new RegExp(`^shots/${shot.shot_id}_c[0-9]{2}$`).test(g.filename_prefix ?? '')) {
    p.push(`${tag}.generation.filename_prefix 须为 "shots/${pl.candidate_id}"（每候选独立前缀，否则产物挤在一起无法归档）`);
  }

  // <Picture N> 约定：I2V 首帧 = <Picture 1>；R2V 按 ref_image_0/1 顺序 = <Picture 1>/<Picture 2>；T2V 禁止
  const refCount = shot.workflow_type === 'R2V' ? (assets?.ref_images?.length ?? 0)
    : shot.workflow_type === 'I2V' ? (assets?.first_frame ? 1 : 0) : 0;
  if (typeof g.prompt === 'string') {
    if (refCount === 0 && g.prompt.includes('<Picture')) p.push(`${tag} 是 T2V，prompt 里不许出现 <Picture 引用`);
    for (let k = 1; k <= refCount; k++) {
      if (!g.prompt.includes(`<Picture ${k}>`)) p.push(`${tag}.prompt 缺 <Picture ${k}> 引用（对应 ${shot.workflow_type === 'I2V' ? 'first_frame' : `ref_image_${k - 1}`}）`);
    }
    if (!allowCjk && CJK_RE.test(g.prompt)) p.push(`${tag}.prompt 须为英文（画外音中文台词除外，须放在引号内）`);
  }

  const a = pl.assets ?? {};
  if (shot.workflow_type === 'T2V') {
    if (a.first_frame || a.ref_images?.length || a.ref_videos?.length || a.ref_audios?.length) {
      p.push(`${tag} 是 T2V，assets 必须为空（契约 allOf：T2V 不该带任何素材）`);
    }
  } else if (shot.workflow_type === 'I2V') {
    p.push(...checkAssetRef(a.first_frame, `${tag}.assets.first_frame`, []));
  } else {
    if (!Array.isArray(a.ref_images) || !a.ref_images.length) p.push(`${tag}.assets.ref_images 必填且至少 1 张（R2V）`);
    else (Array.isArray(a.ref_images) ? a.ref_images : []).forEach((r, i) => p.push(...checkAssetRef(r, `${tag}.assets.ref_images[${i}]`, [])));
    if (a.ref_image_size !== undefined && !['match', 'max'].includes(a.ref_image_size)) p.push(`${tag}.assets.ref_image_size 须为 match / max`);
  }
  return p;
}

/** 跨候选一致性：seed / candidate_id / artifact_id 全局唯一（ComfyUI 会缓存完全相同的输入）。 */
function crossCheck(entries) {
  const p = [];
  const seeds = new Map();
  const cands = new Set();
  for (const { doc } of entries) {
    const { seed } = doc.payload.generation;
    const { candidate_id: cid } = doc.payload;
    if (seeds.has(seed)) p.push(`seed 冲突：${cid} 与 ${seeds.get(seed)} 同为 ${seed}（同种子+同提示词=同结果，多候选必须换种子）`);
    else seeds.set(seed, cid);
    if (cands.has(cid)) p.push(`candidate_id 重复：${cid}`);
    else cands.add(cid);
  }
  return p;
}

// ——— LLM：一次调用产出全部镜头的创作部分，结构不过回灌纠正一轮 ———

function describeAssets(shot, assets) {
  if (shot.workflow_type === 'T2V') return `- ${shot.shot_id}（T2V）：无参考素材，prompt 禁止出现 <Picture 引用`;
  if (shot.workflow_type === 'I2V') return `- ${shot.shot_id}（I2V）：已接首帧 <Picture 1>；首帧来源：${shot.reference_note || '（分镜未注明）'}`;
  const n = assets?.ref_images?.length ?? 0;
  const refs = Array.from({ length: n }, (_, k) => `<Picture ${k + 1}>`).join('、');
  return `- ${shot.shot_id}（R2V）：已接 ${n} 张参考图 ${refs}；各图语义按 reference_note 顺序对应：${shot.reference_note || '（分镜未注明）'}`;
}

function checkIntermediate(raw, perShot) {
  const problems = [];
  const list = raw?.shots ?? (raw?.payload?.shots ?? null);
  if (!Array.isArray(list) || !list.length) return { map: null, problems: ['输出缺少 shots 数组（中间形状：{ "shots": [{ "shot_id", "prompt", "timecodes" }] }）'] };
  const map = {};
  for (const item of list) {
    if (!item?.shot_id) { problems.push('shots 里有条目缺 shot_id'); continue; }
    if (map[item.shot_id]) problems.push(`shot_id ${item.shot_id} 出现了不止一次`);
    map[item.shot_id] = item;
    if (typeof item.prompt !== 'string' || item.prompt.length < 30) problems.push(`${item.shot_id}.prompt 缺失或少于 30 字符`);
    if (!Array.isArray(item.timecodes)) problems.push(`${item.shot_id}.timecodes 须为数组`);
  }
  for (const { shot } of perShot) {
    if (!map[shot.shot_id]) problems.push(`缺 ${shot.shot_id} 的提示词（输入的每个镜头都要有且只有一条）`);
  }
  const want = new Set(perShot.map(({ shot }) => shot.shot_id));
  for (const id of Object.keys(map)) {
    if (!want.has(id)) problems.push(`${id} 不在镜头清单里，不许发明镜头`);
  }
  return { map: problems.length ? null : map, problems };
}

async function callLlm(shotlistDoc, perShot, opts) {
  const { model, style, nodeIdsByType, ctx } = opts;
  const shotlistId = shotlistDoc.envelope?.artifact_id;
  const chatOpts = model ? { model } : {};
  const slim = perShot.map(({ shot }) => ({
    shot_id: shot.shot_id, duration_seconds: shot.duration_seconds, shot_size: shot.shot_size,
    camera_move: shot.camera_move, visual_description: shot.visual_description,
    audio_description: shot.audio_description, workflow_type: shot.workflow_type,
    consistency_group: shot.consistency_group ?? null, reference_note: shot.reference_note ?? '',
  }));
  const styleLine = style
    ? `全片风格锚点（每条 prompt 以它原样开头）：${style}`
    : '未提供全片风格锚点，请自拟统一的写实电影质感开场句，各镜头保持一致。';
  const messages = [
    { role: 'system', content: PROMPT_WRITER },
    {
      role: 'user',
      content: `镜头清单（c03_shotlist，artifact_id=${shotlistId}，共 ${slim.length} 镜）：
${JSON.stringify(slim, null, 2)}

各镜头已接入的参考素材（<Picture N> 序号即接线顺序，写错序号等于指错图）：
${perShot.map(({ shot, assets }) => describeAssets(shot, assets)).join('\n')}

${styleLine}

请按 system prompt 的中间形状只输出一个 JSON 代码块。`,
    },
  ];

  const attempt = (text) => {
    const { map, problems } = checkIntermediate(extractJson(text), perShot);
    if (problems.length) return { entries: null, problems };
    const entries = assembleAll(perShot, map, nodeIdsByType, { ...ctx, allowCjk: false }, 'LLM 生成');
    return { entries, problems: entries.flatMap(({ doc, ctx: c }) => structuralCheck(doc, c)) };
  };

  let text = await chat(messages, chatOpts);
  let first;
  try {
    first = attempt(text);
    if (!first.problems.length) return { entries: first.entries, retried: false };
  } catch (e) {
    first = { problems: [e.message] };
  }
  messages.push({ role: 'assistant', content: text });
  messages.push({
    role: 'user',
    content: `上一轮输出未通过结构校验（问题定位到镜头/候选）：\n- ${first.problems.join('\n- ')}\n请按契约重新输出修正后的完整 JSON（仍只输出一个 JSON 代码块，覆盖全部镜头）。`,
  });
  text = await chat(messages, chatOpts);
  const second = attempt(text); // 解析失败直接抛，由调用方降级
  if (second.problems.length) {
    throw new LlmError(`纠正一轮后仍未通过结构校验：\n- ${second.problems.join('\n- ')}`);
  }
  return { entries: second.entries, retried: true };
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

// ——— 主流程 ———

/**
 * 提示词 Agent 主流程（可编程调用；CLI 只是它的一层壳）。
 * 返回 { shotlistPath, outDir, files, docs, usedFallback, shapeCheck }。
 */
export async function runPromptWriter(options = {}) {
  const log = options.log ?? ((m) => console.log(m));
  const warnings = [];
  const stamp = makeStamp(new Date());

  // 1) 镜头清单：必须给定 c03 文件
  if (!options.shotlist) throw new UsageError('缺少必填输入 --shotlist <c03_shotlist JSON 路径>，见 --help');
  const shotlistPath = resolve(options.shotlist);
  const { doc: shotlistDoc, wrapped } = loadShotlistFile(shotlistPath);
  const shots = shotlistDoc.payload.shots;
  if (!Array.isArray(shots) || !shots.length) throw new Error(`${rel(shotlistPath)} 的 payload.shots 为空，没有可翻译的镜头`);
  const ids = new Set(shots.map((s) => s.shot_id));
  if (ids.size !== shots.length) throw new Error(`${rel(shotlistPath)} 的 payload.shots 里 shot_id 有重复，先修上游`);
  log(`[提示词] 上游镜头清单：${rel(shotlistPath)}（artifact_id=${shotlistDoc.envelope?.artifact_id ?? '未知'}，${shots.length} 镜）`);

  // 2) 上游契约校验：c03 不过就不开工（裸 payload 用补壳后的临时副本校验；c03 无强制人工关口）
  if (options.validate !== false) {
    let tmp = null;
    if (wrapped) {
      tmp = join(tmpdir(), `loom_c03_${process.pid}_${Date.now()}.json`);
      writeFileSync(tmp, JSON.stringify(shotlistDoc, null, 2), 'utf8');
    }
    let r;
    try {
      r = pythonValidate(tmp ?? shotlistPath, 'c03_shotlist');
    } finally {
      if (tmp) rmSync(tmp, { force: true });
    }
    if (r === null) log('[提示词] 警告：未找到可用的 python/jsonschema，跳过上游镜头清单契约校验');
    else if (r.code === 1) throw new Error(`上游镜头清单未通过 c03_shotlist 契约校验，③提示词 拒绝开工：\n${r.out}`);
    else if (r.code !== 0) log(`[提示词] 警告：上游镜头清单校验未执行（退出码 ${r.code}）：\n${r.out}`);
  }

  // 3) 参数与节点 ID 映射（禁止硬编码节点 ID，一律现查 workflows/node_id_map.json）
  const candidates = options.candidates ?? shotlistDoc.payload.batch_plan?.candidates_per_shot ?? 3;
  if (!Number.isInteger(candidates) || candidates < 1 || candidates > 8) {
    throw new Error(`每镜头候选数须为 1–8 的整数（batch_plan.candidates_per_shot=${candidates}），可用 --candidates 覆盖`);
  }
  const megapixels = options.megapixels ?? 0.4;
  const seedBase = options.seedBase ?? 1000;
  const turbo = Boolean(options.turbo);
  const { map, source } = loadNodeIdMap();
  const nodeIdsByType = { T2V: buildNodeIds(map, 'T2V', source), I2V: buildNodeIds(map, 'I2V', source), R2V: buildNodeIds(map, 'R2V', source) };
  log(`[提示词] 节点 ID 映射：${source}（T2V/I2V/R2V 三套已就位）`);
  if (megapixels < 1.0) warnings.push(`megapixels=${megapixels}（约 480p，试错档）；成片批次应调 --megapixels 1.0 才是 H3 标称 768p`);
  if (turbo) warnings.push('turbo_enabled=true：FL2VA 8 步 / Ref2VA 4 步，提速换质量，成片批次慎用');

  // 4) 素材位：I2V/R2V 缺素材直接阻塞，不烧 LLM 也不烧 GPU
  const manifest = options.assets ? loadAssetsManifest(resolve(options.assets)) : null;
  const resolved = resolveAssets(shots, manifest);
  warnings.push(...resolved.warnings);
  if (resolved.problems.length) throw new Error(`素材清单不合法：\n- ${resolved.problems.join('\n- ')}`);
  if (resolved.missing.length) throw missingAssetsError(resolved.missing, options.assets ? resolve(options.assets) : null);
  const needAssets = shots.filter((s) => s.workflow_type !== 'T2V').length;
  if (needAssets) log(`[提示词] 素材清单已解析：${needAssets} 个 I2V/R2V 镜头的素材位全部就位`);

  const ctx = {
    stamp,
    shotlistId: shotlistDoc.envelope?.artifact_id || 'shotlist.unknown',
    candidates, megapixels, seedBase, turbo,
  };

  // 5) 创作部分：LLM → 纠正重试 → 失败降级机械拼装骨架（README 约定：保证流水线照常出片）
  let entries;
  let usedFallback = '';
  const cfg = llmConfig(options.model ? { model: options.model } : {});
  if (options.offline) {
    usedFallback = '按 --offline 要求不调用 LLM';
  } else if (!cfg.apiKey) {
    usedFallback = '未配置 LLM API Key';
  } else {
    try {
      const r = await callLlm(shotlistDoc, resolved.perShot, { model: options.model, style: options.style, nodeIdsByType, ctx });
      log(`[提示词] LLM 生成成功（model=${cfg.model}${r.retried ? '，含一轮纠正重试' : ''}）`);
      entries = r.entries;
    } catch (e) {
      usedFallback = `LLM 调用失败：${e.message}`;
    }
  }
  if (usedFallback) {
    log(`[提示词] ${usedFallback}，降级为机械拼装提示词骨架（内容对应输入镜头，未经润色，交 ④生成 前建议人工复核或配好 LLM 重跑）`);
    const creativeMap = {};
    for (const { shot, assets } of resolved.perShot) {
      creativeMap[shot.shot_id] = { prompt: fallbackPrompt(shot, assets, options.style), timecodes: fallbackTimecodes(shot.duration_seconds) };
    }
    entries = assembleAll(resolved.perShot, creativeMap, nodeIdsByType, { ...ctx, allowCjk: true }, `${usedFallback}；提示词为机械拼装骨架，需人工复核`);
  }

  // 6) 终检（逐候选结构自检 + 跨候选 seed/candidate_id 唯一性）
  const problems = entries.flatMap(({ doc, ctx: c }) => structuralCheck(doc, c));
  problems.push(...crossCheck(entries));
  if (problems.length) throw new Error(`最终产物未通过结构自检：\n- ${problems.join('\n- ')}`);
  for (const { doc } of entries) {
    if (CJK_RE.test(doc.payload.generation.prompt)) {
      warnings.push(`${doc.payload.candidate_id}：prompt 含中文字符（画外音台词引原文可以，其余请复核）`);
      break; // 机械拼装骨架全含中文，只提醒一次
    }
  }

  // 7) 落盘：每候选一份 c04 文件 + 逐份权威校验
  const outDir = options.outDir ? resolve(options.outDir) : join(REPO_ROOT, 'artifacts', `genreq_${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const files = [];
  let shapeCheck = null;
  for (const { doc } of entries) {
    const file = join(outDir, `${doc.payload.candidate_id}.json`);
    writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    files.push(file);
    if (options.validate !== false) {
      const r = pythonValidate(file, 'c04_gen_request');
      if (r === null) {
        if (shapeCheck === null) { shapeCheck = null; log('[提示词] 警告：未找到可用的 python/jsonschema，只做了 JS 结构自检；提交前请手动跑 contracts/validate_contract.py'); }
      } else if (r.code === 1) {
        throw new Error(`${rel(file)} 未通过 c04_gen_request 契约校验：\n${r.out}`);
      } else if (r.code !== 0) {
        log(`[提示词] 警告：${rel(file)} 契约校验未执行（退出码 ${r.code}）：\n${r.out}`);
      } else {
        shapeCheck = { code: 0 };
      }
    }
  }
  if (options.validate !== false && shapeCheck?.code === 0) log(`[提示词] ${files.length} 份 c04_gen_request 全部通过契约结构校验`);
  for (const w of [...new Set(warnings)]) log(`[提示词] 警告：${w}`);

  const count = (t) => shots.filter((s) => s.workflow_type === t).length;
  log(`[提示词] 已落盘 ${files.length} 份生成请求：${rel(outDir)}/`);
  log(`[提示词] ${shots.length} 镜 × ${candidates} 候选 ｜ T2V ${count('T2V')} · I2V ${count('I2V')} · R2V ${count('R2V')} ｜ megapixels=${megapixels} · turbo=${turbo} · seed 基数 ${seedBase}`);

  return { shotlistPath, outDir, files, docs: entries.map((e) => e.doc), usedFallback: Boolean(usedFallback), shapeCheck };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[提示词] ${e.message}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) { usage(); return; }
  try {
    const result = await runPromptWriter(args);
    const firstPayload = result.docs[0]?.payload;
    console.log(`[提示词] 完成：
  上游镜头清单（c03_shotlist）：  ${rel(result.shotlistPath)}
  生成请求（c04_gen_request）：   ${rel(result.outDir)}/（每候选一份，共 ${result.files.length} 份）${result.usedFallback ? '\n  注意：本次提示词为离线机械拼装骨架，仅形状合规，交 ④生成 前请人工复核或配好 LLM 后重跑' : ''}
  示例：${rel(result.files[0])}（shot_id=${firstPayload.shot_id} seed=${firstPayload.generation.seed} prefix=${firstPayload.generation.filename_prefix}）

[提示词] 下一步——交给 ④生成 Agent：
  1. 按镜头清单 batch_plan 排 GPU 队列：FL2VA 批（T2V+I2V）连跑，Ref2VA 批（R2V）单独时段，别交替（重载 21GB+ 权重，见 docs/gpu_protocol.md）
  2. POST 前把 assets 里的 node_filename 逐个 POST /upload/image 上传，重查 object_info 确认在 LoadImage.image 枚举里
  3. 同镜头各候选 seed 已互不相同——ComfyUI 会缓存完全相同的输入，0 秒返回旧文件，不要改回同 seed
  4. ④生成 消费每份 c04 产出 c05_gen_result（参数快照 + 产物哈希从第一个镜头就要记）`);
  } catch (e) {
    console.error(`[提示词] ${e.message}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
