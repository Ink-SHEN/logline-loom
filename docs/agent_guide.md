# Agent 开发指南

写给三个写 Agent 的人。**目标只有一个：你产出的 JSON 必须能被 `contracts/` 里的契约校验通过。**
Agent 内部怎么想、用什么模型、代码写成什么样，都可以各写各的；**交接形状不许各写各的**。

契约定义在 `contracts/film_agent_contracts.json`，**已经冻结**。
自己发明字段名是本项目目前最容易发生、也最贵的一类错误——它会同时崩掉另外两个人的代码。

---

## 〇、一分钟版

- [ ] 读完本文件第一节那 4 个文件（**不读不要开始写**）
- [ ] 建 `agents/<你的slug>/`，放 `prompt.js` / `sample.js` / `index.js` 三件套
- [ ] 输出形状**照抄 `contracts/examples.json` 里你那道契约**，一个字段名都不要改
- [ ] 记得套 `envelope` + `payload` 外壳，这是最容易漏的一层
- [ ] `prompt.js` 里写给模型的 JSON 模板，和 `sample.js` 里的形状**完全一致**
- [ ] 跑 `python contracts/validate_contract.py --contract <你的契约> --file <你的产物>`，看到 `[通过]` 再提交
- [ ] 提交前 `python contracts/validate_contract.py --selftest` 与 `python contracts/negative_test.py` 都过

---

## 一、动手前必读的 4 个文件，按这个顺序

| 顺序 | 文件 | 读什么 | 为什么必须先读 |
|---|---|---|---|
| 1 | `contracts/film_agent_contracts.json` | 只找**你产出那道契约**的 `$defs/c0X_*`，看 `payload.required` 和每个字段的含义 | 这就是你的验收标准。你写代码之前就得知道会被怎么检查 |
| 2 | `contracts/examples.json` | 同名键那一整块 | **这是一份已经通过校验的真实形状**。照它的嵌套层级和字段名抄，比读 Schema 快得多 |
| 3 | `agents/README.md` | 第一节角色表、第五节「初稿与契约的差距」 | 边界、归属、关口，以及前人踩过的那个坑具体长什么样 |
| 4 | 你**上游**那道契约的示例 | `examples.json` 里上游的键 | 你的输入长这样。上游是 mock 的也没关系，形状是真的 |

再加两个按需：写 ③④⑤⑥ 的要看 `docs/gpu_protocol.md`（GPU 排队与实测耗时）和 `workflows/node_id_map.json`；
写 ⑤⑦ 的要看 `shots/meta_template.json`。

先跑一次这个，把 7 道交接面看一遍：

```bash
python contracts/validate_contract.py --list
```

---

## 二、编号对照：`c0X` 和 `①..⑦` 不是一套数字

- `c0X` = 第 X 道**交接面**（契约）。
- `①..⑦` = 第 X 个 **Agent**。
- 规则：**Agent n 消费 `c0n`、产出 `c0(n+1)`**（n = 1..5、7）。
- 唯一例外：⑥重试 消费 `c06` 的 fail 分支，产出**新的 `c04`**，把流程退回 ④生成。

| 你是 | 输入用 | 你必须产出 |
|---|---|---|
| ①编剧 | `c01_brief` | `c02_screenplay`（**带强制人工关口**） |
| ②分镜 | `c02_screenplay` | `c03_shotlist` |
| ③提示词 | `c03_shotlist` | `c04_gen_request` |
| ④生成 | `c04_gen_request` | `c05_gen_result` |
| ⑤质检 | `c05_gen_result` | `c06_qc_report` |
| ⑥重试 | `c06_qc_report`(fail) | 新的 `c04_gen_request` |
| ⑦剪辑 | `c06_qc_report`(pass) | `c07_edit_decision`（**带强制人工关口**） |

`validate_contract.py --list` 行首的数字标的是**契约**，上表行首标的是 **Agent**，别看串了。

**判断"算不算一个 Agent"的标准是有没有契约边界，不是有没有调用大模型。**
④生成 和 ⑥重试 很可能一行 LLM 都不调（就是 HTTP + 轮询 + 换种子），但它们仍然是流水线上独立的两个工位。

---

## 三、标准骨架：一个文件夹 = 一个 Agent

以 ③提示词（`prompt-writer`）为例。

### `agents/prompt-writer/prompt.js` —— 人格

