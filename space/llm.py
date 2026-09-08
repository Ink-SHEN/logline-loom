# -*- coding: utf-8 -*-
"""OpenAI Chat Completions 兼容客户端。

与 agents/*/llm.js 同构：同样的环境变量、同样的重试策略（429/5xx/网络错误重试，
4xx 直接抛）、同样的 JSON 提取顺序（先 ```json 围栏，再首个 { 到末个 }）。
"""
import json
import re
import time
import urllib.error
import urllib.request

from . import config

RETRY_STATUS = (429,)


class LlmError(RuntimeError):
    def __init__(self, message, retryable=False):
        super().__init__(message)
        self.retryable = retryable


def _headers():
    key = config.llm_api_key()
    if not key:
        raise LlmError("未配置 API Key（LOOM_LLM_API_KEY / MODELSCOPE_API_KEY / DASHSCOPE_API_KEY / OPENAI_API_KEY 任一）")
    return {"Content-Type": "application/json", "Authorization": "Bearer %s" % key}


def _request_body(messages, temperature, thinking_off, model=None):
    body = {
        "model": model or config.llm_model(),
        "messages": messages,
        "temperature": temperature,
    }
    # Qwen3 系默认开 thinking，实测一轮剧本要产出 5000+ 字符的推理内容，
    # 关掉后同样请求 35.0s → 12.1s，且正文反而更长（不再把预算耗在 reasoning 上）。
    if thinking_off:
        body["enable_thinking"] = False
    return body


def chat(messages, temperature=0.7, retries=2, backoff=1.0, timeout=None, model=None):
    """model 可为空，此时用 config.llm_model()；传了就按站覆盖。"""
    url = config.llm_base_url() + "/chat/completions"
    thinking_off = not config.llm_thinking()
    timeout = timeout or config.llm_timeout()

    last = None
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(attempt * backoff)
        # 某些端点不认 enable_thinking；一旦被拒，后续重试不再带这个参数
        body = json.dumps(_request_body(messages, temperature, thinking_off, model)).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers=_headers(), method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            if thinking_off and "enable_thinking" in detail:
                thinking_off = False
                last = LlmError("端点不接受 enable_thinking，已去掉重试", retryable=True)
                continue
            if e.code in RETRY_STATUS or e.code >= 500:
                last = LlmError("HTTP %s：%s" % (e.code, detail), retryable=True)
                continue
            raise LlmError("HTTP %s：%s" % (e.code, detail))
        except Exception as e:  # 网络 / 超时
            last = LlmError("请求 %s 失败：%s" % (url, e), retryable=True)
            continue

        content = (data.get("choices") or [{}])[0].get("message", {}).get("content")
        if isinstance(content, str) and content.strip():
            return content
        last = LlmError("响应缺少 choices[0].message.content：%s" % json.dumps(data)[:300])
    raise last


def extract_json(text):
    """与 llm.js 的 extractJson 同序：先 ```json 围栏，再首个 { 到末个 }。"""
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.I)
    candidate = fence.group(1) if fence else text
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start == -1 or end <= start:
        raise LlmError("模型输出中找不到 JSON 对象")
    try:
        return json.loads(candidate[start:end + 1])
    except Exception as e:
        raise LlmError("JSON 解析失败：%s" % e)
