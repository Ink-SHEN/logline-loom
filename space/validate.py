# -*- coding: utf-8 -*-
"""契约校验：直接复用仓库里那份权威校验器 contracts/validate_contract.py。

创空间里跑的校验和本地命令行跑的是同一份代码——评审看到的「通过/不通过」
与你在本地 `python contracts/validate_contract.py` 看到的完全一致。
"""
import importlib.util
import os

from . import config

_SPEC = os.path.join(config.CONTRACTS_DIR, "validate_contract.py")
_mod = None


def _validator():
    global _mod
    if _mod is None:
        spec = importlib.util.spec_from_file_location("loom_validate_contract", _SPEC)
        _mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_mod)
        _mod.CONTRACTS_FILE = _SPEC.replace("validate_contract.py", "film_agent_contracts.json")
        _mod.EXAMPLES_FILE = _SPEC.replace("validate_contract.py", "examples.json")
    return _mod


def contracts():
    v = _validator()
    if not hasattr(contracts, "_cache"):
        contracts._cache = v.load(v.CONTRACTS_FILE)
    return contracts._cache


def validate(name, instance, check_gates=True):
    """返回 (是否通过, 问题列表)。check_gates=True 时人工关口未批准也算不通过。"""
    v = _validator()
    return v.validate_one(contracts(), name, instance, check_gates=check_gates)


def blocking_gates():
    return dict(_validator().BLOCKING_GATES)


def approve_gate(doc, reviewer, reason=""):
    """把强制人工关口置为 approved。谁批的、为什么批，都留在产物里。"""
    gate = (doc.get("payload") or {}).get("gate")
    if gate is None:
        return doc
    gate["required"] = True
    gate["status"] = "approved"
    gate["reviewer"] = reviewer
    gate["reviewed_at"] = _now()
    gate["reason"] = reason
    return doc


def _now():
    import datetime
    return datetime.datetime.now().astimezone().replace(microsecond=0).isoformat()
