// agents/retry/sample.js — 「⑥重试」示例产物（新的 c04_gen_request 形状的活文档）。
//
// ⑥重试 既没有离线降级，也不调 LLM，理由与 ④生成/⑤质检 同源但更进一步：
// 它产出的是一份工单，④生成 拿到就烧 GPU。凭空编一份 c04 不是「示例失真」，
// 是让人拿一张没人开过的工单去排队跑图。所以本文件里的两份都是 runRetry 真跑出来的，
// 只把 created_at 与 artifact_id 里的时间戳换成了固定值（同一次运行共用一个 stamp）。
//
// 两份示例串起的是仓库里现成的那条链，输入一个数字都没手写：
//   sampleRetryRequest         ← 上一份 c04：③提示词 --offline 的产物骨架，generation 对齐
//                                agents/generator/sample.js 的 sampleGenResultNoAudio.params_snapshot；
//                                判定书：agents/qa/sample.js 的 sampleQAFail 原文（fail/retry/new_seed）；
//                                shots/S002_c01/meta.json：sampleGenResultNoAudio 原文
//   sampleRetryRequestRescale  ← 上一份 c04：agents/prompt-writer/sample.js 的 sampleGenRequest 原文（R2V）；
//                                判定书：夹具里一份 change_duration 的 c06（patch 只有 duration_seconds: 8）
// 复现（夹具放在 tmp/ 下，那是 .gitignore 里的目录，这样 envelope.notes 里的 rel(qcFile)
// 是一条干净的仓库相对路径，而不是一条 C:/Users/.../Temp/... 的绝对路径）：
//   node agents/retry/run.js --qc tmp/retry_sample/qc --requests tmp/retry_sample/genreq \
//     --shots-root tmp/retry_sample/shots --out-dir tmp/retry_sample/out
// 换任何一个输入，下面 notes 里的 seed、候选号、时间码都会跟着变——它们是代码算出来的，不是措辞。
//
// 五处容易被当成 bug 的地方，都不是：
//   · sampleRetryRequest 的 action 是 new_seed，但 ⑤ 给的 suggested_change.patch 是空对象 {}。
//     故意的：具体换哪个 seed 由 ⑥ 分配（它要扫上一批 c04 与 shots/<候选>/meta.json 的实测快照，
//     避开这个镜头用过的每一个数）。⑤ 要是自己填一个数，两个工位都在写 seed，迟早撞上 ComfyUI 的缓存。
//   · seed 42 → 1000045，步长 1000003 是质数。用 1000 这种整步长的话，多次重试会落在等差数列上，
//     与别的镜头的 seed 序列周期性相交；质数步长让撞车只能靠巧合。撞了也还会按同样步长继续跳。
//   · sampleRetryRequestRescale 里 ⑤ 只要求改时长，seed 却也从 4001 变成了 1004004。
//     因为 ComfyUI 对完全相同的输入直接返回缓存的旧产物（0 秒出图），
//     新候选必须同时换掉 noise_seed 与 filename_prefix，否则等于要求它复现同一个坏产物、还会盖掉旧归档。
//     这两条是 structuralCheck 里显式写死的不变量，不是顺手带的。
//   · 时间码 [0s-3s],[3s-6s] → [0s-4s],[4s-8s]，是 6s→8s 的等比重排（每段至少 1 秒、末段收在
//     ceil(新时长)），提示词里的 [Xs-Ys] 标记同步替换。这是机械重排不是创意重写：
//     每段演什么一个字都没动。⑥ 一行创意文本都不写。
//   · S004 的 retry_of 是从 c06.envelope.upstream_refs 里认出来的，不是从 shots/S004_c01/meta.json。
//     视频不入库（见 shots/README.md），拉下仓库后产物目录本来就不在——这是常态而非异常，
//     控制台会留一条警告说清闭环证据的这一头只剩 ⑤ 的转述。S002 那份有 meta.json，走的是权威路径。
//   · notes 里的长提示词被截成了前 60 个字符。完整逐字段对照打在控制台上，notes 只负责留一条线索。

