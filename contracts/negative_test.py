#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""反向测试：故意造 8 种组员真实会犯的错，确认校验器抓得住。

校验器只会说"通过"是没有价值的。这份测试证明契约是有牙齿的。
每条都注明"为什么这是真会犯的错"。

用法：python negative_test.py
退出码：0 = 8 条全部被抓到（符合预期），1 = 有漏网
"""
import copy
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from validate_contract import (CONTRACTS_FILE, EXAMPLES_FILE, load,
                               validate_one)

contracts = load(CONTRACTS_FILE)
examples = load(EXAMPLES_FILE)

CASES = []


def case(title, why, contract, mutate):
    CASES.append((title, why, contract, mutate))


# 1
def m1(inst):
    inst["payload"]["generation"]["aspect_ratio"] = "16:9"
case("画幅漏掉括号后缀",
     "ResolutionSelector 的合法值是 '16:9 (Widescreen)'，写 '16:9' 会报 Value not in list",
     "c04_gen_request", m1)


# 2
def m2(inst):
    inst["payload"]["generation"]["duration_seconds"] = 20
case("时长超过 H3 单次上限",
     "H3 单次生成约 4–15 秒，写 20 秒要么报错要么产出被截断",
     "c04_gen_request", m2)


# 3
def m3(inst):
    inst["payload"]["generation"]["filename_prefix"] = "video/MiniMax_H3"
case("沿用模板默认输出前缀",
     "三份模板默认都是 video/MiniMax_H3，不改的话所有产物挤在 output/video/ 下按序号递增，无法归档到镜头",
     "c04_gen_request", m3)


# 4
def m4(inst):
    inst["payload"]["generation"]["seed"] = "1001"
case("种子写成字符串",
     "从表格或聊天里复制数字很容易带上引号，noise_seed 必须是整数",
     "c04_gen_request", m4)


# 5
def m5(inst):
    del inst["payload"]["workflow"]["node_ids"]["prompt"]
case("node_ids 少了 prompt 映射",
     "提示词是每次必改的字段，映射表少这一条就意味着 Agent 根本不知道该写哪个节点",
     "c04_gen_request", m5)


# 6
def m6(inst):
    inst["payload"]["workflow"]["type"] = "I2V"
    inst["payload"]["workflow"]["api_json"] = "workflow_api_i2v.json"
    inst["payload"]["assets"] = {}
case("声明 I2V 却没给首帧图",
     "MiniMaxH3ImageToVideo 的 first_frame 缺失会直接让 POST 失败，白跑一次排队",
     "c04_gen_request", m6)


# 7
def m7(inst):
    inst["payload"]["workflow"]["type"] = "R2V"
    inst["payload"]["workflow"]["api_json"] = "workflow_api_r2v.json"
    inst["payload"]["assets"] = {"first_frame": inst["payload"]["assets"].get("first_frame")}
    inst["payload"]["assets"] = {"ref_images": []}
case("声明 R2V 但参考图列表为空",
     "Ref2VA 没有参考图就没有意义，且节点会因缺必填输入报错",
     "c04_gen_request", m7)


# 8
def m8(inst):
    inst["payload"]["gate"]["status"] = "pending"
    inst["payload"]["gate"]["reviewer"] = None
case("剧本没经人工确认就想往下游走",
     "剧本确认是全片两处强制人工关口之一，未批准时分镜 Agent 必须阻塞",
     "c02_screenplay", m8)


lines = []


def p(s=""):
    lines.append(s)
    print(s)


p("=" * 74)
p("反向测试：8 种真实会犯的错，看校验器抓不抓得住")
p("=" * 74)

missed = 0
for i, (title, why, cname, mutate) in enumerate(CASES, 1):
    inst = copy.deepcopy(examples[cname])
    mutate(inst)
    ok, problems = validate_one(contracts, cname, inst, check_gates=True)
    p("")
    p("[%d] %s" % (i, title))
    p("    为什么是真错：%s" % why)
    if ok:
        missed += 1
        p("    >>> 漏网！校验器说通过了，这条契约需要补强")
    else:
        p("    >>> 已抓到，%d 条报错：" % len(problems))
        for q in problems[:3]:
            p("        %s" % q.strip())
        if len(problems) > 3:
            p("        ...（另有 %d 条）" % (len(problems) - 3))

p("")
p("=" * 74)
p("结果：%d/%d 抓到，漏网 %d 条" % (len(CASES) - missed, len(CASES), missed))
p("=" * 74)

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "negative_test_report.txt"), "w",
          encoding="utf-8", newline="\n") as f:
    f.write("\n".join(lines) + "\n")

sys.exit(1 if missed else 0)
