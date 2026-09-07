// agents/qa/sample.js — 「⑤质检」示例产物（最终 c06 形状的活文档）。
//
// ⑤质检 没有「离线降级编一份」这回事，理由和 ④生成 一样：
// c06 是一份判定书，没跑过的检查写成 pass 就是伪造判决，下游会照着它决定要不要再烧一轮 GPU。
// 所以 --offline 不编 pass，它只把没人看过的主观项老实记 skipped（未复核），再按 --on-unreviewed 分流。
// 本文件的作用是：
//   1. c06_qc_report 输出形状的活文档；
//   2. ⑥重试 与 ⑦剪辑 mock 上游时的现成输入：sampleQA 是 pass_with_notes/转剪辑，
//      sampleQAFail 是 fail/转重试，分别对应 agents/generator/sample.js 的
//      sampleGenResult（S001_c01）与 sampleGenResultNoAudio（S002_c01）；
//   3. tools/samples.js 入库后由它再导出。
//
// 这两份不是手写的，是 runQa 真跑出来的，只把 created_at 换成了固定值。复现：
//   node agents/qa/run.js --candidates S001_c01,S002_c01 --shots-root <夹具>/shots \
//     --requests <夹具>/genreq --review agents/qa/sample_review.json --offline --out-dir <夹具>/out
// 夹具里 shots/<候选>/meta.json 就是上面那两份 c05，genreq/ 是与它们 params_snapshot 对齐的 c04。
// 换任何一个输入，下面这些 detail 文本都会跟着变——它们是代码算出来的，不是措辞。
//
// 三处容易被当成 bug 的地方，都不是：
//   · envelope.notes 写着「产物不在本地，未校 sha256」。视频不入库（见 shots/README.md），
//     跑夹具时 mp4 确实不在。产物在本地且本机有 ffprobe 时，这一段会是
//     「客观项数据来源：c05（已重测对账一致）」——sha256 与重测都对上才敢说这句话。
//   · sampleQAFail 的 score 是 3 不是 3.0。JSON 没有「一位小数」这种类型，
//     JSON.stringify(3.0) === "3"。prompt.js 里那句「一位小数」是写给模型看的口径，不是序列化结果。
//   · created_at 是 UTC 的 Z 格式（代码用 new Date().toISOString()），而 contracts/examples.json
//     里手写的是 +08:00。两者都满足 format: date-time，本站也从不解析它，不要为了统一去改。

export const sampleQA = `{
  "envelope": {
    "schema_version": "1.0",
    "artifact_id": "qc.S001_c01",
    "contract": "c06_qc_report",
    "created_at": "2026-09-08T02:22:00.000Z",
    "producer": { "kind": "agent", "name": "qc_agent", "agent_version": "0.1.0" },
    "upstream_refs": ["genres.S001_c01", "genreq.S001_c01"],
    "notes": "客观项数据来源：c05（产物不在本地，未校 sha256）；主观项通道：review；复核人：组员A"
  },
  "payload": {
    "shot_id": "S001",
    "candidate_id": "S001_c01",
    "verdict": "pass_with_notes",
    "score": 7.5,
    "checks": [
      { "name": "duration_in_range", "status": "pass", "detail": "设定 6s，实测 6.083s，差 0.083s ≤ 0.75s（一个 17 帧对齐步长）", "measured": "6.083" },
      { "name": "fps_is_24", "status": "pass", "measured": "24/1 = 24fps" },
      { "name": "has_video_stream", "status": "pass", "measured": "h264 848x480" },
      { "name": "has_audio_stream", "status": "pass", "measured": "aac 32000Hz 2ch" },
      { "name": "audio_32k_stereo", "status": "pass", "detail": "符合 H3 标称 32kHz 立体声", "measured": "32000Hz 2ch" },
      { "name": "resolution_matches_aspect_ratio", "status": "pass", "detail": "848x480 ≈ 1.767:1，megapixels 0.407", "measured": "848x480" },
      { "name": "prompt_adherence", "status": "pass", "detail": "空镜、冷蓝辉光、缓慢推镜三项均与提示词一致；[3s-6s] 段的琥珀色待机灯确实出现在中央控制台", "measured": "全片" },
      { "name": "character_consistency", "status": "pass", "detail": "无可比对象：本镜是空镜，T2V 也没挂参考图。已确认画面里没有多出提示词未要求的人物——空镜里冒出一张脸是最容易穿帮的地方", "measured": "全片" },
      { "name": "scene_consistency", "status": "pass", "detail": "与 control_room 组其余镜头色调一致，光源方向同为左后侧" },
      { "name": "motion_quality", "status": "pass", "detail": "推镜平滑无抖动，无物体形变" },
      { "name": "audio_matches_scene", "status": "pass", "detail": "低频电气嗡鸣与远处风扇声存在，无人声，与空镜设定相符" },
      { "name": "no_visual_artifact", "status": "fail", "detail": "第 4 秒右下角监控屏幕出现轻微纹理撕裂，边缘有 2–3 像素横向错位；其余时间画面干净", "measured": "t=4.0s 右下角" },
      { "name": "no_red_line_violation", "status": "pass", "detail": "逐条比对片约 red_lines 无命中" }
    ],
    "failed_items": ["no_visual_artifact"],
    "root_cause": "megapixels=0.4 分辨率偏低导致细小屏幕纹理不稳定，属预期范围",
    "suggested_change": {
      "action": "raise_megapixels",
      "patch": { "megapixels": 1 },
      "rationale": "画面伪影出现在 megapixels=0.4（试错档约 480p）——细小纹理在这个分辨率下本来就不稳定，换种子只是换一个同样糊的采样。先按 H3 标称的 1.0 复核一次，再决定要不要换种子"
    },
    "retry_count": 0,
    "max_retries": 3,
    "route_to": "edit",
    "gate": { "required": false, "status": "not_required" }
  }
}`;

