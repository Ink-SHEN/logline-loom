# LOOM 创空间 UI 改造 · 可行性分析

- 分析日期：2026-09-09
- 结论：**可行，且建议做。但必须限定在「主题层 + 样式层 + 轻结构层」三层内，禁止重写前端。**
- 本文只做分析与建议，**未改动任何生产代码**（`app.py` / `space/` / `requirements.txt` 均未触碰）。
- 可复现探针：`tmp/probe_gradio6.py`、`tmp/probe_theme_vars.py`、`tmp/probe_inject.py`、`tmp/probe_theme_css.py`

---

## 一、先校正一个前提：线上是 Gradio 6.17.3，不是 4.x

这是本次分析最重要的发现，直接决定改造手法。

| 项 | 现状 | 问题 |
|---|---|---|
| `requirements.txt` | `gradio>=4.44.0` | **无上限**，版本可漂移 |
| 创空间实际运行 | **gradio 6.17.3**（见《魔搭创空间部署指南_LOOM.md》附 1） | 与 requirements 声明不一致 |

Gradio 6 是 breaking 大版本。按 4.x/5.x 经验写的 UI 代码，在 6.x 上**可能不报错但完全不生效**——见第四节第 1 条。

### 已在本地搭同版本隔离环境实测

```
venv:  C:\Users\smh_2\.workbuddy\binaries\python\envs\loomui
版本:  gradio 6.17.3   （与线上一致，非模拟）
```

---

## 二、可行域：三层能力，全部实测通过

### 层 1 · 主题层 `launch(theme=...)` —— 零风险

| 实测项 | 结果 |
|---|---|
| ThemeClass 实例属性（CSS 变量） | **325 个** |
| 其中 `*_dark` 变量 | 104 个 |
| `.set()` 可显式覆盖的变量 | **约 230 个**（keyword-only） |
| `primary_hue="violet"` 后生成 CSS | `--primary-500: #8b5cf6` ✅ 生效 |
| `.set()` 传入的 hex | `--button-primary-background-fill: #7c3aed` ✅ 生效 |
| 生成主题 CSS 体积 | **21,121 字节 / 442 个变量** |
| 暗色模式作用域 | `:root` ×3、`.dark` ×2 —— **Gradio 自动成对切换** |

**含义**：改配色、圆角、间距、字号、按钮、输入框、卡片——**全部可以只动主题变量，一行 DOM 选择器都不用写**。这是最安全的一层。

变量命名前缀分布（判断语义覆盖广度）：

```
button 71   checkbox 49   block 41   input 24
primary 11  secondary 11  neutral 11 table 11  error 10
body 8      link 8        spacing 7  radius 7  text 7
```

**注意缺口**：前缀里**没有** `tab_*`、`gallery_*`、`json_*`。
→ Tabs / Gallery / JSON 三个组件**没有主题变量可覆盖**，只能走层 2（CSS + `elem_classes`）。而这三样恰恰是契约产物展示的核心组件。

### 层 2 · 样式层 `launch(css=...)` + `elem_classes` —— 低风险

| 实测项 | 结果 |
|---|---|
| `launch(css=...)` 注入自定义 CSS | ✅ 出现在页面 HTML 中 |
| `elem_classes` / `elem_id` 落到 DOM | ✅ 7/7 全部命中 |
| `gr.HTML("<style>...")` 兜底通道 | ✅ 保留，未被转义成 `&lt;style&gt;` |

`elem_classes` 实测命中的 7 个：`loom-panel`、`loom-input`、`loom-status`、`loom-tabs`、`loom-tab`、`loom-footer`、`loom-run`。

这是**最安全的定位方式**：类是我们自己起的，不依赖 Gradio 内部类名，跨版本不会失效。

### 层 3 · 结构层 Blocks 重组 —— 中风险

现有组件参数在 6.17.3 上**全部存活**，逐个实测：

