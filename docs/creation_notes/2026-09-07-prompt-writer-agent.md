# 创作手记 · 09-07（Day 3）提示词 Agent：对齐 c04_gen_request 契约 + LLM API 接入，LLM 只出创作部分、其余全部代码组装

> 本段素材最终并入 09-13 提交用的《魔搭开发者实践创作手记》（衔接 09-07 分镜 Agent 手记「下一步」第 1 条：③提示词 Agent 待建，消费 c03 产出 c04）。
> 范围：提示词 Agent（③）从零新建 `agents/prompt-writer/` 的全过程——输入一份通过校验的镜头清单 `c03_shotlist`，输出每镜头 × 每候选一份、能直接落到 ComfyUI 节点上的 `c04_gen_request`。

---

## 〇、本段一句话

**把「分镜的镜头清单」变成「逐镜头 × 逐候选的 c04_gen_request：英文提示词 + 时间码 + `<Picture N>` + seed + 时长 + 画幅 + megapixels + 输出前缀 + 节点 ID 映射 + 素材引用」，英文创作交给 LLM（与 ①② 同一套 OpenAI 兼容 API），节点 ID / 编号 / 种子 / 素材位等确定性字段全部由代码组装，每份产物过契约校验，I2V/R2V 缺素材开工前阻塞。**

本段没有碰契约文件——`contracts/` 零改动（`--selftest` 7/7、`negative_test.py` 8/8 复跑通过）。

---

## 一、起点：c04 是全流水线「最靠近机器」的一道契约，照抄文档模板会出事

写 c03（分镜）时，初稿的问题是「自创字段名」；写 c04 遇到的是另一种坑：**文档给的骨架不能直接照抄**。

`docs/agent_guide.md` 第三节的标准骨架（本就用「③提示词」举例）要求：`prompt.js` 里给模型的 JSON 模板与 `sample.js` 形状逐字段一致，模型输出完整 c04（含 envelope 和 node_ids）。但 c04 有两个文档没替你消化的现实：

1. **c04 是逐候选的**（`payload.shot_id` + `candidate_id` 都是单值），一个镜头 3 个候选就是 3 份独立文件。让模型在一次输出里把整个镜头清单的 N×候选份完整 c04 全写出来，既有字段爆炸，又没法保证 `retry_of` / `node_ids` 不串；
2. **铁律「节点 ID 一律从 workflows/node_id_map.json 查，不许硬编码」与「让模型写 node_ids」互斥**——模型不会查文件，让它背 ID 就是在制造事故（分镜手记第五节已经记过 `workflow["131"]` 取不到复合编号 `140:131` 的教训）。

**决定：偏离文档骨架，拆成「LLM 中间形状 + 代码组装」两段式。** LLM 只产出创作部分 `{ shots: [{ shot_id, prompt, timecodes }] }`，一次调用覆盖全部镜头；代码拿到后扇出成「每镜头 × 每候选」的完整 c04。文档骨架的另一半（输出形状与 sample.js 逐字段一致）通过「组装后的 c04 与 sample.js 同口径、逐份过契约校验」来兜住。

---

## 二、做了什么（文件级清单）

