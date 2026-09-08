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


def llm_model() -> str:
    # 注意：Qwen2.5-72B-Instruct 已从魔搭 API-Inference 下线（2026-09 实测 /v1/models 里没有了）。
    # 同为赛事点名的 Qwen3.8 系列里，Flash-Next 比 27B 快约 4 倍（2026-09-08 实测：
    # 同样写 3 场景剧本 JSON，Flash-Next 31.9s / 24.4 ch/s，27B 129.1s / 7.4 ch/s）。
    # 27B 会撞上 120s 超时上限导致三个 Agent 全部降级，所以默认走 Flash-Next。
    return os.environ.get("LOOM_LLM_MODEL") or "Qwen/Qwen3.8-Flash-Next"


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
    """ComfyUI 反向代理地址。空 = 不接真生成。"""
    return (os.environ.get("LOOM_COMFY_URL") or "").rstrip("/")


def proxy_token() -> str:
    return os.environ.get("LOOM_PROXY_TOKEN") or ""


def probe_timeout() -> float:
    return float(os.environ.get("LOOM_PROBE_TIMEOUT") or 5)


def generate_budget() -> int:
    """真生成最长等待秒数，超时改用回放并如实标注。"""
    return int(os.environ.get("LOOM_GENERATE_BUDGET") or 240)


def generation_mode() -> str:
    """auto（默认，探测后自动切） / live（只真生成，不可达就报错） / replay（只回放）"""
    return (os.environ.get("LOOM_GENERATION_MODE") or "auto").lower()
