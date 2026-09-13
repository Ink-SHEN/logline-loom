# -*- coding: utf-8 -*-
"""创空间运行配置。

LLM（①–④）的敏感值都从环境变量读（创空间里配置成 secrets），不进仓库、不写默认值。
变量名与 agents/*/llm.js 保持一致，两端共用同一套配置语义。

⑤ 生成接口的配置多一个来源：**界面运行时传入**（见下方 GenSettings）。
优先级 界面传入 > 环境变量，使用者在浏览器里临时填一次就能把链路跑通。
"""
import os
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTRACTS_DIR = os.path.join(ROOT, "contracts")
WORKFLOWS_DIR = os.path.join(ROOT, "workflows")
FALLBACK_DIR = os.path.join(ROOT, "space", "fallback")
OUT_DIR = os.path.join(ROOT, "tmp", "space_runs")
os.makedirs(OUT_DIR, exist_ok=True)


def llm_base_url() -> str:
    return (os.environ.get("LOOM_LLM_BASE_URL") or "https://api-inference.modelscope.cn/v1").rstrip("/")


# 2026-09-08 实测选型依据（同一 logline、同一套契约）：
#   Qwen3.8-Flash-Next        全链路 62s，剧本 3704 字符，分镜严格 8 镜（守 6–8 的约束）
#   Qwen3.5-397B-A17B         全链路 72s，剧本 1946 字符，8 镜，转折偏生硬
#   DeepSeek-V4-Pro-0813      全链路 83s，剧本 3515 字符，但分镜给到 15–21 镜（不听约束）
#   Qwen3.8-27B               单轮 129s，会撞超时（且 Qwen2.5-72B 已从 API-Inference 下线）
# 结论：创意环节（编剧）换更强的模型收益有限但可见；结构化环节（分镜/提示词）
# 反而是快的模型更守规矩。所以默认全站 Flash-Next，但留按站覆盖的口子。
DEFAULT_LLM_MODEL = "Qwen/Qwen3.8-Flash-Next"


def llm_model(slug=None) -> str:
    """取模型名，支持按 Agent 站覆盖。

    优先级：LOOM_LLM_MODEL_<SLUG>  >  LOOM_LLM_MODEL  >  默认值。
    例如只想让编剧用大模型、分镜提示词仍走快模型：
        LOOM_LLM_MODEL_SCREENWRITER=deepseek-ai/DeepSeek-V4-Pro-0813
        LOOM_LLM_MODEL=Qwen/Qwen3.8-Flash-Next
    """
    if slug:
        key = "LOOM_LLM_MODEL_%s" % str(slug).upper().replace("-", "_")
        v = os.environ.get(key)
        if v:
            return v
    return os.environ.get("LOOM_LLM_MODEL") or DEFAULT_LLM_MODEL


def llm_thinking() -> bool:
    """是否让模型先输出推理过程。默认关：实测关掉后快约 3 倍，正文质量无损。

    少数端点不认 enable_thinking 参数，llm.chat 会自动去掉重试。
    """
    return (os.environ.get("LOOM_LLM_THINKING") or "0").strip().lower() in ("1", "true", "yes", "on")


def llm_fix_rounds() -> int:
    """契约校验不过时，把问题清单回灌给模型重生成的轮数。

    实测 1 轮时 c04 只有 1/3 一次过；放到 3 轮兼顾成功率与等待时间
    （每轮约 15 秒，worst case 多花 45 秒）。
    """
    try:
        return max(0, min(int(os.environ.get("LOOM_LLM_FIX_ROUNDS") or 3), 5))
    except ValueError:
        return 3


def llm_api_key() -> str:
    """依次回退，与 llm.js 的顺序一致。"""
    for k in ("LOOM_LLM_API_KEY", "MODELSCOPE_API_KEY", "DASHSCOPE_API_KEY", "OPENAI_API_KEY"):
        v = os.environ.get(k)
        if v:
            return v
    return ""


def llm_timeout() -> int:
    # 一个完整剧本/镜头清单 JSON 有数千字符，27B 实测要 129 秒；120 秒会把它判死。
    # 留足余量到 300 秒，配合默认更快的 Flash-Next，正常应在 60 秒内返回。
    return int(os.environ.get("LOOM_LLM_TIMEOUT_MS") or 300000) // 1000


def run_budget_seconds() -> int:
    """整条流水线（①→④，含 ④ 的逐镜重试）愿意花的**墙上时间**上限，秒。

    为什么需要它：④ 是**逐镜各调一次** LLM（③ 要求 6–8 个镜头），而单次调用最坏
    = (1 + llm_fix_rounds) 轮 × (1 + retries) 次 HTTP × llm_timeout() 秒；
    按默认值算单镜最坏 4 × 3 × 300 = 3600 秒，8 镜叠起来就是**小时级**，
    且 `run_pipeline` 原本没有任何时间上界——上游一慢，前端 SSE 就无限期挂着。

    预算到了之后的处理是**明确的**：不再开始新的镜头，剩余镜头保留占位、
    在 notes 与状态栏如实标注「超出运行预算未生成」，而不是静默丢弃、
    更不是拿示例素材冒充。

    默认 1200 秒（20 分钟）：正常一整片 3–5 分钟，**默认配置下永远碰不到这条线**，
    因此不改变任何正常路径的行为；它只在病态慢（今天只会「什么都不返回」）时才生效。
    """
    try:
        return max(60, min(int(os.environ.get("LOOM_RUN_BUDGET_SECONDS") or 1200), 7200))
    except ValueError:
        return 1200


