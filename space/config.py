# -*- coding: utf-8 -*-
"""创空间运行配置。

所有敏感值都从环境变量读（创空间里配置成 secrets），不进仓库、不写默认值。
变量名与 agents/*/llm.js 保持一致，两端共用同一套配置语义。
"""
import os

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


def comfy_url() -> str:
    """第一个候选地址。新配置请用 LOOM_SPARK_BASE_URL（可填多个，逗号分隔，逐个探活）。"""
    raw = os.environ.get("LOOM_SPARK_BASE_URL") or os.environ.get("LOOM_COMFY_URL") or ""
    return raw.split(",")[0].strip().rstrip("/")


def proxy_token() -> str:
    return os.environ.get("LOOM_PROXY_TOKEN") or ""


def auth_headers():
    """访问 Spark 代理的请求头。token 两端必须完全一致，否则代理返回 401。"""
    h = {"Content-Type": "application/json"}
    t = proxy_token()
    if t:
        h["Authorization"] = "Bearer %s" % t
    return h


def probe_timeout() -> float:
    return float(os.environ.get("LOOM_PROBE_TIMEOUT") or 5)


def generate_budget() -> int:
    """真生成最长等待秒数，超时改用回放并如实标注。"""
    return int(os.environ.get("LOOM_GENERATE_BUDGET") or 240)


def generation_mode() -> str:
    """auto（默认，探测后自动切） / live（只真生成，不可达就报错） / replay（只回放）"""
    return (os.environ.get("LOOM_GENERATION_MODE") or "auto").lower()
