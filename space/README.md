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
  config.py             运行配置：全部从环境变量读，敏感值无默认值
  prompts.py            运行时解析 agents/*/prompt.js（人格只有一份，不复制）
  llm.py                OpenAI 兼容客户端，与 agents/*/llm.js 同构
  validate.py           复用 contracts/validate_contract.py（与本地命令行同一份代码）
  pipeline.py           ①片约 → ②编剧 → ③分镜 → ④提示词 的编排（Agent 之间的契约交接与闸门）
  generate.py           ⑤生成站：一层可插拔的模型 API 接口（**不内置生成模型**）
  fallback/             往期成片（4 段），仅作 ⑤ 站产物形态预览
```

**三处刻意不复制**：Agent 的人格（`agents/*/prompt.js`）、契约校验器（`contracts/`）、
工作流（`workflows/`）。创空间里跑的和你本地跑的是同一份，改一处两边同时生效。

## 二、⑤ 生成站：可插拔的模型 API 接口

创空间**不内置、也不绑定任何具体的视频生成模型**，也不依赖仓库外的任何私有节点。
①–④ 站把一句话拆成**逐镜头的标准化生成请求**；⑤ 站只做两件事：

1. 把 ④ 的 c04 生成请求翻译成一次**标准化 API 调用**；
2. 把结果（任务 ID / 进度 / 成片地址）**原样如实**带回界面。

**接入新模型 = 配 3 个环境变量，Agent 代码一行都不用改。**

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
| **已接入** | `LOOM_GEN_API_URL` 已配置 | 真提交，给出任务 ID，可在「查询生成任务」取回成片 |
| **接口就绪** | URL 未配置 | 明说「等待接入模型」；④ 的生成请求照常产出；**不拿示例素材冒充本次生成** |
| **参考回放** | `LOOM_GEN_BACKEND=replay` | 播放 `space/fallback/` 往期成片，恒标注「非模型生成」 |

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
