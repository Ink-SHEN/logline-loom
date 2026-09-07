// agents/qa/vision.js — 主观项的「看得见」通道：用 ffmpeg 抽帧，把帧交给视觉模型判。
//
// 为什么需要这一层：⑤质检 的 13 项里有 7 项是主观项（提示词遵循度、角色/场景一致性、运动质量、
// 音画匹配、画面崩坏、片约红线）。默认接的 Qwen2.5-72B-Instruct 是纯文本模型，它没看过画面，
// 让它判 prompt_adherence 等于让它编——编出来的 pass 比 skipped 危险得多，因为它会被当成证据。
// 所以主观项只有三个合法来源，优先级从高到低：
//   1. --review 侧清单（人工看过，或外部视觉模型看过后填的结论）
//   2. --vision（本文件：抽帧 + 视觉模型，模型名走 LOOM_LLM_VISION_MODEL）
//   3. skipped（未复核），再由 --on-unreviewed 决定是转人工还是放行进剪辑
// 纯文本 LLM 只被允许判 no_red_line_violation——那一项比的是提示词/分镜描述与片约红线的文字，
// 不需要看画面，是真的能判的。
//
// ffmpeg 与 ffprobe 一样属于外部依赖：没有就明确报缺，不静默降级成「文本模型猜画面」。

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export class VisionError extends Error {
  constructor(message, { available = true } = {}) {
    super(message);
    this.name = 'VisionError';
    this.available = available;
  }
}

let cachedBinary;

export function findFfmpeg(preferred) {
  if (cachedBinary !== undefined && !preferred) return cachedBinary;
  const cmd = preferred || 'ffmpeg';
  const r = spawnSync(cmd, ['-version'], { encoding: 'utf8', timeout: 20_000 });
  const ok = !r.error && r.status === 0;
  if (!preferred) cachedBinary = ok ? cmd : null;
  return ok ? cmd : null;
}

const NOT_INSTALLED = `本机没有可用的 ffmpeg，--vision 抽不了帧。

装上再跑（三选一）：
  Windows   winget install Gyan.FFmpeg        或  scoop install ffmpeg
  macOS     brew install ffmpeg
  Ubuntu    sudo apt-get install ffmpeg

不想装也行，主观项另有两个合法来源：
  --review <侧清单>   人工（或外部视觉模型）看过之后按 agents/qa/sample_review.json 的格式填结论
  什么都不给          主观项记 skipped，由 --on-unreviewed human|edit 决定转人工还是放行`;

/**
 * 等间隔抽帧。取每段中点而不是段首，避免整片抽到同一动作的前半截。
 * 返回 [{ index, atSeconds, path, bytes }]。
 */
export function extractFrames(videoPath, { count = 4, durationSeconds, binary, quality = 3 } = {}) {
  const cmd = binary || findFfmpeg();
  if (!cmd) throw new VisionError(NOT_INSTALLED, { available: false });
  if (!(count >= 1)) throw new VisionError(`抽帧数须 ≥ 1，收到 ${count}`);
  if (!(durationSeconds > 0)) throw new VisionError(`抽帧需要产物时长（c05.ffprobe.duration_seconds 是契约必填），收到 ${durationSeconds}`);
  const dir = join(tmpdir(), `loom_frames_${process.pid}_${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const frames = [];
  try {
    for (let i = 0; i < count; i++) {
      const at = Math.round(durationSeconds * ((i + 0.5) / count) * 1000) / 1000;
      const out = join(dir, `f${String(i).padStart(2, '0')}.jpg`);
      const r = spawnSync(cmd, ['-v', 'error', '-y', '-ss', String(at), '-i', videoPath, '-frames:v', '1', '-q:v', String(quality), out], {
        encoding: 'utf8',
        timeout: 120_000,
      });
      if (r.error) throw new VisionError(`调用 ffmpeg 失败：${r.error.message}`);
      if (r.status !== 0 || !existsNonEmpty(out)) {
        throw new VisionError(`第 ${i + 1} 帧（t=${at}s）抽取失败：${((r.stderr || '') + (r.stdout || '')).trim().slice(0, 400)}`);
      }
      const buf = readFileSync(out);
      frames.push({ index: i, atSeconds: at, path: out, bytes: buf.length, base64: buf.toString('base64') });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true }); // 帧只是过路的中间产物，不留档（留档的是 c06 里的判定与 detail）
  }
  return frames;
}

function existsNonEmpty(p) {
  try {
    return readFileSync(p).length > 0;
  } catch {
    return false;
  }
}

/** 帧 → OpenAI 视觉格式的 content 分段数组（chat() 原样透传，不需要改 llm.js）。 */
export function framesToContent(text, frames) {
  const parts = [{ type: 'text', text }];
  for (const f of frames) {
    parts.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${f.base64}` },
    });
  }
  return parts;
}

/** 抽帧位置的描述，写进 c06 的 detail 里，让「模型看了哪几帧」也是可追溯的。 */
export function describeFrames(frames) {
  return frames.map((f) => `t=${f.atSeconds}s`).join('、');
}
