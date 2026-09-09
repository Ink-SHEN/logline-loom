#!/bin/bash
# 一眼看清整条链路：ComfyUI → 代理 → natapp → 创空间上报。
# 评审期间每天瞄一眼这个就够了。
L=/home/Developer/loom

echo "── ComfyUI（回环 8288，公网不可达） ──"
pgrep -f "[m]ain.py" >/dev/null && echo "  进程：在" || echo "  进程：❌ 不在"
curl -s -m 3 http://127.0.0.1:8288/system_stats >/dev/null 2>&1 \
  && echo "  接口：✅ 就绪" || echo "  接口：❌ 无响应"

echo "── 鉴权代理（0.0.0.0:8188 = natapp 转发目标） ──"
pgrep -f "[l]oom_proxy.py" >/dev/null && echo "  进程：在" || echo "  进程：❌ 不在"
echo -n "  无 token 访问（期望 401）："
curl -s -m 3 -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:8188/system_stats

echo "── 整片调度器（127.0.0.1:8388，代理 /batch/* 转发） ──"
pgrep -f "[l]oom_batch.py" >/dev/null && echo "  进程：在" || echo "  进程：❌ 不在"
echo -n "  本地可达（无 token，期望 401）："
curl -s -m 3 -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:8388/batch/nonexistent

echo "── natapp 隧道 ──"
pgrep -x natapp >/dev/null && echo "  进程：在" || echo "  进程：❌ 不在"
URL=$(cat "$L/tunnel_url" 2>/dev/null)
echo "  地址：${URL:-（未知）}"
if [ -n "$URL" ]; then
  echo -n "  公网可达性（无 token，期望 401）："
  curl -s -m 8 -o /dev/null -w "HTTP %{http_code}\n" "$URL/system_stats"
fi

echo "── 地址上报 ──"
pgrep -f "[l]oom_watch.py" >/dev/null && echo "  守护：在" || echo "  守护：❌ 不在"
[ -f "$L/report_state.json" ] && cat "$L/report_state.json" || echo "  尚无上报记录"
