# 创作手记 · 09-06（Day 2）编剧 Agent：契约对齐 + LLM 接入，从三件套到可执行管线

> 本段素材最终并入 09-13 提交用的《魔搭开发者实践创作手记》（对应 kickoff Day 2「创意线 + 生成线同时开工」）。
> 范围：编剧 Agent（①）对齐 `c02_screenplay` 契约并接入 LLM 的全过程——输入一句 logline，输出一份能过校验的完整剧本。

---

## 〇、本段一句话

**把「一句 logline（必填）+ 主题 / 时长 / 画幅 / 视听风格 / 人物形象等可选约束」变成「含场次（地点 / 时间 / 人物 / beats）、情绪曲线、台词语言的完整剧本 `c02_screenplay`」，LLM 经设计好的 OpenAI 兼容 API 接入，调用失败自动降级离线示例，流水线不断。**

本段没有碰契约文件——`contracts/` 零改动（`--selftest` 7/7、`negative_test.py` 8/8 复跑通过）。

---

## 一、起点：三份初稿的「非典型失败」

项目开工时，7 道接口契约 v1.0 已冻结并通过自检，但 `agents/` 下的三份 Agent 初稿（含编剧）**输出形状全都不合规**，且失败方式高度雷同：

1. **没有 `envelope` / `payload` 外壳**——直接从 payload 那一层开始写 JSON，而 7 道契约顶层只有这两个键、都必填
2. **字段名是自创的**——编剧初稿的 `scenes[]` 只有 `id` / `beat` / `description`，与契约要求的 `scene_id` / `location` / `time_of_day` / `summary` / `characters[]` / `beats[]` 无一同名
3. **缺 `emotion_curve` / `dialogue_language` / `gate`**——c02 是两处强制人工关口之一，缺 gate 校验器直接判不通过

幸运的是，这些差距在 `agents/README.md` 第五节被逐条写成了清单，`docs/agent_guide.md` 把「输出形状照抄 examples.json」列为第一条铁律。**前人踩过的坑变成了文档，这是我们没有重踩一遍的根本原因。**

**决定：不新建目录、不动目录约定，原地重写 `agents/screenwriter/` 三件套并新增两个文件。** 理由与 README 的判断一致：目录约定（一个文件夹 = 一个 Agent）是对的，错的只是输出形状；「骨架是提示词生成的，重写成本低于对齐成本」。

---

## 二、做了什么（文件级清单）

