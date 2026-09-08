# agents/

7 个 Agent 的实现，**一个 Agent 一个文件夹**。

本文件管**边界与归属**（谁负责哪段、契约怎么对、当前差什么）；
具体**怎么写一个 Agent 的代码**，见 [docs/agent_guide.md](../docs/agent_guide.md)。

> Agent 之间**只通过 `contracts/` 里的版本化 JSON 契约交接**。
> 一个人的输出形状变了，另外两个人会全崩，所以输出形状由契约决定，不由实现者决定。

---

## 一、七个角色与它们的契约

```
人 ──c01──▶ ①编剧 ──c02──▶ ★关口1 ──▶ ②分镜 ──c03──▶ ③提示词 ──c04──▶ ④生成
                                                                          │ c05
                                                                          ▼
                     ⑦剪辑 ◀──c06(pass)── ⑤质检 ◀─────────────────────────┘
                       │                    │ c06(fail)
                       │                    ▼
                    c07──▶ ★关口2 ──▶ 成片   ⑥重试 ──▶ 新的 c04（回到 ④）
```

| # | Agent | 消费 | 产出 | 一句话职责 |
|---|---|---|---|---|
| ① | 编剧 | `c01_brief` | `c02_screenplay` | 把一句 logline 展开成带场景编号的剧本 |
| ② | 分镜 | `c02_screenplay` | `c03_shotlist` | 拆镜头，**并为每个镜头标注 T2V / I2V / R2V**，给出分批顺序 |
| ③ | 提示词 | `c03_shotlist` | `c04_gen_request` | 写英文提示词 + 时间码 + `<Picture N>` 约定 + 节点 ID 映射 |
| ④ | 生成 | `c04_gen_request` | `c05_gen_result` | POST 到 ComfyUI，轮询，落盘，记录参数快照与哈希 |
| ⑤ | 质检 | `c05_gen_result` | `c06_qc_report` | ffprobe 硬指标 + 提示词遵循度，判 pass / fail |
| ⑥ | 重试 | `c06_qc_report`(fail) | 新的 `c04_gen_request` | **主要靠换种子**，受 `max_retries` 约束防止无限烧 GPU |
| ⑦ | 剪辑 | `c06_qc_report`(pass) | `c07_edit_decision` | 出剪辑决策单（时间码、转场、混音、字幕） |

### 编号换算（两条编号不是一回事，容易搞混）

- **`c0X` 是"第 X 道交接面"**，`①..⑦` 是"第 X 个 Agent"。`contracts/validate_contract.py --list`
  打印的行首数字标的是**契约**，本表的行首数字标的是**Agent**。
- 规则：**Agent n 消费 `c0n`、产出 `c0(n+1)`**（n = 1..5、7）。
  唯一例外是 ⑥重试，它消费 `c06` 的 fail 分支、产出的是**新的 `c04`**，把流程退回 ④生成。

### Agent 的边界由契约定义，不由"是否调用大模型"定义

④生成 与 ⑥重试 很可能一行 LLM 都不调（就是 HTTP + 轮询 + 换种子），
但它们**仍然是 Agent**，因为它们是流水线上有契约边界的独立工位。
反过来，①②③ 必须调 LLM。是否调用模型是实现细节，不是判断"算不算一个 Agent"的依据。

---

## 二、目录约定：一个文件夹 = 一个 Agent

每个 Agent 自包含三样东西：

| 文件 | 作用 |
|---|---|
| `prompt.js` | 该 Agent 的人格（system prompt）。**改脾气/风格只改这里。** ④⑤⑥⑦ 若不调 LLM，可不建此文件 |
| `sample.js` | 离线降级示例产物（SDK / 鉴权不可用时返回它，保证流水线照常出片）；同时是该 Agent 输出 JSON 格式的**活文档** |
| `index.js` | 自包含入口：再导出 prompt + sample，并给出 `meta` |

`meta` 的字段固定为：

```js
export const meta = {
  name: '编剧',                    // 中文名
  slug: 'screenwriter',            // 文件夹名，kebab-case
  role: '把一句话前提扩写成 3 幕剧本 JSON',
  promptExport: 'SCREENWRITER',    // prompt.js 导出的常量名
  sampleExport: 'sampleScript',    // sample.js 导出的函数/常量名
  contract: 'c02_screenplay',      // 本 Agent 的产出契约（新增字段，见下）
};
```