```
gr.Gallery columns/height/label  ✅     gr.Accordion open/label   ✅
gr.Textbox  lines/placeholder    ✅     gr.Row visible/scale      ✅
gr.Column   scale                ✅     gr.Slider step/label      ✅
gr.Dropdown label                ✅     gr.Checkbox label/value   ✅
gr.Button   variant/scale        ✅     gr.JSON label             ✅
```

→ 调整布局、增删容器、改比例，**不会因参数失效而崩**。风险来自"改动面大"而非"API 不支持"。

### 禁止区 · 重写前端

Gradio 前端是 Svelte 编译产物。重写等于自建 SPA，会丢掉创空间的隧道上报、队列、API 通道，5 天内不可行且得不偿失。

---

## 三、当前 UI 的四个问题（值得改的理由）

按改动性价比排序：

**1. 自检占了首屏黄金位（最该改，成本极低）**
`app.py:291` 把 `self_check()` 直接堆在标题和简介下方。自检内容是 LLM 配置、隧道连通性、回放素材数——**全是运维信息**。评审一进来可能先看到「**未配置** LOOM_LLM_API_KEY」或「未连通，将走回放」，第一印象直接扣分。
→ 建议：移进 `gr.Accordion(open=False)`。

**2. 七站没有进度指示（最该改，收益最大）**
作品核心卖点是「看 7 个 Agent 一个个往下走」，但当前 `status` 只是 Markdown 文本逐行追加（`app.py:322`），评审看不出跑到第几步。
→ 建议：后端 Python 生成七站状态 HTML（等待 / 运行中 / 通过 / 阻塞 / 失败），随 `yield` 更新。**纯后端生成 HTML，不需要 JS，最稳。**

**3. 右侧大片空白**
`scale=3 : scale=4` 的配比下，左列有 logline + 时长 + 画幅 + 两种风格 + 镜头设计 + 两个开关 + 按钮，右列只有一段文字。
→ 建议：进度条放进右列，或改配比为 4:5 并给左列做分组。

**4. 运维面板喧宾夺主**
隧道状态、查询生成任务、整片任务三个 Accordion 与主流程同级占据下半页。
→ 建议：合并为一个「运维 / 高级」Accordion，默认关闭。

---

## 四、必须避开的四个坑

### 坑 1：`gr.Blocks(css=...)` 静默失效（最阴险）

Gradio 6 把应用级参数从 `Blocks` 移到了 `launch()`。实测：

```
gr.Blocks(css=".gradio-container{background:red}")
→ 不抛异常，只发 UserWarning，CSS 被静默忽略
→ "The parameters have been moved from the Blocks constructor
   to the launch() method in Gradio 6.0: css."
```

**后果**：按老写法改完，推上去 UI 毫无变化，且没有任何报错。会浪费大量时间在错误的方向上排查。
**正确写法**：`demo.launch(theme=..., css=...)`。

实测参数归属：

| 参数 | 归属 |
|---|---|
| `theme` `css` `css_paths` `js` `head` `head_paths` | **全部 → `launch()`** |
| `footer_links` `allowed_paths` | → `launch()` |

### 坑 2：版本漂移会击穿自定义 CSS

`requirements.txt` 写的 `gradio>=4.44.0`，平台装了 6.17.3。若平台某次重建装到 6.22 / 7.x，基于 6.17.3 调的样式可能失效。
→ **建议锁版本**：`gradio>=6.17.3,<7`。（本次未改，待你确认）

### 坑 3：Google Fonts 在魔搭环境有加载风险

实测 `gr.themes.GoogleFont("Noto Sans SC")` 会向页面注入：

```
fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;600...
```

魔搭容器内访问该域名**可能慢或失败**，导致 FOUC 或字体回退。评审只有一次第一印象。
→ **建议**：用系统字体栈，或 `gr.themes.LocalFont` + 随仓库分发的字体文件。**不用 GoogleFont。**

### 坑 4：硬编码颜色会在暗色模式下崩

