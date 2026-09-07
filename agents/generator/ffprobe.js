// agents/generator/ffprobe.js — 产物硬指标测量（④生成 落 c05 前必经的一步）。
//
// 为什么这一步不许 LLM 参与、也不许估算：c05.ffprobe 是契约必填字段，而且是 ⑤质检 客观项
// （duration_in_range / fps_is_24 / has_video_stream / has_audio_stream / audio_32k_stereo /
// resolution_matches_aspect_ratio）的唯一数据来源。填估算值等于让整条质检链失去证据基础——
// 所以本机没有 ffprobe 时 ④生成 直接阻塞，不降级、不编数（agents/qa 侧才有降级，因为它读的是 c05 里已有的实测值）。
//
// 原始输出也要留档：shots/<candidate_id>/ffprobe.txt 存 ffprobe 的完整 JSON，
// 契约里那份只是从中摘出来的字段，事后有争议以原文为准（.gitignore 已显式放行 shots/**/ffprobe.txt）。

import { spawnSync } from 'node:child_process';

export class FfprobeError extends Error {
  constructor(message, { available = true } = {}) {
    super(message);
    this.name = 'FfprobeError';
    this.available = available;
  }
}

let cachedBinary;

/** 找一个能跑的 ffprobe。显式指定优先，其次 PATH 上的 ffprobe。返回命令名或 null。 */
export function findFfprobe(preferred) {
  if (cachedBinary !== undefined && !preferred) return cachedBinary;
  const candidates = preferred ? [preferred] : ['ffprobe'];
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ['-version'], { encoding: 'utf8', timeout: 20_000 });
    if (!r.error && r.status === 0) {
      if (!preferred) cachedBinary = cmd;
      return cmd;
    }
  }
  if (!preferred) cachedBinary = null;
  return null;
}

const NOT_INSTALLED = `本机没有可用的 ffprobe，④生成 拒绝落 c05。

c05.ffprobe 是契约必填字段，也是 ⑤质检 全部客观项的数据来源；用估算值或 0 填进去，
整条质检链就只剩一份编造的证据，等于把 ⑤ 变成走过场。所以这里硬阻塞，不降级。

装上再跑（三选一）：
  Windows   winget install Gyan.FFmpeg        或  scoop install ffmpeg
  macOS     brew install ffmpeg
  Ubuntu    sudo apt-get install ffmpeg
装完确认：ffprobe -version
只想看提交计划、不碰 GPU 也不落 c05：加 --dry-run`;

/**
 * 跑 ffprobe，返回 { raw, data, contract, frameCount, nbFrames }。
 * raw 是原始 JSON 文本（原样存进 shots/<cid>/ffprobe.txt），contract 是 c05.ffprobe 的形状。
 */
export function probeVideo(filePath, { binary } = {}) {
  const cmd = binary || findFfprobe();
  if (!cmd) throw new FfprobeError(NOT_INSTALLED, { available: false });
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath];
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw new FfprobeError(`调用 ffprobe 失败：${r.error.message}`);
  if (r.status !== 0) {
    throw new FfprobeError(`ffprobe 退出码 ${r.status}：${((r.stderr || '') + (r.stdout || '')).trim().slice(0, 500)}`);
  }
  const raw = r.stdout || '';
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new FfprobeError(`ffprobe 输出不是合法 JSON：${e.message}`);
  }
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1) ?? null;
  const audio = streams.find((s) => s.codec_type === 'audio') ?? null;
  const contract = toContractShape({ video, audio, format: data.format });
  const frameCount = countFrames({ video, contract });
  return {
    raw: raw.trim() + '\n',
    data,
    contract,
    frameCount: frameCount.measured,
    nbFrames: frameCount.nbFrames,
    frameCountSource: frameCount.source,
    streamsCount: streams.length,
  };
}

