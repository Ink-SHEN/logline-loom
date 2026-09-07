// agents/generator/graph.js — 把 c04_gen_request 填进 ComfyUI 的 API 格式工作流图（④生成 专用）。
//
// 三条纪律，都来自仓库里已经踩过的坑：
//   1. 节点 ID 一律从 c04 的 workflow.node_ids 取，并与 workflows/node_id_map.json 逐条比对——
//      两边不一致说明模板被重新导出过，此时按旧 ID 写值会写到别的节点上，必须先重跑
//      workflows/preflight.py 与 verify_map.py 再让 ③提示词 重出 c04（docs/agent_guide.md 第九节）。
//   2. T2V/I2V 的节点 ID 是子图摊平后的复合编号（"140:131"），必须用完整字符串索引，graph["131"] 取不到。
//   3. duration_seconds 写的是【秒】（浮点），不是帧数。帧数由下游 ComfyMathExpression 换算并对齐到
//      17 的倍数，禁止绕过它直接写 length（node_id_map.json 的 _meta.warnings 第 2 条）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAP_KEY = { T2V: 't2v', I2V: 'i2v', R2V: 'r2v' };
export const WORKFLOW_FILE = { T2V: 'workflow_api_t2v.json', I2V: 'workflow_api_i2v.json', R2V: 'workflow_api_r2v.json' };

// 每份工作流该用哪份权重：判断「这次跑的是 FL2VA 还是 Ref2VA」的唯一依据（shots/README.md 第二节）
export const EXPECTED_UNET = {
  T2V: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  I2V: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  R2V: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
};
export const TURBO_LORA = {
  FL2VA: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
  REF2VA: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
};

// c04 的 generation 里这些键要落进图；键名 = node_id_map.json 的 fields 语义名
const DIRECT_WRITES = [
  ['prompt', 'prompt'],
  ['seed', 'seed'],
  ['duration_seconds', 'duration_seconds'],
  ['aspect_ratio', 'aspect_ratio'],
  ['megapixels', 'megapixels'],
  ['filename_prefix', 'filename_prefix'],
  ['fps', 'fps'],
  ['multiple', 'multiple'],
  ['bit_depth', 'bit_depth'],
  ['color_space', 'color_space'],
  ['sampler_name', 'sampler_name'],
  ['scheduler', 'scheduler'],
];

export function loadNodeIdMap(workflowsDir) {
  const path = join(workflowsDir, 'node_id_map.json');
  let map;
  try {
    map = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`无法读取 workflows/node_id_map.json：${e.message}（节点 ID 只能从映射表查；模板重新导出过就先跑 python workflows/preflight.py 与 verify_map.py）`);
  }
  for (const t of ['T2V', 'I2V', 'R2V']) {
    if (!map[MAP_KEY[t]]?.fields) throw new Error(`node_id_map.json 缺 ${MAP_KEY[t]}.fields，映射表版本不对`);
  }
  return map;
}

export function loadTemplate(workflowsDir, type, apiJson) {
  const file = apiJson || WORKFLOW_FILE[type];
  const path = join(workflowsDir, file);
  let wf;
  try {
    wf = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`无法读取工作流模板 ${file}：${e.message}`);
  }
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) throw new Error(`${file} 不是 API 格式的图（应为 {节点ID: {class_type, inputs}}）`);
  return { wf, file, path };
}

/**
 * c04 的 node_ids 与当前映射表逐条比对。
 * 返回不一致清单（空 = 一致）。source 字段不参与比对（它记的是映射表版本）。
 */
export function diffNodeIds(c04NodeIds, mapEntry) {
  const bad = [];
  for (const [semantic, pair] of Object.entries(c04NodeIds ?? {})) {
    if (semantic === 'source') continue;
    const want = mapEntry.fields[semantic];
    if (!want) {
      bad.push(`${semantic}: 映射表里没有这个语义键（c04 写的是 ${JSON.stringify(pair)}）`);
      continue;
    }
    if (!Array.isArray(pair) || pair[0] !== want.node || pair[1] !== want.key) {
      bad.push(`${semantic}: c04 写的是 ${JSON.stringify(pair)}，映射表现在是 ["${want.node}", "${want.key}"]`);
    }
  }
  return bad;
}

