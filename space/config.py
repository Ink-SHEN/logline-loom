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
    # 默认改用赛事模型库里点名的 Qwen3.8。换模型只改环境变量，不动代码。
    return os.environ.get("LOOM_LLM_MODEL") or "Qwen/Qwen3.8-27B"


def llm_api_key() -> str:
    """依次回退，与 llm.js 的顺序一致。"""
    for k in ("LOOM_LLM_API_KEY", "MODELSCOPE_API_KEY", "DASHSCOPE_API_KEY", "OPENAI_API_KEY"):
        v = os.environ.get(k)
        if v:
            return v
    return ""


def llm_timeout() -> int:
    return int(os.environ.get("LOOM_LLM_TIMEOUT_MS") or 120000) // 1000


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
