# 决策记录 · 2026-09-07：⑦剪辑的两项输入约定

> 决定人：A（总导演）。改动了 `contracts/` 两个文件的**描述与示例值**，未改任何 Schema 约束，
> `--selftest` 7/7、`negative_test.py` 8/8 复跑通过。按 `docs/agent_guide.md` 第八节，此条需 B、C 追认。

---

## 一、决定是什么

**1. 产物路径只有一个口径：`shots/<candidate_id>/video.mp4`（扁平，目录名 = candidate_id）。**
c07 `timeline[].source_path` 一律**原样取**该候选对应 c05 的 `payload.output.path`，剪辑侧不拼路径。

**2. 字幕不走契约、不走推断，走一份人工撰写的侧清单 `--subtitles`。**
格式见 `agents/editor/sample_subtitles.json`，与 ③提示词 的 `sample_assets.json` 同一处理方式。

---

## 二、当时的已知信息

- 口径分叉的现场：`shots/README.md` 第一节与 `shots/meta_template.json:22` 都是扁平的
  `shots/S001_c00/video.mp4`；但 `contracts/examples.json` 的 c05 `output.path` 与 c07 三条
  `source_path` 写的是嵌套的 `shots/S001/c01/video.mp4`，契约里 `output.path` 的 description 也这么写。
  **两处都合法**——Schema 只给 `output.path` / `source_path` 设了 `type: string`，没有 pattern，
  所以校验器抓不到，只有真渲染时会炸。
- 为什么现在必须定死：④生成还没开工。它一旦照 `examples.json` 那份写嵌套路径，
  ⑤⑥⑦ 三家的归档和反查全部分叉，`shots/README.md` 第四节那条追溯链就断了。
- 字幕的结构性障碍：c02 的 `beats[].dialogue` 与 c03 的 `shots[]` 之间**没有外键**
  （c03 的 shot 不带 beat 引用），分镜按 beat 切镜，但切完就回不去是哪个 beat 了。
  而 `docs/agent_guide.md` 第七节明写「字幕只在 c07 出现，别塞进 c03」。
- c07 的 `timeline[].subtitle` 类型是 `string | null`，一条 timeline 只有一个字幕位，
  装不下「一个 6 秒镜头里两句台词」的逐行时序。
- 当时未实测：渲染机（DGX Spark，ARM64）上有没有中文字体。字幕是中文，`drawtext` / `.ass`
  缺字体就是豆腐块，这个只能等真渲染时验。

---

## 三、备选方案与为什么不选

**路径口径**

| 方案 | 为什么不选 |
|---|---|
| 反过来把 `shots/README` 改成嵌套 | README 的目录约定同时管 `.gitignore`（`!shots/**/meta.json` 这类放行规则）、`filename_prefix` 正则 `^shots/S[0-9]{3}(_c[0-9]{2})?$`（扁平，与嵌套矛盾）和人工的 `selected.txt` 落点。改一处要动三处，且 `filename_prefix` 是 ComfyUI 侧的真实输出前缀，改不动 |
| 给 `output.path` / `source_path` 加 pattern 强约束 | 这才是真正的"机器拦住"，但那是**改 Schema**，按第八节要三人一致同意，且 B 的 ④生成 与 C 的归档代码都要跟。本轮先统一口径与文档，加 pattern 留到 ④ 开工前一起提 |
| 让剪辑 Agent 自己按 `candidate_id` 拼路径 | 契约合法但把约定复制成了两份实现，将来目录一改就分叉。改成"只读不猜"，路径的唯一来源是 c05 |

**字幕**

| 方案 | 为什么不选 |
|---|---|
| (a) LLM 按 c02 的 `beats[].action` 与 c03 的 `visual_description` 推对应关系 | 推出来的结果是概率的，字幕错了要重烧全片。而这件事人工写一份清单十分钟就能做完，且是人审过的 |
| (b) 给 c03 的 shot 加 `beat_ref` | 正解，但要改 Schema、要 ②分镜 重新产出、要三人同意。等跑通一轮再按第八节提 |
| (c) 把字幕塞进 c03 | `docs/agent_guide.md` 第七节明令禁止，且 c03 是 ③提示词 的输入，字幕进那里会被抄进生成提示词污染画面 |
| **选中：侧清单** | 零契约改动；格式自己定；缺了会在**调用 LLM 之前**阻塞报错，照 ③提示词 的素材清单先例 |

清单字段定成「源视频时间」而不是「成片时间」，是为了让人对着一句话标时间时看的是手头这条素材；
剪辑 Agent 改 in/out 点或换候选时，不必重标全片字幕。这是本条决定里唯一有远见的地方，值得记下来。

---

## 四、什么条件下该重新审视它

- **④生成开工前**：把 `output.path` / `source_path` 的 pattern 一并提进契约变更
  （`^shots/S[0-9]{3}_c[0-9]{2}/video\.[a-z0-9]+$`），让校验器来拦而不是靠文档。B 是同意的另一方，因为他就是写路径的人。
- **若一个镜头需要 3 行以上字幕**：`\n` 拼接的记法会难读，届时考虑把同候选拆成多条 timeline 条目
  （契约允许同 `shot_id` 重复出现），而不是改 `subtitle` 的类型。
- **若渲染机没有中文字体**：字幕样式要退回英文，或者把字体文件随素材一起管进 `asset_ref.license` 那条线。
- **若 ②分镜 补了 `beat_ref`**：本清单可以降级为「只标注需要字幕的镜头」的覆盖表，其余由 ② 自动带过来。
