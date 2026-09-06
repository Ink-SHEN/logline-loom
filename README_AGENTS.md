# agents/ — 每个 Agent 一个独立文件夹

一个文件夹 = 一个 Agent。每个 Agent 自包含三样东西：

| 文件 | 作用 |
|---|---|
| `prompt.js` | 该 Agent 的人格(system prompt)。**改脾气/风格只改这里。** |
| `sample.js` | 离线降级示例产物(SDK/鉴权不可用时用)，同时是输出 JSON 格式的活文档。 |
| `index.js`  | 自包含入口：再导出 prompt + sample，并给出 `meta`(中文名/角色/导出名)。 |

## 现有 3 个 Agent

| 文件夹 | 中文名 | 角色 | 人格导出 |
|---|---|---|---|
| `screenwriter/` | 编剧 | 一句话前提 → 3 幕剧本 JSON | `SCREENWRITER` |
| `storyboard/` | 分镜 | 剧本 → 镜头 JSON（可被打回重拍） | `STORYBOARD` |
| `qa/` | 质检 | 审分镜 → PASS / REJECT(带修改意见) | `QA` |

## 与流水线的关系（重要）

- `studio.mjs` 仍然从根目录 `prompts.js` 和 `tools/samples.js` 导入——这两个文件现在是**聚合再导出**，
  内容已转到各 Agent 文件夹，但对外接口不变，所以 `studio.mjs` 一行都不用改。
- `tools/agent.mjs`（`runAgent()`）是**共享管线**：三个 Agent 本质是同一次 SDK 调用、只换 system prompt，
  所以它不属于任何单个 Agent，留在 `tools/`。
- 第 4 个工位「**渲染**」(`tools/slideshow.mjs` + `tools/comfyui.mjs`) **不是 Agent**（不调用大模型），
  因此不在本目录下。

## 加一个新 Agent（例如「配乐」）

1. 新建 `agents/music/`，照葫芦画瓢放 `prompt.js`(导出 `MUSIC`) + `sample.js`(导出 `sampleMusic`) + `index.js`。
2. 在 `prompts.js` 加一行 `export { MUSIC } from './agents/music/prompt.js';`
3. 在 `tools/samples.js` 加一行 `export { sampleMusic } from '../agents/music/sample.js';`
4. 在 `studio.mjs` 里用 `runAgent({ name:'配乐', systemPrompt: MUSIC, ... })` 串进流水线。

架构无需重构——这正是「加工位＝加文件夹」的设计意图。