```js
// agents/prompt-writer/prompt.js — 「提示词」Agent 的人格(system prompt)。
// 想改措辞偏好、镜头语言癖好，只改这一个文件。
export const PROMPT_WRITER = `你是位提示词工程师，负责把分镜逐条翻译成 MiniMax-H3 可用的英文提示词。
脾气：只写画面里真实存在的东西，不堆形容词，不写模型做不到的事。

必须【只】输出一个 JSON 代码块，结构严格如下，不要输出 JSON 以外的任何文字：
\`\`\`json
{ "envelope": { ... 照抄 examples.json 的 c04_gen_request.envelope ... },
  "payload":  { ... 照抄 examples.json 的 c04_gen_request.payload ... } }
\`\`\`
注意：节点 ID 一律从 workflows/node_id_map.json 查，不许写死在提示词里。`;
```

> 反引号在 JS 模板字符串里必须转义成 `` \` ``，否则整个文件语法就坏了。
> 上面代码块里的 `\`\`\`json` 是有意写成转义的，抄过去之后**别把它「修好」**。

### `agents/prompt-writer/sample.js` —— 离线兜底

```js
// agents/prompt-writer/sample.js — 离线降级示例产物。
// SDK / 鉴权不可用时 runAgent 返回它，保证流水线照常出片；同时是输出 JSON 的活文档。
export const sampleGenRequest = `{ ...这里放一份符合 c04_gen_request 的完整 JSON... }`;
```

### `agents/prompt-writer/index.js` —— 入口 + 元信息

```js
// agents/prompt-writer/index.js — 「提示词」Agent 的自包含入口。
export { PROMPT_WRITER } from './prompt.js';
export { sampleGenRequest } from './sample.js';

export const meta = {
  name: '提示词',
  slug: 'prompt-writer',
  role: '把分镜逐条翻译成英文提示词 + 时间码 + <Picture N> + 节点 ID 映射',
  promptExport: 'PROMPT_WRITER',
  sampleExport: 'sampleGenRequest',
  contract: 'c04_gen_request',
};
```

不调 LLM 的工位（④⑥）可以不建 `prompt.js`，但 `sample.js` + `index.js` 仍然要有——
下游需要能 mock 你。

---

## 四、五条铁律

**1. 顶层必须同时有 `envelope` 和 `payload`，两个都必填。**
7 道契约顶层只有这两个键。直接从 `scenes` / `shots` 开始写 = 一定不通过。

`envelope` 五项必填：`schema_version` / `artifact_id` / `contract` / `created_at` / `producer`。
`producer` 是对象：`{ "kind": "agent", "name": "你的名字", "agent_version": "0.1.0" }`。

**2. `envelope.contract` 必须等于你正在满足的契约名。**
写成 `c02_screenplay` 就得真是 `c02_screenplay`。校验器会明确报这个不一致。

**3. 字段名、层级、枚举值大小写，一律照抄 `examples.json`。**
JSON Schema 的 `enum` **区分大小写**。`"PASS"` 不合法，只有 `"pass"` / `"pass_with_notes"` / `"fail"`。
`workflow_type` 同理，只有 `"T2V"` / `"I2V"` / `"R2V"`。

**4. 关口契约必须带 `gate`。**
①编剧（c02）和 ⑦剪辑（c07）的输出里必须有 `payload.gate`，`human_gate` 要求 `required` + `status` 两项。
缺了它，校验器直接判不通过，下游拿不到放行产物——**这正是设计意图**：人机边界是机器拦的，不是君子协定。

**5. 多余字段不报错，但等于没写。**
契约没设 `additionalProperties: false`，所以你多写 `caption`、`reasons` 之类不会失败，
可下游读不到、也没有任何测试保证它存在。要加字段，走第八节的契约变更流程，别私自带。

---

## 五、自检：提交之前一定跑

契约里没写的东西不算数，**校验通过才算交付**。

### 第 1 步：把 `sample.js` 里的 JSON 单独存成文件

`sample.js` 导出的是一个 JS 模板字符串，两个反引号之间的内容就是纯 JSON。
把那一段原样复制到 `artifacts/sample_c04.json`（`artifacts/` 目录自己建）。

> `artifacts/` **没有**被 `.gitignore` 排除，所以 `git add` 前看清楚，别把一堆中间产物一起提交进去。

### 第 2 步：校验它

```bash
python contracts/validate_contract.py --contract c04_gen_request --file artifacts/sample_c04.json
```

通过时输出（退出码 `0`）：

```
[通过] artifacts/sample_c04.json 符合 c04_gen_request
```

不通过时会逐条列出缺什么（退出码 `1`）。真实例子——这是①编剧初稿跑出来的结果：

