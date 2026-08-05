import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createProductStore } from './productStore.mjs'
import {
  assertProductStoreContract,
  productStoreCoreMethods,
  productStoreSupports,
} from './productStoreContract.mjs'

function coreStore() {
  return Object.fromEntries(productStoreCoreMethods.map((method) => [method, () => undefined]))
}

test('ProductStore 契约明确报告缺失的核心能力', () => {
  const store = coreStore()
  delete store.readProject

  assert.throws(
    () => assertProductStoreContract(store, { adapter: 'BrokenStore' }),
    /BrokenStore 缺少 ProductStore 核心方法：readProject/,
  )
})

test('ProductStore 可选能力必须完整实现后才会暴露', () => {
  const store = coreStore()
  store.createMediaObject = () => undefined
  assert.equal(productStoreSupports(store, 'mediaObjects'), false)

  store.readMediaObject = () => undefined
  assert.equal(productStoreSupports(store, 'mediaObjects'), true)
})

test('本地 ProductStore 满足核心契约和成员管理能力', () => {
  const directory = mkdtempSync(join(tmpdir(), 'botanic-product-contract-'))
  try {
    const store = createProductStore({
      dataPath: join(directory, 'product.json'),
      bootstrapAccessToken: 'contract-test',
    })
    assert.equal(assertProductStoreContract(store, { adapter: 'LocalProductStore' }), store)
    assert.equal(productStoreSupports(store, 'workspaceMembers'), true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
