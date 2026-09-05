# contracts/

7 道 Agent 之间的接口契约。JSON Schema **draft 2020-12**。

**这是整个项目里唯一被三个人同时依赖的东西，也是唯一必须冻结的东西。**

---

## 一、文件

| 文件 | 作用 |
|---|---|
| `film_agent_contracts.json` | 7 道契约 + 9 个共享定义，全在 `$defs` 下 |
| `examples.json` | 7 份**合法**示例产物，可直接当 mock 输入输出用 |
| `validate_contract.py` | 校验器（命令行） |
| `negative_test.py` | 反向测试：8 种真实错误能否被抓到 |

---

## 二、三条命令

```bash
pip install jsonschema

python validate_contract.py --list        # 列出 7 道交接面
python validate_contract.py --selftest    # 校验 7 份示例（仅结构，不查关口状态）
python negative_test.py                   # 反向测试，应输出 8/8 抓到
```

交接自己产出的文件给下游前：

```bash
python validate_contract.py --contract c04_gen_request --file artifacts/xxx.json
python validate_contract.py --dir artifacts/          # 批量，按 envelope.contract 自动认类型
python validate_contract.py --dir artifacts/ --report report.txt   # 同时写文件（Windows 终端编码保险）
```

退出码：**0 通过 / 1 有不通过 / 2 用法错误**。可以直接挂 pre-commit 或 CI。

---

## 三、七道契约

| 契约 | 交接面 | 关口 |
|---|---|---|
| `c01_brief` | 人 → 编剧 Agent | 人写，源头 |
| `c02_screenplay` | 编剧 → 分镜 | **★ 剧本确认（阻塞）** |
| `c03_shotlist` | 分镜 → 提示词 | |
| `c04_gen_request` | 提示词 → 生成 | |
| `c05_gen_result` | 生成 → 质检 | |
| `c06_qc_report` | 质检 → 剪辑 / 重试 | |
| `c07_edit_decision` | 剪辑 → 人 | **★ 粗剪确认（阻塞）** |

每道契约都是 `{envelope, payload}` 两段式，
`envelope.contract` 用 `const` 钉死，所以 `--dir` 批量校验能自动认类型。

---

## 四、几个刻意的设计

### 关口是机器会拦的，不是口头约定

`gate.required = true` 且 `status != approved` 时校验直接不通过。
这让「人机边界」变成代码里的硬约束——下游 Agent 拿不到放行的产物，
而不是靠自觉。

### 结构校验与关口状态校验是分开的

`validate_contract.py` 里有个 `check_gates` 开关：

- `--selftest` 走 `check_gates=False`，只查 schema 结构。
  因为 `examples.json` 里 c07 的关口**故意**设成 `pending`，
  用来演示阻塞长什么样；如果 selftest 也查关口，它会永远报失败，
  那就分不清是 schema 坏了还是示例本来就该被拦
- 日常 `--file` / `--dir` 校验两个都查

### c04 里有条件规则，防的是白烧一轮 GPU

`allOf` + `if`/`then` 三条：

| 声明的工作流 | 约束 |
|---|---|
| T2V | **不许带任何素材**（首帧 / 参考图 / 参考视频 / 参考音频都不行） |
| I2V | **必须有 `first_frame`** |
| R2V | **必须有 `ref_images` 且至少 1 张** |

为什么要在契约层拦：这类错误 ComfyUI **也会**报，
但它是在跑完前面所有节点之后才报，
一次就是几分钟 GPU 白烧。在 JSON 层拦下来是 0 成本。

### 枚举值带括号后缀

`aspect_ratio` 是 `{"const": "16:9 (Widescreen)"}`，
**不是** `"16:9"`。ComfyUI 的 `ResolutionSelector` 枚举值就长这样，
写短了会报 `Value not in list`。契约在这里的作用是
把「节点上真实的枚举字符串」固化下来，不让任何人在代码里凭记忆简写。

### 时长与帧数分开记

`duration_seconds` 是**秒（浮点，1–15）**，
`frame_count_actual` 是 17 对齐后的真实帧数（5 秒 → 124）。
工作流里只该填秒，帧数由 `ComfyMathExpression` 换算。
契约要求把换算结果也记下来，是为了事后对得上产物实际长度。

---

## 五、冻结规则

**契约一旦冻结，任何改动必须三人一致同意。**

因为三个人都在依赖它，单方面改一行就会让另两人的代码全崩。
改动流程：

1. 开 issue：改哪个字段、为什么、影响哪几个 Agent
2. 三人确认
3. 改 `film_agent_contracts.json`，**同步改 `examples.json`**
4. `--selftest` 与 `negative_test.py` 都过才提交
5. 在 `docs/decisions/` 补一条决策记录

---

## 六、反向测试为什么不能省

一个只会说「通过」的校验器是没有价值的——它可能根本没在校验。

`negative_test.py` 里放了 8 个**故意写错**的实例，
每个都注明为什么这是真错（不是为凑数编的畸形 JSON）：

1. 画幅漏掉括号后缀（写成 `16:9`）
2. 时长 20 s 超出 15 s 上限
3. 沿用 ComfyUI 默认前缀 `video/MiniMax_H3`（会导致产物互相覆盖）
4. `seed` 写成字符串 `"1001"`
5. `node_ids` 缺 `prompt` 键
6. 声明 I2V 却没有首帧
7. 声明 R2V 但参考图是空数组
8. c02 的关口是 `pending`

当前结果：**8/8 抓到，0 漏网，退出码 0。**

改完契约必须重跑这个文件。如果哪一条从「抓到」变成「漏网」，
说明这次改动削弱了约束。