// ⑥重试 要有东西可打回：这份是 fail/转 retry。
// 客观硬伤（没有音频流，H3 原生出声）+ 主观硬伤（构图完全偏离提示词），
// 两条都会让 verdict 直接是 fail，不给 pass_with_notes 的余地。
// audio_matches_scene 记 skipped 但不是「未复核」——没有音频流就无声音可判，
// 让人去听一个没声音的文件是噪音，所以代码把它标成 moot，不计入未复核、也不进 route_to 的理由里。
// suggested_change.patch 故意是空对象：⑤ 只说「换种子」，具体换哪个种子由 ⑥重试 分配
//（它要扫 shots/ 和所有 c04，避开这个镜头用过的每一个 seed）。⑤ 要是自己填一个数，
// 两站就会为同一个数字打架，还可能撞上已经烧过的那一个。
export const sampleQAFail = `{
  "envelope": {
    "schema_version": "1.0",
    "artifact_id": "qc.S002_c01",
    "contract": "c06_qc_report",
    "created_at": "2026-09-08T02:37:00.000Z",
    "producer": { "kind": "agent", "name": "qc_agent", "agent_version": "0.1.0" },
    "upstream_refs": ["genres.S002_c01", "genreq.S002_c01"],
    "notes": "客观项数据来源：c05（产物不在本地，未校 sha256）；主观项通道：review；复核人：组员A"
  },
  "payload": {
    "shot_id": "S002",
    "candidate_id": "S002_c01",
    "verdict": "fail",
    "score": 3,
    "checks": [
      { "name": "duration_in_range", "status": "pass", "detail": "设定 5s，实测 5.167s，差 0.167s ≤ 0.75s（一个 17 帧对齐步长）", "measured": "5.167" },
      { "name": "fps_is_24", "status": "pass", "measured": "24/1 = 24fps" },
      { "name": "has_video_stream", "status": "pass", "measured": "h264 848x480" },
      { "name": "has_audio_stream", "status": "fail", "detail": "产物没有音频流。H3 是原生出声的，出不了声就是生成异常，不是「可选特性没开」", "measured": "no audio stream" },
      { "name": "audio_32k_stereo", "status": "skipped", "detail": "无音频流，跳过" },
      { "name": "resolution_matches_aspect_ratio", "status": "pass", "detail": "848x480 ≈ 1.767:1，megapixels 0.407", "measured": "848x480" },
      { "name": "prompt_adherence", "status": "fail", "detail": "提示词要求「手合闸特写、static locked-off camera」，实际输出是远景房间全景，主体手只占画面约 1/12；机位也没锁住，有轻微漂移", "measured": "全片构图" },
      { "name": "character_consistency", "status": "pass", "detail": "无可比对象：T2V 没挂参考图，画面里也只有一只手入画，没有可辨识的角色身份。手的年龄感与皮肤纹理与提示词的 weathered 相符。构图偏离已经记在 prompt_adherence，不在这一项重复扣分", "measured": "全片" },
      { "name": "scene_consistency", "status": "pass", "detail": "色调与 S001 一致，同一控制室" },
      { "name": "motion_quality", "status": "pass", "detail": "无明显抖动或形变" },
      { "name": "audio_matches_scene", "status": "skipped", "detail": "无从判起：产物没有音频流，无声音可判（has_audio_stream 已 fail）" },
      { "name": "no_visual_artifact", "status": "pass", "detail": "画面干净" },
      { "name": "no_red_line_violation", "status": "pass", "detail": "逐条比对片约 red_lines 无命中" }
    ],
    "failed_items": ["has_audio_stream", "prompt_adherence"],
    "root_cause": "客观硬指标不合格：has_audio_stream（产物没有音频流。H3 是原生出声的，出不了声就是生成异常，不是「可选特性没开」）。seed=42 这一次的构图完全偏离提示词，主体比例差一个数量级；音频流同时缺失，属生成异常而非提示词写得不清楚（提示词里 close-up 与 static 都写明了）",
    "suggested_change": {
      "action": "new_seed",
      "patch": {},
      "rationale": "H3 原生出画出声，缺流或音频规格不对属生成异常而非提示词问题，换种子重试最省（⑥重试 会另取一个没用过的 seed）"
    },
    "retry_count": 0,
    "max_retries": 3,
    "route_to": "retry",
    "gate": { "required": false, "status": "not_required" }
  }
}`;
