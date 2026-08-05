# Botanic Agent 开发入口

本仓库是 Botanic 品牌视觉生产工作台。开始改动前依次阅读：

1. [产品架构与 Ontology](docs/PRODUCT_ARCHITECTURE.md)
2. [代码地图](docs/CODEMAP.md)
3. [模块接口与依赖方向](docs/ARCHITECTURE.md)
4. 涉及持久化、图谱或 Artifact 时阅读对应 [ADR](docs/README.md#架构决策)

## 开发约束

- 先确认行为归属，再修改拥有该行为的模块；不要把领域规则放回 UI。
- `src/components/` 保持纯 UI，不直接访问 Store、网络或服务端。
- 生成任务与持久化记录是状态权威；UI 占位、Toast 和本地选择态不是。
- 不改变幂等键、任务恢复、项目版本冲突和媒体授权语义，除非需求明确要求。
- Agent Session、Message、Memory、Run 的独立实体是权威；`CanvasDocument` 中同名字段仍是迁移兼容视图。
- Artifact Index 是历史血缘目录；删除画布节点或素材引用不得级联删除历史 Artifact。
- ProductStore 有本地、PostgreSQL、Supabase 三个 Adapter；变更接口时同步维护全部 Adapter 和契约测试。
- 优先形成拥有明确行为的深模块；不要只为缩短文件而增加透传层。
- 历史验收和已完成计划不是当前规范；当前入口见 [文档索引](docs/README.md)。

## 修改路线

- 画布节点、连线、布局：从 `src/domain/canvas*.ts` 开始。
- 生成、恢复、批量任务：从 `src/domain/generation*.ts`、`src/store/canvasStore.ts` 和 `server/generation*.mjs` 开始。
- Agent 面板交互：从 `src/features/agent/AgentWorkspace.tsx` 开始；对话、计划、执行、Artifact 语义从 `src/domain/agent*.ts` 和 `server/botanicAgent*.mjs` 开始。
- Store 命令或状态形状：先核对 `src/store/canvasStore.types.ts`，再修改 `src/store/canvasStore.ts`。
- 浏览器会话、远端项目、协作：从 `src/lib/` 开始。
- HTTP、鉴权、队列和存储 Adapter：从 `server/` 开始。
- 更完整的文件和测试对应关系见 [CODEMAP](docs/CODEMAP.md)。

## 最小验证

```bash
npm test
npm run check:architecture
npm run build
git diff --check
```

先运行被修改模块的聚焦测试，再运行全量验证。不得用真实生成 Provider 作为普通开发测试。