Gradio 6 用 `:root` / `.dark` 双作用域自动切换，官方支持 `xxx` 与 `xxx_dark` 成对设置。若在自定义 CSS 里硬编码 `#fff` 背景、`#333` 文字，评审若开着暗色模式就会看到不可读的界面。
→ **建议**：颜色一律走主题变量；必须写死时用 CSS 变量并同时给 dark 分支。

---

## 五、改造不能破坏的五条（回归清单）

UI 改造必须以下面五条仍然成立为验收标准：

| # | 保护对象 | 位置 | 实测状态 |
|---|---|---|---|
| 1 | `/gradio_api/call/run_pipeline` 线上验证入口 | `app.py:336` | 6.17.3 下 `api_name` ✅ 仍支持 |
| 2 | `/gradio_api/run/report_tunnel`（Spark 上报隧道地址） | `app.py:360` `api_name="report_tunnel"` | ✅ 仍支持 |
| 3 | 生成器逐段 `yield` 依赖的队列 | `app.py:388` `queue(default_concurrency_limit=4)` | ✅ 参数存活 |
| 4 | `_mount_tunnel_api` 挂载的 FastAPI 路由 | `app.py:57-88` | 与 UI 无关，不受影响 |
| 5 | `run_pipeline` 的 6 个输出顺序 | `app.py:336-339` | 改动时不得增减 |

另注：Gradio 6 已移除 `show_api`，改为 `api_visibility`。当前代码未使用，无影响。

---

## 六、三档方案

| 方案 | 内容 | 风险 | 工作量 | 收益 |
|---|---|---|---|---|
| **A · 保守** | 只做层 1：定制主题（配色 / 圆角 / 间距 / 字号）+ 锁版本 + 自检下移 | 极低 | 小 | 去掉默认橙色，建立品牌调性；首屏不再暴露运维告警 |
| **B · 均衡** | A + 层 2：Tabs/Gallery/JSON 样式优化 + 容器最大宽度 + 运维面板收拢 + 七站进度条 | 低 | 中 | 首屏信息层级清晰；「多 Agent 编排」这个卖点**真正被看见** |
| **C · 激进** | B + 层 3：Blocks 大幅重组、自定义 hero 区、暗色模式专项调优 | 中 | 大 | 产品感最强，但挤压 09-13 / 09-14 的手记与端到端验证 |

**建议选 B**，并在 **09-11 前完成并冻结**，把 09-12 之后的时间留给真生成演练与创作手记。

---

## 七、时间窗

今天是 09-09，作品提交截止 **09-14 22:00**，剩 5 天。计划表里 09-13 要跑双模式端到端验证、09-13 要写创作手记。

```
09-09  分析（本文）        ← 现在
09-10  改造 + 本地验证     ← 建议
09-11  部署 + 线上回归     ← 必须冻结
09-12  真生成演练（方案 A）
09-13  端到端验证 + 创作手记
09-14  提交
```

UI 改造若拖到 09-12 之后，会与硬任务抢时间，且没有回滚余量。

---

## 八、待你确认 / 仍存的不确定性

1. **魔搭平台是否通过 `python app.py` 启动？**
   强证据表明是（现有 `launch(server_port=7860)` 生效、线上可访问），但属间接推断。
   → 首次部署后需**立刻截图确认样式生效**。若万一不生效，已有兜底通道：用 `gr.HTML("<style>...")`（实测未被转义）注入样式。

2. **`requirements.txt` 是否锁 `gradio>=6.17.3,<7`？** 建议锁，待你点头。

3. **视觉调性方向**：LOOM = 织布机（把一条 logline 织成一部片子），科幻短片题材。
   候选：深空蓝 + 琥珀强调色（影院感）/ 冷灰 + 品红（赛博感）/ 保持浅色克制风。
   注：Gradio 内置 `Cyberpunk`（primary `#d946ef`）与 `Glass`（`#3b82f6`）是现成的低成本起点。

4. **是否要进度条？** 这是收益最大的一项，但需要改 `run_pipeline` 的 yield 逻辑（从纯文本改为文本 + HTML 两个输出）。属于本次分析中风险相对最高的改动，需要你确认。