export const sampleRetryRequest = `{
  "envelope": {
    "schema_version": "1.0",
    "artifact_id": "genreq.S002_c02.20260908T025000",
    "contract": "c04_gen_request",
    "created_at": "2026-09-08T02:50:00.000Z",
    "producer": { "kind": "agent", "name": "retry_agent", "agent_version": "0.1.0" },
    "upstream_refs": ["qc.S002_c01", "genreq.S002_c01", "genres.S002_c01"],
    "notes": "⑥重试 按 tmp/retry_sample/qc/S002_c01.json 的判定打回：S002_c01 → S002_c02（第 1 次重试，上限 3）。action=new_seed。payload.candidate_id: \\"S002_c01\\" → \\"S002_c02\\"；payload.generation.filename_prefix: \\"shots/S002_c01\\" → \\"shots/S002_c02\\"；payload.generation.seed: 42 → 1000045；payload.retry_of: null → \\"genres.S002_c01\\"。⑤ 的失败项：has_audio_stream、prompt_adherence。⑤ 的归因：客观硬指标不合格：has_audio_stream（产物没有音频流。H3 是原生出声的，出不了声就是生成异常，不是「可选特性没开」）。seed=42 这一次的构图完全偏离提示词，主体比例差一个数量级；音频流同时缺失，属生成异常而非提示词写得不清楚（提示词里 close-up 与 static 都写明了）。提示词、素材位、工作流类型、节点 ID 映射全部原样沿用上一份 c04，⑥重试 不改创意内容"
  },
  "payload": {
    "shot_id": "S002",
    "candidate_id": "S002_c02",
    "retry_of": "genres.S002_c01",
    "workflow": {
      "type": "T2V",
      "api_json": "workflow_api_t2v.json",
      "node_ids": {
        "source": "workflows/node_id_map.json@20ddf50",
        "prompt": ["140:131", "prompt"],
        "seed": ["140:129", "noise_seed"],
        "duration_seconds": ["140:133", "value"],
        "aspect_ratio": ["115", "aspect_ratio"],
        "megapixels": ["115", "megapixels"],
        "filename_prefix": ["92", "filename_prefix"],
        "fps": ["140:130", "fps"],
        "turbo_enabled": ["140:139", "value"],
        "steps_normal": ["140:137", "value"],
        "steps_turbo": ["140:138", "value"]
      },
      "turbo_enabled": false
    },
    "generation": {
      "prompt": "Realistic live-action cinematic look, cool blue instrument glow. [0s-2s] Close-up shot, static locked-off camera, a weathered hand rests on a heavy brass knife-switch on the central console. [2s-5s] The hand throws the switch, amber light floods the panel. Audio: a solid mechanical clunk, then rising transformer whine.",
      "prompt_language": "en",
      "timecodes": ["[0s-2s]", "[2s-5s]"],
      "duration_seconds": 5,
      "seed": 1000045,
      "aspect_ratio": "16:9 (Widescreen)",
      "megapixels": 0.4,
      "multiple": 32,
      "fps": 24,
      "bit_depth": 8,
      "color_space": "sRGB",
      "steps": 20,
      "sampler_name": "res_multistep",
      "scheduler": "simple",
      "filename_prefix": "shots/S002_c02"
    },
    "assets": {}
  }
}`;