> `contract` 是本表里新加的字段，现有三份 `index.js` 还没有它。补上是为了让任何人
> 打开一个 Agent 文件夹就知道自己该产出哪道契约，不必翻文档。

### 共享部分放哪里

五个 LLM Agent 本质上是同一次调用、只换 system prompt，所以调用逻辑是**共享管线**，
不属于任何单个 Agent。按组员 gzsyl1 初稿的设计，它落在 `tools/agent.mjs`（`runAgent()`）。

该文件已入库（第四节）。它进来后，`agents/{screenwriter,storyboard,prompt-writer,qa,editor}/llm.js`
已降级为 3–7 行的 re-export shim（`export { chat, ... } from '../../tools/agent.mjs'`）——各站仍能
自包含独立跑，但「HTTP 客户端 / 重试 / 抽 JSON / runAgent 装配」只有一份真身；`agents/generator/comfyui.js`
同样降级为 `export *` 指向 `tools/comfyui.mjs`。共享调用管线与 ComfyUI 客户端的真身都在 `tools/`。

---

## 三、加一个新 Agent（以「③提示词」为例）

1. 新建 `agents/prompt-writer/`，放 `prompt.js` + `sample.js` + `index.js`，`meta` 按上表填
2. 在聚合入口 `prompts.js` 加一行 `export { PROMPT_WRITER } from './agents/prompt-writer/prompt.js';`
3. 在 `tools/samples.js` 加一行 `export { sampleGenRequest } from '../agents/prompt-writer/sample.js';`
4. 在主程序 `studio.mjs` 里用 `runAgent({ name:'提示词', systemPrompt: PROMPT_WRITER, ... })` 串进流水线
5. **交出去之前先过契约校验**，命令见 [docs/agent_guide.md](../docs/agent_guide.md) 第五节

架构不需要重构——**加工位 = 加文件夹**，这正是这套目录约定的设计意图。

> 第 2、3、4 步依赖的 `prompts.js` / `tools/samples.js` / `studio.mjs` 都已入库，
> 加完新 Agent 在聚合入口各补一行即可，无需等任何人。

---

## 四、目标目录与当前状态

7 个 Agent 的文件夹规划（slug 命名与现有 `screenwriter` / `storyboard` / `qa` 一致，用角色名而非契约名；
定下来之前先在群里说一声，别两个人各建一个）：

| # | Agent | 目录 | 状态 |
|---|---|---|---|
| ① | 编剧 | `agents/screenwriter/` | ✅ 已入库（输出对齐 c02_screenplay 并过校验，接入 LLM API，附 run.js 管线；c02 是强制人工关口之一，产出的 gate 一律 `pending`，Agent 不自批） |
| ② | 分镜 | `agents/storyboard/` | ✅ 已入库（输出对齐 c03_shotlist 并过校验，接入 LLM API，附 run.js 管线；`shot_size` 与 `camera_move` 拆成两个字段、`workflow_type` 必填，见第五节 ②） |
| ③ | 提示词 | `agents/prompt-writer/` | ✅ 已入库（输出对齐 c04_gen_request 并过校验，接入 LLM API，附 run.js 管线与素材清单示例 sample_assets.json） |
| ④ | 生成 | `agents/generator/` | ✅ 已入库（输出对齐 c05_gen_result 并过校验，附 run.js 管线；**不调 LLM**，见第一节末。自包含 ComfyUI 客户端 `comfyui.js` + 填图 `graph.js` + 硬指标测量 `ffprobe.js`；`--dry-run` 只出提交计划不 POST。节点地址来自 `--endpoint` / 环境变量 `LOOM_COMFY_URL`（默认 `http://127.0.0.1:8188`），**地址与任何 token 都不入库**——ComfyUI 无鉴权，只能走 SSH 隧道） |
| ⑤ | 质检 | `agents/qa/` | ✅ 已重写（**审查对象已从「审分镜」改回「审产物视频」**，走第五节末的 (a) 方案；输出对齐 c06_qc_report 并过校验。客观 6 项由 ffprobe 实测值 + 代码硬判、模型不参与，主观 7 项只认三个来源：`--review` 侧清单 > `--vision` 抽帧 + 视觉模型 > `skipped` 未复核；接入 LLM API，附复核侧清单示例 sample_review.json） |
| ⑥ | 重试 | `agents/retry/` | ✅ 已入库（消费 c06(fail) 产出**新的 c04_gen_request** 并过校验，把流程退回 ④；**不调 LLM**。深拷贝上一份 c04 打白名单补丁，`workflow.node_ids` 与 `assets` 原样沿用；白名单只有 5 个键且各归一个动作管，`action` 与 `patch` 归属对不上就打回 ⑤质检 重开；越权动作写 `needs_human.md` 转交上游或人工，`retry_count` 达 `max_retries` 就停手，见 docs/decisions/2026-09-08-generation-loop-conventions.md） |
| ⑦ | 剪辑 | `agents/editor/` | ✅ 已入库（输出对齐 c07_edit_decision 并过校验，接入 LLM API，附 run.js 管线；消费 c06(pass)+c05(取 source_path)+c03(取顺序)，字幕走侧清单 sample_subtitles.json，见 docs/decisions/2026-09-07-editor-input-conventions.md） |

