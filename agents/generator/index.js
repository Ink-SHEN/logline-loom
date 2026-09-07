// agents/generator/index.js — 「④生成」Agent 的自包含入口。
// 一个文件夹 = 一个 Agent。这一站不调 LLM（promptExport: null）：它的活儿是把 c04 如实填进
// ComfyUI 的图、提交、等结果、把产物与全部证据落盘，没有「创作」可交给概率模型。
// 离线示例(sample) + ComfyUI 客户端(comfyui) + 填图(graph) + 硬指标测量(ffprobe)
// + 可执行管线(run) + 元信息(meta)。
// CLI：node agents/generator/run.js --requests artifacts/genreq_xxx/ [--dry-run]（详见 run.js --help）
export { AGENT_VERSION, AGENT_NAME, runGenerator } from './run.js';
export { sampleGenResult, sampleGenResultNoAudio } from './sample.js';
export {
  ComfyError, comfyConfig, comfyEndpoint, DEFAULT_ENDPOINT,
  getSystemStats, getQueue, getObjectInfo, allowedValues, uploadImage,
  postPrompt, getHistoryRecord, waitForHistory, downloadView, parseHistoryRecord, msToIso,
} from './comfyui.js';
export {
  MAP_KEY, WORKFLOW_FILE, EXPECTED_UNET, TURBO_LORA,
  loadNodeIdMap, loadTemplate, diffNodeIds, buildGraph, readModelFiles, checkUnetMatchesType,
} from './graph.js';
export { FfprobeError, findFfprobe, probeVideo, parseRate, toContractShape, countFrames, describeProbe } from './ffprobe.js';

export const meta = {
  name: '生成',
  slug: 'generator',
  role: '消费 c04_gen_request，按 FL2VA(T2V+I2V)→Ref2VA(R2V) 分批把工作流图提交给 ComfyUI 单例队列，轮询 /history 取回产物，落盘 shots/<候选>/video.mp4 + ffprobe.txt + meta.json，并把提交图、prompt_id、节点侧时间戳、缓存命中节点数、产物 sha256 一起写进 c05_gen_result，追加一行 docs/task_registry.md',
  promptExport: null, // ④生成 不调 LLM，没有人格可导出
  sampleExport: 'sampleGenResult',
  contract: 'c05_gen_result',
};
