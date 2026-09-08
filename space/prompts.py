# -*- coding: utf-8 -*-
"""从 agents/*/prompt.js 里读 system prompt。

为什么不复制一份到创空间：prompt 是 Agent 的人格，仓库里只有一份才不会出现
「改了 Agent 的脾气、创空间还是旧的」这种事。这里做的是运行时解析，
解析失败就报错，绝不静默降级成另一份文案。
"""
import os
import re

from . import config

# Agent slug -> (prompt.js 路径, 导出的常量名)
AGENT_PROMPTS = {
    "screenwriter": ("agents/screenwriter/prompt.js", "SCREENWRITER"),
    "storyboard": ("agents/storyboard/prompt.js", "STORYBOARD"),
    "prompt_writer": ("agents/prompt-writer/prompt.js", "PROMPT_WRITER"),
}

_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\", "`": "`", "$": "$"}


def _unescape(s: str) -> str:
    out = []
    i = 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            nxt = s[i + 1]
            out.append(_ESCAPES.get(nxt, "\\" + nxt))
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def load_prompt(slug: str) -> str:
    """解析 agents/<slug>/prompt.js 中 export const NAME = `...` 的模板字符串。"""
    if slug not in AGENT_PROMPTS:
        raise KeyError("未知 Agent：%s。可用：%s" % (slug, ", ".join(AGENT_PROMPTS)))
    rel, const = AGENT_PROMPTS[slug]
    path = os.path.join(config.ROOT, rel.replace("/", os.sep))
    if not os.path.exists(path):
        raise FileNotFoundError("找不到 prompt 文件：%s" % rel)

    src = open(path, encoding="utf-8").read()
    m = re.search(r"export\s+const\s+%s\s*=\s*`" % re.escape(const), src)
    if not m:
        raise ValueError("%s 里找不到 `export const %s = `" % (rel, const))

    i = m.end()
    buf = []
    while i < len(src):
        c = src[i]
        if c == "\\":
            buf.append(src[i:i + 2])
            i += 2
            continue
        if c == "`":
            return _unescape("".join(buf))
        buf.append(c)
        i += 1
    raise ValueError("%s 里的 %s 模板字符串没有闭合" % (rel, const))
