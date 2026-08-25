import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WORKFLOW_BATCH_FIELDS,
  addWorkflowBatchRow,
  canSubmitWorkflowBatch,
  parseWorkflowBatchCsv,
  removeWorkflowBatchRow,
  updateWorkflowBatchCell,
  validateWorkflowBatchItems,
  workflowBatchColumns,
  workflowBatchImportSummary,
} from './workflowBatchInput.ts'

test('声明字段词表与服务端保持一致', () => {
  // 两边不一致会让「校验通过」变得不可信。
  assert.deepEqual([...WORKFLOW_BATCH_FIELDS], ['sku', 'channel', 'language', 'aspectRatio', 'copy', 'assetGroupId'])
})

test('声明字段按名映射，其余列进 variables', () => {
  const result = parseWorkflowBatchCsv('sku,channel,产品名\nSKU-1,tmall,香水 A\nSKU-2,jd,香水 B')
  assert.deepEqual(result.items, [
    { sku: 'SKU-1', channel: 'tmall', variables: { 产品名: '香水 A' } },
    { sku: 'SKU-2', channel: 'jd', variables: { 产品名: '香水 B' } },
  ])
  assert.deepEqual(result.variableColumns, ['产品名'])
})

test('引号内的逗号不会切错行', () => {
  // SKU 里有逗号时朴素 split 会静默生成一批标识错误的项，
  // 之后「只重试这 2 个失败项」会打到别的行上。
  const result = parseWorkflowBatchCsv('sku,copy\n"SKU-1,PRO","限时 5 折，今日截止"\nSKU-2,常规文案')
  assert.deepEqual(result.items, [
    { sku: 'SKU-1,PRO', copy: '限时 5 折，今日截止' },
    { sku: 'SKU-2', copy: '常规文案' },
  ])
})

test('引号内的换行与双引号转义都能还原', () => {
  const result = parseWorkflowBatchCsv('sku,copy\nSKU-1,"第一行\n第二行"\nSKU-2,"他说""要留白"""')
  assert.equal(result.items[0].copy, '第一行\n第二行')
  assert.equal(result.items[1].copy, '他说"要留白"')
})

test('最后一行没有换行符时也会被收进来', () => {
  // 少收一行是静默丢数据。
  assert.equal(parseWorkflowBatchCsv('sku\nSKU-1\nSKU-2').items.length, 2)
})

test('列数不符的行报告出来，不补空也不丢弃', () => {
  // 补空或丢弃都会让用户以为导入成功。
  const result = parseWorkflowBatchCsv('sku,channel\nSKU-1,tmall\nSKU-2\nSKU-3,jd,多余')
  assert.deepEqual(result.items.map((item) => item.sku), ['SKU-1'])
  assert.deepEqual(result.problems.map((problem) => `${problem.line}:${problem.code}`), [
    '3:column_count_mismatch', '4:column_count_mismatch',
  ])
})

test('同一批里重复的业务标识按输入错误报告', () => {
  const result = parseWorkflowBatchCsv('sku,channel\nSKU-1,tmall\nSKU-1,tmall')
  assert.equal(result.items.length, 1)
  assert.equal(result.problems[0].code, 'duplicate_id')
  // 渠道不同就不是同一项。
  assert.equal(parseWorkflowBatchCsv('sku,channel\nSKU-1,tmall\nSKU-1,jd').items.length, 2)
})

test('空行跳过但仍记录，表头大小写不敏感', () => {
  const result = parseWorkflowBatchCsv('SKU,AspectRatio\nSKU-1,1:1\n\nSKU-2,3:4')
  assert.deepEqual(result.items, [
    { sku: 'SKU-1', aspectRatio: '1:1' },
    { sku: 'SKU-2', aspectRatio: '3:4' },
  ])
  assert.equal(result.problems.filter((problem) => problem.code === 'empty_row').length, 1)
})

test('显式 id 列优先于业务身份', () => {
  const result = parseWorkflowBatchCsv('id,sku\ncustom-1,SKU-1')
  assert.deepEqual(result.items, [{ id: 'custom-1', sku: 'SKU-1' }])
})

test('导入摘要把待修正的行数与可导入行数并列', () => {
  // 只报成功了几行，用户不会去看剩下的怎么了。
  const result = parseWorkflowBatchCsv('sku,channel\nSKU-1,tmall\nSKU-2')
  assert.equal(workflowBatchImportSummary(result), '1 行可导入，另有 1 行需要先修正。')
  assert.match(workflowBatchImportSummary(result, 'en'), /1 row\(s\) need fixing/u)
  const clean = parseWorkflowBatchCsv('sku\nSKU-1')
  assert.equal(workflowBatchImportSummary(clean), '1 行可导入。')
})

