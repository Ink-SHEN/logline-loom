# space/

魔搭创空间部署。**Agent 赛道（进阶创作｜电影 Agent）的提交项。**

> 入口 `app.py` 在**仓库根目录**（创空间要求入口文件在根），真正逻辑在本目录的 python 包里。
> 完整部署十步流程见仓库外那份《魔搭创空间部署指南_LOOM.md》。

---

## 一、现在的目录

```
app.py                  Gradio 界面（入口，创空间要求）
requirements.txt        gradio / jsonschema / requests
space/
  config.py             运行配置：LLM 走环境变量；⑤ 的配置支持「界面运行时传入 > 环境变量」
  prompts.py            运行时解析 agents/*/prompt.js（人格只有一份，不复制）
  llm.py                OpenAI 兼容客户端，与 agents/*/llm.js 同构
  validate.py           复用 contracts/validate_contract.py（与本地命令行同一份代码）
  pipeline.py           ①片约 → ②编剧 → ③分镜 → ④提示词 的编排（Agent 之间的契约交接与闸门）
  generate.py           ⑤生成站：一层可插拔的模型 API 接口（**不内置生成模型**，支持界面填地址）
  fallback/             往期成片（4 段），仅作 ⑤ 站产物形态预览
```

**三处刻意不复制**：Agent 的人格（`agents/*/prompt.js`）、契约校验器（`contracts/`）、
工作流（`workflows/`）。创空间里跑的和你本地跑的是同一份，改一处两边同时生效。

## 二、⑤ 生成站：可插拔的模型 API 接口

创空间**不内置、也不绑定任何具体的视频生成模型**，也不依赖仓库外的任何私有节点。
①–④ 站把一句话拆成**逐镜头的标准化生成请求**；⑤ 站只做两件事：

1. 把 ④ 的每份 c04 生成请求翻译成一次**标准化 API 调用**（逐镜一份独立任务）；
2. 把结果（任务 ID / 进度 / 成片地址）**原样如实**带回界面。

**接入新模型 = 填一次地址，Agent 代码一行都不用改。**有两种填法：

| 填法 | 位置 | 适合 |
|---|---|---|
| **界面运行时填**（推荐试用） | 「⑤ 生成接口」页签顶部的面板：地址 / Key / 模型名 / 后端 / 等待上限 | 当场跑通，不动环境变量、不重新部署 |
| 环境变量 | 创空间 secrets（见第三节） | 长期接入 |

界面填的值**优先于**环境变量。界面填的 Key 只活在那一次请求里：**不落盘、不进日志**
（`config.GenSettings.__repr__` 已掩码，任务表只记主机名）。

地址只允许公网 `http/https`——创空间是公开服务，不能借它去探内网或云元数据端点（SSRF）；
本地调试跑在 `127.0.0.1` 时用 `LOOM_GEN_ALLOW_PRIVATE=1` 放行。

接口契约 v1（完整版见 `space/generate.py` 头部，界面「⑤ 生成接口」标签页同源）：

| 动作 | 请求 | 期望响应 |
|---|---|---|
| 提交 | `POST {LOOM_GEN_API_URL}/generations` | `{"task_id": "…", "status": "queued", "eta_seconds": 300}` |
| 查询 | `GET {LOOM_GEN_API_URL}/generations/{task_id}` | `{"status": "succeeded", "video_url": "https://….mp4"}` |

- 鉴权：`Authorization: Bearer {LOOM_GEN_API_KEY}`（Key 为空则不发送该头）
- 对模型侧唯一的硬要求：**能返回一个可播放的 mp4 URL**；同步/异步、有无进度、是否支持 seed 全部可选
- 同步后端在提交响应里直接给 `video_url` 也会被自动识别为已完成

### 三种状态，界面永远说真话

| 状态 | 触发条件 | 界面表现 |
|---|---|---|
| **已接入** | 地址已填（界面或环境变量）且通过校验 | 逐镜真提交，给出任务 ID，等待上限内自动取回成片，产物区标 **★ 本次生成** |
| **接口就绪** | 地址未配置 | 明说「等待接入模型」；④ 的生成请求照常产出；**不拿示例素材冒充本次生成** |
| **参考回放** | 后端切到 `replay` | 播放 `space/fallback/` 往期成片，产物区恒标注「参考回放（非模型生成）」，**不标 ★** |

## 三、环境变量（在创空间里配成 secrets，不进仓库）