function setInGraph(graph, node, key, value, writes, semantic, problems) {
  const target = graph[node];
  if (!target || typeof target !== 'object') {
    problems.push(`${semantic}: 模板里没有节点 "${node}"（模板可能重新导出过，先跑 python workflows/preflight.py）`);
    return;
  }
  if (!target.inputs || typeof target.inputs !== 'object') target.inputs = {};
  target.inputs[key] = value;
  writes.push({ semantic, node, key, value, class_type: target.class_type });
}

/**
 * 按 c04 填图。返回 { graph, writes, problems, imageWrites }。
 * problems 非空就不许 POST——填错一个节点等于白烧一整轮 GPU 才在 ComfyUI 里报错。
 */
export function buildGraph({ template, type, c04, mapEntry }) {
  const problems = [];
  const writes = [];
  const imageWrites = [];
  const graph = JSON.parse(JSON.stringify(template)); // 深拷贝：一份模板要填多个候选
  const nodeIds = c04.payload.workflow.node_ids;
  const gen = c04.payload.generation;
  const wf = c04.payload.workflow;
  const fields = mapEntry.fields;

  // 1) 直接映射的 generation 字段
  for (const [genKey, semantic] of DIRECT_WRITES) {
    if (gen[genKey] === undefined) continue;
    const f = fields[semantic];
    if (!f?.node || !f?.key) {
      problems.push(`${semantic}: 映射表里没有这个字段，无法把 generation.${genKey} 落进图`);
      continue;
    }
    setInGraph(graph, f.node, f.key, gen[genKey], writes, semantic, problems);
  }

  // 2) turbo 开关 + 步数：开关翻的是 PrimitiveBoolean，步数只写「当前生效的那一个」
  //    turbo_enabled=false 时生效 steps_normal，true 时 steps_turbo（node_id_map.json warnings 第 3 条）
  const turbo = wf.turbo_enabled === true;
  const turboField = fields.turbo_enabled;
  if (turboField?.node) setInGraph(graph, turboField.node, turboField.key, turbo, writes, 'turbo_enabled', problems);
  else problems.push('turbo_enabled: 映射表里没有这个字段');
  const stepsSemantic = turbo ? 'steps_turbo' : 'steps_normal';
  const stepsField = fields[stepsSemantic];
  if (typeof gen.steps === 'number') {
    if (!stepsField?.node) problems.push(`${stepsSemantic}: 映射表里没有这个字段`);
    else setInGraph(graph, stepsField.node, stepsField.key, gen.steps, writes, stepsSemantic, problems);
    // 手动改步数只改了一半、画面会崩（docs/gpu_protocol.md 第六节），所以两个值必须自洽
    const wantSteps = turbo ? (type === 'R2V' ? 4 : 8) : 20;
    if (gen.steps !== wantSteps) {
      problems.push(`generation.steps=${gen.steps} 与 turbo_enabled=${turbo} 不自洽：${type} 在 turbo=${turbo} 时应为 ${wantSteps} 步（不要手动改步数，改 turbo 开关让 ComfySwitchNode 自己换）`);
    }
  }

  // 3) 素材位：按映射表 image_inputs 的 role 顺序接，序号即提示词里 <Picture N> 的 N
  const assets = c04.payload.assets ?? {};
  const imageInputs = Array.isArray(mapEntry.image_inputs) ? mapEntry.image_inputs : [];
  if (type === 'T2V') {
    if (imageInputs.length) problems.push(`T2V 模板不该有 image_inputs，映射表异常（${imageInputs.length} 个）`);
    if (assets.first_frame || assets.ref_images?.length || assets.ref_videos?.length || assets.ref_audios?.length) {
      problems.push('T2V 镜头带了素材（契约 allOf：T2V 不该带任何素材）');
    }
  } else {
    for (const slot of imageInputs) {
      let ref = null;
      if (slot.role === 'first_frame') ref = assets.first_frame ?? null;
      else if (slot.role.startsWith('ref_image_')) {
        const idx = Number(slot.role.slice('ref_image_'.length));
        ref = Array.isArray(assets.ref_images) ? assets.ref_images[idx] ?? null : null;
      }
      if (!ref) {
        problems.push(`素材位 ${slot.role}（节点 ${slot.node}.${slot.key}，对应 ${slot.prompt_ref}）在 c04.assets 里没有对应条目`);
        continue;
      }
      if (typeof ref.node_filename !== 'string' || !ref.node_filename) {
        problems.push(`素材位 ${slot.role} 的 node_filename 缺失（必须是已 POST /upload/image、且在 LoadImage.image 枚举里的文件名）`);
        continue;
      }
      setInGraph(graph, slot.node, slot.key, ref.node_filename, imageWrites, slot.role, problems);
      imageWrites[imageWrites.length - 1].prompt_ref = slot.prompt_ref;
    }
    if (type === 'I2V' && !assets.first_frame) problems.push('I2V 镜头缺 assets.first_frame（契约必填）');
    if (type === 'R2V' && !(Array.isArray(assets.ref_images) && assets.ref_images.length)) problems.push('R2V 镜头缺 assets.ref_images（契约必填，至少 1 张）');
    // R2V 的 ref_image_size 是专有字段
    if (type === 'R2V' && assets.ref_image_size !== undefined && fields.ref_image_size?.node) {
      setInGraph(graph, fields.ref_image_size.node, fields.ref_image_size.key, assets.ref_image_size, writes, 'ref_image_size', problems);
    }
    if (assets.ref_videos?.length || assets.ref_audios?.length) {
      problems.push('c04.assets 里有 ref_videos / ref_audios，但三份模板都没接线，POST 会失败（契约允许这些位，模板没接）');
    }
  }

  return { graph, writes, imageWrites, problems };
}