function num(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** 解析 "24/1" / "24000/1001" 这种分数帧率。解析不出返回 null。 */
export function parseRate(rate) {
  if (typeof rate !== 'string' || !rate.trim() || rate === '0/0') return null;
  const parts = rate.split('/');
  const a = Number(parts[0]);
  if (!Number.isFinite(a) || a === 0) return null;
  if (parts.length === 1) return a;
  const b = Number(parts[1]);
  if (!Number.isFinite(b) || b === 0) return null;
  return a / b;
}

/** ffprobe 原始输出 → 契约 #/$defs/ffprobe_result 的形状。缺视频流就抛，缺音频流记 null（由 ⑤ 判不合格）。 */
export function toContractShape({ video, audio, format }) {
  if (!video) {
    throw new FfprobeError(`产物里没有视频流（ffprobe 报 ${format?.format_name ?? '未知'} 格式，共 ${format ? '有' : '无'} format 段）——ComfyUI 可能只落了音频或落了空文件`);
  }
  const duration = num(format?.duration) ?? num(video.duration) ?? num(audio?.duration);
  if (duration === null || duration <= 0) {
    throw new FfprobeError(`产物时长测不出来（format.duration=${format?.duration}，video.duration=${video.duration}）——文件可能没写完或被截断`);
  }
  const width = num(video.width);
  const height = num(video.height);
  const out = {
    duration_seconds: Math.round(duration * 1000) / 1000,
    video_stream: {
      codec_name: String(video.codec_name ?? 'unknown'),
      width: width === null ? 0 : Math.round(width),
      height: height === null ? 0 : Math.round(height),
      avg_frame_rate: String(video.avg_frame_rate ?? '0/0'),
    },
    audio_stream: null,
  };
  if (!width || !height) throw new FfprobeError(`产物视频流缺宽高（width=${video.width} height=${video.height}）`);
  if (audio) {
    out.audio_stream = {
      codec_name: String(audio.codec_name ?? 'unknown'),
      sample_rate: String(audio.sample_rate ?? '0'),
      channels: Math.round(num(audio.channels) ?? 0),
    };
  }
  return out;
}

/**
 * 真实帧数：优先 nb_frames（mp4 容器一般带），其次 nb_read_frames（要 -count_frames，慢，不默认跑），
 * 最后按 时长×帧率 推算并在 source 里标明是推算的。
 * c05 的 frame_count_actual 是可选字段，记推算值不算造假，但来源要写清楚。
 */
export function countFrames({ video, contract }) {
  const nb = num(video?.nb_frames);
  if (nb !== null && nb > 0) return { measured: Math.round(nb), nbFrames: Math.round(nb), source: 'nb_frames' };
  const read = num(video?.nb_read_frames);
  if (read !== null && read > 0) return { measured: Math.round(read), nbFrames: Math.round(read), source: 'nb_read_frames' };
  const fps = parseRate(contract.video_stream.avg_frame_rate);
  if (fps) {
    return { measured: Math.round(contract.duration_seconds * fps), nbFrames: null, source: 'duration_x_fps（推算，容器没写 nb_frames）' };
  }
  return { measured: null, nbFrames: null, source: '无法确定（容器没有 nb_frames，avg_frame_rate 也解析不出）' };
}

/** 把 ffprobe 结果讲成人话，用于命令行输出与登记表备注。 */
export function describeProbe(contract, frameCount, frameCountSource) {
  const v = contract.video_stream;
  const a = contract.audio_stream;
  const fps = parseRate(v.avg_frame_rate);
  const parts = [
    `${v.width}x${v.height}`,
    `${fps === null ? v.avg_frame_rate : Math.round(fps * 100) / 100} fps`,
    `${contract.duration_seconds}s`,
    frameCount === null ? '帧数未知' : `${frameCount} 帧（${frameCountSource}）`,
    v.codec_name,
  ];
  parts.push(a ? `音频 ${a.codec_name} ${a.sample_rate}Hz ${a.channels}ch` : '无音频流');
  return parts.join(' ｜ ');
}
