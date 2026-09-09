import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'

import { internals } from '../lib/index.js'

test('session log locator reuses a valid path without rescanning cwd buckets', async () => {
  assert.equal(typeof internals.createSessionLogLocator, 'function')

  let scans = 0
  const wanted = join('sessions', 'cwd-b', 'session-1', 'session.jsonl.zstd')
  const locator = internals.createSessionLogLocator({
    maxEntries: 4,
    readDir: async () => {
      scans += 1
      return ['cwd-a', 'cwd-b']
    },
    statFile: async (file) => {
      if (file === wanted) return { mtimeMs: 10, size: 20 }
      throw new Error('missing')
    },
  })

  assert.equal((await locator.find('sessions', 'session-1'))?.file, wanted)
  assert.equal((await locator.find('sessions', 'session-1'))?.file, wanted)
  assert.equal(scans, 1)
})

test('bounded map entries evict the least recently used session', () => {
  assert.equal(typeof internals.setBoundedMapEntry, 'function')

  const cache = new Map()
  internals.setBoundedMapEntry(cache, 'a', 1, 2)
  internals.setBoundedMapEntry(cache, 'b', 2, 2)
  internals.setBoundedMapEntry(cache, 'a', 3, 2)
  internals.setBoundedMapEntry(cache, 'c', 4, 2)

  assert.deepEqual([...cache.entries()], [['a', 3], ['c', 4]])
})

test('session ids reject path traversal and accept normal DSH ids', () => {
  assert.equal(typeof internals.isSafeSessionId, 'function')
  assert.equal(internals.isSafeSessionId('session-efd4ea10-5c81-426f-9443-59be3e82d5bd'), true)
  assert.equal(internals.isSafeSessionId('会话-1'), true)
  assert.equal(internals.isSafeSessionId('../credentials'), false)
  assert.equal(internals.isSafeSessionId('..\\credentials'), false)
  assert.equal(internals.isSafeSessionId(''), false)
})
