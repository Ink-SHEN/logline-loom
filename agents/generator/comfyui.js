// agents/generator/comfyui.js — ComfyUI HTTP API 客户端（④生成 用）。
// 实现已并入 tools/comfyui.mjs（agents/README.md 第四节：共享客户端落 tools/ 后去重，
// 按 docs/node_baseline.md 第七节封装 /system_stats、/queue、/object_info、/upload/image、
// /prompt、/history、/view 七个接口）；本文件保留为再导出薄壳——
// agents/generator/{run,index}.js 的既有 import 不用动，④ 依旧自包含、可独立执行。
export * from '../../tools/comfyui.mjs';
