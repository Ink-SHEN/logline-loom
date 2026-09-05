import json, io, urllib.request, urllib.error

COMFY = "http://127.0.0.1:8188"
FILES = {
    "t2v": "workflow_api_t2v.json",
    "i2v": "workflow_api_i2v.json",
    "r2v": "workflow_api_r2v.json",
}

out = io.StringIO()
def p(*a):
    out.write(" ".join(str(x) for x in a) + "\n")

_cache = {}
def object_info(cls):
    if cls in _cache:
        return _cache[cls]
    for path in (f"/api/object_info/{cls}", f"/object_info/{cls}"):
        try:
            with urllib.request.urlopen(COMFY + path, timeout=30) as r:
                d = json.loads(r.read())
            info = d.get(cls)
            if info:
                _cache[cls] = info
                return info
        except urllib.error.HTTPError:
            continue
        except Exception:
            continue
    _cache[cls] = None
    return None

def allowed_values(spec):
    """只有真正的 COMBO/枚举才返回可选值列表。
    ComfyUI object_info 里：
      基本类型 -> ["STRING", {...}] / ["INT", {...}]，spec[0] 是类型名字符串，不是枚举
      枚举     -> [["optA","optB"], {...}]，spec[0] 是列表
      新版枚举 -> ["COMBO", {"options": [...]}]
    注意：选项列表可能混有整数，例如 CreateVideo.bit_depth = ["auto", 8, 10]，
    只筛字符串会把合法的 8 判成非法。
    """
    if not isinstance(spec, list) or not spec:
        return None
    head = spec[0]
    opts = None
    if isinstance(head, list):
        opts = head
    elif isinstance(head, str) and head.upper() == "COMBO" and len(spec) > 1 and isinstance(spec[1], dict):
        o = spec[1].get("options")
        if isinstance(o, list):
            opts = o
    if opts is None:
        return None
    vals = [x for x in opts if isinstance(x, (str, int, float)) and not isinstance(x, bool)]
    return vals or None

total_bad = 0

for wid, fname in FILES.items():
    wf = json.load(open(fname, encoding="utf-8"))
    p("=" * 78)
    p(f"{wid}  ({fname})   {len(wf)} 节点")
    p("=" * 78)

    # 1) 建反向引用图，找悬空节点
    referenced = set()
    for nid, node in wf.items():
        for k, v in node.get("inputs", {}).items():
            if isinstance(v, list) and len(v) >= 1:
                referenced.add(str(v[0]))
    OUTPUT_CLASSES = {"SaveVideo", "SaveImage", "SaveAnimatedWEBP", "PreviewImage", "VHS_VideoCombine"}
    roots = {nid for nid, n in wf.items() if n.get("class_type") in OUTPUT_CLASSES}
    orphans = []
    for nid in wf:
        if nid in roots or nid in referenced:
            continue
        orphans.append(nid)

    # 2) 逐节点校验必填输入 + COMBO 取值
    bad = 0
    for nid, node in wf.items():
        cls = node.get("class_type", "?")
        info = object_info(cls)
        if info is None:
            p(f"\n  [{nid}] {cls}  -- 无法获取节点定义（可能类名不存在）")
            bad += 1
            continue
        inputs = node.get("inputs", {})
        spec_all = {}
        spec_all.update(info.get("input", {}).get("required", {}) or {})
        optional = info.get("input", {}).get("optional", {}) or {}
        spec_all.update(optional)
        required = info.get("input", {}).get("required", {}) or {}

        problems = []
        # 必填缺失（子图摊平后嵌套输入会变成 values.a 这种点号键名，须一并认可）
        for field in required:
            if field in inputs:
                continue
            if any(k == field or k.startswith(field + ".") for k in inputs):
                continue
            problems.append(f"缺少必填输入 {field!r}")
        # COMBO 取值不在允许列表（这是 "Value not in list" 的根源）
        for field, val in inputs.items():
            if isinstance(val, list):
                src = str(val[0])
                if src not in wf:
                    problems.append(f"{field} 指向不存在的节点 {src!r}")
                continue
            if field not in spec_all:
                continue
            av = allowed_values(spec_all[field])
            if av is not None and val not in av:
                hint = ""
                if field in ("image", "lora_name", "unet_name", "vae_name", "clip_name"):
                    hint = "  <-- 文件不存在于 ComfyUI 对应目录"
                problems.append(f"{field} = {val!r} 不在允许列表{hint}")

        is_orphan = nid in orphans
        if problems or is_orphan:
            tag = "悬空" if is_orphan else "  "
            p(f"\n  [{nid}] {cls}   {tag}")
            for x in problems:
                p(f"        [X] {x}")
            if is_orphan and not problems:
                p(f"        [!] 输出无人引用（不影响校验，但属冗余；若它自身缺输入则会导致 POST 失败）")
            bad += 1

    # 3) 关键一致性检查
    p("")
    res = {nid: n for nid, n in wf.items() if n.get("class_type") == "ResolutionSelector"}
    for nid, n in res.items():
        p(f"  分辨率节点 {nid}: aspect_ratio={n['inputs'].get('aspect_ratio')!r} "
          f"megapixels={n['inputs'].get('megapixels')} multiple={n['inputs'].get('multiple')}")
    for nid, n in wf.items():
        if n.get("class_type") == "RandomNoise":
            p(f"  种子节点 {nid}: noise_seed={n['inputs'].get('noise_seed')}")
    for nid, n in wf.items():
        if n.get("class_type") == "SaveVideo":
            p(f"  输出节点 {nid}: filename_prefix={n['inputs'].get('filename_prefix')!r}")

    p("")
    p(f"  >>> {wid} 共 {bad} 个节点有问题")
    total_bad += bad
    p("")

p("=" * 78)
p(f"全部检查结束：{total_bad} 处问题" if total_bad else "全部检查通过")
p("=" * 78)

open("preflight_report.txt", "w", encoding="utf-8", newline="\n").write(out.getvalue())
print("done")
