# -*- coding: utf-8 -*-
"""创空间视觉层：主题 + 自定义 CSS + 七站进度条渲染。

设计约束（改这里之前先读）：
1. 配色只做「黑白灰 + 魔搭品牌紫 #624AFF」，紫色仅用于强调（主按钮 / 运行态 / 完成态 / 链接），
   大面积留给中性灰。不引入第二个品牌色。
2. 所有颜色必须成对给 light / dark 两套（Gradio 6 用 :root + .dark 双作用域自动切换）。
   自定义 CSS 里优先引用 Gradio 变量（var(--neutral-200, 回退值)），不要硬编码颜色。
3. 字体只用系统字体栈。实测 gr.themes.GoogleFont 会注入 fonts.googleapis.com，
   魔搭容器内可能加载失败，评审第一印象赌不起。
4. 选择器一律用自己起的 .loom-* 类，不依赖 Gradio 内部类名（官方明确不保证跨版本）。

Gradio 6 注意：theme / css 必须传给 demo.launch()，不是 gr.Blocks()。
"""
import html

import gradio as gr

# ---------------------------------------------------------------- 品牌色板

# 魔搭品牌紫 #624AFF -> HSL(248, 100%, 64.5%)。
# c500 对齐品牌色原亮度；浅色端略降饱和避免荧光感，深色端保持。
# 可访问性实测（WCAG）：白字 on c500 = 5.33:1（AA 正文），c500 文字 on 白 = 5.33:1。
LOOM_PURPLE = gr.themes.Color(
    c50="#F2F1FE", c100="#E5E2FE", c200="#CBC3FE", c300="#A294FF", c400="#7A66FF",
    c500="#624AFF", c600="#3C1FFF", c700="#2305EB", c800="#2008BF", c900="#1D0A99",
    c950="#14085E",
    name="loom-purple",
)

PURPLE = "#624AFF"
PURPLE_HOVER_LIGHT = "#4F35F5"   # 亮色 hover：更深，白字对比度更高
PURPLE_HOVER_DARK = "#7159FF"    # 暗色 hover：略亮，白字 4.59:1 仍过 AA

# 中性灰（zinc 系），正文/次要文字对比度均已实测达标
GREY_TEXT = "#27272A"          # 亮色正文   on #fff  = 14.89:1
GREY_TEXT_SUB = "#52525B"      # 亮色次要   on #fff  =  7.73:1
GREY_TEXT_SUB_2 = "#71717A"    # 亮色弱化   on #fff  =  4.83:1
GREY_BG = "#FAFAFA"            # 亮色页面底
GREY_SURFACE = "#FFFFFF"       # 亮色卡片面
GREY_BORDER = "#E4E4E7"        # 亮色描边

GREY_TEXT_DARK = "#E4E4E7"     # 暗色正文   on #09090B = 15.68:1
GREY_TEXT_SUB_DARK = "#A1A1AA" # 暗色次要   on #09090B =  7.76:1
GREY_BG_DARK = "#09090B"
GREY_SURFACE_DARK = "#18181B"
GREY_BORDER_DARK = "#27272A"

FONT_STACK = [
    "system-ui", "-apple-system", "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "sans-serif",
]
MONO_STACK = [
    "ui-monospace", "SFMono-Regular", "Menlo", "Consolas",
    "Liberation Mono", "monospace",
]


