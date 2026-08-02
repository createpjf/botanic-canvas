import type { AssetRecord, CanvasDocument, CanvasNode, CanvasSnapshot } from '../domain/canvas'
import productImage from '../assets/figma/product.webp'
import modelImage from '../assets/figma/model.webp'
import sceneImage from '../assets/figma/scene.webp'
import toneImage from '../assets/figma/tone.webp'
import resultImage from '../assets/figma/result.webp'

/** 新建项目共享的内置品牌素材；不写入任何 CanvasDocument。 */
export const seedGlobalAssets: AssetRecord[] = [
  { id: 'santal-01', role: '商品', name: 'Santal 01 香薰', image: productImage, source: 'brand', mediaKind: 'image', collection: '品牌素材', tags: ['香氛', '白瓷', '主推'] },
  { id: 'fig-scent', role: '商品', name: '无花果香氛', image: sceneImage, source: 'brand', mediaKind: 'image', collection: '品牌素材', tags: ['香氛', '无花果'] },
  { id: 'mia-portrait', role: '模特', name: 'Mia 氛围肖像', image: modelImage, source: 'brand', mediaKind: 'image', collection: '品牌素材', tags: ['人物', '自然光'] },
  { id: 'summer-window', role: '场景', name: '夏日窗台', image: sceneImage, source: 'brand', mediaKind: 'image', collection: '品牌素材', tags: ['植物', '窗台'] },
  { id: 'airy-whitespace', role: '调性', name: '清透留白', image: toneImage, source: 'brand', mediaKind: 'image', collection: '品牌素材', tags: ['留白', '柔光'] },
]

/** 示例项目自有的历史生成结果，不会出现在其他项目的素材库中。 */
const initialProjectAssets: AssetRecord[] = [
  { id: 'hero-v03', role: '首图', name: '夏日香氛 · 示例首图 v03', image: resultImage, source: 'generated', mediaKind: 'image', collection: '生成结果', tags: ['首图', '示例资产'] },
]

const initialNodes: CanvasNode[] = [
  {
    id: 'asset-product',
    type: 'asset',
    position: { x: 290, y: 225 },
    draggable: true,
    data: { kind: 'asset', assetId: 'santal-01', role: '商品', name: 'Santal 01 香薰', image: productImage, source: 'brand' },
  },
  {
    id: 'asset-scene',
    type: 'asset',
    position: { x: 490, y: 225 },
    draggable: true,
    data: { kind: 'asset', assetId: 'summer-window', role: '场景', name: '夏日窗台', image: sceneImage, source: 'brand' },
  },
  {
    id: 'asset-model',
    type: 'asset',
    position: { x: 290, y: 485 },
    draggable: true,
    data: { kind: 'asset', assetId: 'mia-portrait', role: '模特', name: 'Mia 氛围肖像', image: modelImage, source: 'brand' },
  },
  {
    id: 'asset-tone',
    type: 'asset',
    position: { x: 490, y: 485 },
    draggable: true,
    data: { kind: 'asset', assetId: 'airy-whitespace', role: '调性', name: '清透留白', image: toneImage, source: 'brand' },
  },
  {
    id: 'text-v03',
    type: 'text',
    position: { x: 700, y: 86 },
    draggable: true,
    data: {
      kind: 'text',
      label: '首图创意描述',
      content: '夏日植物与白瓷台面，柔和自然光，顶部留出标题区',
    },
  },
  {
    id: 'generate-v03',
    type: 'generate',
    position: { x: 700, y: 282 },
    draggable: true,
    data: {
      kind: 'generate',
      label: '图像生成',
      prompt: '保持香氛商品主体清晰，适合电商首图投放。',
      batchCount: 1,
      settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
      inputOrder: ['asset-product', 'asset-scene', 'asset-model', 'asset-tone', 'text-v03'],
      primaryInputId: 'asset-product',
      status: 'succeeded',
      generationKind: 'generation',
    },
  },
  {
    id: 'result-hero',
    type: 'result',
    position: { x: 1070, y: 210 },
    draggable: true,
    selected: true,
    data: {
      kind: 'result',
      outputOf: 'generate-v03',
      image: resultImage,
      selected: true,
      status: 'ready',
      label: '示例首图 · v03',
      versionId: 'history-summer-v03',
      generationKind: 'generation',
      generationSettings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
      rootRecipe: {
        primaryReferenceNodeId: 'asset-product',
        references: [
          { nodeId: 'asset-product', assetId: 'santal-01', name: 'Santal 01 香薰', image: productImage, role: '商品', source: 'brand', primary: true, priority: 1 },
          { nodeId: 'asset-scene', assetId: 'summer-window', name: '夏日窗台', image: sceneImage, role: '场景', source: 'brand', priority: 2 },
          { nodeId: 'asset-model', assetId: 'mia-portrait', name: 'Mia 氛围肖像', image: modelImage, role: '模特', source: 'brand', priority: 3 },
          { nodeId: 'asset-tone', assetId: 'airy-whitespace', name: '清透留白', image: toneImage, role: '调性', source: 'brand', priority: 4 },
        ],
        prompt: '夏日植物与白瓷台面，柔和自然光，顶部留出标题区\n保持香氛商品主体清晰，适合电商首图投放。',
        batchCount: 1,
        settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
      },
      generationRecipe: {
        primaryReferenceNodeId: 'asset-product',
        references: [
          { nodeId: 'asset-product', assetId: 'santal-01', name: 'Santal 01 香薰', image: productImage, role: '商品', source: 'brand', primary: true, priority: 1 },
          { nodeId: 'asset-scene', assetId: 'summer-window', name: '夏日窗台', image: sceneImage, role: '场景', source: 'brand', priority: 2 },
          { nodeId: 'asset-model', assetId: 'mia-portrait', name: 'Mia 氛围肖像', image: modelImage, role: '模特', source: 'brand', priority: 3 },
          { nodeId: 'asset-tone', assetId: 'airy-whitespace', name: '清透留白', image: toneImage, role: '调性', source: 'brand', priority: 4 },
        ],
        prompt: '夏日植物与白瓷台面，柔和自然光，顶部留出标题区\n保持香氛商品主体清晰，适合电商首图投放。',
        batchCount: 1,
        settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
      },
    },
  },
]

