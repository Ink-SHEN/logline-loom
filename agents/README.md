# agents/

7 个 Agent 的实现。**按交接面切分，不按「模块」切分** —— 每个人手里是一段连续的管线，
边界正好落在契约文件上，不会出现两个人改同一个 Agent。

> 本目录当前只有这份说明。实现由各 owner 在自己的分支上提交，
> 契约冻结之前不要急着写代码，见下文「开发顺序」。

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

---

## 二、归属

| 人 | owns | 产出契约 | 独占职责 |
|---|---|---|---|
| **A · 总导演** | ①编剧、⑦剪辑 | `c01`、`c02`、`c07` | 全部人工关口的裁决、质检标准定义、合规自查、创作手记、最终提交、仓库 owner |
| **B · 生成与复现** | ④生成、⑥重试 | 消费 `c04`、产出 `c05` | ComfyUI API 接入、GPU 排队、`meta.json` 与环境快照、素材上传、仓库工程化 |
| **C · 中间层 + 部署** | ②分镜、③提示词、⑤质检 | `c03`、`c04`、`c06` | 视觉一致性资产与 R2V 参考集、GPU 排班表与 `docs/task_registry.md` 维护、创空间部署 |

**人工关口必须集中在 A 一个人手里。** 关口是「阻塞等待」，
如果三个人都能批，那就不叫关口。

---

## 三、人工关口是数据，不是口头约定

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

## 四、开发顺序：先 mock，不要等上游

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

## 五、LLM 放在哪里

**节点上没有文本模型**（实测各加载器的枚举可选值里只有 MiniMax-H3 的
视频权重、文本编码器与 VAE，详见 `docs/node_baseline.md` 第四节）。

所以 ①编剧、②分镜、③提示词 这三个 Agent 的 LLM 调用
**走云端 API 或各自开发机，完全不占 GPU**，可以和生成任务并行推进，
不受 `docs/gpu_protocol.md` 的排班约束。

⑤质检 里客观的部分（时长、帧率、分辨率、有无音轨）用 `ffprobe` 硬判，
**不要用 LLM 判这些**——能确定性判定的事不要交给概率模型。
主观部分（提示词遵循度、画面崩坏）才用 LLM 或人。

---

## 六、目录约定

各 owner 建自己的子目录：

```
agents/
  screenwriter/     ①  A
  storyboard/       ②  C
  prompter/         ③  C
  generator/        ④  B
  qc/               ⑤  C
  retry/            ⑥  B
  editor/           ⑦  A
```

三条硬性要求：

1. **节点 ID 一律从 `workflows/node_id_map.json` 读**，不许在代码里硬编码
   `"140:131"` 这类字符串。T2V / I2V 的 ID 是子图摊平后的复合编号，
   ComfyUI 升级或重导模板就会变
2. **交接物落盘为 JSON 并过校验器**，不要靠聊天窗口传参数
3. **不要把素材、视频、权重写进仓库**。产物目录已被 `.gitignore` 排除，
   只允许 `meta.json` / `selected.txt` / `ffprobe.txt` 入库，见 `shots/README.md`