# ---------------------------------------------------------------- ⑤ 生成接口
#
# 创空间不内置、也不绑定任何具体的视频生成模型，也不依赖仓库外的私有节点。
# ⑤ 站对外只有一层标准化接口（见 space/generate.py 头部契约）：
# 把 ④ 产出的生成请求 POST 出去、把任务状态取回来。
#
# 配置有两个来源，优先级：**界面运行时传入** > 环境变量（创空间 secrets）。
# 2026-09-13 起支持使用者在自己的浏览器里临时填接口地址 / Key / 模型名，
# 不改环境变量也能把整条链路跑通。


class GenSettings(object):
    """⑤ 生成接口的一份配置快照。

    刻意做成**不可持久化的值对象**：使用者在界面里填的 Key 只活在这次请求里——
    不落盘（tmp/space_runs 只记非敏感的端点标签）、不进日志。
    __repr__ 会把 Key 掩掉，避免任何 %r / f-string 顺手把它打出去。
    """

    __slots__ = ("url", "key", "model", "backend", "timeout", "source")

    def __init__(self, url="", key="", model="", backend=None, timeout=None, source="env"):
        self.url = (url or "").strip().rstrip("/")
        self.key = key or ""
        self.model = (model or "").strip()
        self.backend = (backend or gen_backend()).strip().lower()
        self.timeout = float(timeout) if timeout else gen_timeout()
        self.source = source

    @property
    def configured(self) -> bool:
        return bool(self.url)

    def label(self) -> str:
        """给界面/日志用的非敏感标签：只有主机名，不带路径、查询串与凭据。"""
        if not self.url:
            return ""
        try:
            return urllib.parse.urlsplit(self.url).netloc or self.url
        except Exception:
            return self.url

    def masked(self) -> dict:
        return {"url": self.url, "model": self.model, "backend": self.backend,
                "timeout": self.timeout, "source": self.source,
                "key": "***" if self.key else ""}

    def __repr__(self):
        return "<GenSettings %r>" % (self.masked(),)


def gen_settings(overrides=None) -> "GenSettings":
    """合并「界面运行时传入」与「环境变量」，返回一份 GenSettings。

    overrides 形如 {"url":…, "key":…, "model":…, "backend":…, "timeout":…}；
    空字符串一律视为「没填」，回落到环境变量。
    """
    o = overrides or {}
    if isinstance(o, GenSettings):
        return o
    ui_url = str(o.get("url") or "").strip()
    return GenSettings(
        url=ui_url or gen_api_url(),
        # 界面留空则回落环境变量：内网/公开端点的人可以把 Key 留空
        key=(o.get("key") or gen_api_key()),
        model=str(o.get("model") or "").strip() or gen_api_model(),
        backend=str(o.get("backend") or "").strip() or None,
        timeout=o.get("timeout") or None,
        source="ui" if ui_url else "env",
    )


def gen_wait_seconds() -> int:
    """⑤ 提交后愿意等待成片的秒数上限。0 = 只提交不等待（立刻返回任务 ID）。"""
    try:
        return max(0, int(float(os.environ.get("LOOM_GEN_WAIT_SECONDS") or 300)))
    except ValueError:
        return 300


def gen_max_shots() -> int:
    """④ 最多为几个镜头产出生成请求（⑤ 也就最多下发这么多）。默认 8。

    ③ 分镜 Agent 被告知产出 6–8 个镜头，所以默认值 8 **等于不设限**；
    调小它可以在评测/演示时把整片缩短（同时也缩短 ⑤ 的下发时长）。
    超出的镜头会在 ④ 的 notes 里如实报出「已按上限截断」，不会静默丢弃。
    """
    try:
        return max(1, min(int(os.environ.get("LOOM_GEN_MAX_SHOTS") or 8), 24))
    except ValueError:
        return 8


def gen_backend() -> str:
    """后端选择：http（默认，通用模型 API） / replay（内置参考回放）。"""
    return (os.environ.get("LOOM_GEN_BACKEND") or "http").strip().lower()


def gen_api_url() -> str:
    """模型服务基址，形如 https://<host>/v1。空 = 接口就绪但未接入模型。"""
    return (os.environ.get("LOOM_GEN_API_URL") or "").strip().rstrip("/")


def gen_api_key() -> str:
    """模型服务鉴权 Key。为空时不发送 Authorization 头（本地/内网服务常见）。"""
    return os.environ.get("LOOM_GEN_API_KEY") or ""


def gen_api_model() -> str:
    """模型名，随提交请求一起发；服务端不需要就留空。"""
    return (os.environ.get("LOOM_GEN_API_MODEL") or "").strip()


def gen_timeout() -> float:
    """单次 HTTP 调用超时秒数。生成类接口通常提交即返回，30 秒足够。"""
    return float(os.environ.get("LOOM_GEN_TIMEOUT") or 30)
