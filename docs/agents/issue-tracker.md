# Canvas Sync V2 审查记录

固定点：`abdc907f70c8b11d8ff15d830d71ee8b686535d3` + 当前未提交工作树。

| ID | 发现 | 状态 |
| --- | --- | --- |
| SYNC-01 | 初次握手前 `project.updated` 可能按 V1 覆盖 V2 图谱 | 已修复 |
| SYNC-02 | Supabase 整文档 RPC 的 epoch 切换存在 TOCTOU，legacy RPC 可绕过 | 已修复，migration 未应用 |
| SYNC-03 | 图谱先于 Generation tombstone 落库，失败时可复活投影 | 已修复 |
| SYNC-04 | CRDT 媒体仅浅投影，新媒体节点可在 ACK 后丢失 | 已修复 |
| SYNC-05 | React effect 延迟生成 Outbox，关页窗口可丢图谱改动 | 已修复 |
| SYNC-06 | 漏播后 hello/duplicate 可使用过期 room 假装已同步 | 已修复 |
| SYNC-07 | Worker Redis 广播失败可把 durable success 伪装成失败 | 已修复 |
| SYNC-08 | 连线数据可绕过 CRDT 媒体深投影进入 Yjs/Redis | 已修复 |
| SYNC-09 | duplicate 恢复只重载单实例 room，其他客户端可长期落后 | 已修复 |
| SYNC-10 | 未知字段中的内联媒体或二进制可绕过字段名清洗 | 已修复 |
| SYNC-11 | 服务端图谱变更可绕过 CRDT 清洗，把媒体负载写入物化图谱 | 已修复 |
| SYNC-12 | 媒体清洗会改变持久化增量，导致同 mutation 原样重试被误判冲突 | 已修复 |
| SYNC-13 | 持久化拒绝后内存 Y.Doc 未回滚，下一次合法提交可夹带被拒绝内容 | 已修复 |
| SYNC-14 | 服务端 duplicate 已被压缩时可误广播本次未提交候选增量 | 已修复 |
| SYNC-15 | 写入失败且权威重载暂时失败后，房间仍可继续使用污染状态写入 | 已修复 |
| SYNC-16 | Local Adapter 原子文件写失败后内存 state 未回滚，reload 可读到假权威 | 已修复 |
| SYNC-17 | append 后压缩 CAS 冲突未重载远端新版本，在线房间可长期停留旧图 | 已修复 |
| SYNC-18 | 显式权威重载失败未进入 fail-closed，后续读写可跳过恢复门禁 | 已修复 |
| SYNC-19 | PostgreSQL/Supabase 分步读取图谱与增量，并发压缩时可组合出不一致权威快照 | 已修复，migration 未应用 |
| SYNC-20 | V1 历史增量以行 ID 回填幂等身份，无法命中按内容哈希重试 | 已修复，migration 未应用 |
| SYNC-21 | duplicate 已持久化但权威重载失败时，房间仍可基于候选状态继续读写 | 已修复 |
| SYNC-22 | 同一服务端 mutation 在不同 Y.Doc 中产生不同字节，合法并发重放被误判为身份冲突 | 已修复 |

发布边界：代码纳入本次 Release Candidate；不部署、不应用数据库 migration、不切换 epoch。`.cursor/settings.json` 与既有无关文档不纳入。