def build_theme():
    """构造 LOOM 主题。只在 app.py 里调一次，结果传给 demo.launch(theme=...)。"""
    return gr.themes.Default(
        primary_hue=LOOM_PURPLE,
        secondary_hue=gr.themes.colors.zinc,   # 黑白灰，不给第二个彩色
        neutral_hue=gr.themes.colors.zinc,
        spacing_size=gr.themes.sizes.spacing_md,
        radius_size=gr.themes.sizes.radius_md,
        text_size=gr.themes.sizes.text_md,
        font=FONT_STACK,
        font_mono=MONO_STACK,
    ).set(
        # —— 页面 ——
        body_background_fill=GREY_BG,
        body_background_fill_dark=GREY_BG_DARK,
        body_text_color=GREY_TEXT,
        body_text_color_dark=GREY_TEXT_DARK,
        body_text_color_subdued=GREY_TEXT_SUB,
        body_text_color_subdued_dark=GREY_TEXT_SUB_DARK,
        # —— 容器 / 卡片 ——
        block_background_fill=GREY_SURFACE,
        block_background_fill_dark=GREY_SURFACE_DARK,
        block_border_color=GREY_BORDER,
        block_border_color_dark=GREY_BORDER_DARK,
        block_title_text_color=GREY_TEXT_SUB,
        block_title_text_color_dark=GREY_TEXT_SUB_DARK,
        block_title_text_weight="500",
        block_label_text_color=GREY_TEXT_SUB,
        block_label_text_color_dark=GREY_TEXT_SUB_DARK,
        block_label_text_weight="500",
        block_radius="10px",
        block_padding="16px",
        # —— 输入框 ——
        input_background_fill=GREY_SURFACE,
        input_background_fill_dark=GREY_SURFACE_DARK,
        input_border_color=GREY_BORDER,
        input_border_color_dark=GREY_BORDER_DARK,
        input_radius="8px",
        # —— 主按钮：紫底白字，亮/暗两套 hover 都过 AA ——
        button_primary_background_fill=PURPLE,
        button_primary_background_fill_dark=PURPLE,
        button_primary_background_fill_hover=PURPLE_HOVER_LIGHT,
        button_primary_background_fill_hover_dark=PURPLE_HOVER_DARK,
        button_primary_text_color="#FFFFFF",
        button_primary_text_color_dark="#FFFFFF",
        button_primary_text_color_hover="#FFFFFF",
        button_primary_text_color_hover_dark="#FFFFFF",
        button_primary_border_color=PURPLE,
        button_primary_border_color_dark=PURPLE,
        # —— 其他紫色触点 ——
        link_text_color=PURPLE,
        link_text_color_dark="#A294FF",
        slider_color=PURPLE,
        slider_color_dark="#A294FF",
        loader_color=PURPLE,
        loader_color_dark="#A294FF",
        # —— 面板 / 表格 ——
        panel_background_fill=GREY_SURFACE,
        panel_background_fill_dark=GREY_SURFACE_DARK,
        border_color_primary=GREY_BORDER,
        border_color_primary_dark=GREY_BORDER_DARK,
    )


# ---------------------------------------------------------------- 自定义 CSS