| 文件 | 动作 | 要点 |
|---|---|---|
| `agents/prompt-writer/prompt.js` | 新增 | 提示词工程师人格 + **中间形状**输出模板（不是完整 c04——见第一节）。硬规则：全英文、时间码只用整数秒且段段相接、景别/运镜译成具体电影语言、声音收尾写 `Audio:`、画外音中文台词可留原文引号、I2V 必含 `<Picture 1>` 且只写运动不重复首帧静态内容、R2V 按顺序引 `<Picture N>` 并说明各锁什么、T2V 禁止 `<Picture`；同一 consistency_group 的英文用词保持一致 |
| `agents/prompt-writer/sample.js` | 新增 | **最终 c04 形状的活文档**（离线兜底已不用它——见设计 6）：选 R2V 镜头做示例（对应 storyboard sample 的 S004），因为它能同时示范 `assets.ref_images` 与 `<Picture 1>/<Picture 2>`；T2V 的更简形态 `contracts/examples.json` 已有，不重复。节点 ID 全部照抄真实映射表（r2v：`138`/`129`/`132`…） |
| `agents/prompt-writer/sample_assets.json` | 新增 | 素材清单格式示例：键 = `shot_id`（S007，优先）或 `consistency_group`（watchman，组内共用）；I2V 给 `first_frame`，R2V 给 `ref_images`（≤2）+ `ref_image_size`；每个 asset_ref 带 node_filename / source_path / license / generated_by |
| `agents/prompt-writer/llm.js` | 新增 | **LLM API 接入**：第三份共享客户端副本（screenwriter / storyboard / prompt-writer 各自包含一份，README 约定共享管线最终落 `tools/` 时去重）。OpenAI Chat Completions 兼容、原生 fetch、零依赖；`LOOM_LLM_BASE_URL` / `LOOM_LLM_API_KEY` / `LOOM_LLM_MODEL` 配置，Key 自动回退识别 `MODELSCOPE_API_KEY` / `DASHSCOPE_API_KEY` / `OPENAI_API_KEY`，默认魔搭 API-Inference；只对 429 / 5xx / 网络错误退避重试 |
| `agents/prompt-writer/run.js` | 新增 | 可执行管线（CLI + 可编程双入口）：`--shotlist <c03 路径>` 必填 → 上游过 python 校验才开工 → 读 `workflows/node_id_map.json`（git 短 hash 进 `node_ids.source`）→ 解析素材清单，I2V/R2V 缺素材**开工前阻塞** → LLM 生成（结构不过回灌纠错一轮）→ 代码组装 → JS 自检 + python 逐份校验 → 失败降级机械拼装骨架 |
| `agents/prompt-writer/index.js` | 新增 | `meta` 带 `contract: 'c04_gen_request'`，导出 `PROMPT_WRITER` / `sampleGenRequest` / `runPromptWriter` |
| `agents/README.md` | 更新 | 状态表 ③ 行：`⬜ 待建` → `✅ 初稿已入库`（注明对齐 c04 并过校验、接入 LLM API、附 run.js 管线与素材清单示例） |

---

## 三、关键设计决策（为什么这么做）

### 1. 两段式：LLM 只写创作，代码持有机器字段

模型输出 `{ shots: [{ shot_id, prompt, timecodes }] }`，run.js 的 `assembleDoc()` 把它扇出成候选级 c04 并接管全部确定性字段：

- `envelope`：`artifact_id = genreq.<candidate_id>.<时间戳>`、`producer = prompt_agent`、`upstream_refs = [镜头清单的 artifact_id]`——追溯链从 ① 编剧一路连到本段；
- `node_ids`：**运行时从 `workflows/node_id_map.json` 现查**，只取 c04 需要的语义键（prompt / seed / duration_seconds / aspect_ratio / megapixels / filename_prefix / fps / turbo_enabled / steps_normal / steps_turbo），`source` 字段带 git 短 hash；T2V/I2V 的复合编号（`105:104`）由映射表原样给出，代码从不去猜；
- `api_json` 由 `workflow_type` 查表（T2V→`workflow_api_t2v.json`，依此类推）；
- `seed = --seed-base + 镜头序号×100 + 候选号`——同镜各候选必不同，否则命中 ComfyUI 缓存 0 秒返回旧文件；跨候选唯一性有专门的自检（`crossCheck`）；
- `filename_prefix = shots/<candidate_id>`（每候选独立前缀，三份模板默认都是 `video/MiniMax_H3`，不改的话产物挤在一起无法归档）；
- `duration_seconds` 原样抄镜头清单的秒数，禁止写帧数；`aspect_ratio` 锁 `16:9 (Widescreen)`；`fps=24`、`steps` 按 turbo 开关取 20 /（FL2VA 8、Ref2VA 4）。

### 2. 素材清单化 + 开工前阻塞：把「白烧 GPU」拦在 LLM 之前

c04 的契约 allOf 规定 T2V 空素材、I2V 必带 `first_frame`、R2V 必带 `ref_images`——填错会白烧一整轮 GPU 才在 ComfyUI 里报 `Value not in list: image`。所以素材不进提示词、不进 LLM 上下文，而是走**独立清单文件**（`--assets`），由代码解析后逐镜匹配：`shot_id` 精确命中优先，其次 `consistency_group` 组内共用（同一组镜头的定妆参考集只写一次）。任何 I2V/R2V 镜头缺条目，**在调用 LLM 之前就 exit 1 阻塞**，报错按 `reference_note` 列出每个镜头缺什么、怎么补——既省 token 又省 GPU。

清单解析还拦了两类「契约合法但模板做不到」的写法：

- `ref_images` 契约上限 9 张，但实测 R2V 模板只接了 2 个图位（`ref_image_0/1`，node_id_map warnings 明说「要更多须在画布加线重导」）——按模板现实收紧为 ≤2 并报错指引；
- `ref_videos` / `ref_audios` 契约里合法，但三份模板没有对应接线——清单里出现直接报错拒收，不把 POST 必失败的东西放进产物。