```
[不通过] artifacts/_probe_c02.json 违反 c02_screenplay，共 4 处：
    (根): 'envelope' is a required property
    (根): 'payload' is a required property
envelope.contract = None，但按 'c02_screenplay' 校验。二者必须一致
这是强制人工关口（剧本确认），但 payload.gate 缺失
```

看不懂报错没关系，**每条都直接写了缺哪个字段**，照着补就行。退出码 `0` 通过 / `1` 有不通过 / `2` 用法错误。

### 第 3 步：确认没把契约本身弄坏

```bash
python contracts/validate_contract.py --selftest    # 7 份官方示例应全部通过
python contracts/negative_test.py                   # 8 种真实错误应全部被抓到
```

两个都过才提交。批量校验自己的产物目录用 `python contracts/validate_contract.py --dir artifacts/`（自动认类型）。

---

## 六、用 Qoder 生成 Agent 代码时，把这段丢给它

你们的代码主要靠 Qoder 生成。生成 Agent 时**必须把契约文件喂给它**，否则它会自己发明一套字段——
①②⑤ 三份初稿就是这么来的。可直接复制下面这段，替换三处尖括号：

```
我要实现 LOOM 项目的 <③提示词> Agent，目录建在 agents/<prompt-writer>/。

先完整读这两个文件再动手：
1. contracts/film_agent_contracts.json 里的 $defs/<c04_gen_request> —— 这是我必须满足的 Schema
2. contracts/examples.json 里的 <c04_gen_request> —— 这是已通过校验的真实形状，照抄结构与字段名

要求：
- 输出顶层必须是 envelope + payload 两段式，envelope.contract 常量等于 <c04_gen_request>
- 字段名与枚举值大小写严格照 examples.json，不要发明新字段，不要合并字段
- 按 agents/README.md 第二节建三件套：prompt.js / sample.js / index.js（含 meta）
- prompt.js 里给模型的 JSON 输出模板，必须与 sample.js 的形状逐字段一致
- 写完自己跑 python contracts/validate_contract.py --contract <c04_gen_request> --file <产物>，
  必须看到 [通过] 才算完成，把命令输出贴给我
- 参考 docs/agent_guide.md 第四节五条铁律
```

**关键在最后一条：让它自己跑校验并把输出贴给你。** 你不跑校验，它就不知道自己想多了。

---

## 七、七个工位各自的落点与坑

| Agent | 必须做到的 | 会踩的坑 |
|---|---|---|
| ①编剧 | 产出 `scenes[]`（每项 6 个必填：`scene_id`/`location`/`time_of_day`/`summary`/`characters[]`/`beats[]`）、`emotion_curve[]`、`dialogue_language`、`gate` | 关口没批就是没批，**不要自己把 `gate.status` 写成 `approved`**。这是留给人点的 |
| ②分镜 | **每个镜头必须标 `workflow_type`**（T2V/I2V/R2V）+ `duration_seconds` + `shot_size` 与 `camera_move` 分开写 + `scene_id` | 时长写**秒（浮点）**，不要写帧数——下游会换算并对齐到 17 的倍数。建议顺手给 `batch_plan`，GPU 按工作流类型分批入队靠它 |
| ③提示词 | 英文提示词 + 时间码 + `<Picture N>` 约定 + 节点 ID 映射 | H3 **没有 `negative_prompt`，也没有 CFG**，设不了就别写。节点 ID 从 `workflows/node_id_map.json` 查，**不许硬编码**；T2V/I2V 的 ID 是子图摊平后的复合编号（`"140:131"`），写 `workflow["131"]` 取不到 |
| ④生成 | POST `/prompt` 拿 `prompt_id` → 轮询 `GET /history/<prompt_id>` → 落盘 → 记录**完整参数快照与产物哈希** → 产出 c05 | ①ComfyUI **会缓存完全相同的输入**，0 秒返回旧文件，所以「一个镜头多候选」**必须换种子**；②参考图素材要先 `POST /upload/image`，否则报 `Value not in list: image`；③热态单镜头 2–4 分钟、冷启动多花约 7 分钟，按 `docs/gpu_protocol.md` 排队 |
| ⑤质检 | **逐镜头、逐候选**出报告；客观项（时长/帧率/分辨率/有无音轨）用 `ffprobe` 硬判填进 `checks[]`；`verdict` 小写；必须给 `route_to` | 能确定性判定的事**不要交给 LLM**。`route_to` 是 ⑤→⑥/⑦ 的分流开关，漏了它重试闭环直接断。`sample.js` 里留一条 fail 样例是有用的（⑥和⑦ 要 mock 两种分支） |
| ⑥重试 | 消费 fail 的 c06，产出**新的 c04**；主要手段是换种子；**必须受 `max_retries` 约束** | 忘记收敛 = 无限烧 GPU，这是全项目最贵的一类 bug。改提示词可以，但别顺手改 `workflow_type`（会打乱 GPU 分批） |
| ⑦剪辑 | 出 `c07_edit_decision`：时间码、转场、混音、字幕、AI 生成标识 | c07 也是**强制人工关口**，`gate` 必填。字幕只在 c07 出现，别塞进 c03 |