七站的示例产物现在都能过自己 `meta.contract` 声明的那道契约（`envelope.contract` 与 `meta.contract` 也逐个核对一致）。
c02 与 c07 带强制人工关口，示例里的 `gate.status` 故意留 `pending`，所以 `--file` 模式会判它们「关口未批」——
那是第六节要的机器拦截，不是结构缺陷；`--selftest` 只查结构，7/7 通过。

七站现在各自都有可独立执行的 `run.js`，**逐站手接就能跑通 ①→⑦**
（每站的完成提示里都印着下一站的命令）；「一条命令串起七站」由主程序承担（下表第 1 行），
渲染成片已就位（下表末行），编排层与共享层都已入库：

| 路径 | 作用 | 状态 |
|---|---|---|
| `studio.mjs` | 主程序，串起 7 个工位 | ✅ 已入库（`node studio.mjs --help`。六档：1 编剧 → 2 分镜 → 3 提示词 → 4 ④⑤⑥回环 → 5 剪辑 → 6 渲染；两道强制人工关口（c02/c07）只由人 `--approve` 点批、机器绝不代批，未批就停靠并打印续跑命令；回环一轮 = ④提交→⑤质检→⑥打回收敛，`--dry-run` 停在「③产物 + ④提交计划」的离线边界；⑦出决策单先渲「审阅粗剪」再停靠，批完 `--from render` 只核验不重烧） |
| `prompts.js` | 根聚合入口，再导出各 Agent 的 prompt | ✅ 已入库 |
| `tools/agent.mjs` | `runAgent()` 共享调用管线（含 LLM HTTP 客户端与契约校验助手） | ✅ 已入库。**①②③⑤⑦ 各自的 `llm.js` 已降级为 re-export shim**，真身只有这一份（见第二节「共享部分放哪里」） |
| `tools/samples.js` | 根聚合入口，再导出各 Agent 的 sample | ✅ 已入库 |
| `tools/comfyui.mjs` | ComfyUI 客户端 | ✅ 已入库。**④生成 的 `agents/generator/comfyui.js` 已降级为 `export *` shim**（上传素材 / POST /prompt / 轮询 /history / 下载） |
| `tools/slideshow.mjs` | 渲染成片：消费 c07_edit_decision，按 timeline trim+concat（cut 硬切 / dissolve 叠化 / 首尾淡入淡出）、烧 .ass 字幕与 AI 生成标识（主赛道硬要求）、loudnorm 到 `audio_mix.loudness_target_lufs`，渲染后**回填** `final_output` 的 sha256/size_bytes/duration_seconds 与 `audio_mix.measured_loudness_lufs` 并用 gate=approved 副本复跑权威校验（真产物 gate 不动，仍 pending 等人批）。已实测：11 镜夹具（含无音轨垫静音、48kHz 单声道、双 dissolve、中文字幕）端到端出片 63s，抽帧核对叠化/字幕/AI 标识/时序逐项吻合 | ✅ 已入库（`node tools/slideshow.mjs --help`；渲染机需 ffmpeg 带 libass + 中文字体，见文件头「运行前提」） |

---

## 五、初稿与契约的差距（**已全部解决**，保留作对照）

> 状态：截至 09-08，①②③⑤⑦ 五份初稿都已重写为对齐契约的版本，④⑥ 从零建成，第四节状态表是实况。
> 本节**不删**——下面这些表格解释的是「现在的代码为什么长成这样」：
> 为什么 `shot_size` 与 `camera_move` 是两个字段而不是一个 `shotType` 字符串、
> 为什么 c03 必须带 `workflow_type`、为什么 ⑤ 审的是视频而不是分镜。
> 只留结论不留依据，下一个人还会把它改回去。