### 3. 时间码是「砌砖」不是「分句」：格式、铺满、逐字出现三条硬规则

`generation.prompt` 用 `[0s-3s]` 分段描述，质检要拿它核对画面节奏，所以结构性校验里对时间码做了确定性检查（这部分不能只靠模型自觉）：① 每条匹配契约 `^\[[0-9]+s-[0-9]+s\]$`（整数秒）；② 从 `0s` 开始、段段相接不重叠、**收在 `ceil(duration_seconds)`**（duration 允许小数，6.5 秒的镜头契约只认整数时间码，取上整 7）；③ 每个时间码必须逐字出现在 prompt 里。任何一条不过就回灌给模型纠一轮。

`<Picture N>` 的序号同理是机器可查的：I2V 必须含 `<Picture 1>`（对应 `first_frame`），R2V 按 `ref_images` 数量必须含 `<Picture 1>..<Picture N>`（对应 `ref_image_0/1` 接线顺序），T2V 出现任何 `<Picture` 都算错——序号写错等于指错图。

### 4. 一条 LLM 调用产出全部镜头的创作部分，代码扇出成候选

没按「每镜头调一次」或「每候选调一次」：c03 可能 20–30 个镜头，逐镜调用贵且慢；创作层面同镜各候选**共享同一份 prompt**（契约规定多候选靠换 seed，不靠改提示词）。所以一次调用拿回全量 `{shots:[…]}`，代码按 `candidates_per_shot` 扇出 `_c01.._c0N` 并换 seed——LLM 一次，文件 N×候选份。

### 5. 与 ② 同构的质量闸：结构不过回灌纠错一轮，真不行才降级

LLM 第一把输出先过中间形状检查（缺镜头 / 多镜头 / 字段类型）再过逐文档结构自检（时间码铺满 / `<Picture>` 约定 / 素材位 / 常量字段），错误清单带镜头定位原样回灌，给一轮修正机会；再不过走降级。**验证用本地 mock 实测走通**（见第四节），不是声称「应该能跑」。

### 6. 离线降级不整份返回 sample——和 ①② 不一样的取舍

编剧 / 分镜的离线兜底是整份返回 sample（README 约定「保证流水线照常出片」），但 c04 是逐候选产物：拿一份固定 sample 广播成 30 份，形状合规、内容全是同一个控制室镜头，等于把废品送进 ④生成。所以降级改成**机械拼装提示词骨架**：按每个镜头的真实字段拼英文句式（景别短语 + 运镜短语 + 画面描述 + `<Picture N>` 占位句 + `Audio:` 声音描述 + 按秒数均分的时间码），内容对应真实输入，只是未经润色；`envelope.notes` 与终端日志都诚实标注「机械拼装，需人工复核」。sample.js 降级为「形状活文档 + 下游 mock 输入」两用，这个取舍写进了 sample.js 的文件头注释。

### 7. 创作纪律直接编进人格：写实锚点、能力边界、用词一致性

`prompt.js` 要求：有风格锚点（`--style`，对应 c01 的 visual_style）就每条 prompt 原样开头，没有也要自拟统一开场句；不写 H3 做不到的事（复杂打斗 / 多人对口型 / 画面内文字，`negative_prompt` / CFG 在 H3 不存在，禁止提及）；台词一律画外音处理、中文台词可保留原文（出声音靠原词）；同 consistency_group 的镜头英文用词必须一致——这是 R2V 参考集之外的第二道一致性保险。

---

## 四、验证（全部实测，不是声称）

| 场景 | 结果 |
|---|---|
| sample.js 活文档直验 | `[通过] ... 符合 c04_gen_request`，exit 0 |
| 上游 c03 直验 | storyboard sample 过 `c03_shotlist` 校验后作为输入 |
| `--offline` 全流程 | exit 0；10 镜 × 3 候选 = **30 份 c04 逐份过 python 校验**，`--dir` 批量复验 0 个不通过；T2V 6 · I2V 1 · R2V 3 |
| **API 路径（本地 mock OpenAI 兼容端点）** | mock 第 1 把返回时间码不收口、缺 `<Picture>` 引用的坏 JSON → run.js 检出并回灌纠错 → 第 2 把通过。日志「LLM 生成成功（model=Mock-1，含一轮纠正重试）」，30 份产物全过校验，exit 0——**API 接入与纠错轮真实走通** |
| I2V/R2V 缺素材（不带 `--assets`） | **exit 1 阻塞**，逐个列出 S004–S007 缺什么、reference_note 原文、补法与清单格式指引 |
| 素材清单越界：ref_images > 2 / 带 ref_videos | exit 1，报错指向模板只接 2 图位 / 模板无视频音频接线 |
| 产物抽查 | S007（I2V）`node_ids` 为复合编号 `105:104`/`105:15`…，`assets.first_frame` 就位；S004_c01/c02 同 prompt 异 seed（1301/1302）；`filename_prefix = shots/S004_c02` |
| 参数边界：缺 `--shotlist` / `--candidates 99` / `--megapixels 99` | exit 2，报错指向契约原因 |
| 契约自检 / 反向测试 | `--selftest` 7/7 通过、`negative_test.py` 8/8 抓到，`contracts/` 零 diff |