CUSTOM_CSS = """
/* ===== 七站流水线进度条 ===== */
.loom-progress{
  /* 全部从 Gradio 语义变量派生：Gradio 在 :root 和 .dark 双作用域里各定义一遍，
     所以暗色模式下这些值会自动跟着变，不需要手写任何 .dark 规则。 */
  --loom-line:var(--border-color-primary, #E4E4E7);
  --loom-surface:var(--background-fill-primary, #FFFFFF);
  --loom-text:var(--body-text-color, #27272A);
  --loom-sub:var(--body-text-color-subdued, #52525B);
  display:flex; align-items:flex-start; gap:4px;
  margin:0 0 16px; padding:0; list-style:none;
}
.loom-step{ flex:1 1 0; min-width:0; text-align:center; position:relative; }
.loom-step__dot{
  display:flex; align-items:center; justify-content:center;
  width:26px; height:26px; margin:0 auto 6px;
  border-radius:50%; border:1.5px solid var(--loom-line);
  background:var(--loom-surface);
  color:var(--loom-sub);
  font-size:12px; font-weight:500; line-height:1;
}
.loom-step:not(:last-child)::after{
  content:""; position:absolute; top:13px;
  left:calc(50% + 15px); width:calc(100% - 30px); height:1.5px;
  background:var(--loom-line);
}
.loom-step__name{
  display:block; font-size:11px; line-height:1.35;
  color:var(--loom-sub);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.loom-step--done .loom-step__dot{
  background:#624AFF; border-color:#624AFF; color:#FFFFFF;
}
.loom-step--done::after{ background:#624AFF; }
.loom-step--done .loom-step__name{ color:var(--loom-text); font-weight:500; }
.loom-step--running .loom-step__dot{
  border-color:#624AFF; color:#624AFF; background:var(--loom-surface);
}
.loom-step--running .loom-step__name{ color:var(--loom-text); font-weight:500; }
.loom-step--blocked .loom-step__dot{
  border-style:dashed; border-color:var(--loom-sub); color:var(--loom-sub);
}
.loom-step--blocked .loom-step__name{ color:var(--loom-sub); }
.loom-step--local .loom-step__dot{
  border-style:dashed; border-color:var(--loom-line); color:var(--loom-sub);
}
@media (prefers-reduced-motion: no-preference){
  @keyframes loom-pulse{
    0%,100%{ box-shadow:0 0 0 0 rgba(98,74,255,.35); }
    50%{ box-shadow:0 0 0 5px rgba(98,74,255,0); }
  }
  .loom-step--running .loom-step__dot{ animation:loom-pulse 1.6s ease-in-out infinite; }
}
@media (max-width:640px){
  .loom-progress{ flex-wrap:wrap; gap:8px 4px; }
  .loom-step{ flex:0 0 calc(25% - 4px); }
  .loom-step:not(:last-child)::after{ display:none; }
}

/* ===== 右侧状态区：把任务 ID / film_id 的 code 渲染成可选中的等宽胶囊 ===== */
.loom-status{
  --loom-line:var(--border-color-primary, #E4E4E7);
  --loom-text:var(--body-text-color, #27272A);
  --loom-chip:var(--background-fill-secondary, #F4F4F5);
}
.loom-status code{
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size:.92em; padding:2px 6px; border-radius:5px;
  background:var(--loom-chip);
  border:1px solid var(--loom-line);
  color:var(--loom-text);
  word-break:break-all; user-select:all;
}
.loom-status h1,.loom-status h2,.loom-status h3{
  font-size:14px; font-weight:500; margin:.6em 0 .3em;
}
.loom-status hr{ margin:12px 0; }

/* ===== Tabs：Gradio 无 tab_* 主题变量，只能走 CSS，保持最小干预 ===== */
.loom-tabs{ margin-top:4px; }
"""

# ---------------------------------------------------------------- 七站进度条

# (序号, 站名, 契约)。创空间只跑 ①–⑤，⑥⑦ 跑在本地节点上。
STATIONS = [
    ("1", "片约", "c01"),
    ("2", "编剧", "c02"),
    ("3", "分镜", "c03"),
    ("4", "提示词", "c04"),
    ("5", "生成", "c05"),
    ("6", "质检", "c06"),
    ("7", "剪辑", "c07"),
]

STATE_LABEL = {
    "pending": "待运行",
    "running": "进行中",
    "done": "已完成",
    "blocked": "已阻塞",
    "local": "本地节点",
}

# 默认：①–⑤ 待运行，⑥⑦ 标注为本地节点
DEFAULT_STATES = ["pending"] * 5 + ["local"] * 2


def progress_html(states=None):
    """渲染七站进度条。

    states: 长度 7 的列表，取值 pending / running / done / blocked / local。
    状态不只靠颜色区分：实心 / 空心 / 虚线边框 + 文字亮度 + aria-label 三重编码。

    注意：这里返回的是 HTML 字符串，交给 gr.HTML 渲染。实测 Gradio 6 的 gr.HTML
    不会转义 <style>/<div>，但会净化掉脚本类标签——所以只输出结构 + 类名，
    样式全部放在上面的 CUSTOM_CSS 里。
    """
    st = list(states) if states else list(DEFAULT_STATES)
    if len(st) < len(STATIONS):
        st += list(DEFAULT_STATES[len(st):])

    items = []
    for i, (num, name, contract) in enumerate(STATIONS):
        state = st[i] if st[i] in STATE_LABEL else "pending"
        label = STATE_LABEL[state]
        items.append(
            '<li class="loom-step loom-step--%s" role="listitem" '
            'aria-label="第%s站 %s（%s）：%s">'
            '<span class="loom-step__dot" aria-hidden="true">%s</span>'
            '<span class="loom-step__name">%s</span>'
            "</li>"
            % (state, num, html.escape(name), html.escape(contract), label,
               num, html.escape(name))
        )

    return (
        '<ul class="loom-progress" role="list" aria-label="LOOM 七站流水线进度">'
        + "".join(items)
        + "</ul>"
    )