test('空输入与超限都不炸', () => {
  assert.deepEqual(parseWorkflowBatchCsv(''), { items: [], variableColumns: [], problems: [] })
  assert.deepEqual(parseWorkflowBatchCsv(undefined as unknown as string).items, [])
  const many = ['sku', ...Array.from({ length: 30 }, (_, index) => `SKU-${index}`)].join('\n')
  assert.equal(parseWorkflowBatchCsv(many, { limit: 10 }).items.length, 10)
})

test('表格列固定字段在前，变量列按出现顺序跟随', () => {
  const items = [{ sku: 'A', variables: { 产品名: '香水' } }, { sku: 'B', variables: { season: '夏' } }]
  const columns = workflowBatchColumns(items, ['产品名'])
  assert.deepEqual(columns.fields, ['sku', 'channel', 'language', 'aspectRatio', 'copy', 'assetGroupId'])
  assert.deepEqual(columns.variables, ['产品名', 'season'])
})

test('清空单元格删除该键，不留空串', () => {
  // 空串会被当成「声明了这个字段且值为空」，进而生成 {{sku}} 插值出空白的 Prompt。
  const items = [{ sku: 'A', channel: 'tmall' }]
  const cleared = updateWorkflowBatchCell(items, 0, { kind: 'field', name: 'channel' }, '  ')
  assert.deepEqual(cleared[0], { sku: 'A' })
  assert.equal('channel' in cleared[0], false)
  // 变量同理，清空最后一个变量时连 variables 一起去掉。
  const withVariable = updateWorkflowBatchCell(items, 0, { kind: 'variable', name: '产品名' }, '香水')
  assert.deepEqual(withVariable[0].variables, { 产品名: '香水' })
  assert.equal('variables' in updateWorkflowBatchCell(withVariable, 0, { kind: 'variable', name: '产品名' }, ''), false)
  // 不改其他行。
  assert.equal(updateWorkflowBatchCell([{ sku: 'A' }, { sku: 'B' }], 0, { kind: 'field', name: 'sku' }, 'X')[1].sku, 'B')
})

test('编辑出重复标识时立刻报出来，并指向先出现的那一行', () => {
  // 等到提交才发现就晚了：那时钱已经花出去了。
  const issues = validateWorkflowBatchItems([
    { sku: 'A', channel: 'tmall' },
    { sku: 'B', channel: 'tmall' },
    { sku: 'A', channel: 'tmall' },
  ])
  assert.equal(issues.length, 1)
  assert.equal(issues[0].index, 2)
  assert.equal(issues[0].code, 'duplicate_id')
  assert.match(issues[0].detail, /与第 1 行重复/u)
  assert.match(issues[0].detail, /重复标识会让失败重试打到别的行上/u)
  // 渠道不同就不是同一项。
  assert.deepEqual(validateWorkflowBatchItems([{ sku: 'A', channel: 'tmall' }, { sku: 'A', channel: 'jd' }]), [])
})

test('空行报出来但不校验「字段是否都填了」', () => {
  // 批量项本来就允许只给部分字段，其余走工作流版本里的默认值。
  assert.deepEqual(validateWorkflowBatchItems([{ sku: 'A' }]), [])
  assert.deepEqual(validateWorkflowBatchItems([{ variables: {} }]).map((issue) => issue.code), ['empty_row'])
  assert.deepEqual(validateWorkflowBatchItems([{}]).map((issue) => issue.code), ['empty_row'])
})

test('增删行与提交闸门', () => {
  assert.equal(addWorkflowBatchRow([{ sku: 'A' }]).length, 2)
  assert.equal(addWorkflowBatchRow(Array.from({ length: 200 }, () => ({})), { limit: 200 }).length, 200)
  assert.deepEqual(removeWorkflowBatchRow([{ sku: 'A' }, { sku: 'B' }], 0), [{ sku: 'B' }])
  assert.equal(canSubmitWorkflowBatch([{ sku: 'A' }]), true)
  assert.equal(canSubmitWorkflowBatch([]), false, '一行都没有时不能提交')
  assert.equal(canSubmitWorkflowBatch([{ sku: 'A' }, { sku: 'A' }]), false, '有重复标识时不能提交')
})
