/**
 * 批量输入解析（Epic 7）。
 *
 * 服务端已经按声明式字段词表校验批量项（`sku` / `channel` / `language` /
 * `aspectRatio` / `copy` / `assetGroupId`，其余进 `variables`），缺的是把用户手里的
 * 表格变成那个形状。
 *
 * 这里**必须**自己解析而不是 `split(',')`：批量项的标识来自 SKU，而 SKU 里出现逗号
 * 或引号时朴素切分会把一行切错，结果是**静默地**生成了一批标识错误的项 —— 之后
 * 「只重试这 2 个失败项」会打到别的行上。
 */

/** 与服务端 `WORKFLOW_INPUT_FIELDS` 同一份词表。两边不一致会让「校验通过」变得不可信。 */
export const WORKFLOW_BATCH_FIELDS = ['sku', 'channel', 'language', 'aspectRatio', 'copy', 'assetGroupId'] as const

export type WorkflowBatchField = typeof WORKFLOW_BATCH_FIELDS[number]

export type WorkflowBatchItem = {
  id?: string
} & Partial<Record<WorkflowBatchField, string>> & {
  variables?: Record<string, string>
}

export type WorkflowBatchParseResult = {
  items: WorkflowBatchItem[]
  /** 表头里出现但不属于声明字段的列名；它们进 `variables`。 */
  variableColumns: string[]
  /** 逐行问题。**不静默丢行**：丢掉的行用户不会发现少了。 */
  problems: Array<{ line: number; code: 'empty_row' | 'column_count_mismatch' | 'duplicate_id'; detail: string }>
}

/**
 * 解析一行 CSV。支持双引号包裹、引号内逗号与换行、以及 `""` 转义。
 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let index = 0
  const push = () => { row.push(field); field = '' }
  const endRow = () => { push(); rows.push(row); row = [] }
  while (index < text.length) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 2; continue }
        quoted = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"') { quoted = true; index += 1; continue }
    if (char === ',') { push(); index += 1; continue }
    if (char === '\r') { index += 1; continue }
    if (char === '\n') { endRow(); index += 1; continue }
    field += char
    index += 1
  }
  // 最后一行没有换行符时也要收进来，否则会静默少一项。
  if (field || row.length) endRow()
  return rows
}

function normalizeHeader(value: string) {
  const trimmed = value.trim()
  const matched = WORKFLOW_BATCH_FIELDS.find((field) => field.toLowerCase() === trimmed.toLowerCase())
  return matched ?? trimmed
}

/**
 * 把 CSV 文本解析成批量项。
 *
 * 第一行是表头。声明字段按名映射，其余列进 `variables` 供 Prompt 插值。
 * 列数与表头不符的行**报告出来**而不是补空或丢弃 —— 两者都会让用户以为导入成功。
 */
export function parseWorkflowBatchCsv(text: string, { limit = 200 } = {}): WorkflowBatchParseResult {
  const rows = parseCsvRows(typeof text === 'string' ? text : '')
  const problems: WorkflowBatchParseResult['problems'] = []
  if (!rows.length) return { items: [], variableColumns: [], problems }
  const header = rows[0].map(normalizeHeader)
  const variableColumns = header.filter((name) => name && !WORKFLOW_BATCH_FIELDS.includes(name as WorkflowBatchField) && name !== 'id')
  const items: WorkflowBatchItem[] = []
  const seen = new Set<string>()
  for (let index = 1; index < rows.length; index += 1) {
    const line = index + 1
    const cells = rows[index]
    if (!cells.some((cell) => cell.trim())) {
      problems.push({ line, code: 'empty_row', detail: '空行已跳过。' })
      continue
    }
    if (cells.length !== header.length) {
      // 补空或丢弃都会让用户以为导入成功；报告出来让他去改表。
      problems.push({ line, code: 'column_count_mismatch', detail: `该行有 ${cells.length} 列，表头是 ${header.length} 列。` })
      continue
    }
    const item: WorkflowBatchItem = {}
    const variables: Record<string, string> = {}
    header.forEach((name, column) => {
      const value = cells[column]?.trim() ?? ''
      if (!name || !value) return
      if (name === 'id') { item.id = value; return }
      if (WORKFLOW_BATCH_FIELDS.includes(name as WorkflowBatchField)) {
        item[name as WorkflowBatchField] = value
        return
      }
      variables[name] = value
    })
    if (Object.keys(variables).length) item.variables = variables
    const identity = item.id ?? [item.sku, item.channel, item.language].filter(Boolean).join('_')
    if (identity && seen.has(identity)) {
      // 同一批里重复的业务标识是输入错误，不是可以静默去重的情况（与服务端同一判断）。
      problems.push({ line, code: 'duplicate_id', detail: `标识「${identity}」在本批中重复。` })
      continue
    }
    if (identity) seen.add(identity)
    items.push(item)
    if (items.length >= limit) break
  }
  return { items, variableColumns, problems }
}

/** 导入摘要。问题必须与成功数并列显示，不能只报成功了几行。 */
export function workflowBatchImportSummary(result: WorkflowBatchParseResult, locale: 'zh-CN' | 'en' = 'zh-CN') {
  const skipped = result.problems.filter((problem) => problem.code !== 'empty_row').length
  if (locale === 'en') {
    return skipped
      ? `${result.items.length} row(s) ready, ${skipped} row(s) need fixing before import.`
      : `${result.items.length} row(s) ready.`
  }
  return skipped
    ? `${result.items.length} 行可导入，另有 ${skipped} 行需要先修正。`
    : `${result.items.length} 行可导入。`
}