三份初稿是在契约已冻结、但实现者手上没有可跑环境的情况下写的，**目录约定和拆分思路是对的，
可以直接沿用**；问题集中在**输出形状**上：三份 `sample.js` 都不符合契约，
而 `prompt.js` 里给模型的 JSON 输出模板也是同一个错误形状。

**只改 `sample.js` 不改 `prompt.js` 等于没改**——`prompt.js` 里那段 JSON 模板就是给大模型的字段规格，
模型会照着它输出，离线时用 sample 兜底，两条路径必须同一个形状。
（这条教训在重写时兑现了：⑤质检 的 `prompt.js` 里给模型的不是 c06，而是一个**中间形状**——
只让它输出 7 个主观项的判定，`envelope`、6 个客观项、`route_to`、`retry_count` 全部由代码组装。）

### 三份共同的两个问题

1. **没有 `envelope` / `payload` 外壳**。7 道契约顶层都只有这两个键，且都必填。
   `envelope` 里 `schema_version` / `artifact_id` / `contract` / `created_at` / `producer` 五项必填。
   初稿三份都是从 `payload` 那一层直接开始写的。
2. **字段名是自创的**，与契约不同名。契约的 `additionalProperties` 没设限，所以多写字段不会报错，
   但**缺必填字段一定不通过**，而且下游 Agent 读不到你多写的那些。

### ①编剧 —— `c02_screenplay`

| 契约要求 | 初稿实际 |
|---|---|
| `payload.scenes[]`，每项必填 `scene_id` / `location` / `time_of_day` / `summary` / `characters[]` / `beats[]` | `scenes[]` 只有 `id`（整数）/ `beat` / `description` |
| `payload.emotion_curve[]`（必填，每项 `beat` + `intensity`） | 缺 |
| `payload.dialogue_language`（必填） | 缺 |
| `payload.gate`（**必填**，`human_gate` 要 `required` + `status`） | 缺 —— c02 是强制人工关口，缺 gate 会被校验器直接判不通过，②分镜拿不到放行产物 |

对应要改的位置：`agents/screenwriter/prompt.js:8-19`（输出模板）与 `agents/screenwriter/sample.js`。

### ②分镜 —— `c03_shotlist`

`payload.shots` 必填，且**每个 shot 有 10 个必填字段**。初稿的 7 个字段
（`id` / `frame` / `shotType` / `visual` / `caption` / `sfx` / `seconds`）与契约的 10 个必填**无一同名**。

| 契约要求（每项必填） | 说明 |
|---|---|
| `shot_id` / `scene_id` / `order` | 初稿的 `id` / `frame` 对不上，且缺 `scene_id`——丢了镜头归属场景，就没法追溯 |
| `duration_seconds` | 初稿叫 `seconds`。**写秒，不要写帧数**（下游 `ComfyMathExpression` 会换算并对齐到 17 的倍数） |
| `aspect_ratio` | 缺 |
| `shot_size` + `camera_move` | 初稿把两者合成了一个 `shotType: "大远景 · 缓推"` 字符串，**必须拆成两个字段** |
| `visual_description` / `audio_description` | 初稿的 `visual` 改个名；`sfx` 归到 `audio_description` |
| `workflow_type` | **缺，这是最要命的一项**。enum `T2V` / `I2V` / `R2V`，它决定 ③提示词 选哪份工作流、以及 GPU 按类型分批入队（换模型要重载 21 GB+ 权重）。缺了它整条生成排程就没了依据 |
| 可选但建议给 | `batch_plan`（GPU 分批计划）、`consistency_group`、`needs_reference_assets`、`reference_note` |

另外初稿的 `caption`（字幕文案）不属于 c03。字幕/混音是 **⑦剪辑** 在 `c07_edit_decision` 里的事。

### ⑤质检 —— `c06_qc_report`

`payload` 必填 `shot_id` / `candidate_id` / `verdict` / `checks` / `route_to`，初稿**五个缺四个**。

