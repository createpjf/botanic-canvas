import { createHash, randomUUID } from 'node:crypto'
import postgres from 'postgres'

const now = () => Date.now()
const hashAccessToken = (token) => createHash('sha256').update(token).digest('hex')
const clone = (value) => structuredClone(value)

function productError(message, code = 'PRODUCT_STORE_ERROR') {
  const error = new Error(message)
  error.code = code
  return error
}

function asUser(row) {
  return row ? { id: row.id, email: row.email, name: row.name, role: row.role } : undefined
}

function asJson(value) {
  if (typeof value === 'string') {
    try {
      return clone(JSON.parse(value))
    } catch {
      return value
    }
  }
  return clone(value)
}

function asPayload(row) {
  return row ? asJson(row.payload) : undefined
}

function projectDocumentSummary(document) {
  const nodes = Array.isArray(document?.nodes) ? document.nodes : []
  const images = nodes
    .filter((node) => node?.type === 'result' && typeof node?.data?.image === 'string')
    .map((node) => node.data.image)
  return { nodeCount: nodes.length, resultCount: images.length, coverImage: images.at(-1) }
}

function canvasGraph(document) {
  return {
    nodes: Array.isArray(document?.nodes) ? clone(document.nodes) : [],
    edges: Array.isArray(document?.edges) ? clone(document.edges) : [],
  }
}