| 文件 | 动作 | 要点 |
|---|---|---|
| `agents/screenwriter/prompt.js` | 重写 | 编剧人格 + c02 输出模板。模板与 `sample.js` 形状逐字段一致；硬规则：`scene_id` 两位编号、`time_of_day` 五值枚举、每拍 4–8 秒且加总落在目标时长 ±20%、`emotion_curve` ≥2 项、`dialogue_language` 三值、**gate 永写 pending**、红线清单逐条禁止、台词优先画外音（H3 不擅长多人对口型） |
| `agents/screenwriter/sample.js` | 重写 | 离线兜底产物：完整 c02 形状，沿用演示片「启明 / First Light」故事（3 场 10 拍 / 66s / 5 点情绪曲线 / zh 画外音），与 `storyboard/sample.js` 演示链一一对应；gate 保持 pending——**示例也不自我批准** |
| `agents/screenwriter/index.js` | 更新 | `meta` 补 `contract: 'c02_screenplay'`（README 新增约定：打开文件夹就知道产出哪道契约），并导出可编程入口 |
| `agents/screenwriter/llm.js` | 新增 | **设计好的 LLM API 接口**：OpenAI Chat Completions 兼容，原生 fetch、零第三方依赖；`LOOM_LLM_BASE_URL` / `LOOM_LLM_API_KEY` / `LOOM_LLM_MODEL` 环境变量配置（Key 自动回退识别 `MODELSCOPE_API_KEY` / `DASHSCOPE_API_KEY` / `OPENAI_API_KEY`，默认魔搭 API-Inference）；只对 429 / 5xx / 网络错误退避重试，4xx 直接抛；支持 ```json 围栏提取 |
| `agents/screenwriter/run.js` | 新增 | 可执行管线（CLI + 可编程双入口）：`--logline` 必填 + 可选 `--theme / --duration / --aspect-ratio / --visual-style / --audio-style / --character / --red-lines`，或 `--brief` 直接消费现成 c01 文件 → 构建并落盘片约 → **上游先过校验，不过不开工** → LLM 生成（结构不过回灌纠错一轮）→ 规范化 → JS 自检 + python 权威校验 → 失败降级 sample |
| `package.json` | 新增（根） | `"type": "module"`——解掉 `agent_guide` 第十节记录的阻塞项：没有它，`agents/*.js` 的 `export` 在 Node 下直接 `SyntaxError`，整条链路 clone 下来跑不了 |

---

## 三、关键设计决策（为什么这么做）

### 1. envelope 与 gate 归代码，不归模型

`created_at` / `artifact_id` / `upstream_refs` 是确定性字段，由程序统一生成覆盖；模型输出缺 payload 外壳时自动补包。最狠的一条：**`payload.gate` 无条件重置为 `pending`，模型写了 `approved` 也会被抹掉。**

依据是项目自己的原则——「人工关口是数据，不是口头约定」，剧本确认是全片两处强制阻塞关口之一，批准权留给人。让模型自己批准自己，等于没有关口。

### 2. prompt.js 模板与 sample.js 形状必须逐字段一致

模型照模板输出，离线时用 sample 兜底——两条路径如果形状不一致，LLM 可用和不可用的日子产出的东西就不是一个物种。README 的原话：「只改 `sample.js` 不改 `prompt.js` 等于没改」。

### 3. 校验不重造轮子，但学会了和关口语义共处

权威校验器是 `contracts/validate_contract.py`，JS 侧只做轻量结构自检（第一道闸，python 不在环境里也能兜底）。开发中遇到一个**反直觉时刻**：自己产出的剧本 gate=pending，拿去校验居然判「不通过」——一度以为是 bug，读校验器源码才明白这是设计：`BLOCKING_GATES` 里 c02 / c07 未批准就是不放行，**下游阻塞是机器拦的**。

解法：结构校验用一份 `gate.status = approved` 的**临时副本**做（与真实产物唯一差异就是 gate 状态，等价于 `--selftest` 的 `check_gates=False` 语义），真实产物保持 pending 等人工。校验器退出码 1 不再吓人，而是变成「形状 OK，等人点按钮」的信号。

### 4. 离线降级是特性，不是妥协

README 约定 sample.js 是「SDK / 鉴权不可用时 runAgent 返回它，保证流水线照常出片」。演示现场网络或 Key 出问题是最常见的翻车方式——降级保证当天演示不断片，且产物 `notes` 里诚实标注「内容不对应输入 logline，仅形状合规」，不把占位故事冒充真结果。

### 5. 模型第一把输出不可控 → 一次纠错轮 + 降级兜底

LLM 输出经 `normalize` + JS 结构自检后仍不过，就把**结构错误清单原样回灌**，给它一轮修正机会；再不过才降级 sample。不把可靠性押在模型的第一把输出上，也不无限重试烧时间。

### 6. LLM 接入做成「接口」而不是写死一家

节点的文本模型实测只有 MiniMax-H3 的视频权重（见 `docs/node_baseline.md` 第四节），编剧这类 LLM Agent 必须走云端 API。但团队三人用的 provider 未必一致——所以 `llm.js` 是 OpenAI 兼容协议 + 环境变量配置：魔搭 API-Inference（默认）/ DashScope 兼容模式 / OpenAI / 本地 vLLM 同一套代码切换，Key 命名也兼容三种常见环境变量，避免「换个 Key 就要改代码」。

---

## 四、验证（全部实测，不是声称）

| 场景 | 结果 |
|---|---|
| 离线端到端（`--offline` + 完整 logline） | exit 0；片约 c01 与剧本 c02 均过 python 校验（approved 副本）；`gate=pending` 直校验仅 1 条关口报错、exit 1——**关口语义正确** |
| 模拟人工批准（副本改 `approved`） | `[通过] artifacts/... 符合 c02_screenplay`，exit 0 |
| LLM 端点不可达（假 Key + `127.0.0.1:9`） | 重试后降级 sample，exit 0——降级路径通 |
| `--brief` 消费 `examples.json` 的 c01 | 追溯链挂上：`upstream_refs = ["brief.v1"]`，c01 校验 `[通过]` |
| 参数边界：缺 `--logline` / `--duration 30` | exit 2，报错指向契约原因（logline 20–400 字 / 时长 60–300 秒） |
| `--aspect-ratio "16:9"` 缩写 | 自动补全为 `16:9 (Widescreen)`（契约要求括号后缀） |
| 契约自检 / 反向测试 | `--selftest` 7/7 通过、`negative_test.py` 8/8 抓到，`contracts/` 零 diff |

---

## 五、失败与修正（本段素材，直接并入手记对应章节）

| 现象 | 归因 | 修正 |
|---|---|---|
| 初稿 `scenes[]` 自创字段，全不合规 | 写初稿时契约已冻结但没照抄 examples | 按 `agents/README.md` 第五节差距清单逐字段对齐，一个字段名都不发明 |
| 自己产出的剧本 gate=pending，校验器判不通过 | 一度以为是 bug；实为 `BLOCKING_GATES` 设计——未批准就该阻塞 | 读 `validate_contract.py` 源码确认语义；用 approved 临时副本做结构校验 |
| 测试脚本里 node 写 `/tmp/xxx.json` 报 `ENOENT` | git-bash 的 `/tmp` 映射到 Windows 用户 Temp，Node 进程不认这套映射 | 测试文件改放仓库内临时文件，用后即删 |
| sample 文案里混进一个英文单词（"firmly"） | 起草时的中英混杂笔误 | 改纯中文「果断」 |
| 每次跑校验器都会覆盖 git 里已跟踪的 `contracts/validate_report.txt` | 校验器默认把报告写在契约目录 | `run.js` 内部一律 `--report` 重定向到系统临时目录，跑完即删——不污染 git diff |

---

## 六、下一步

1. **人审剧本并批准 gate**——c02 是强制人工关口，批准后（`gate.status = approved` + reviewer / reviewed_at）②分镜 Agent 才能消费；本段产物已给出一键复现命令
2. **`storyboard` 初稿仍未对齐 c03**（`qa` 此前已对齐 c06），建议按同一套方法原地重写
3. **`prompts.js` / `tools/agent.mjs` / `studio.mjs` 仍未入库**——三件套目前各自可跑，但要串成一条流水线还差共享调用层
4. 本段素材将在 09-13 并入创作手记终稿（「团队与流程」「失败与修正」章节）

## 附：复现命令

```bash
# 一句 logline → 完整剧本（LLM 走 LOOM_LLM_* 环境变量；没配 Key 自动降级离线示例）
node agents/screenwriter/run.js --logline "一位独自值守射电望远镜阵列的夜班技师，在最后一个班次里收到一段来自自己未来的信号" --duration 150

# 人工批准后的最终关卡
python contracts/validate_contract.py --contract c02_screenplay --file artifacts/screenplay_*.json
```