// change_duration 这一份要看的是「⑥ 是打补丁不是重写」这句话到底兑现了没有：
// R2V 的 assets.ref_images 两个素材位、workflow.node_ids 全套映射、api_json、提示词正文
// 全部与 agents/prompt-writer/sample.js 的 sampleGenRequest 逐字节相同，
// 变的只有 candidate_id / filename_prefix / seed / retry_of / duration_seconds / timecodes
// 以及提示词里那两处 [Xs-Ys] 标记。素材位一改就得连提示词一起改（<Picture N> 与素材位一一绑定），
// 而素材清单是人工维护的侧输入——所以 ⑥ 不碰 assets，c06 要是要求 change_reference_asset，
// 本站直接打回「人工改素材清单 → ③提示词 → ④生成」，见 run.js 的 PATCH_REFUSALS / PATCH_OWNER。
export const sampleRetryRequestRescale = `{
  "envelope": {
    "schema_version": "1.0",
    "artifact_id": "genreq.S004_c02.20260908T025000",
    "contract": "c04_gen_request",
    "created_at": "2026-09-08T02:50:00.000Z",
    "producer": { "kind": "agent", "name": "retry_agent", "agent_version": "0.1.0" },
    "upstream_refs": ["qc.S004_c01", "genreq.S004_c01.sample", "genres.S004_c01"],
    "notes": "⑥重试 按 tmp/retry_sample/qc/S004_c01.json 的判定打回：S004_c01 → S004_c02（第 1 次重试，上限 3）。action=change_duration。payload.candidate_id: \\"S004_c01\\" → \\"S004_c02\\"；payload.generation.filename_prefix: \\"shots/S004_c01\\" → \\"shots/S004_c02\\"；payload.generation.seed: 4001 → 1004004；payload.retry_of: null → \\"genres.S004_c01\\"；payload.generation.duration_seconds: 6 → 8；payload.generation.timecodes: [\\"[0s-3s]\\",\\"[3s-6s]\\"] → [\\"[0s-4s]\\",\\"[4s-8s]\\"]；payload.generation.prompt: \\"Realistic live-action cinematic look, cold blue darkness wit…\\"（原 707 字符，全文见 payload，逐字段对照在控制台） → \\"Realistic live-action cinematic look, cold blue darkness wit…\\"（原 707 字符，全文见 payload，逐字段对照在控制台）。⑤ 的失败项：duration_in_range、prompt_adherence。⑤ 的归因：分镜表给 S004 的目标时长是 8s，③ 落成 c04 时写成了 6s。两段动作本身没问题，是被压短了。提示词、素材位、工作流类型、节点 ID 映射全部原样沿用上一份 c04，⑥重试 不改创意内容"
  },
  "payload": {
    "shot_id": "S004",
    "candidate_id": "S004_c02",
    "retry_of": "genres.S004_c01",
    "workflow": {
      "type": "R2V",
      "api_json": "workflow_api_r2v.json",
      "node_ids": {
        "source": "workflows/node_id_map.json@2026-09-04",
        "prompt": ["138", "value"],
        "seed": ["129", "noise_seed"],
        "duration_seconds": ["132", "value"],
        "aspect_ratio": ["115", "aspect_ratio"],
        "megapixels": ["115", "megapixels"],
        "filename_prefix": ["92", "filename_prefix"],
        "fps": ["130", "fps"],
        "turbo_enabled": ["146", "value"],
        "steps_normal": ["143", "value"],
        "steps_turbo": ["144", "value"]
      },
      "turbo_enabled": false
    },
    "generation": {
      "prompt": "Realistic live-action cinematic look, cold blue darkness with a single amber practical light. <Picture 1> locks the watchman's face, graying short hair and dark workwear; <Picture 2> locks the dim control room set with rows of dead analog gauges. [0s-4s] Medium tracking shot following the watchman as he walks slowly past a row of motionless instrument panels, every needle frozen at zero, the amber indicator light sweeping across his profile. [4s-8s] The camera keeps drifting with him past the last panel, his breath faintly visible in the cold air, the amber glow pulsing once on his cheekbone. Audio: boot steps echoing in the control room, low-frequency machine hum underneath, no music, no dialogue.",
      "prompt_language": "en",
      "timecodes": ["[0s-4s]", "[4s-8s]"],
      "duration_seconds": 8,
      "seed": 1004004,
      "aspect_ratio": "16:9 (Widescreen)",
      "megapixels": 0.4,
      "multiple": 32,
      "fps": 24,
      "bit_depth": 8,
      "color_space": "sRGB",
      "steps": 20,
      "sampler_name": "res_multistep",
      "scheduler": "simple",
      "filename_prefix": "shots/S004_c02"
    },
    "assets": {
      "ref_images": [
        {
          "node_filename": "example.png",
          "source_path": "comfyui/input/example.png",
          "license": "self_generated",
          "generated_by": "占位：正式跑时换成值守者正面定妆图（MiniMax-H3 T2V 预生成，watchman 组内复用）"
        },
        {
          "node_filename": "example.png",
          "source_path": "comfyui/input/example.png",
          "license": "self_generated",
          "generated_by": "占位：正式跑时换成控制室场景参考图"
        }
      ],
      "ref_image_size": "match"
    }
  }
}`;