function sameGraph(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function insertAudit(sql, { actorId, action, projectId, targetId, detail = {} }) {
  await sql`
    insert into audit_events (id, actor_id, action, project_id, target_id, detail, created_at)
    values (${`audit_${randomUUID()}`}, ${actorId}, ${action}, ${projectId ?? null}, ${targetId ?? null}, ${sql.json(detail)}::jsonb, ${now()})
  `
}

/**
 * PostgreSQL Adapter。它实现与 file ProductStore 相同的 Interface；调用方无需
 * 知道 JSONB、事务、行锁与审计写入的细节。
 */
export async function createPostgresProductStore({ databaseUrl, bootstrapAccessToken, bootstrapEmail = 'owner@botanic.local' }) {
  if (!databaseUrl) throw new Error('DATABASE_URL 未配置，无法启动生产数据存储。')

  const sql = postgres(databaseUrl, {
    max: Number(process.env.POSTGRES_POOL_MAX ?? 4),
    idle_timeout: 20,
    connect_timeout: 10,
    connection: {
      application_name: 'botanic-worker-api',
      statement_timeout: Number(process.env.POSTGRES_STATEMENT_TIMEOUT_MS ?? 15_000),
      lock_timeout: Number(process.env.POSTGRES_LOCK_TIMEOUT_MS ?? 5_000),
    },
  })

  await sql.begin(async (tx) => {
    await tx`set local client_min_messages = warning`
    await tx`select pg_advisory_xact_lock(72695837)`
    await tx.unsafe(`
    create table if not exists app_users (
      id text primary key,
      email text not null unique,
      name text not null,
      role text not null check (role in ('owner', 'member')),
      created_at bigint not null
    );
    create table if not exists access_tokens (
      id text primary key,
      user_id text not null references app_users(id) on delete cascade,
      token_hash text not null unique,
      created_at bigint not null,
      revoked_at bigint
    );
    create table if not exists projects (
      id text primary key,
      name text not null,
      document jsonb not null,
      revision integer not null default 1,
      created_at bigint not null,
      updated_at bigint not null
    );
    create table if not exists project_members (
      project_id text not null references projects(id) on delete cascade,
      user_id text not null references app_users(id) on delete cascade,
      role text not null check (role in ('owner', 'editor', 'viewer')),
      added_at bigint not null,
      primary key (project_id, user_id)
    );
    create table if not exists canvas_graphs (
      project_id text primary key references projects(id) on delete cascade,
      graph jsonb not null,
      revision integer not null default 1,
      yjs_snapshot text,
      updated_at bigint not null
    );
    create table if not exists canvas_graph_updates (
      id bigserial primary key,
      project_id text not null references canvas_graphs(project_id) on delete cascade,
      update_base64 text not null,
      created_at bigint not null
    );
    create table if not exists global_asset_libraries (
      id text primary key,
      library jsonb not null,
      updated_at bigint not null
    );
    create table if not exists generation_jobs (
      id text primary key,
      owner_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      updated_at bigint not null,
      payload jsonb not null
    );
    create table if not exists media_objects (
      id text primary key,
      project_id text not null,
      owner_id text not null references app_users(id) on delete cascade,
      storage_key text not null unique,
      content_type text not null,
      byte_size bigint not null,
      created_at bigint not null
    );
    create table if not exists audit_events (
      id text primary key,
      actor_id text not null references app_users(id) on delete cascade,
      action text not null,
      project_id text,
      target_id text,
      detail jsonb not null default '{}'::jsonb,
      created_at bigint not null
    );
    create index if not exists projects_updated_at_idx on projects (updated_at desc);
    create index if not exists canvas_graph_updates_project_idx on canvas_graph_updates (project_id, id);
    create index if not exists jobs_status_updated_at_idx on generation_jobs (status, updated_at);
    create index if not exists media_project_idx on media_objects (project_id);
    create index if not exists audit_project_created_idx on audit_events (project_id, created_at desc);
    -- 对象先上传、再原子写入新项目文档时，项目行尚未存在。媒体可短暂成为
    -- 不可访问孤儿对象；读取授权仍通过 project_members join 约束，生命周期规则负责清理。
    alter table media_objects drop constraint if exists media_objects_project_id_fkey;
    insert into canvas_graphs (project_id, graph, revision, updated_at)
    select id,
      jsonb_build_object(
        'nodes', coalesce(document->'nodes', '[]'::jsonb),
        'edges', coalesce(document->'edges', '[]'::jsonb)
      ),
      1,
      updated_at
    from projects
    on conflict (project_id) do nothing;
    `)
  })

  // 本地访问令牌模式才需要预置 token。生产迁移期由 Supabase Auth 校验身份，
  // 因而不能要求一个额外的共享启动令牌。
  if (bootstrapAccessToken) {
    const bootstrapHash = hashAccessToken(bootstrapAccessToken)
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(72695838)`
      const [token] = await tx`select id from access_tokens where token_hash = ${bootstrapHash} and revoked_at is null`
      if (token) return
      let [owner] = await tx`select id from app_users where role = 'owner' order by created_at asc limit 1`
      if (!owner) {
        owner = { id: `usr_${randomUUID()}` }
        await tx`insert into app_users (id, email, name, role, created_at) values (${owner.id}, ${bootstrapEmail}, 'Botanic Owner', 'owner', ${now()})`
      }
      await tx`insert into access_tokens (id, user_id, token_hash, created_at) values (${`token_${randomUUID()}`}, ${owner.id}, ${bootstrapHash}, ${now()})`
    })
  }

  async function memberRole(projectId, userId) {
    const [row] = await sql`select role from project_members where project_id = ${projectId} and user_id = ${userId}`
    return row?.role
  }

  async function ensureCanvasGraph(tx, projectId) {
    await tx`
      insert into canvas_graphs (project_id, graph, revision, updated_at)
      select p.id,
        jsonb_build_object(
          'nodes', coalesce(p.document->'nodes', '[]'::jsonb),
          'edges', coalesce(p.document->'edges', '[]'::jsonb)
        ),
        1,
        p.updated_at
      from projects p
      where p.id = ${projectId}
      on conflict (project_id) do nothing
    `
  }

  const store = {
    async authenticate(accessToken) {
      if (!accessToken) return undefined
      const [row] = await sql`
        select u.id, u.email, u.name, u.role
        from access_tokens t join app_users u on u.id = t.user_id
        where t.token_hash = ${hashAccessToken(accessToken)} and t.revoked_at is null
      `
      return asUser(row)
    },

    // 迁移期用 Supabase user.id 作为 PostgreSQL 主键：同一登录用户无须重新注册，
    // 但业务数据从此不再经过 Supabase PostgREST。
    async ensureAuthenticatedUser({ id, email, name, roleHint }) {
      if (!id) throw productError('登录用户缺少标识。', 'AUTH_USER_INVALID')
      const normalizedEmail = (email || `${id}@auth.botanic.local`).trim().toLowerCase()
      const normalizedName = name?.trim() || normalizedEmail.split('@')[0] || 'Botanic Member'
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(72695839)`
        const [existing] = await tx`select id, email, name, role from app_users where id = ${id} for update`
        if (existing) {
          if (existing.email !== normalizedEmail || existing.name !== normalizedName) {
            await tx`update app_users set email = ${normalizedEmail}, name = ${normalizedName} where id = ${id}`
          }
          return asUser({ ...existing, email: normalizedEmail, name: normalizedName })
        }
        const [owner] = await tx`select id from app_users where role = 'owner' limit 1`
        const role = roleHint === 'owner' || !owner ? 'owner' : 'member'
        const [emailOwner] = await tx`select id from app_users where lower(email) = lower(${normalizedEmail}) limit 1`
        if (emailOwner) throw productError('该邮箱已绑定其他工作区成员。', 'AUTH_EMAIL_CONFLICT')
        await tx`insert into app_users (id, email, name, role, created_at) values (${id}, ${normalizedEmail}, ${normalizedName}, ${role}, ${now()})`
        return { id, email: normalizedEmail, name: normalizedName, role }
      })
    },

    async readUser(userId) {
      const [row] = await sql`select id, email, name, role from app_users where id = ${userId}`
      return asUser(row)
    },

    async createUser(actorId, { email, name, role = 'member', accessToken }) {
      return sql.begin(async (tx) => {
        const [actor] = await tx`select role from app_users where id = ${actorId}`
        if (actor?.role !== 'owner') throw productError('只有工作区所有者可以创建成员。', 'USER_CREATE_FORBIDDEN')
        const [existing] = await tx`select id from app_users where lower(email) = lower(${email})`
        if (existing) throw productError('该成员已存在。', 'USER_EXISTS')
        const user = { id: `usr_${randomUUID()}`, email, name: name || email, role }
        await tx`insert into app_users (id, email, name, role, created_at) values (${user.id}, ${user.email}, ${user.name}, ${user.role}, ${now()})`
        await tx`insert into access_tokens (id, user_id, token_hash, created_at) values (${`token_${randomUUID()}`}, ${user.id}, ${hashAccessToken(accessToken)}, ${now()})`
        await insertAudit(tx, { actorId, action: 'member.created', targetId: user.id, detail: { email: user.email, role: user.role } })
        return user
      })
    },

    async listProjects(userId) {
      const rows = await sql`
        select p.id, p.name, greatest(p.updated_at, coalesce(c.updated_at, p.updated_at)) as "updatedAt",
          p.revision, p.document, m.role, c.graph, c.revision as "graphRevision"
        from projects p join project_members m on m.project_id = p.id
        left join canvas_graphs c on c.project_id = p.id
        where m.user_id = ${userId}
        order by greatest(p.updated_at, coalesce(c.updated_at, p.updated_at)) desc
      `
      return rows.map((row) => {
        const document = asJson(row.document)
        const graph = row.graph ? asJson(row.graph) : canvasGraph(document)
        return {
          ...row,
          ...projectDocumentSummary({ ...document, ...graph }),
          updatedAt: Number(row.updatedAt),
          revision: Number(row.revision),
          graphRevision: Number(row.graphRevision ?? 1),
          document: undefined,
          graph: undefined,
        }
      })
    },

    async readProject(userId, projectId) {
      const [row] = await sql`
        select p.document, p.revision, p.updated_at as "projectUpdatedAt", c.graph,
          c.revision as "graphRevision", c.updated_at as "graphUpdatedAt"
        from projects p join project_members m on m.project_id = p.id
        left join canvas_graphs c on c.project_id = p.id
        where p.id = ${projectId} and m.user_id = ${userId}
      `
      if (!row) return undefined
      const document = asJson(row.document)
      const graph = row.graph ? asJson(row.graph) : canvasGraph(document)
      const updatedAt = Math.max(
        Number(document.updatedAt ?? 0),
        Number(row.projectUpdatedAt ?? 0),
        Number(row.graphUpdatedAt ?? 0),
      )
      return {
        document: { ...document, ...graph, updatedAt },
        revision: Number(row.revision),
        graphRevision: Number(row.graphRevision ?? 1),
      }
    },

    async canEditProject(userId, projectId) {
      const role = await memberRole(projectId, userId)
      return role === 'owner' || role === 'editor'
    },

    async writeProject(userId, document, expectedRevision, expectedGraphRevision) {
      return sql.begin(async (tx) => {
        const [existing] = await tx`
          select p.id, p.revision, m.role
          from projects p left join project_members m on m.project_id = p.id and m.user_id = ${userId}
          where p.id = ${document.id}
          for update of p
        `
        const timestamp = now()
        if (existing) {
          if (!['owner', 'editor'].includes(existing.role)) throw productError('你没有编辑该项目的权限。', 'PROJECT_WRITE_FORBIDDEN')
          if (Number.isInteger(expectedRevision) && expectedRevision !== Number(existing.revision)) {
            throw productError('项目已被其他成员更新，请刷新后再保存。', 'PROJECT_CONFLICT')
          }
          await ensureCanvasGraph(tx, document.id)
          const [currentGraphEntry] = await tx`
            select graph, revision from canvas_graphs where project_id = ${document.id} for update
          `
          const currentGraph = asJson(currentGraphEntry.graph)
          const nextGraph = canvasGraph(document)
          const graphChanged = !sameGraph(currentGraph, nextGraph)
          if (graphChanged && Number.isInteger(expectedGraphRevision) && expectedGraphRevision !== Number(currentGraphEntry.revision)) {
            throw productError('画布已被其他成员更新，请刷新后再保存。', 'CANVAS_GRAPH_CONFLICT')
          }
          const revision = Number(existing.revision) + 1
          await tx`update projects set name = ${document.name}, document = ${tx.json(document)}::jsonb, revision = ${revision}, updated_at = ${timestamp} where id = ${document.id}`
          let graphRevision = Number(currentGraphEntry.revision)
          if (graphChanged) {
            const [savedGraph] = await tx`
              update canvas_graphs
              set graph = ${tx.json(nextGraph)}::jsonb, revision = revision + 1, updated_at = ${timestamp}
              where project_id = ${document.id}
              returning revision
            `
            graphRevision = Number(savedGraph.revision)
          }
          await insertAudit(tx, { actorId: userId, action: 'project.updated', projectId: document.id, detail: { revision } })
          return { document: { ...clone(document), ...(graphChanged ? nextGraph : currentGraph) }, revision, graphRevision, created: false }
        }

        await tx`insert into projects (id, name, document, revision, created_at, updated_at) values (${document.id}, ${document.name}, ${tx.json(document)}::jsonb, 1, ${timestamp}, ${timestamp})`
        await tx`insert into project_members (project_id, user_id, role, added_at) values (${document.id}, ${userId}, 'owner', ${timestamp})`
        await tx`
          insert into canvas_graphs (project_id, graph, revision, updated_at)
          values (${document.id}, ${tx.json(canvasGraph(document))}::jsonb, 1, ${timestamp})
        `
        await insertAudit(tx, { actorId: userId, action: 'project.created', projectId: document.id })
        return { document: clone(document), revision: 1, graphRevision: 1, created: true }
      })
    },

    async deleteProject(userId, projectId) {
      return sql.begin(async (tx) => {
        const [member] = await tx`select role from project_members where project_id = ${projectId} and user_id = ${userId} for update`
        if (!member) return false
        if (member.role !== 'owner') throw productError('只有项目所有者可以删除项目。', 'PROJECT_DELETE_FORBIDDEN')
        const [project] = await tx`select name from projects where id = ${projectId} for update`
        if (!project) return false
        await tx`delete from media_objects where project_id = ${projectId}`
        await tx`delete from projects where id = ${projectId}`
        await insertAudit(tx, { actorId: userId, action: 'project.deleted', targetId: projectId, detail: { name: project.name } })
        return true
      })
    },

    async addProjectMember(actorId, projectId, userId, role) {
      return sql.begin(async (tx) => {
        const [member] = await tx`select role from project_members where project_id = ${projectId} and user_id = ${actorId} for update`
        if (member?.role !== 'owner') throw productError('只有项目所有者可以管理成员。', 'PROJECT_MEMBER_FORBIDDEN')
        const [user] = await tx`select id from app_users where id = ${userId}`
        if (!user) throw productError('未找到成员。', 'USER_NOT_FOUND')
        await tx`
          insert into project_members (project_id, user_id, role, added_at)
          values (${projectId}, ${userId}, ${role}, ${now()})
          on conflict (project_id, user_id) do update set role = excluded.role
        `
        await tx`update projects set revision = revision + 1, updated_at = ${now()} where id = ${projectId}`
        await insertAudit(tx, { actorId, action: 'project.member.upserted', projectId, targetId: userId, detail: { role } })
      })
    },

    async loadCanvasCollaboration(userId, projectId) {
      return sql.begin(async (tx) => {
        const [member] = await tx`select role from project_members where project_id = ${projectId} and user_id = ${userId}`
        if (!member) return undefined
        await ensureCanvasGraph(tx, projectId)
        const [entry] = await tx`
          select graph, revision as "graphRevision", yjs_snapshot as snapshot, updated_at as "updatedAt"
          from canvas_graphs where project_id = ${projectId}
        `
        if (!entry) return undefined
        const updates = await tx`
          select update_base64 as update from canvas_graph_updates where project_id = ${projectId} order by id asc
        `
        return {
          graph: asJson(entry.graph),
          graphRevision: Number(entry.graphRevision),
          snapshot: entry.snapshot ?? undefined,
          updates: updates.map((item) => item.update),
          updatedAt: Number(entry.updatedAt),
        }
      })
    },

    async appendCanvasGraphUpdate(userId, projectId, { update, graph }) {
      if (typeof update !== 'string' || !update || !Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
        throw new TypeError('画布协作更新格式无效。')
      }
      return sql.begin(async (tx) => {
        const [member] = await tx`select role from project_members where project_id = ${projectId} and user_id = ${userId}`
        if (!['owner', 'editor'].includes(member?.role)) throw productError('你没有编辑该项目的权限。', 'PROJECT_WRITE_FORBIDDEN')
        await ensureCanvasGraph(tx, projectId)
        const timestamp = now()
        const [entry] = await tx`
          update canvas_graphs
          set graph = ${tx.json(graph)}::jsonb, revision = revision + 1, updated_at = ${timestamp}
          where project_id = ${projectId}
          returning revision as "graphRevision"
        `
        await tx`
          insert into canvas_graph_updates (project_id, update_base64, created_at)
          values (${projectId}, ${update}, ${timestamp})
        `
        const [{ count }] = await tx`select count(*)::int as count from canvas_graph_updates where project_id = ${projectId}`
        return { graphRevision: Number(entry.graphRevision), updatedAt: timestamp, updateCount: Number(count) }
      })
    },

    async compactCanvasGraphUpdates(userId, projectId, { snapshot, graph }) {
      if (typeof snapshot !== 'string' || !snapshot || !Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
        throw new TypeError('画布协作快照格式无效。')
      }
      return sql.begin(async (tx) => {
        const [member] = await tx`select role from project_members where project_id = ${projectId} and user_id = ${userId}`
        if (!['owner', 'editor'].includes(member?.role)) throw productError('你没有编辑该项目的权限。', 'PROJECT_WRITE_FORBIDDEN')
        await ensureCanvasGraph(tx, projectId)
        const timestamp = now()
        const [entry] = await tx`
          update canvas_graphs
          set graph = ${tx.json(graph)}::jsonb, yjs_snapshot = ${snapshot}, updated_at = ${timestamp}
          where project_id = ${projectId}
          returning revision as "graphRevision"
        `
        await tx`delete from canvas_graph_updates where project_id = ${projectId}`
        return { graphRevision: Number(entry.graphRevision), updatedAt: timestamp }
      })
    },

    async readGlobalAssetLibrary(userId, id) {
      const [access] = await sql`select 1 from project_members where user_id = ${userId} limit 1`
      if (!access) return undefined
      const [row] = await sql`select library from global_asset_libraries where id = ${id}`
      return row ? asJson(row.library) : undefined
    },

    async writeGlobalAssetLibrary(userId, library) {
      const [workspace] = await sql`
        select 1 from project_members where user_id = ${userId} and role in ('owner', 'editor') limit 1
      `
      const [{ count }] = await sql`select count(*)::int as count from projects`
      if (!workspace && Number(count)) throw productError('你没有编辑品牌素材库的权限。', 'LIBRARY_WRITE_FORBIDDEN')
      await sql`
        insert into global_asset_libraries (id, library, updated_at)
        values (${library.id}, ${sql.json(library)}::jsonb, ${now()})
        on conflict (id) do update set library = excluded.library, updated_at = excluded.updated_at
      `
      await insertAudit(sql, { actorId: userId, action: 'brand-library.updated', targetId: library.id })
      return clone(library)
    },

    async deleteGlobalAsset(userId, assetId) {
      const [workspace] = await sql`
        select 1 from project_members where user_id = ${userId} and role in ('owner', 'editor') limit 1
      `
      if (!workspace) throw productError('你没有编辑品牌素材库的权限。', 'LIBRARY_WRITE_FORBIDDEN')
      return sql.begin(async (tx) => {
        const [row] = await tx`select library from global_asset_libraries where id = 'global-brand-assets' for update`
        if (!row) return { deleted: false, library: undefined }
        const currentLibrary = asJson(row.library)
        const assets = currentLibrary.assets.filter((asset) => asset.id !== assetId)
        const deleted = assets.length !== currentLibrary.assets.length
        const library = deleted ? { ...currentLibrary, assets, updatedAt: now() } : currentLibrary
        if (deleted) {
          await tx`update global_asset_libraries set library = ${tx.json(library)}::jsonb, updated_at = ${now()} where id = 'global-brand-assets'`
          await insertAudit(tx, { actorId: userId, action: 'brand-asset.deleted', targetId: assetId })
        }
        return { deleted, library: clone(library) }
      })
    },

    async putGenerationJob(userId, job) {
      const payload = { ...clone(job), ownerId: userId, updatedAt: now() }
      await sql`
        insert into generation_jobs (id, owner_id, project_id, status, updated_at, payload)
        values (${job.id}, ${userId}, ${job.projectId}, ${job.status}, ${payload.updatedAt}, ${sql.json(payload)}::jsonb)
        on conflict (id) do update set status = excluded.status, updated_at = excluded.updated_at, payload = excluded.payload
      `
      await insertAudit(sql, { actorId: userId, action: `generation.${job.status}`, projectId: job.projectId, targetId: job.id, detail: { model: job.settings?.model, batchCount: job.batchCount } })
    },

    async readGenerationJob(userId, jobId) {
      const [row] = await sql`select payload from generation_jobs where id = ${jobId} and owner_id = ${userId}`
      return asPayload(row)
    },

    async listGenerationJobsForProject(userId, projectId, limit = 60) {
      const rows = await sql`
        select g.payload
        from generation_jobs g join project_members m on m.project_id = g.project_id
        where g.project_id = ${projectId} and g.owner_id = ${userId} and m.user_id = ${userId}
        order by g.updated_at desc
        limit ${Math.max(1, Math.min(limit, 120))}
      `
      return rows.map(asPayload)
    },

    async readGenerationJobForWorker(jobId) {
      const [row] = await sql`select payload from generation_jobs where id = ${jobId}`
      return asPayload(row)
    },

    async recoverGenerationJobs() {
      const queued = await sql`select payload from generation_jobs where status = 'queued' order by updated_at asc`
      return queued.map(asPayload)
    },

    async recoverStaleGenerationJobs(staleAfterMs = 90_000) {
      const staleBefore = now() - Math.max(30_000, staleAfterMs)
      const running = await sql`
        select payload from generation_jobs
        where status = 'running' and updated_at <= ${staleBefore}
        order by updated_at asc
      `
      return running.map(asPayload)
    },

    async createMediaObject(ownerId, projectId, { id = `media_${randomUUID()}`, storageKey, contentType, byteSize }) {
      await sql`insert into media_objects (id, project_id, owner_id, storage_key, content_type, byte_size, created_at) values (${id}, ${projectId}, ${ownerId}, ${storageKey}, ${contentType}, ${byteSize}, ${now()})`
      return { id, storageKey, contentType, byteSize }
    },

    async readMediaObject(userId, mediaId) {
      const [row] = await sql`
        select o.id, o.project_id as "projectId", o.storage_key as "storageKey", o.content_type as "contentType", o.byte_size as "byteSize"
        from media_objects o join project_members m on m.project_id = o.project_id
        where o.id = ${mediaId} and m.user_id = ${userId}
      `
      return row ? { ...row, byteSize: Number(row.byteSize) } : undefined
    },

    async listAuditEvents(userId, projectId, limit = 100) {
      const role = await memberRole(projectId, userId)
      if (!role) return undefined
      const rows = await sql`
        select id, actor_id as "actorId", action, project_id as "projectId", target_id as "targetId", detail, created_at as "createdAt"
        from audit_events where project_id = ${projectId} order by created_at desc limit ${Math.max(1, Math.min(limit, 500))}
      `
      return rows.map((row) => ({ ...row, createdAt: Number(row.createdAt), detail: asJson(row.detail) }))
    },

    async close() {
      await sql.end({ timeout: 5 })
    },
  }

  return store
}
