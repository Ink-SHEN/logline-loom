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
  pipeline.py           ①片约 → ②编剧 → ③分镜 → ④提示词 的编排
  generate.py           ⑤生成：隧道探测 → 真生成 / 预生成回放
  fallback/             回放素材（6 段已生成镜头 + index.json）
```

**三处刻意不复制**：Agent 的人格（`agents/*/prompt.js`）、契约校验器（`contracts/`）、
工作流（`workflows/`）。创空间里跑的和你本地跑的是同一份，改一处两边同时生效。

## 二、环境变量（在创空间里配成 secrets，不进仓库）

| 变量 | 用途 | 是否敏感 |
|---|---|---|
| `LOOM_LLM_API_KEY` | LLM API Key（缺省回退 `MODELSCOPE_API_KEY`） | **secret** |
| `LOOM_LLM_BASE_URL` | 默认 `https://api-inference.modelscope.cn/v1` | 明文即可 |
| `LOOM_LLM_MODEL` | 默认 `Qwen/Qwen3.8-Flash-Next` | 明文即可 |
| `LOOM_COMFY_URL` | 反向代理地址（方案 A）。空 = 只回放 | **secret** |
| `LOOM_PROXY_TOKEN` | 代理层校验用的 token | **secret** |
| `LOOM_PROBE_TIMEOUT` | 隧道探测超时秒数，默认 5 | 明文 |
| `LOOM_GENERATE_BUDGET` | 真生成最长等待秒数，默认 240，超时转回放并标注 | 明文 |
| `LOOM_GENERATION_MODE` | `auto`（默认）/ `live` / `replay` | 明文 |

## 三、A / B 两案怎么落在一套代码里

```
创空间收到 logline
      │
      ▼
  ①②③ Agent 编排（真跑，两个方案完全一样）
      │
      ▼
  探测 Spark 隧道（带超时）
      │
   ┌──┴───────────────┐
 可达                不可达 / 超时
   │                   │
   ▼                   ▼
POST /prompt       播放预生成结果
真生成             并在界面上【明确标注】
                   「本次为预生成回放」
```

关键是**标注**。评审当天网络出问题，界面自己说清楚是回放，
比悄悄放一个旧视频要安全得多——后者一旦被看出来是造假，丢的就不只是那几分。

## 四、人工关口默认怎么处理

`c02_screenplay` 与 `c07_edit_decision` 是**强制人工关口**（`gate.required = true`），
Agent 不自批。创空间界面上：

- 默认勾选「自动批准人工关口（演示模式）」——为了一句 logline 能全自动跑通，
  批准者记成 `创空间自动批准（演示模式）`，界面上打 ⚠️ 明示
- 取消勾选 → 流程在剧本处**真的停下**，下游拿不到放行产物，界面显示 ⛔

两种状态都写在产物里，评审能看到「合规机制」是机器拦的，不是写在文档里的君子协定。

## 五、如果选方案 A，安全上三条不能让步

1. **ComfyUI 绝不能直接暴露公网。** 它没有任何鉴权，
   暴露出去等于任何人都能 `POST /prompt` 烧我们的 GPU，也能 `GET /history` 读走全部产物
2. **代理层必须校验 token**，token 走环境变量，**不进仓库**
3. **只在评审期开放。** 评审结束立刻关掉隧道，节点回到 `--listen 127.0.0.1`
