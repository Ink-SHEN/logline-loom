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

三个 LLM Agent 本质上是同一次调用、只换 system prompt，所以调用逻辑是**共享管线**，
不属于任何单个 Agent。按组员 gzsyl1 初稿的设计，它落在 `tools/agent.mjs`（`runAgent()`）。

**注意：`tools/` 目录、根目录的 `studio.mjs` / `prompts.js` / `tools/samples.js` 目前都还没入库**，
见第四节的状态表。在它们进来之前，`agents/*` 里的三份代码是无法独立跑通的。

---

## 三、加一个新 Agent（以「③提示词」为例）

1. 新建 `agents/prompt-writer/`，放 `prompt.js` + `sample.js` + `index.js`，`meta` 按上表填
2. 在聚合入口 `prompts.js` 加一行 `export { PROMPT_WRITER } from './agents/prompt-writer/prompt.js';`
3. 在 `tools/samples.js` 加一行 `export { sampleGenRequest } from '../agents/prompt-writer/sample.js';`
4. 在主程序 `studio.mjs` 里用 `runAgent({ name:'提示词', systemPrompt: PROMPT_WRITER, ... })` 串进流水线
5. **交出去之前先过契约校验**，命令见 [docs/agent_guide.md](../docs/agent_guide.md) 第五节

架构不需要重构——**加工位 = 加文件夹**，这正是这套目录约定的设计意图。

> 第 2、3、4 步依赖的 `prompts.js` / `tools/samples.js` / `studio.mjs` 尚未入库。
> 谁先来建这三个文件，建完立刻提交，后面的人就有地方挂。

---

## 四、目标目录与当前状态

7 个 Agent 的文件夹规划（slug 命名与现有 `screenwriter` / `storyboard` / `qa` 一致，用角色名而非契约名；
定下来之前先在群里说一声，别两个人各建一个）：

| # | Agent | 目录 | 状态 |
|---|---|---|---|
| ① | 编剧 | `agents/screenwriter/` | ✅ 初稿已入库（**输出形状不合规，见第五节**） |
| ② | 分镜 | `agents/storyboard/` | ✅ 初稿已入库（**不合规**） |
| ③ | 提示词 | `agents/prompt-writer/` | ✅ 初稿已入库（输出对齐 c04_gen_request 并过校验，接入 LLM API，附 run.js 管线与素材清单示例 sample_assets.json） |
| ④ | 生成 | `agents/generator/` | ⬜ 待建 |
| ⑤ | 质检 | `agents/qa/` | ✅ 初稿已入库（**不合规，且审查对象错位**） |
| ⑥ | 重试 | `agents/retry/` | ⬜ 待建 |
| ⑦ | 剪辑 | `agents/editor/` | ⬜ 待建 |

另需入库（不属于 `agents/`，但没有它们整条链路跑不起来）：

| 路径 | 作用 | 状态 |
|---|---|---|
| `studio.mjs` | 主程序，串起 7 个工位 | ⬜ 组员本地有，未上传 |
| `prompts.js` | 根聚合入口，再导出各 Agent 的 prompt | ⬜ 同上 |
| `tools/agent.mjs` | `runAgent()` 共享调用管线 | ⬜ 同上 |
| `tools/samples.js` | 根聚合入口，再导出各 Agent 的 sample | ⬜ 同上 |
| `tools/slideshow.mjs` / `tools/comfyui.mjs` | 渲染：合成与 ComfyUI 客户端 | ⬜ 同上 |

---

## 五、初稿与契约的差距（开工前必须先解决）

三份初稿是在契约已冻结、但实现者手上没有可跑环境的情况下写的，**目录约定和拆分思路是对的，
可以直接沿用**；问题集中在**输出形状**上：三份 `sample.js` 都不符合契约，
而 `prompt.js` 里给模型的 JSON 输出模板也是同一个错误形状。

**只改 `sample.js` 不改 `prompt.js` 等于没改**——`prompt.js` 里那段 JSON 模板就是给大模型的字段规格，
模型会照着它输出，离线时用 sample 兜底，两条路径必须同一个形状。

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

### 还有一个对象错位，需要团队定一下

初稿把「质检」实现成了**审分镜**（`agents/qa/index.js` 的 `meta.role` = "审分镜是否忠实剧本/有电影感"），
而契约里 ⑤质检 审的是**生成出来的视频文件**（消费 `c05_gen_result`，产出 `c06_qc_report`）。
`sampleQAReject` 里"第 2 镜缺少合闸前的张力铺垫"属于分镜阶段的稿子评审，不是 c06 该记的东西。

两条路：

- **(a) 把 `agents/qa/` 改成对齐 c06**，审视频、用 ffprobe。分镜阶段的稿子评审交给 ②分镜 自检或人
- **(b) 保留这个前置审查**，但它是 c06 之外的第 8 道交接面，**需要新增契约**

契约要改必须三人一致同意（见第七节）。**我建议先走 (a)**，因为 c06 已经冻结且有示例通过校验，
改动成本最低；前置审查确实有价值，等跑通一轮之后再按第七节流程补契约。

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

所以 ①编剧、②分镜、③提示词 这三个 Agent 的 LLM 调用
**走云端 API 或各自开发机，完全不占 GPU**，可以和生成任务并行推进，
不受 `docs/gpu_protocol.md` 的排班约束。

⑤质检 里客观的部分（时长、帧率、分辨率、有无音轨）用 `ffprobe` 硬判，
**不要用 LLM 判这些**——能确定性判定的事不要交给概率模型。
主观部分（提示词遵循度、画面崩坏）才用 LLM 或人。
