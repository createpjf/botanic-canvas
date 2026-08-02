import { createHash, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { assertProjectPermission, assertWorkspacePermission, projectPermissionDecision } from './authorization.mjs'
import { applyGenerationJobToAgentRun } from './botanicAgentRun.mjs'

const now = () => Date.now()
const hashAccessToken = (token) => createHash('sha256').update(token).digest('hex')
const clone = (value) => structuredClone(value)

function productError(message, code = 'PRODUCT_STORE_ERROR') {
  const error = new Error(message)
  error.code = code
  return error
}

function asUser(row) {
  return row ? {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status ?? 'active',
    createdAt: row.createdAt === undefined ? undefined : Number(row.createdAt),
  } : undefined
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
      status text not null default 'active',
      created_at bigint not null
    );
    create table if not exists access_tokens (
      id text primary key,
      user_id text not null references app_users(id) on delete cascade,
      token_hash text not null unique,
      created_at bigint not null,
      revoked_at bigint
    );
    create table if not exists auth_identities (
      provider text not null,
      subject text not null,
      user_id text not null references app_users(id) on delete cascade,
      created_at bigint not null,
      primary key (provider, subject),
      unique (provider, user_id)
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
    create table if not exists agent_runs (
      id text primary key,
      owner_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      status text not null check (status in ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
      updated_at bigint not null,
      payload jsonb not null
    );
    create table if not exists agent_skills (
      id text primary key,
      owner_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      status text not null check (status in ('active', 'archived')),
      updated_at bigint not null,
      payload jsonb not null
    );
    create table if not exists agent_action_receipts (
      id text primary key,
      owner_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      created_at bigint not null,
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
    alter table app_users add column if not exists status text not null default 'active';
    create index if not exists app_users_status_idx on app_users (status, created_at);
    create index if not exists auth_identities_user_idx on auth_identities (user_id);
    create index if not exists canvas_graph_updates_project_idx on canvas_graph_updates (project_id, id);
    create index if not exists jobs_status_updated_at_idx on generation_jobs (status, updated_at);
    create index if not exists agent_runs_project_updated_idx on agent_runs (project_id, updated_at desc);
    create index if not exists agent_skills_project_updated_idx on agent_skills (project_id, updated_at desc);
    create index if not exists agent_action_receipts_project_created_idx on agent_action_receipts (project_id, created_at desc);
    create index if not exists media_project_idx on media_objects (project_id);
    create index if not exists audit_project_created_idx on audit_events (project_id, created_at desc);
    create index if not exists audit_created_idx on audit_events (created_at desc);
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
        select u.id, u.email, u.name, u.role, u.status, u.created_at as "createdAt"
        from access_tokens t join app_users u on u.id = t.user_id
        where t.token_hash = ${hashAccessToken(accessToken)} and t.revoked_at is null and u.status = 'active'
      `
      return asUser(row)
    },

    // Auth 身份通过 auth_identities 绑定既有工作区用户，绝不改写用户主键、
    // 项目成员关系或历史数据；业务数据也不经过 Supabase PostgREST。
    async ensureAuthenticatedUser({ id, email, name, roleHint, statusHint = 'active', createIfMissing = true }) {
      if (!id) throw productError('登录用户缺少标识。', 'AUTH_USER_INVALID')
      const normalizedEmail = (email || `${id}@auth.botanic.local`).trim().toLowerCase()
      const normalizedName = name?.trim() || normalizedEmail.split('@')[0] || 'Botanic Member'
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(72695839)`
        const [identity] = await tx`
          select u.id, u.email, u.name, u.role, u.status, u.created_at as "createdAt"
          from auth_identities i join app_users u on u.id = i.user_id
          where i.provider = 'supabase' and i.subject = ${id}
          for update of u
        `
        const [sameId] = identity ? [] : await tx`select id, email, name, role, status, created_at as "createdAt" from app_users where id = ${id} for update`
        const [sameEmail] = identity || sameId ? [] : await tx`select id, email, name, role, status, created_at as "createdAt" from app_users where lower(email) = lower(${normalizedEmail}) for update`
        const existing = identity ?? sameId ?? sameEmail
        if (existing) {
          if (existing.status === 'disabled') return undefined
          const status = existing.status === 'invited' && statusHint === 'active' ? 'active' : existing.status
          if (existing.email !== normalizedEmail || existing.name !== normalizedName || existing.status !== status) {
            await tx`update app_users set email = ${normalizedEmail}, name = ${normalizedName}, status = ${status} where id = ${existing.id}`
          }
          await tx`
            insert into auth_identities (provider, subject, user_id, created_at)
            values ('supabase', ${id}, ${existing.id}, ${now()})
            on conflict (provider, subject) do update set user_id = excluded.user_id
          `
          return asUser({ ...existing, email: normalizedEmail, name: normalizedName, status })
        }
        if (!createIfMissing) return undefined
        const [owner] = await tx`select id from app_users where role = 'owner' limit 1`
        const role = roleHint === 'owner' || !owner ? 'owner' : 'member'
        const status = statusHint === 'invited' ? 'invited' : 'active'
        const createdAt = now()
        await tx`insert into app_users (id, email, name, role, status, created_at) values (${id}, ${normalizedEmail}, ${normalizedName}, ${role}, ${status}, ${createdAt})`
        await tx`insert into auth_identities (provider, subject, user_id, created_at) values ('supabase', ${id}, ${id}, ${createdAt})`
        return { id, email: normalizedEmail, name: normalizedName, role, status, createdAt }
      })
    },

    async readUser(userId) {
      const [row] = await sql`select id, email, name, role, status, created_at as "createdAt" from app_users where id = ${userId}`
      return asUser(row)
    },

    async createUser(actorId, { email, name, role = 'member', accessToken }) {
      return sql.begin(async (tx) => {
        const [actor] = await tx`select role, status from app_users where id = ${actorId}`
        assertWorkspacePermission(actor, 'manage-members', 'USER_CREATE_FORBIDDEN')
        const [existing] = await tx`select id from app_users where lower(email) = lower(${email})`
        if (existing) throw productError('该成员已存在。', 'USER_EXISTS')
        const user = { id: `usr_${randomUUID()}`, email, name: name || email, role, status: 'active', createdAt: now() }
        await tx`insert into app_users (id, email, name, role, status, created_at) values (${user.id}, ${user.email}, ${user.name}, ${user.role}, ${user.status}, ${user.createdAt})`
        await tx`insert into access_tokens (id, user_id, token_hash, created_at) values (${`token_${randomUUID()}`}, ${user.id}, ${hashAccessToken(accessToken)}, ${now()})`
        await insertAudit(tx, { actorId, action: 'member.created', targetId: user.id, detail: { email: user.email, role: user.role } })
        return user
      })
    },

    async listUsers(actorId) {
      const [actor] = await sql`select role, status from app_users where id = ${actorId}`
      assertWorkspacePermission(actor, 'manage-members', 'USER_MANAGE_FORBIDDEN')
      const rows = await sql`
        select id, email, name, role, status, created_at as "createdAt"
        from app_users order by created_at asc
      `
      return rows.map(asUser)
    },

    async updateUser(actorId, targetId, updates) {
      return sql.begin(async (tx) => {
        const [actor] = await tx`select role, status from app_users where id = ${actorId} for update`
        assertWorkspacePermission(actor, 'manage-members', 'USER_MANAGE_FORBIDDEN')
        const [target] = await tx`
          select id, email, name, role, status, created_at as "createdAt"
          from app_users where id = ${targetId} for update
        `
        if (!target) throw productError('未找到该工作区成员。', 'USER_NOT_FOUND')
        const role = updates?.role ?? target.role
        const status = updates?.status ?? target.status
        if (!['owner', 'member'].includes(role) || !['invited', 'active', 'disabled'].includes(status)) {
          throw productError('成员更新参数无效。', 'USER_UPDATE_INVALID')
        }
        if (target.role === 'owner' && target.status === 'active' && (role !== 'owner' || status !== 'active')) {
          const [{ count }] = await tx`select count(*)::int as count from app_users where role = 'owner' and status = 'active'`
          if (Number(count) <= 1) throw productError('工作区必须保留至少一名启用的所有者。', 'LAST_OWNER_REQUIRED')
        }
        await tx`update app_users set role = ${role}, status = ${status} where id = ${targetId}`
        if (status === 'disabled') await tx`update access_tokens set revoked_at = ${now()} where user_id = ${targetId} and revoked_at is null`
        await insertAudit(tx, { actorId, action: 'member.updated', targetId, detail: { role, status } })
        return asUser({ ...target, role, status })
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

    async projectAccess(userId, projectId) {
      const [row] = await sql`
        select p.id, m.role
        from projects p left join project_members m on m.project_id = p.id and m.user_id = ${userId}
        where p.id = ${projectId}
      `
      return { exists: Boolean(row), role: row?.role }
    },

    async canEditProject(userId, projectId) {
      const role = await memberRole(projectId, userId)
      return projectPermissionDecision(role, 'edit') === 'allow'
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
          assertProjectPermission(existing.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
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
        assertProjectPermission(member.role, 'delete', 'PROJECT_DELETE_FORBIDDEN')
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
        assertProjectPermission(member?.role, 'manage-members', 'PROJECT_MEMBER_FORBIDDEN')
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
        assertProjectPermission(member?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
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
        assertProjectPermission(member?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
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
      const [access] = await sql`select 1 from app_users where id = ${userId} and status <> 'disabled'`
      if (!access) return undefined
      const [row] = await sql`select library from global_asset_libraries where id = ${id}`
      return row ? asJson(row.library) : undefined
    },

    async writeGlobalAssetLibrary(userId, library) {
      const [user] = await sql`select role, status from app_users where id = ${userId}`
      assertWorkspacePermission(user, 'manage-library', 'LIBRARY_WRITE_FORBIDDEN')
      await sql`
        insert into global_asset_libraries (id, library, updated_at)
        values (${library.id}, ${sql.json(library)}::jsonb, ${now()})
        on conflict (id) do update set library = excluded.library, updated_at = excluded.updated_at
      `
      await insertAudit(sql, { actorId: userId, action: 'brand-library.updated', targetId: library.id })
      return clone(library)
    },

    async deleteGlobalAsset(userId, assetId) {
      const [user] = await sql`select role, status from app_users where id = ${userId}`
      assertWorkspacePermission(user, 'manage-library', 'LIBRARY_WRITE_FORBIDDEN')
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

    async putAgentSkill(userId, skill) {
      const role = await memberRole(skill.projectId, userId)
      assertProjectPermission(role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const timestamp = now()
      const [existing] = await sql`select project_id as "projectId", payload from agent_skills where id = ${skill.id}`
      if (existing && existing.projectId !== skill.projectId) throw productError('Skill 标识已被其他项目使用。', 'AGENT_SKILL_ID_CONFLICT')
      const previous = asPayload(existing)
      const payload = {
        ...clone(skill), ownerId: userId,
        createdAt: Number(previous?.createdAt ?? skill.createdAt) || timestamp,
        updatedAt: timestamp,
      }
      await sql`
        insert into agent_skills (id, owner_id, project_id, status, updated_at, payload)
        values (${skill.id}, ${userId}, ${skill.projectId}, ${payload.status}, ${timestamp}, ${sql.json(payload)}::jsonb)
        on conflict (id) do update set status = excluded.status, updated_at = excluded.updated_at, payload = excluded.payload
      `
      await insertAudit(sql, { actorId: userId, action: existing ? 'agent-skill.updated' : 'agent-skill.created', projectId: skill.projectId, targetId: skill.id })
      return clone(payload)
    },

    async listAgentSkills(userId, projectId) {
      if (!await memberRole(projectId, userId)) return undefined
      const rows = await sql`
        select s.payload from agent_skills s join project_members m on m.project_id = s.project_id
        where s.project_id = ${projectId} and s.status = 'active' and m.user_id = ${userId}
        order by s.updated_at desc
      `
      return rows.map(asPayload)
    },

    async putAgentActionReceipt(userId, receipt) {
      const role = await memberRole(receipt.projectId, userId)
      assertProjectPermission(role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const [existing] = await sql`select owner_id as "ownerId", project_id as "projectId" from agent_action_receipts where id = ${receipt.id}`
      if (existing && (existing.ownerId !== userId || existing.projectId !== receipt.projectId)) {
        throw productError('Agent 行动回执冲突。', 'AGENT_ACTION_RECEIPT_CONFLICT')
      }
      const payload = { ...clone(receipt), ownerId: userId }
      await sql`
        insert into agent_action_receipts (id, owner_id, project_id, created_at, payload)
        values (${receipt.id}, ${userId}, ${receipt.projectId}, ${receipt.createdAt}, ${sql.json(payload)}::jsonb)
        on conflict (id) do update set payload = excluded.payload
      `
      try {
        await insertAudit(sql, { actorId: userId, action: 'agent-action.succeeded', projectId: receipt.projectId, targetId: receipt.id, detail: { toolCallId: receipt.toolCallId } })
      } catch (error) {
        console.warn(`[agent-action] audit deferred for ${receipt.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return clone(payload)
    },

    async readAgentActionReceipt(userId, receiptId) {
      const [row] = await sql`
        select receipt.payload from agent_action_receipts receipt
        join project_members member on member.project_id = receipt.project_id
        where receipt.id = ${receiptId} and receipt.owner_id = ${userId} and member.user_id = ${userId}
      `
      return asPayload(row)
    },

    async putGenerationJob(userId, job) {
      const payload = { ...clone(job), ownerId: userId, updatedAt: now() }
      await sql.begin(async (tx) => {
        await tx`
          insert into generation_jobs (id, owner_id, project_id, status, updated_at, payload)
          values (${job.id}, ${userId}, ${job.projectId}, ${job.status}, ${payload.updatedAt}, ${tx.json(payload)}::jsonb)
          on conflict (id) do update set status = excluded.status, updated_at = excluded.updated_at, payload = excluded.payload
        `
        if (payload.agentRun?.runId) {
          const [row] = await tx`select payload from agent_runs where id = ${payload.agentRun.runId} and owner_id = ${userId} for update`
          if (row) {
            const run = applyGenerationJobToAgentRun(asPayload(row), payload)
            await tx`update agent_runs set status = ${run.status}, updated_at = ${run.updatedAt}, payload = ${tx.json(run)}::jsonb where id = ${run.id}`
          }
        }
      })
      await insertAudit(sql, { actorId: userId, action: `generation.${job.status}`, projectId: job.projectId, targetId: job.id, detail: { model: job.settings?.model, batchCount: job.batchCount } })
    },

    async putAgentRun(userId, run) {
      const role = await memberRole(run.projectId, userId)
      assertProjectPermission(role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const payload = { ...clone(run), ownerId: userId, updatedAt: Number(run.updatedAt) || now() }
      await sql`
        insert into agent_runs (id, owner_id, project_id, status, updated_at, payload)
        values (${run.id}, ${userId}, ${run.projectId}, ${run.status}, ${payload.updatedAt}, ${sql.json(payload)}::jsonb)
        on conflict (id) do update set status = excluded.status, updated_at = excluded.updated_at, payload = excluded.payload
      `
      await insertAudit(sql, { actorId: userId, action: `agent-run.${run.status}`, projectId: run.projectId, targetId: run.id })
      return clone(payload)
    },

    async readAgentRun(userId, runId) {
      const [row] = await sql`
        select r.payload from agent_runs r join project_members m on m.project_id = r.project_id
        where r.id = ${runId} and r.owner_id = ${userId} and m.user_id = ${userId}
      `
      return asPayload(row)
    },

    async readAgentRunForWorker(runId) {
      const [row] = await sql`select payload from agent_runs where id = ${runId}`
      return asPayload(row)
    },

    async listAgentRunsForProject(userId, projectId, limit = 30) {
      const rows = await sql`
        select r.payload from agent_runs r join project_members m on m.project_id = r.project_id
        where r.project_id = ${projectId} and r.owner_id = ${userId} and m.user_id = ${userId}
        order by r.updated_at desc limit ${Math.max(1, Math.min(limit, 60))}
      `
      return rows.map(asPayload)
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
      const [project] = await sql`select id from projects where id = ${projectId}`
      if (!project) return undefined
      assertProjectPermission(role, 'read-audit', 'PROJECT_AUDIT_FORBIDDEN')
      const rows = await sql`
        select id, actor_id as "actorId", action, project_id as "projectId", target_id as "targetId", detail, created_at as "createdAt"
        from audit_events where project_id = ${projectId} order by created_at desc limit ${Math.max(1, Math.min(limit, 500))}
      `
      return rows.map((row) => ({ ...row, createdAt: Number(row.createdAt), detail: asJson(row.detail) }))
    },

    async listWorkspaceAuditEvents(userId, limit = 100) {
      const [user] = await sql`select role, status from app_users where id = ${userId}`
      assertWorkspacePermission(user, 'read-audit', 'WORKSPACE_AUDIT_FORBIDDEN')
      const rows = await sql`
        select id, actor_id as "actorId", action, project_id as "projectId", target_id as "targetId", detail, created_at as "createdAt"
        from audit_events order by created_at desc limit ${Math.max(1, Math.min(limit, 500))}
      `
      return rows.map((row) => ({ ...row, createdAt: Number(row.createdAt), detail: asJson(row.detail) }))
    },

    async recordSecurityAuditEvent(userId, action, detail = {}) {
      const [user] = await sql`select id, status from app_users where id = ${userId}`
      if (!user || user.status === 'disabled') throw productError('登录状态无效。', 'AUTH_REQUIRED')
      await insertAudit(sql, { actorId: userId, action, detail })
      return { action }
    },

    async close() {
      await sql.end({ timeout: 5 })
    },
  }

  return store
}