| 问题 | 说明 |
|---|---|
| `verdict` 值大小写不合法 | 契约 enum 是小写 `pass` / `pass_with_notes` / `fail`，初稿写的是 `"PASS"` / `"REJECT"`。JSON Schema 的 enum 区分大小写 |
| 缺 `shot_id` + `candidate_id` | 质检是**逐镜头、逐候选**的。一条全局 PASS 无法反查是哪个镜头哪个候选，直接砸掉本项目"可追溯"这条目标 |
| 缺 `checks[]` | 每项 `name` + `status`。客观项（时长 / 帧率 / 分辨率 / 有无音轨）由 `ffprobe` 硬判定后填进来，**不要用 LLM 判这些** |
| 缺 `route_to` | enum `retry` / `edit` / `human`，这是 ⑤→⑥ 或 ⑤→⑦ 的**分流开关**。没有它，重试 Agent 根本不会被触发，闭环断了 |
| `reasons` / `fixes` 不在契约里 | 对应位置是 `failed_items[]` / `root_cause` / `suggested_change` / `retry_count` / `max_retries` |

**已解决**：五个必填项齐备，`verdict` 走小写 enum，`route_to` 是代码按判定结果算出来的分流开关，四档：

| 判定结果 | `verdict` | `route_to` |
|---|---|---|
| 客观 6 项任一 fail，或主观硬伤（`prompt_adherence` / `character_consistency` / `no_red_line_violation`）fail | `fail` | `retry`；重试次数已耗尽则 `human` |
| 只剩主观软伤（如 `no_visual_artifact`） | `pass_with_notes` | `edit` |
| 全过，但有主观项没人真看过画面 | `pass_with_notes` | `--on-unreviewed` 指定的方向（默认 `human`） |
| 全过且都看过 | `pass` | `edit` |

`pass_with_notes` 那两档也会附上 `suggested_change`——那是给人和 ⑦剪辑 看的建议（「这一镜要是想更好，
可以提高 megapixels 重出一版」），**不是分流依据**，代码不会因为写了它就再烧一轮 GPU。
客观/主观的分界比上表要求的更严一格：客观 6 项**只**由 ffprobe 实测值 + 代码硬判，模型一个字都不参与；
主观 7 项只认三个来源——`--review` 人工侧清单 > `--vision` 抽帧 + 视觉模型 > `skipped`（未复核），
没看过就是没看过，按 `--on-unreviewed human|edit` 转人工，**不许伪装成 pass**。
另外 13 项按固定顺序输出（`CHECK_ORDER`），这样两个候选的 c06 能并排逐行对着读。

### 还有一个对象错位，需要团队定一下

初稿把「质检」实现成了**审分镜**（`agents/qa/index.js` 的 `meta.role` = "审分镜是否忠实剧本/有电影感"），
而契约里 ⑤质检 审的是**生成出来的视频文件**（消费 `c05_gen_result`，产出 `c06_qc_report`）。
`sampleQAReject` 里"第 2 镜缺少合闸前的张力铺垫"属于分镜阶段的稿子评审，不是 c06 该记的东西。

两条路：

- **(a) 把 `agents/qa/` 改成对齐 c06**，审视频、用 ffprobe。分镜阶段的稿子评审交给 ②分镜 自检或人
- **(b) 保留这个前置审查**，但它是 c06 之外的第 8 道交接面，**需要新增契约**

契约要改必须三人一致同意（见 `docs/agent_guide.md` 第八节）。**我建议先走 (a)**，因为 c06 已经冻结且有示例通过校验，
改动成本最低；前置审查确实有价值，等跑通一轮之后再按第八节流程补契约。

**已裁定：走 (a)。** `agents/qa/` 已按 c06 整体重写（`meta.role` 改成审产物视频，`sampleQAReject` 删除，
换成 `sampleQA`(pass_with_notes/转剪辑) 与 `sampleQAFail`(fail/转重试) 两份真跑出来的活文档）。
分镜阶段的稿子评审留给 ②分镜 自检与人。**(b) 那条第 8 道交接面仍然没开**——契约零改动，
等真跑通一轮、确认前置审查的价值值得动 Schema 之后，再按 `docs/agent_guide.md` 第八节的五步流程提。

---

## 六、人工关口是数据，不是口头约定

机器强制的阻塞关口有**两处**：

| 契约 | 关口 | 阻塞含义 |
|---|---|---|
| `c02_screenplay` | 剧本确认 | `gate.required = true` 且 `status != approved` 时，校验器直接判不通过 |
| `c07_edit_decision` | 粗剪确认 | 同上 |