const initialEdges = [
  { id: 'product-to-generate-v03', source: 'asset-product', sourceHandle: 'asset-output', target: 'generate-v03', targetHandle: 'input', type: 'default', style: { stroke: '#b6cfbd', strokeWidth: 1.3 } },
  { id: 'scene-to-generate-v03', source: 'asset-scene', sourceHandle: 'asset-output', target: 'generate-v03', targetHandle: 'input', type: 'default', style: { stroke: '#b6cfbd', strokeWidth: 1.3 } },
  { id: 'model-to-generate-v03', source: 'asset-model', sourceHandle: 'asset-output', target: 'generate-v03', targetHandle: 'input', type: 'default', style: { stroke: '#b6cfbd', strokeWidth: 1.3 } },
  { id: 'tone-to-generate-v03', source: 'asset-tone', sourceHandle: 'asset-output', target: 'generate-v03', targetHandle: 'input', type: 'default', style: { stroke: '#b6cfbd', strokeWidth: 1.3 } },
  { id: 'text-to-generate-v03', source: 'text-v03', sourceHandle: 'output', target: 'generate-v03', targetHandle: 'input', type: 'default', style: { stroke: '#b6cfbd', strokeWidth: 1.3 } },
  { id: 'generate-v03-to-result', source: 'generate-v03', sourceHandle: 'output', target: 'result-hero', type: 'default', style: { stroke: '#2a5238', strokeWidth: 1.7 }, data: { system: true, role: 'output' }, reconnectable: false },
]

function cloneSnapshot(name: string): CanvasSnapshot {
  return {
    name,
    nodes: initialNodes.map((node) => ({ ...node, position: { ...node.position }, data: { ...node.data } })),
    edges: initialEdges.map((edge) => ({ ...edge, style: { ...edge.style } })),
    viewport: { x: 0, y: 0, zoom: 1 },
  }
}

const initialSnapshot = cloneSnapshot('夏日香氛视觉实验 · v03')

function cloneWorkflowSnapshot(name: string): CanvasSnapshot {
  const nodes = initialNodes
    .filter((node) => node.type !== 'result')
    .map((node) => node.type === 'generate'
      ? { ...node, position: { ...node.position }, data: { ...node.data, status: undefined, generationKind: undefined } }
      : { ...node, position: { ...node.position }, data: { ...node.data } }) as CanvasNode[]
  const nodeIds = new Set(nodes.map((node) => node.id))
  return {
    name,
    nodes,
    edges: initialEdges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)).map((edge) => ({ ...edge, style: { ...edge.style } })),
    viewport: { x: 0, y: 0, zoom: 1 },
  }
}

export const seedDocument: CanvasDocument = {
  schemaVersion: 25,
  id: 'summer-fragrance-visual-lab',
  name: '夏日香氛视觉实验',
  updatedAt: Date.now(),
  viewport: { x: 0, y: 0, zoom: 1 },
  assets: initialProjectAssets,
  assetGroups: [],
  templates: [
    {
      id: 'template-summer-airy',
      name: '夏日香氛 · 清透留白',
      image: resultImage,
      createdAt: Date.now() - 86_400_000,
      sourceHistoryId: 'history-summer-v03',
      snapshot: cloneWorkflowSnapshot('夏日香氛 · 清透留白'),
    },
  ],
  history: [
    {
      id: 'history-summer-v03',
      name: '夏日香氛视觉实验 · 示例 v03',
      image: resultImage,
      createdAt: Date.now() - 3_600_000,
      kind: 'generation',
      snapshot: initialSnapshot,
    },
  ],
  deliveries: [],
  generationJobs: [],
  batchVariationRuns: [],
  agentRuns: [],
  agentSessions: [],
  agentMemory: [],
  activeVersionId: 'history-summer-v03',
  nodes: initialNodes,
  edges: initialEdges,
}

export function createEmptyCanvasDocument(id: string, name: string): CanvasDocument {
  return {
    schemaVersion: 25,
    id,
    name,
    updatedAt: Date.now(),
    viewport: { x: 0, y: 0, zoom: 1 },
    assets: [],
    assetGroups: [],
    templates: [],
    history: [],
    deliveries: [],
    generationJobs: [],
    batchVariationRuns: [],
    agentRuns: [],
    agentSessions: [],
    agentMemory: [],
    nodes: [],
    edges: [],
  }
}