---

## 八、提交与协作

### 日常提交

```bash
cd /d/StudyMaterial/ModelscopeProject/LOOM
git status                    # 先看自己改了什么
git pull                      # 拉组员的新改动，先跑校验
python contracts/validate_contract.py --selftest
git add <你改的文件路径>       # 建议按文件加，别惯用 -A
git commit -m "feat(agents): ③提示词 Agent 初版，输出满足 c04_gen_request"
git push                      # 卡住/超时是网络抖动，重试 2~5 次
```

`git push` 被拒（`Updates were rejected...`）说明组员先推了，跑 `git pull --rebase` 再 `git push`。

**别人（含 Qoder）生成的代码，不要看都不看就 `git add -A`。** 上面那三个初稿就是这样进去的。

### 要改契约，必须走这 5 步

1. 在 issue 里说明改哪个字段、为什么、影响哪几个 Agent
2. **三人一致同意**
3. 改 `contracts/film_agent_contracts.json`，**同步改** `contracts/examples.json`
4. 跑 `--selftest` 与 `negative_test.py`，两个都过
5. 在 `docs/decisions/` 补一条决策记录

单方面改一行契约 = 另两个人代码全崩。

---

## 九、症状 → 原因 → 修法

| 症状 | 原因 | 修法 |
|---|---|---|
| `'envelope' is a required property` | 忘了套外壳，从 payload 层直接开始写 | 把现有内容整体缩进进 `"payload": { ... }`，再补 `envelope` |
| `envelope.contract = None，但按 'cXX' 校验` | `envelope.contract` 漏写或写错 | 填成你这道契约的准确名字，一字不差 |
| `这是强制人工关口，但 payload.gate 缺失` | c02 / c07 忘带 `gate` | 加 `gate: {required: true, status: "pending"}`，批不批由人改 |
| `is not one of ['pass','pass_with_notes','fail']` | 枚举值大小写 | 全小写。`PASS` / `Reject` 都不行 |
| 下游 Agent 读不到你的字段 | 你自创了字段名 | 打开 `examples.json` 逐字段对齐，别问，直接抄 |
| 生成完拿回**同一个视频** | 输入完全相同，命中了 ComfyUI 缓存 | 换 `noise_seed` |
| `Value not in list: image` | 参考图没上传 | 先 `POST /upload/image`，再引用文件名 |
| `workflow["131"]` 取不到 | 用了子图内部 ID | 用完整复合编号 `workflow["140:131"]` |
| 跑 `node agents/xxx/index.js` 报 `SyntaxError: Unexpected token 'export'` | 仓库缺 `package.json`，Node 把 `.js` 当 CommonJS | 需要有人入库 `{"type":"module"}` 的 `package.json`，见第十节 |
| 工作流节点报错 / ID 找不到 | ComfyUI 升级或重新导出过模板 | 重跑 `python workflows/preflight.py` 与 `verify_map.py`，别直接改 JSON |

---

## 十、当前的阻塞项（谁先来解一下）

`agents/` 下三份初稿的**目录约定可以沿用，输出形状全都不合规**，
逐字段清单见 [agents/README.md 第五节](../agents/README.md)。另有：

| 缺什么 | 影响 | 谁 |
|---|---|---|
| `studio.mjs` / `prompts.js` / `tools/agent.mjs` / `tools/samples.js` / `tools/slideshow.mjs` / `tools/comfyui.mjs` 未入库 | 现有 9 个 JS 文件是孤岛，clone 下来跑不了 | 组员 gzsyl1 本地有，补一次上传 |
| `package.json`（含 `"type": "module"`） | `.js` 里的 `export` 在 Node 下直接语法错 | 同上，随 `studio.mjs` 一起进来 |
| ③④⑥⑦ 四个文件夹未建 | 流水线中间与后半段空着 | 按第二节认领 |

改之前先跑一次第五节那条校验命令，**亲眼看到那 4 条报错**，就知道要改成什么样了。