（`c01_brief` 本身由人撰写，`producer` 字段就是人，它是源头输入而不是关口。）

实现上的含义：**下游 Agent 不能靠读上游文件来判断能不能开工**，
必须先过 `contracts/validate_contract.py`。校验不过就停下等人，
这样「人机边界」才是机器会拦的东西，而不是写在文档里的君子协定。

```bash
python contracts/validate_contract.py --contract c02_screenplay --file artifacts/screenplay_v3.json
# 退出码 1 = 不通过（含关口未批），不要继续往下走
```

---

## 七、开发顺序：先 mock，不要等上游

契约冻结后，三个人可以真正并行，因为每个人的输入输出都能从
`contracts/examples.json` 里拿到假数据：

| 谁 | 不用等谁 | 怎么开工 |
|---|---|---|
| B | 不等 C 的提示词 Agent | 抄 `examples.json` 里的 `c04_gen_request` 当假输入，直接开发生成 Agent |
| C | 不等 B 的生成 Agent | 拿 `examples.json` 里的 `c05_gen_result` 当假输出，直接开发质检 Agent |
| A | 不等任何人 | 片约与剧本是源头 |

**代价：契约一旦冻结，任何改动必须三人一致同意。**
因为三个人都在依赖它，单方面改一行就会让另两人的代码全崩。
要改契约走这个流程：

1. 在 issue 里说明改哪个字段、为什么、影响哪几个 Agent
2. 三人确认
3. 改 `contracts/film_agent_contracts.json`，同步改 `examples.json`
4. 跑 `--selftest` 与 `negative_test.py`，两个都过才提交
5. 在 `docs/decisions/` 里补一条决策记录

---

## 八、LLM 放在哪里

**节点上没有文本模型**（实测各加载器的枚举可选值里只有 MiniMax-H3 的
视频权重、文本编码器与 VAE，详见 `docs/node_baseline.md` 第四节）。

所以 ①编剧、②分镜、③提示词、⑤质检、⑦剪辑 这五个 Agent 的 LLM 调用
**走云端 API 或各自开发机，完全不占 GPU**，可以和生成任务并行推进，
不受 `docs/gpu_protocol.md` 的排班约束。（④生成 与 ⑥重试 一行 LLM 都不调。）

⑤质检 里客观的部分（时长、帧率、分辨率、有无音轨）用 `ffprobe` 硬判，
**永远不要交给 LLM**——能确定性判定的事不要交给概率模型。
主观 7 项才用视觉模型或人；而且给模型的从来不是「判一下这个视频好不好」这种开放问题：
视觉通道拿到的是 ffmpeg 抽出的静帧，`motion_quality`（运动是否平滑）与 `audio_matches_scene`（音画匹配）
它判不了就不许输出；纯文本通道只被授权判 `no_red_line_violation` 一项，因为那是唯一比文字就能判的。
`route_to` / `retry_count` / `verdict` 这些决定「要不要再烧一轮 GPU」的字段，一律由代码算，不由一次采样决定。

---

## 九、七站怎么跑

最省事的是主程序一条命令（`node studio.mjs --help` 是全部档位与参数的权威说明）：

```bash
node studio.mjs --logline "一句话故事（20–400 字）" --offline     # ①→…，到强制人工关口停下等人批
node studio.mjs --approve artifacts/screenplay_<时间戳>.json --reviewer <你的名字>   # 人点批（只有人能跑）
node studio.mjs --from 2 --offline                                # 批完续跑
node studio.mjs --from 4 --genreq artifacts/genreq_<时间戳>/ --dry-run   # 离线边界：③产物 + ④提交计划
```

也可以逐站手接（单站调试、或想替某一站换参数时更顺手）。七站各自都有可独立执行的 `run.js`，
每站跑完都会把下一站的命令连着实际路径打印出来，照着抄即可。下面是最短的一条路径，
`<时间戳>` 用上一站打印出来的那个目录名。

