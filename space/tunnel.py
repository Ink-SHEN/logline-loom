# -*- coding: utf-8 -*-
"""隧道地址解析：创空间怎么在「地址会变」的前提下找到那台 DGX Spark。

问题
----
natapp 免费隧道的域名是服务端分配的（如 http://ncafd2da.natappfree.cc）。
实测重启客户端后域名**通常不变**（2026-09-08 连测两次都没变），但它**会变**：
隧道长时间离线被回收、服务端调度、重新购买隧道，都会换一个域名。
换域名后旧地址不是超时，而是返回 404 + `Tunnel xxx not found`——比超时更隐蔽，
因为「连不上」和「地址错了」在界面上长得一样。

对策：不赌一个地址，而是**维护一串候选地址，用之前先探活**。

优先级（越靠前越可信）：
  1. secrets 里的硬地址        LOOM_SPARK_BASE_URL        —— 人工兜底，最可靠
  2. Spark 主动上报来的地址     （POST /loom/tunnel/report）—— 自动跟进，域名变了也能自愈
  3. 上次探活成功过的地址       （内存 + 落盘缓存）

三者都没有 → 返回空 → 走预生成回放，并在界面上如实标注。
"""
import json
import os
import time
import urllib.error
import urllib.request

from . import config

CACHE_FILE = os.path.join(config.OUT_DIR, "tunnel_cache.json")
CACHE_TTL = 300  # 探活成功的地址，5 分钟内直接用，不用每次都探

_mem = {"url": "", "at": 0.0, "source": ""}


def _split_env(key):
    raw = os.environ.get(key) or ""
    return [u.strip().rstrip("/") for u in raw.replace("\n", ",").split(",") if u.strip()]


def _reported_url():
    try:
        with open(CACHE_FILE, encoding="utf-8") as f:
            d = json.load(f)
        return (d.get("url") or "").rstrip("/"), d.get("reported_at", 0)
    except Exception:
        return "", 0


def candidates():
    """去重后的候选地址列表，按可信度排序。"""
    out, seen = [], set()

    def add(u, src):
        u = (u or "").strip().rstrip("/")
        if not u or u in seen:
            return
        if not u.startswith(("http://", "https://")):
            u = "http://" + u
        seen.add(u)
        out.append((u, src))

    for u in _split_env("LOOM_SPARK_BASE_URL"):
        add(u, "secrets 硬地址")
    for u in _split_env("LOOM_COMFY_URL"):  # 兼容旧变量名
        add(u, "secrets（LOOM_COMFY_URL）")
    rep, _ts = _reported_url()
    add(rep, "Spark 上报")
    if _mem["url"]:
        add(_mem["url"], "上次探活成功")
    return out


def probe(url, timeout=None):
    """探活。返回 (是否可用, 说明)。

    注意 natapp 地址失效时返回的是 404 + 正文 `Tunnel xxx not found`，
    不是超时——必须把这种「通了但地址不对」的情况判为不可用，
    否则界面会显示「已连通」但提交任务永远失败。
    """
    timeout = timeout or config.probe_timeout()
    req = urllib.request.Request(url + "/system_stats", headers=config.auth_headers())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(4096).decode("utf-8", "replace")
        if "not found" in body.lower() and "tunnel" in body.lower():
            return False, "地址已失效（natapp 返回 Tunnel not found）"
        try:
            data = json.loads(body)
            dev = ((data.get("devices") or [{}])[0]).get("name", "")
            return True, "已连通：%s" % (dev or "ComfyUI 节点")
        except Exception:
            return True, "已连通（响应非 JSON）"
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return True, "已连通，但 token 被拒（HTTP %s）——检查 LOOM_PROXY_TOKEN 两端是否一致" % e.code
        return False, "HTTP %s" % e.code
    except Exception as e:
        return False, str(e)


def current(force=False):
    """返回当前可用的后端地址；都不可用返回 ""。"""
    if config.generation_mode() == "replay":
        return "", "运行模式被设为 replay"
    if not force and _mem["url"] and time.time() - _mem["at"] < CACHE_TTL:
        return _mem["url"], "（缓存命中，%s）" % _mem["source"]

    for url, src in candidates():
        ok, detail = probe(url)
        if ok:
            _mem.update({"url": url, "at": time.time(), "source": src})
            return url, "%s（来源：%s）" % (detail, src)
    _mem["url"] = ""
    cands = candidates()
    if not cands:
        return "", "未配置任何后端地址（LOOM_SPARK_BASE_URL），且未收到 Spark 上报"
    return "", "全部候选地址不可用：%s" % "；".join(
        "%s→%s" % (u, probe(u)[1]) for u, _ in cands[:3])


def save_reported(url, token):
    """收下 Spark 上报的地址。token 必须对得上，否则任何人都能把创空间指到别处。"""
    expect = config.proxy_token()
    if not expect:
        return False, "创空间未配置 LOOM_PROXY_TOKEN，拒绝接收上报"
    if not token or len(token) != len(expect):
        return False, "token 不匹配"
    r = 0
    for x, y in zip(token, expect):
        r |= ord(x) ^ ord(y)
    if r != 0:
        return False, "token 不匹配"
    url = (url or "").strip().rstrip("/")
    if not url.startswith(("http://", "https://")):
        return False, "地址格式不对：%s" % url
    try:
        json.dump({"url": url, "reported_at": int(time.time()), "source": "spark"},
                  open(CACHE_FILE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    except Exception as e:
        return False, "落盘失败：%s" % e
    # 新地址先探一次，好用就直接切成当前地址
    ok, detail = probe(url)
    if ok:
        _mem.update({"url": url, "at": time.time(), "source": "Spark 上报"})
    return True, "已接收并%s（%s）" % ("探活成功" if ok else "记录，但探活未通过", detail)


def status_lines():
    """给界面自检用的一段文字。"""
    cands = candidates()
    if not cands:
        return "未配置 LOOM_SPARK_BASE_URL，也没收到 Spark 上报 —— 将走预生成回放"
    url, detail = current()
    if url:
        return "当前后端：%s %s" % (url, detail)
    return "候选 %d 个，均不可用 —— 将走预生成回放（%s）" % (len(cands), detail)
