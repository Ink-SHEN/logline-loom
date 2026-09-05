#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""接口契约校验器。

用途：三人并行开发时，各自产出的 JSON 先过这一关再交给下游。
契约不合就不许往下传，这样"合不起来"的问题在产出方就暴露，不会攒到最后。

依赖：pip install jsonschema

用法：
  python validate_contract.py --list
  python validate_contract.py --selftest                 # 校验 examples.json 里的 7 份示例
  python validate_contract.py --contract c04_gen_request --file 某个产物.json
  python validate_contract.py --dir artifacts/           # 批量校验，自动按 envelope.contract 认类型

退出码：0 = 全部通过，1 = 有不通过，2 = 用法/文件错误
"""
import argparse
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


class Tee:
    """同时写到终端和一份 UTF-8 报告文件。

    Windows 控制台默认 GBK，中文容易变乱码；有这份文件兜底，
    终端显示成什么样都不影响事后查看。
    """

    def __init__(self, stream, path):
        self.stream = stream
        self.fh = open(path, "w", encoding="utf-8", newline="\n")

    def write(self, s):
        self.stream.write(s)
        self.fh.write(s)

    def flush(self):
        self.stream.flush()
        self.fh.flush()

    def close(self):
        self.fh.close()

try:
    from jsonschema import Draft202012Validator, FormatChecker
except ImportError:
    print("缺少依赖，请先执行：python -m pip install jsonschema")
    sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACTS_FILE = os.path.join(HERE, "film_agent_contracts.json")
EXAMPLES_FILE = os.path.join(HERE, "examples.json")

CONTRACT_ORDER = [
    "c01_brief",
    "c02_screenplay",
    "c03_shotlist",
    "c04_gen_request",
    "c05_gen_result",
    "c06_qc_report",
    "c07_edit_decision",
]

# 每道契约的强制人工关口。required=true 时 status 必须是 approved 才放行下游。
BLOCKING_GATES = {"c02_screenplay": "剧本确认", "c07_edit_decision": "粗剪确认"}


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def build_validator(contracts, name):
    """把单个契约抽出来做成自包含 schema 再校验。

    为什么不用 referencing.Registry：契约内部的引用都写成 "#/$defs/xxx"，
    这个 "#" 指的是【校验器根 schema】。如果把 c01_brief 单独拿出来当根，
    它自己没有 $defs，指针就落到 nowhere（实测会抛 PointerToNowhere）。
    最省事且无额外依赖的做法：把整份 $defs 复制进子 schema，
    让它自己成为带 $defs 的根，所有内部指针都能解析。
    """
    defs = contracts.get("$defs", {})
    if name not in defs:
        raise KeyError(name)
    subschema = dict(defs[name])
    subschema["$defs"] = defs
    return Draft202012Validator(subschema, format_checker=FormatChecker())


def fmt_error(err, indent="    "):
    """把 jsonschema 的报错翻译成人能看懂的路径 + 原因。"""
    path = "/".join(str(p) for p in err.absolute_path) or "(根)"
    return "%s%s: %s" % (indent, path, err.message)


def check_gate(name, instance):
    """人工关口检查。返回问题列表。"""
    problems = []
    if name not in BLOCKING_GATES:
        return problems
    gate = (instance.get("payload") or {}).get("gate")
    if gate is None:
        problems.append("这是强制人工关口（%s），但 payload.gate 缺失" % BLOCKING_GATES[name])
        return problems
    if gate.get("required") is True and gate.get("status") != "approved":
        problems.append("人工关口「%s」未通过（status=%r）。下游 Agent 必须阻塞等待，"
                        "禁止自动流转" % (BLOCKING_GATES[name], gate.get("status")))
    return problems


def check_contract_field(name, instance):
    """envelope.contract 必须与文件名声明的类型一致，防止张冠李戴。"""
    got = (instance.get("envelope") or {}).get("contract")
    if got != name:
        return ["envelope.contract = %r，但按 %r 校验。二者必须一致" % (got, name)]
    return []


def validate_one(contracts, name, instance, check_gates=True):
    """返回 (是否通过, 问题列表)。

    check_gates=True 时把「人工关口未批准」也算作不通过——交接给下游前应该这么查。
    check_gates=False 时只做结构校验——自检契约本身是否自洽时用这个，
    因为示例里可能故意留一个 pending 的关口来演示阻塞长什么样。
    """
    problems = []
    try:
        v = build_validator(contracts, name)
    except KeyError:
        return False, ["未知契约 %r。可用：%s" % (name, ", ".join(CONTRACT_ORDER))]

    errors = sorted(v.iter_errors(instance), key=lambda e: list(e.absolute_path))
    for e in errors:
        problems.append(fmt_error(e))
    problems.extend(check_contract_field(name, instance))
    if check_gates:
        problems.extend(check_gate(name, instance))
    return (not problems), problems


def cmd_list(contracts):
    print("可用契约（7 道交接面）：")
    for name in CONTRACT_ORDER:
        d = contracts["$defs"][name]
        mark = "  [强制人工关口]" if name in BLOCKING_GATES else ""
        print("  %-20s %s%s" % (name, d.get("title", ""), mark))
    return 0


def cmd_selftest(contracts):
    if not os.path.exists(EXAMPLES_FILE):
        print("找不到 %s" % EXAMPLES_FILE)
        return 2
    examples = load(EXAMPLES_FILE)
    ok_all = True
    print("=" * 70)
    print("自检：校验 examples.json 里的示例产物（只查结构，不查关口流转状态）")
    print("=" * 70)
    for name in CONTRACT_ORDER:
        if name not in examples:
            print("  [缺失] %-20s examples.json 里没有这份示例" % name)
            ok_all = False
            continue
        inst = examples[name]
        ok, problems = validate_one(contracts, name, inst, check_gates=False)
        aid = inst.get("envelope", {}).get("artifact_id", "?")
        if ok:
            print("  [通过] %-20s artifact_id=%s" % (name, aid))
        else:
            ok_all = False
            print("  [不通过] %-20s artifact_id=%s" % (name, aid))
            for p in problems:
                print(p)

        # 关口状态单独作为信息展示，不计入通过与否
        if name in BLOCKING_GATES:
            gate = (inst.get("payload") or {}).get("gate") or {}
            print("         └ 强制人工关口「%s」：required=%s status=%s"
                  % (BLOCKING_GATES[name], gate.get("required"), gate.get("status")))
            if gate.get("required") is True and gate.get("status") != "approved":
                print("           （示例故意留成未批准，用来演示阻塞。真交接时"
                      "--file/--dir 模式会把它判为不通过）")

    print("=" * 70)
    print("自检结果：%s" % ("7 份示例全部符合契约结构" if ok_all else "有结构问题，见上"))
    print("=" * 70)
    return 0 if ok_all else 1


def cmd_file(contracts, name, path):
    if not os.path.exists(path):
        print("文件不存在：%s" % path)
        return 2
    inst = load(path)
    ok, problems = validate_one(contracts, name, inst)
    if ok:
        print("[通过] %s 符合 %s" % (path, name))
        return 0
    print("[不通过] %s 违反 %s，共 %d 处：" % (path, name, len(problems)))
    for p in problems:
        print(p)
    return 1


def cmd_dir(contracts, directory):
    if not os.path.isdir(directory):
        print("目录不存在：%s" % directory)
        return 2
    files = []
    for root, _, names in os.walk(directory):
        for n in names:
            if n.endswith(".json"):
                files.append(os.path.join(root, n))
    files.sort()
    if not files:
        print("目录里没有 .json：%s" % directory)
        return 2

    bad = 0
    print("=" * 70)
    print("批量校验 %s（%d 个 json）" % (directory, len(files)))
    print("=" * 70)
    for path in files:
        try:
            inst = load(path)
        except Exception as e:
            print("  [解析失败] %s -> %s" % (path, e))
            bad += 1
            continue
        name = (inst.get("envelope") or {}).get("contract")
        if name not in CONTRACT_ORDER:
            print("  [跳过] %s -> envelope.contract=%r 不是已知契约" % (path, name))
            continue
        ok, problems = validate_one(contracts, name, inst)
        if ok:
            print("  [通过] %s (%s)" % (path, name))
        else:
            bad += 1
            print("  [不通过] %s (%s)" % (path, name))
            for p in problems:
                print(p)
    print("=" * 70)
    print("结果：%d 个文件不通过" % bad)
    print("=" * 70)
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description="电影 Agent 接口契约校验器")
    ap.add_argument("--list", action="store_true", help="列出 7 道契约")
    ap.add_argument("--selftest", action="store_true", help="校验自带的 7 份示例")
    ap.add_argument("--contract", help="契约名，如 c04_gen_request")
    ap.add_argument("--file", help="要校验的产物 json")
    ap.add_argument("--dir", help="批量校验一个目录下所有 json")
    ap.add_argument("--contracts", default=CONTRACTS_FILE, help="契约文件路径")
    ap.add_argument("--report", default=os.path.join(HERE, "validate_report.txt"),
                    help="UTF-8 报告输出路径，防止终端 GBK 乱码看不清")
    args = ap.parse_args()

    real_stdout = sys.stdout
    tee = Tee(real_stdout, args.report)
    sys.stdout = tee
    try:
        return _run(args)
    finally:
        sys.stdout = real_stdout
        tee.close()
        real_stdout.write("（报告已写入 %s）\n" % args.report)


def _run(args):
    if not os.path.exists(args.contracts):
        print("找不到契约文件：%s" % args.contracts)
        return 2
    try:
        contracts = load(args.contracts)
    except Exception as e:
        print("契约文件本身不是合法 JSON：%s" % e)
        return 2

    # 七份契约自己都得是合法 schema，否则报错会很难懂
    for cname in CONTRACT_ORDER:
        sub = contracts.get("$defs", {}).get(cname)
        if sub is None:
            print("契约文件里缺 %s" % cname)
            return 2
        try:
            Draft202012Validator.check_schema(sub)
        except Exception as e:
            print("契约 %s 的 schema 定义本身有问题：%s" % (cname, e))
            return 2

    if args.list:
        return cmd_list(contracts)
    if args.selftest:
        return cmd_selftest(contracts)
    if args.dir:
        return cmd_dir(contracts, args.dir)
    if args.contract and args.file:
        return cmd_file(contracts, args.contract, args.file)

    print("没指定要做什么。试试 --list / --selftest / --contract X --file Y / --dir Z")
    return 2


if __name__ == "__main__":
    sys.exit(main())
