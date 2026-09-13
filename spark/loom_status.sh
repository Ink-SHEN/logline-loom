#!/bin/bash
# 一眼看清本地节点上还开着什么。
#
# 2026-09-13 第二次变更：**隧道与地址上报已退役**，本机不再有任何公网入口。
# 架构改成「创空间侧一层可插拔的模型 API 接口」（见 space/generate.py），
# 所以这里只列本机内部服务的存活情况，不再有 cloudflared / natapp / 上报守护。
L=/home/Developer/loom

echo "── ComfyUI（回环 8288，公网不可达） ──"
pgrep -f "[m]ain.py" >/dev/null && echo "  进程：在" || echo "  进程：❌ 不在"
curl -s -m 3 http://127.0.0.1:8288/system_stats >/dev/null 2>&1 \
  && echo "  接口：✅ 就绪" || echo "  接口：❌ 无响应"

echo "── 鉴权代理（8188，仅本机内部使用） ──"
pgrep -f "[l]oom_proxy.py" >/dev/null && echo "  进程：在" || echo "  进程：❌ 不在"
echo -n "  无 token 访问（期望 401）："
curl -s -m 3 -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:8188/system_stats

echo "── 整片调度器（127.0.0.1:8388） ──"
pgrep -f "[l]oom_batch.py" >/dev/null && echo "  进程：在" || echo "  进程：❌ 不在"
echo -n "  本地可达（无 token，期望 401）："
curl -s -m 3 -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:8388/batch/nonexistent

echo "── 已退役：公网隧道 / 地址上报 ──"
for p in cloudflared natapp; do
  pgrep -x "$p" >/dev/null && echo "  $p：仍在（应已停止，可 kill -x $p）" || echo "  $p：已停止 ✅"
done
pgrep -f "[l]oom_watch.py" >/dev/null && echo "  loom_watch：仍在（应已停止）" || echo "  loom_watch：已停止 ✅"
echo "  说明：⑤ 生成站已改为创空间侧可插拔模型 API 接口，本机不再需要公网入口。"