注：真实 provider（魔搭 / DashScope）与 ComfyUI POST 未实测——本机没配 API Key、节点无权限，这两段留给 ④生成 Agent 联调时覆盖。

---

## 五、失败与修正（本段素材，直接并入手记对应章节）

| 现象 | 归因 | 修正 |
|---|---|---|
| 文档骨架让模型直接输出完整 c04（含 node_ids） | 没消化「节点 ID 禁止硬编码」与「c04 逐候选一份」两条现实 | 拆两段式：LLM 只出 `{shots:[{shot_id,prompt,timecodes}]}` 中间形状，机器字段全部代码组装（见设计 1） |
| 任务描述写 `<PictureN>`、契约与映射表写 `<Picture N>` | 引用格式口径不一 | 以 `workflows/node_id_map.json` 的 `prompt_ref` 为准（带空格），校验按 `<Picture k>` 逐字匹配 |
| R2V ref_images 契约上限 9、模板只接 2 图位 | 契约给的是模型上限，模板接线是另一回事 | run.js 按模板现实收紧为 ≤2 并报错指引「画布加线重导」，不把必失败的东西放进产物 |
| 离线兜底一度打算照 ①② 整份返回 sample | c04 逐候选，固定 sample 广播成 30 份全是废品 | 改成机械拼装骨架（内容对应真实输入），sample.js 专职当形状活文档（见设计 6） |
| 时间码端点对小数秒时长（如 6.5s）失守 | 契约时间码只认整数秒 | 校验统一按 `ceil(duration_seconds)` 收口，规则同时写进 prompt.js 人格 |
| 每跑一次校验都覆盖 git 已跟踪的 `contracts/validate_report.txt` | 校验器默认把报告写在契约目录 | 代码内一律 `--report` 重定向临时文件、跑完即删（沿用 09-06 / 09-07 的教训） |
| 完成日志里把首份产物 payload 的变量名写成 `bp` | 从分镜 run.js 抄结构时带过来的误导命名（那是指 batch_plan） | 改名 `firstPayload`，顺手清理注释 |

---

## 六、下一步

1. **④生成 Agent 待建**（`agents/generator/`）：消费本段产出的 c04 直接 POST ComfyUI。它的输入长什么样现在有了真实形状样本——每候选一份文件、`node_ids` 可直接索引、`filename_prefix` 已按镜头分好，④ 不该再碰任何提示词工程
2. **真机联调**：配好 LOOM_LLM_* 用真实 provider 跑一轮；素材按 `node_filename` 逐个 POST /upload/image 并重查 object_info；按 c03 `batch_plan` 分批入队（FL2VA 连跑、Ref2VA 单独时段）
3. **人工审剧本并批 gate**：把 ①→②→③ 真实串起来跑一遍（①产出 → 人批 → ②分镜 → ③提示词），验证全链路而不只是 mock
4. **`prompts.js` / `tools/agent.mjs` / `studio.mjs` 仍未入库**——三个 Agent 各有一份自包含 llm.js，共享客户端归位 `tools/` 后要去重
5. 本段素材将在 09-13 并入创作手记终稿（「团队与流程」「失败与修正」章节）

## 附：复现命令

```bash
# 提示词 Agent（LLM 走 LOOM_LLM_* 环境变量；没配 Key 自动降级机械拼装骨架）
node agents/prompt-writer/run.js --shotlist artifacts/shotlist_*.json --assets <素材清单.json> --offline   # 离线直出，先看形状
node agents/prompt-writer/run.js --shotlist artifacts/shotlist_*.json --assets <素材清单.json>             # 配好 Key 后走 LLM API

# 素材清单格式示例（键 = shot_id 或 consistency_group 组名）
#   agents/prompt-writer/sample_assets.json

# 最终产物关卡（每候选一份，全部要过）
python contracts/validate_contract.py --dir artifacts/genreq_<时间戳>/
```
