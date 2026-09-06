# 创作手记 · 09-07（Day 3）分镜 Agent：对齐 c03_shotlist 契约 + LLM API 接入，从三件套到可执行管线

> 本段素材最终并入 09-13 提交用的《魔搭开发者实践创作手记》（衔接 09-06 编剧 Agent 手记「下一步」第 2 条：分镜初稿仍未对齐 c03，建议按同一套方法原地重写）。
> 范围：分镜 Agent（②）对齐 `c03_shotlist` 契约并接入 LLM 的全过程——输入一份已批准（gate=approved）的剧本 `c02_screenplay`，输出一份能过校验、含工作流选型与 GPU 分批计划的镜头清单。

---

## 〇、本段一句话

**把「剧本的场次 / 情绪曲线 / 台词语言」变成「逐镜头的 c03_shotlist：镜号 / 秒数 / 画幅 / 景别 / 运镜 / 画面描述 / 声音描述 / 工作流类型（T2V｜I2V｜R2V）+ GPU 分批计划」，LLM 经与编剧同一套 OpenAI 兼容 API 接入，调不通自动降级离线示例，流水线不断。**

本段没有碰契约文件——`contracts/` 零改动（`--selftest` 7/7、`negative_test.py` 8/8 复跑通过）。

---

## 一、起点：三份初稿时代的「分镜问题」

分镜初稿的问题和编剧初稿同源，但更彻底：**自创的 7 个字段与契约的 10 个必填字段无一同名**。

| 契约要求（每镜必填） | 初稿实际 |
|---|---|
| `shot_id` / `scene_id` / `order` | `id`（整数）/ `frame`（帧号，还绑死三张示例帧）——丢了镜头归属场景，无法追溯 |
| `duration_seconds` | `seconds`——不算错名字，但容易写串成帧数（下游要对齐到 17 的倍数） |
| `aspect_ratio` | 缺 |
| `shot_size` + `camera_move` | 合并成一个 `shotType: "大远景 · 缓推"` 字符串，契约要求拆成两个枚举字段 |
| `visual_description` / `audio_description` | `visual` / `sfx`——`caption`（字幕）根本不属于 c03，是 ⑦剪辑 在 c07 的事 |
| `workflow_type` | **缺，最要命的一项**。它决定 ③提示词 选哪份 ComfyUI 工作流、GPU 按什么类型分批，缺了它生成排程没有依据 |

同样套用 README 的判断：目录约定（一个文件夹 = 一个 Agent）是对的，错的只是输出形状，**骨架是提示词生成的，重写成本低于对齐成本**。**决定：原地重写 `agents/storyboard/` 三件套并新增两个文件**，输出形状与 `contracts/examples.json` 的 `c03_shotlist` 逐字段一致。

---

## 二、做了什么（文件级清单）

| 文件 | 动作 | 要点 |
|---|---|---|
| `agents/storyboard/prompt.js` | 重写 | 分镜师人格 + c03 输出模板（模板与 sample.js 逐字段一致）。硬规则：`shot_id` 三位编号按播放顺序、`scene_id` 必须来自剧本（不许发明）、每镜 1–15 秒 / 目标 4–8 秒且**写秒不写帧**、`aspect_ratio` 锁 `16:9 (Widescreen)`、景别与运镜拆两字段、9 条情绪曲线节奏规则、c03 无人工关口（每镜 gate 一律 `not_required` 占位）、字幕归属 c07 禁止外溢 |
| `agents/storyboard/sample.js` | 重写 | 离线兜底产物：完整 c03 形状，内容与编剧 sample《启明 / First Light》三场十拍一一对应（10 beat → 10 镜，共 66 秒，与剧本 `total_estimated_seconds` 精确相等）；T2V 6 / I2V 1 / R2V 3，三种工作流都有示范 |
| `agents/storyboard/index.js` | 更新 | `meta` 补 `contract: 'c03_shotlist'` 并导出可编程入口 `runStoryboard` |
| `agents/storyboard/llm.js` | 新增 | **LLM API 接入**：与 `screenwriter/llm.js` 同一份客户端的副本——OpenAI Chat Completions 兼容、原生 fetch、零第三方依赖；`LOOM_LLM_BASE_URL` / `LOOM_LLM_API_KEY` / `LOOM_LLM_MODEL` 环境变量配置，Key 自动回退识别 `MODELSCOPE_API_KEY` / `DASHSCOPE_API_KEY` / `OPENAI_API_KEY`，默认魔搭 API-Inference；只对 429 / 5xx / 网络错误退避重试。README 约定共享调用管线最终落 `tools/`，入库前各 Agent 先自包含一份，届时一并迁移 |
| `agents/storyboard/run.js` | 新增 | 可执行管线（CLI + 可编程双入口）：`--screenplay <c02 路径>` 必填 → **先查人工关口，未 approved 直接阻塞（exit 1）** → 上游过 python 校验才开工 → LLM 生成（结构不过回灌纠错一轮）→ 规范化 → JS 自检 + python 权威校验 → 失败降级 sample |