| 变量 | 用途 | 是否敏感 |
|---|---|---|
| `LOOM_LLM_API_KEY` | LLM API Key（缺省回退 `MODELSCOPE_API_KEY`） | **secret** |
| `LOOM_LLM_BASE_URL` | 默认 `https://api-inference.modelscope.cn/v1` | 明文即可 |
| `LOOM_LLM_MODEL` | 默认 `Qwen/Qwen3.8-Flash-Next` | 明文即可 |
| `LOOM_GEN_API_URL` | ⑤ 生成接口基址，如 `https://<host>/v1`。**不配 = 接口就绪但未接入模型** | 明文 |
| `LOOM_GEN_API_KEY` | ⑤ 生成接口鉴权 Key | **secret** |
| `LOOM_GEN_API_MODEL` | 模型名，随提交请求发送；服务端不需要就留空 | 明文 |
| `LOOM_GEN_BACKEND` | `http`（默认）/ `replay`（内置参考回放） | 明文 |
| `LOOM_GEN_TIMEOUT` | 单次 HTTP 超时秒数，默认 30 | 明文 |
| `LOOM_GEN_WAIT_SECONDS` | ⑤ 提交后等待成片的秒数上限，默认 300（`0` = 只下发不等待） | 明文 |
| `LOOM_GEN_MAX_SHOTS` | ④ 最多为几个镜头产生成请求（⑤ 也就最多下发这么多），默认 8 | 明文 |
| `LOOM_GEN_ALLOW_PRIVATE` | 允许内网/环回地址（**仅本地调试**，生产不要开） | 明文 |
| `LOOM_LLM_TIMEOUT_MS` | 单次 LLM 调用超时，默认 300000（300 秒） | 明文 |
| `LOOM_LLM_FIX_ROUNDS` | 契约校验不过时回灌重生成的轮数，默认 3 | 明文 |
| `LOOM_RUN_BUDGET_SECONDS` | 整条 ①→④ 的**墙上时间预算**，默认 1200（20 分钟） | 明文 |

### 耗时上界是怎么保证的（2026-09-13 晚补）

④ 是**逐镜各调一次** LLM，而单次调用最坏 = `(1 + LOOM_LLM_FIX_ROUNDS)` 轮 ×
`(1 + retries)` 次 HTTP × `LOOM_LLM_TIMEOUT_MS`；按默认值单镜最坏 4 × 3 × 300 = 3600 秒，
8 镜叠起来是**小时级**。两道闸门把它压成有界：

1. **`LOOM_RUN_BUDGET_SECONDS`**（默认 1200 秒）：④ 在**开始每一镜之前**检查剩余预算，
   到点就不再开新的镜头；每次 `llm.chat` 的超时取 `min(LOOM_LLM_TIMEOUT_MS, 剩余预算)`，
   所以发出去的那次调用也不会拖着超期。
2. **`LOOM_GEN_MAX_SHOTS`**（默认 8）：真正截断镜头数（③ 只要 6–8 个，所以默认等于不设限）。

**默认配置下这两道闸门都碰不到**：正常一整片 3–5 分钟，单次超时也仍是 300 秒——
与加闸门之前**行为完全一致**（有断言 `5c` 守着）。它们只在「上游病态慢、原本会无限期挂住」
时才生效，且到点后的处理是**明说**：剩余镜头保留占位、`gen` 留空，
在 ④ 的 summary 与 ⑤ 的状态表里如实标 `skipped` 并写明「超出本次运行预算」——
不静默丢弃，更不拿示例素材冒充。

## 四、人工关口默认怎么处理

`c02_screenplay` 与 `c07_edit_decision` 是**强制人工关口**（`gate.required = true`），
Agent 不自批。创空间界面上：

- 默认勾选「自动批准人工关口（演示模式）」——为了一句 logline 能全自动跑通，
  批准者记成 `创空间自动批准（演示模式）`，界面上打 ⚠️ 明示
- 取消勾选 → 流程在剧本处**真的停下**，下游拿不到放行产物，界面显示 ⛔

两种状态都写在产物里，评审能看到「合规机制」是机器拦的，不是写在文档里的君子协定。

## 五、架构演进记录

| 版本 | ⑤ 生成怎么走 | 说明 |
|---|---|---|
| 09-08 | 创空间经隧道回源 DGX Spark 上的 ComfyUI | 需公网入口，见 `docs/decisions/2026-09-08-space-deployment-decisions.md` |
| 09-13 上午 | 隧道从 natapp 换成 cloudflared quick tunnel | 见 `docs/creation_notes/2026-09-13-tunnel-switch.md` |
| **09-13 下午** | **改成本目录这套可插拔模型 API 接口** | 创空间自包含、零外部节点依赖；Spark 侧隧道与上报守护一并退役（见 `docs/creation_notes/2026-09-13-generation-api.md`） |
| **09-13 傍晚** | **⑤ 支持「界面运行时接入」+ 逐镜下发/轮询** | 使用者在「⑤ 生成接口」面板填地址 / Key / 模型名即可当场跑通 ①→⑤；⑤ 由「只发 S001」改为**逐镜各一份任务**并有界轮询取回成片 |