function readLiteral(graph, field, semantic, problems) {
  if (!field?.node) {
    problems.push(`model_files.${semantic}: 映射表里没有这个字段`);
    return null;
  }
  const node = graph[field.node];
  if (!node) {
    problems.push(`model_files.${semantic}: 模板里没有节点 "${field.node}"`);
    return null;
  }
  const v = node.inputs?.[field.key];
  if (Array.isArray(v)) {
    problems.push(`model_files.${semantic}: 节点 ${field.node}.${field.key} 是链接不是字面值，读不到实际权重名`);
    return null;
  }
  return v ?? null;
}

/**
 * 从「真跑的那份图」里读回权重清单——params_snapshot 记的是实际写进工作流的最终值，
 * 不是 c04 请求的值（contracts 的 c05 描述），所以一律回读图，不回读请求。
 */
export function readModelFiles(graph, mapEntry, turbo) {
  const problems = [];
  const f = mapEntry.fields;
  const lora = readLiteral(graph, f.lora_name, 'lora_name', problems);
  return {
    model_files: {
      unet_name: readLiteral(graph, f.unet_name, 'unet_name', problems),
      weight_dtype: readLiteral(graph, f.weight_dtype, 'weight_dtype', problems),
      clip_name: readLiteral(graph, f.clip_name, 'clip_name', problems),
      clip_type: readLiteral(graph, f.clip_type, 'clip_type', problems),
      video_vae_name: readLiteral(graph, f.video_vae_name, 'video_vae_name', problems),
      audio_vae_name: readLiteral(graph, f.audio_vae_name, 'audio_vae_name', problems),
      // turbo=false 时 ComfySwitchNode 走 on_false 直连 UNETLoader，LoRA 不在链路里，记 null 才是事实
      lora_name: turbo ? lora : null,
    },
    lora_in_graph: lora,
    problems,
  };
}

/** 权重与工作流类型必须对得上：拿 FL2VA 跑 R2V 会直接失败，拿 Ref2VA 跑 T2V 也一样。 */
export function checkUnetMatchesType(modelFiles, type) {
  const want = EXPECTED_UNET[type];
  const got = modelFiles.unet_name;
  if (got && want && got !== want) {
    return [`unet_name=${got}，但 ${type} 该用 ${want}（模板选错了，或映射表与工作流不匹配）`];
  }
  if (modelFiles.lora_name) {
    const wantLora = type === 'R2V' ? TURBO_LORA.REF2VA : TURBO_LORA.FL2VA;
    if (modelFiles.lora_name !== wantLora) return [`turbo LoRA=${modelFiles.lora_name}，但 ${type} 该用 ${wantLora}`];
  }
  return [];
}