---

## 三、关键设计决策（为什么这么做）

### 1. 三种工作流怎么选——把选型标准编进人格，而不是留给模型自由发挥

`workflow_type` 是 c03 里唯一一个「选错会白烧一整轮 GPU」的字段（FL2VA 与 Ref2VA 权重不能同时常驻，换批要重载 21 GB+）。所以 prompt.js 把选型口径写成硬规则，依据 MiniMax-H3 官方模型卡与 ComfyUI 模板实测：

- **T2V**（FL2VA 模型）：氛围镜头和空镜、科幻概念快速预演、带环境音/音乐/对白的单镜头、角色造型未定时的视觉探索。不带任何参考素材。
- **I2V**（同样加载 FL2VA）：手上有一张确定的首帧时用——最典型是取上一镜头选中候选的定格帧作首帧，保证画面与光影衔接。一个契约细节值得记录：H3 的 I2V 模板其实支持首帧 / 尾帧 / 首尾帧三种连法，**但本项目 c04 契约的素材位只有 `first_frame`**——尾帧用法写不进下游，所以 prompt 里明确「一律按首帧衔接设计」，不把做不了的事教给模型。
- **R2V**（Ref2VA 模型）：需要锁角色身份 / 场景风格 / 动作 / 音色时用——凡角色跨镜头复现的优先 R2V，靠定妆参考集锁造型。素材上限原样编码：图 ≤9、视频 ≤3 段（每段 2–15s、总长 ≤15s）、音频 ≤3 段（不能作唯一输入）、合计 ≤12 文件。
- 附带一条**调度纪律**：同角色 / 同场景的镜头集中选型，减少换批次数——这直接决定 ④生成 的 GPU 排班能不能连跑。

### 2. 关口是机器拦的，消费方这边第一次真正「被拦了一次」

编剧侧（09-06 手记第 3 节）学会的是「产出方把 gate 留 pending 等人工」；分镜侧把同一原则换到**消费方视角**：`payload.gate.required=true 且 status != approved` 时，run.js 直接抛错退出（exit 1），错误信息里带「人工批准四步操作指引」。测试里拿 pending 的剧本跑，机器真的拦住了——人机边界不是文档里的君子协定，是代码路径上的一道闸。

### 3. 确定性字段全部归代码，不归概率模型

`normalize()` 接管了模型不该碰的一切：

- `shot_id`（S001 起）与 `order` 按模型输出的**数组顺序**重编——播放顺序由数组决定，编号不可能跳号或重复
- `aspect_ratio` 一律覆盖为 `16:9 (Widescreen)`
- `needs_reference_assets` 由 `workflow_type` 推导（I2V/R2V 恒 true，T2V 恒 false）——模型就算写反也被抹掉
- 每镜 `gate` 无条件写 `{ required: false, status: "not_required" }`（c03 不是关口，纯占位）
- **`batch_plan` 整体由代码重算**：按镜头数组把 T2V+I2V 归入 `fl2va_shots`、R2V 归入 `ref2va_shots`，`candidates_per_shot` 由 CLI `--candidates` 定。GPU 分批是排程正确性的核心，手写必错，程序算必对

### 4. c03 与 c02 的「gate 学」不同，产物校验不需要编剧侧的技巧

编剧产物 gate=pending，拿去校验器直验必报「关口未通过」，所以 09-06 的 run.js 用 approved 临时副本做结构校验。**c03 没有强制关口**，每镜 gate 只是占位——所以分镜产物可以直接过校验器，run.js 少一层「副本校验」的复杂度。反过来，分镜消费的上游 c02 带关口，校验顺序是：JS 查 gate（给人能看懂的中文阻塞信息）→ python 校验 c02（守其他结构错误）→ 才轮到 LLM。

### 5. LLM API 接入：接口化 + 一次纠错轮 + 离线兜底

与编剧同构：不写死任何一家 provider（魔搭 / DashScope / OpenAI / 本地 vLLM 一套代码切），LLM 第一把输出过不了结构自检就把**错误清单原样回灌**，给一轮修正机会；再不过降级 sample（`notes` 诚实标注「内容不对应输入剧本，仅形状合规」）。本机没有配 API Key，因此 API 路径用**本地 mock 的 OpenAI 兼容端点**实测（见下节），不是声称「应该能跑」。

### 6. 一个真实的跨批依赖：I2V 首帧来自上一批的 R2V 候选