```bash
# ① 编剧：c01_brief（人写）→ c02_screenplay。c02 是强制人工关口之一，产出的 gate 一律 pending
node agents/screenwriter/run.js --brief artifacts/brief_v1.json --offline      # 先离线看形状
node agents/screenwriter/run.js --brief artifacts/brief_v1.json                # 配好 Key 走 LLM
# ↓ 人工看过剧本、点批放行（只有人能批，机器拦，见第六节）：
#   node studio.mjs --approve artifacts/screenplay_<时间戳>.json --reviewer <你的名字>

# ② 分镜：c02 → c03_shotlist（每镜带 workflow_type，它决定 ③ 选哪份工作流、④ 按类型分批入队）
node agents/storyboard/run.js --screenplay artifacts/screenplay_<时间戳>.json

# ③ 提示词：c03 → 逐镜头 × 逐候选的 c04_gen_request
node agents/prompt-writer/run.js --shotlist artifacts/shotlist_<时间戳>.json \
     --assets agents/prompt-writer/sample_assets.json                          # 素材清单是人工侧输入

# ④ 生成：c04 → 提交 ComfyUI → 落盘 shots/<候选>/ + c05_gen_result。**这一步才烧 GPU**
node agents/generator/run.js --requests artifacts/genreq_<时间戳>/ --dry-run    # 只出提交计划，不 POST
node agents/generator/run.js --requests artifacts/genreq_<时间戳>/

# ⑤ 质检：c05（+ c04 作比对基准）→ 逐候选 c06_qc_report，route_to 决定分流
node agents/qa/run.js --candidates S001_c01,S001_c02 --shots-root shots/ \
     --requests artifacts/genreq_<时间戳>/ --review agents/qa/sample_review.json --offline
#   主观项的三个来源：--review 人工侧清单 > --vision 抽帧 + 视觉模型 > skipped（未复核）
#   没看过就是没看过，--on-unreviewed human|edit 决定它转人工还是放行进剪辑（默认 human）

# ⑥ 重试：c06(route_to=retry) + 上一批 c04 → **新的 c04**，回到 ④
node agents/retry/run.js --qc artifacts/qc_<时间戳>/ --requests artifacts/genreq_<时间戳>/ --dry-run
node agents/retry/run.js --qc artifacts/qc_<时间戳>/ --requests artifacts/genreq_<时间戳>/
#   ⑥ 做不了的那些（越权补丁 / action 与 patch 的键归属对不上 / 换工作流类型 / 换参考素材 /
#   要它重写提示词 / 新时长装不下原有分段数 / 重试次数耗尽）
#   不是错误，会写进 <输出目录>/needs_human.md，逐条注明该转交哪一站、下一步命令是什么

# ⑦ 剪辑：c06(pass) + c05(取 source_path) + c03(取顺序) + 字幕侧清单 → c07_edit_decision
node agents/editor/run.js --qc artifacts/qc_<时间戳>/ --shotlist artifacts/shotlist_<时间戳>.json \
     --subtitles agents/editor/sample_subtitles.json --offline
# ↓ c07 是强制人工关口之二：粗剪确认。gate 一律 pending，Agent 不自批
```

三件事值得单说：

- **④→⑤→⑥→④ 是个回环，不是一条直线**。⑥ 产出的新 c04 要回 ④ 重跑、再回 ⑤ 复检，
  直到 `pass`/`pass_with_notes` 进 ⑦，或者 `retry_count` 达 `max_retries` 转人工。
  上限是机器拦的：⑤ 判耗尽就 `route_to=human`，⑥ 收到也拒绝再出新 c04，防无限烧 GPU。
- **`--dry-run`（④⑥）与 `--offline`（①②③⑤⑦）都不烧 GPU、都不调 LLM**，
  先用它们把形状看清楚再动真格。⑤ 的 `--offline` 不编 pass，只把没人看过的主观项老实记 `skipped`。
- **每站落盘前都过一遍权威校验器**（`python contracts/validate_contract.py`，报告重定向到临时文件跑完即删），
  JS 侧的结构自检只是先一步把话说清楚。校验不过就 exit 1，不写出注定不合法的产物。
- **各站的默认输出目录都在 `artifacts/` 下，而 `artifacts/` 没有进 `.gitignore`**
  （`docs/agent_guide.md` 第五节第 1 步明写「`git add` 前看清楚，别把一堆中间产物一起提交进去」）。
  试跑请把输出指到 `tmp/`（已忽略）：④ 用 `--plan-dir tmp/genplan`、⑥ 用 `--out-dir tmp/genreq_retry`，
  或者提交前 `rm -rf artifacts/`。注意 **④ 的 `--dry-run` 照样会写一个计划目录**，它只是不碰 GPU。
