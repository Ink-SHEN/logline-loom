import json, io

MAP = json.load(open("node_id_map.json", encoding="utf-8"))
out = io.StringIO()
def p(*a):
    out.write(" ".join(str(x) for x in a) + "\n")

bad = 0
for wid in ("t2v", "i2v", "r2v"):
    e = MAP[wid]
    wf = json.load(open(e["file"], encoding="utf-8"))
    p("=" * 70)
    p(f"{wid}  ({e['file']})  映射表声明 {e['node_count']} 节点 / 实际 {len(wf)} 节点")
    if e["node_count"] != len(wf):
        p("  [X] 节点数不符")
        bad += 1
    p("=" * 70)

    def chk(node, key, tag, expect_enum=None):
        global bad
        if node not in wf:
            p(f"  [X] {tag:<20} 节点 {node!r} 不存在")
            bad += 1
            return
        inputs = wf[node].get("inputs", {})
        if key not in inputs:
            p(f"  [X] {tag:<20} {node!r} 无 {key!r}，实际键: {list(inputs)}")
            bad += 1
            return
        v = inputs[key]
        if isinstance(v, list):
            p(f"  [X] {tag:<20} {node!r}.{key} 是链接(来自 {v[0]})，不可直接改")
            bad += 1
            return
        s = repr(v)
        if len(s) > 44:
            s = s[:44] + "..."
        flag = ""
        if expect_enum:
            allowed = MAP["_enums"].get(expect_enum, {}).get("allowed")
            if allowed is not None and v not in allowed:
                flag = f"   [X] 不在合法值 {allowed}"
                bad += 1
            elif allowed is not None:
                flag = "   [OK 合法值]"
        p(f"  [OK] {tag:<20} {node!r}.{key} = {s}{flag}")

    ENUM_HINT = {"aspect_ratio": "aspect_ratio", "megapixels": None,
                 "unet_name": "unet_name", "clip_name": "clip_name",
                 "video_vae_name": "vae_name", "audio_vae_name": "vae_name",
                 "lora_name": "lora_name", "sampler_name": "sampler_name",
                 "scheduler": "scheduler", "weight_dtype": "weight_dtype",
                 "clip_type": "clip_type", "color_space": "color_space",
                 "bit_depth": "bit_depth", "ref_image_size": "ref_image_size"}
    for tag, info in e["fields"].items():
        chk(info["node"], info["key"], tag, ENUM_HINT.get(tag))
    for img in e.get("image_inputs", []):
        chk(img["node"], img["key"], "img:" + img["role"], "image")
    for tag, info in e.get("derived_nodes", {}).items():
        n = info["node"]
        if n not in wf:
            p(f"  [X] {tag:<20} 节点 {n!r} 不存在"); bad += 1
        elif wf[n].get("class_type") != info["class_type"]:
            p(f"  [X] {tag:<20} 节点 {n!r} 类型是 {wf[n].get('class_type')}，期望 {info['class_type']}"); bad += 1
        elif info["key"] not in wf[n].get("inputs", {}):
            p(f"  [X] {tag:<20} 节点 {n!r} 无 {info['key']!r}"); bad += 1
        else:
            p(f"  [OK] {tag:<20} {n!r}.{info['key']} ({info['class_type']})")
    p("")

p("=" * 70)
p(f"验证结束：{bad} 处问题" if bad else "验证通过：映射表与工作流完全一致，且所有枚举取值合法")
p("=" * 70)
open("verify_map_report.txt", "w", encoding="utf-8", newline="\n").write(out.getvalue())
print("bad =", bad)