sample 的 S007（I2V）首帧取 S006（R2V）选中候选的定格帧——S006 在 Ref2VA 批、S007 在 FL2VA 批。这暴露了 batch_plan 的边界：**分批只解决「权重常驻」，不解决「候选依赖」**。I2V 镜头真正入队前，必须先等上游 R2V 镜头产出并人工选定。这条依赖在 `reference_note` 里写成数据（「首帧取 S006 选中候选的定格帧」），提醒 ③④ 按依赖序排生成，而不是按镜头号排。

---

## 四、验证（全部实测，不是声称）

| 场景 | 结果 |
|---|---|
| sample 落盘直验 | `[通过] ... 符合 c03_shotlist`，exit 0 |
| 剧本 gate=pending（未批） | **exit 1，机器阻塞**，报错信息含批准操作指引——关口语义正确 |
| 剧本 gate=approved + `--offline` | exit 0；产物 JS 自检 + python 校验双过；10 镜 / 66s / T2V 6·I2V 1·R2V 3 / FL2VA 批 7 镜·Ref2VA 批 3 镜 |
| **API 路径（mock OpenAI 兼容端点）** | 本地 mock：第 1 把返回缺 `duration_seconds` 的坏 JSON → run.js 检出并回灌纠错 → 第 2 把通过。日志「LLM 生成成功（含一轮纠正重试）」，产物过校验，exit 0——**API 接入与纠错轮真实走通** |
| 参数边界：缺 `--screenplay` / `--candidates 99` | exit 2，报错指向契约原因 |
| 产物 envelope 追溯 | 落盘产物 `upstream_refs = [剧本的 artifact_id]`，producer 带 `agent_version 0.2.0` |
| 契约自检 / 反向测试 | `--selftest` 7/7 通过、`negative_test.py` 8/8 抓到，`contracts/` 零 diff |

---

## 五、失败与修正（本段素材，直接并入手记对应章节）

| 现象 | 归因 | 修正 |
|---|---|---|
| 初稿 7 字段与契约 10 必填无一同名 | 写初稿时契约已冻结但没照抄 examples | 按 09-06 已验证的方法原地重写：prompt 模板与 sample 逐字段对齐、跑校验看到 `[通过]` 才算完 |
| 一度把 I2V 的「尾帧 / 首尾帧」写法教给模型 | 官方文档支持，但 c04 契约素材位只有 `first_frame`，下游表达不了 | 读契约资产定义后，prompt 改为「一律按首帧衔接设计」，并注明原因 |
| bash 一行测退出码拿到 0 | 管道 `node ... \| head` 里 `$?` 取到的是 head 的退出码 | 测试命令去掉管道直取 `$?`；真实退出码语义 0/1/2（通过/阻塞/用法错） |
| 命令行内联 JS 里写 `//` 注释被 shell 工具误判为 UNC 路径拒执行 | 工具的安全启发式把行首 `//` 当网络路径 | mock 端点脚本落成临时 `.mjs` 文件再跑，用后即删 |
| 每次跑校验器都会覆盖 git 里已跟踪的 `contracts/validate_report.txt` | 校验器默认把报告写在契约目录 | 手动校验一律 `--report` 重定向临时文件，跑完即删（沿用 09-06 的教训） |

---

## 六、下一步

1. **③提示词 Agent 待建**（`agents/prompt-writer/`）：消费本段产出的 c03，按 `workflow_type` 选工作流模板、按 `batch_plan` 分批，产出 c04_gen_request——它的输入长什么样，现在有了真实形状的样本
2. **人审剧本并批准 gate**：把 ①→② 真实串起来跑一遍（①产出 → 人批 → ②分镜），验证全链路而不只是 mock
3. **`prompts.js` / `tools/agent.mjs` / `studio.mjs` 仍未入库**——两个 Agent 各自自包含一份 llm.js，共享客户端归位 `tools/` 后要去重
4. 本段素材将在 09-13 并入创作手记终稿（「团队与流程」「失败与修正」章节）

## 附：复现命令

```bash
# 分镜 Agent（LLM 走 LOOM_LLM_* 环境变量；没配 Key 自动降级离线示例）
node agents/storyboard/run.js --screenplay artifacts/screenplay_*.json --offline   # 离线直出，先看形状
node agents/storyboard/run.js --screenplay artifacts/screenplay_*.json             # 配好 Key 后走 LLM API

# 人工批准剧本（c02 是强制关口，批准前分镜会拒绝开工）
python contracts/validate_contract.py --contract c02_screenplay --file artifacts/screenplay_*.json
# 最终产物关卡
python contracts/validate_contract.py --contract c03_shotlist --file artifacts/shotlist_*.json
```
