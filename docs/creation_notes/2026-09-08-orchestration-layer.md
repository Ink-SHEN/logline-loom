# 创作手记 · 09-08（Day 4）编排与共享层：studio.mjs 主程序 + prompts.js / tools/agent.mjs / tools/samples.js / tools/comfyui.mjs 入库，七站 llm.js / comfyui.js 降级为 re-export shim

> 衔接 agents/README.md 第四节末尾那张「另需入库」状态表：slideshow 渲染工具先一步入库，本段把剩的五份一次补齐——clone 下来即可「一条命令跑通全流水线」这件事就此闭环。
> 范围：主程序 `studio.mjs`（六档编排 + 两道人工关口点批 + ④⑤⑥ 回环 + 渲染复用）；根聚合 `prompts.js` / `tools/samples.js`；共享调用管线 `tools/agent.mjs`（runAgent + LLM HTTP 客户端 + 契约校验助手）；ComfyUI 客户端 `tools/comfyui.mjs`；随后把 ①②③⑤⑦ 各自的 `agents/*/llm.js` 与 ④ 的 `agents/generator/comfyui.js` 降级为指向 tools/ 真身的 re-export shim。

---

## 〇、本段一句话

**流水线从「七站各自可独立跑的 run.js」升级为「一条命令串到底」：`node studio.mjs` 从 ①编剧 起步，走到两道强制人工关口（c02 剧本确认 / c07 粗剪确认）停下打印点批命令等人批（机器绝不代批，`--approve` 是唯一批准通道，批准时顺手跑权威校验），④⑤⑥ 生成回环作为一次性单元收敛，⑦出决策单先渲「审阅粗剪」给人看，批完 `--from render` 只核验已回填的成片不重烧；共享的 LLM 管线与 ComfyUI 客户端从 agents/ 各自副本收敛为 tools/ 单份真身 + 各站 3–7 行 shim，自包含独立跑的能力不受影响。**

本段没改契约 Schema、没动任何 agents 站内逻辑（只把 llm.js/comfyui.js 换成了等价 re-export）。`--selftest` 7/7 依旧（本段没碰 contracts/）。

---

## 一、设计口径：编排只调 runX()，不新开一套约定

写主程序之前先立了六条口径（studio.mjs 文件头注释，逐条对应代码）：

1. **编排只调各站的 `runX()` 可编程入口**，产物路径一律以返回值打印出来，不自己拼 artifacts/ 命名；站与站交接面 = 上一站返回的路径。这样每站 CLI 与编排走的是同一条路，不存在两套行为。
2. **两道人工关口由人点批**：`--approve <c02/c07> --reviewer <姓名>` 把 gate 写成 approved 并跑权威校验（exit 0 才算批成）。c07 批的是「全组看过渲染粗剪」之后的确认，所以 ⑦ 出决策单后编排先渲一版审阅粗剪再停靠。
3. **④⑤⑥ 是回环不是直线**：一轮 = ④提交 → ⑤质检 → fail(retry) 打回 ⑥ 出新 c04 → 下一轮只跑新候选；质检报告在整轮内累积到同一个 qc 目录，任何 route_to=edit 的 c06 都留给 ⑦ 按分数选。
4. **GPU 干跑边界**：④生成 收 `--dry-run`（编排透传，本段补的旗标——初版没透传导致 dryRunHalt 分支不可达，验证时发现后修掉），编排随之停在「③产物 + ④提交计划」，这是离线自检全链路的天然终点。
5. **深层参数不全会透传**：要细调某一站直接跑那站 run.js --help；主程序管默认参数下的整线串接。
6. 退出码与全仓库一致：0 正常（含关口停靠）/ 1 运行错 / 2 用法错。

---

## 二、验证实录（全部真实跑过，产物已清理）

| 场景 | 命令 | 结果 |
|---|---|---|
| 用法错退出码 | `--badflag` / 无 --logline / `--from 9` / `--from 2 --until 1` / `--approve` 无 reviewer / logline 短于 20 字 | 全部 exit 2（logline 长度校验是本段补进 parseArgs 的早检——初版漏掉，短 logline 会在 ①内部抛非本模块 UsageError 被错标 exit 1） |
| ①→关口 1 | `--offline --logline <44字>` | c02 落盘 pending，关口 1 banner 停靠，exit 0 |
| 点批 | `--approve <c02> --reviewer 测试` | gate 写 approved，python 权威校验 exit 0 |
| ②→③ 续跑 | `--from 2 --offline` | ② 出 c03；③ 遇示例镜头清单的 I2V/R2V 缺素材，拒绝开工 exit 1（Agent 既有护栏：素材位填错会白烧 GPU，非编排 bug） |
| ③+④ 离线边界 | `--from 3 --offline --dry-run --assets agents/prompt-writer/sample_assets.json` | ③ 落 30 份 c04 → ④ dry-run 出提交计划 → 编排停靠 exit 0（dry-run 放行素材 preCheck） |
| 无节点真跑 | `--from 4 --genreq <纯 T2V 迷你批>` | ④ 连不上 ComfyUI，抛带三件事排查指引的错，exit 1（与直跑 agent 口径一致） |
| c07 关口链 | `--from render --edit <已回填 fixture>`（pending）→ 拦下 exit 1；`--approve` → exit 0；再跑 → 「已渲染并回填…直接交付」skip 分支 exit 0 | 三道全通。fixture 的 final_output.path 语义确认是相对仓库根（与 slideshow/editor 一致） |

未覆盖、留给真机联调的分支：⑤ 判 fail → ⑥ 出新 c04 的回环重试轮（需要 ComfyUI 真出片后才有 c05 可质检）；回环内「单 job POST 失败」走 results error 而非整批抛错（generator 无节点时直接抛，有节点单失败才走那条）。

## 三、去重与 shim

`tools/agent.mjs`（runAgent + chat/extractJson/llmConfig/LlmError + pythonValidateDoc）与 `tools/comfyui.mjs`（原 agents/generator/comfyui.js 原样迁入）入库后：

- `agents/{screenwriter,storyboard,prompt-writer,qa,editor}/llm.js` → 3–7 行 `export { ... } from '../../tools/agent.mjs'`，各站自带头注释保留；
- `agents/generator/comfyui.js` → `export * from '../../tools/comfyui.mjs'`；
- 七站 index.js/run.js + 全部新文件的 import 冒烟通过；`node --check` 全绿。

shim 不 import agents/*（真身不依赖 shim），无循环依赖。

## 四、文档同步

agents/README.md 第二节（共享部分去向）、第三节注、第四节状态表 5 行 ⬜→✅、第九节（一条命令 + 逐站手接两种跑法，c02 放行注释改为 --approve）；docs/agent_guide.md 第十节「当前阻塞项」整体改写为「已全部清零，保留作对照」（顺带修正 package.json 行已入库的过时说法）；package.json 补 `"studio": "node studio.mjs"`。

## 五、留下的边界（如实记录）

- ⑦ 的 gate-2 停靠前会先渲审阅粗剪：无 ffmpeg 的机器跳过渲染直接按决策单审（提示里有说明）。
- `--from render` 的「已回填则跳过」判定 = c07 final_output.sha256 非全 0 + 相对仓库根路径存在 mp4；人工批准的 c07 若在无 ffmpeg 机器上批的，换有 ffmpeg 的机器重跑同一命令即可补渲。
- 本段全部产物/改动保持未提交；artifacts/ 为试跑产物已清理（该目录未进 .gitignore，提交前照 agent_guide 第五节先 rm -rf artifacts/）。
