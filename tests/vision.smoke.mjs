/**
 * 真实 Host bundle 的图片挑战回归：供应商 stub 从 PNG 像素读取答案，不读取生成器 expected。
 * 配置与附件都在内存中；Host VM 不提供 Node、网络或 Web 全局。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const z = require('@deepseek-ai/schemastery')
const plain = (value) => JSON.parse(JSON.stringify(value))
let code = readFileSync(process.env.MODEL_PRO_HOST_BUNDLE || new URL('../dist/host.js', import.meta.url), 'utf8')
code = code.replace(/^import .* from ["']@deepseek-ai\/[^"']+["'];?$/gm, '')
code = code.replace(/export\s*\{[\s\S]*?\};?\s*$/m, '')
let randomSeed = 0x12345678
const deterministicMath = Object.create(Math)
deterministicMath.random = () => {
  randomSeed = (Math.imul(randomSeed, 1664525) + 1013904223) >>> 0
  return randomSeed / 0x100000000
}
const sandbox = vm.createContext({ z, Math: deterministicMath, console, TypertRemoteService: class {} })
assert.deepEqual(plain(vm.runInContext('[typeof Buffer, typeof fetch, typeof AbortController, typeof TextEncoder, typeof TextDecoder, typeof crypto, typeof URL, typeof window]', sandbox)), Array(8).fill('undefined'))
const api = vm.runInContext(`(() => { ${code}; return { verifyImageInput, savedImageVerification, resolvedImageVerificationBinding, imageVerificationBinding, verificationDigest, matchesVisionAnswer, getProvider }; })()`, sandbox)

// 标准 PNG 解码及一个独立的七段字/图形读图 stub，避免“答案被放进请求文字”也能通过测试。
function readChallenge(data) {
  const png = Buffer.from(data)
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  const chunks = [], encoded = []
  let width, height
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const payload = png.subarray(offset + 8, offset + 8 + length)
    assert(offset + length + 12 <= png.length)
    chunks.push(type)
    if (type === 'IHDR') {
      width = payload.readUInt32BE(0); height = payload.readUInt32BE(4)
      assert.equal(payload[8], 8); assert.equal(payload[9], 2)
    }
    if (type === 'IDAT') encoded.push(payload)
    offset += length + 12
  }
  assert.deepEqual(chunks, ['IHDR', 'IDAT', 'IEND'], 'PNG must not contain answer-bearing text or metadata')
  assert.equal(width, 384); assert.equal(height, 288)
  const raw = inflateSync(Buffer.concat(encoded))
  const stride = width * 3 + 1
  assert.equal(raw.length, stride * height)
  for (let row = 0; row < height; row++) assert.equal(raw[row * stride], 0)
  const rgb = (x, y) => [...raw.subarray(y * stride + 1 + x * 3, y * stride + 1 + x * 3 + 3)]
  const ink = (x, y) => rgb(x, y).every((channel) => channel < 80)
  const segments = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg']
  let digits = ''
  for (let index = 0; index < 4; index++) {
    const x = 68 + index * 68, y = 24
    const points = [[x + 22, y + 4], [x + 39, y + 24], [x + 39, y + 64], [x + 22, y + 83], [x + 4, y + 64], [x + 4, y + 24], [x + 22, y + 43]]
    const lit = points.map(([px, py], bit) => ink(px, py) ? 'abcdefg'[bit] : '').join('')
    const digit = segments.indexOf(lit)
    assert(digit >= 0, `Unreadable image glyph: ${lit}`)
    digits += String(digit)
  }
  const readSymbol = (begin, end) => {
    const rows = [], colors = new Map()
    for (let y = Math.floor(height / 2); y < height; y++) {
      let count = 0
      for (let x = begin; x < end; x++) {
        const [r, g, b] = rgb(x, y)
        if (r === 255 && g === 255 && b === 255) continue
        assert(!(r === g && g === b), 'Shapes must be encoded visually in color')
        const color = b > r && b > g ? 'blue' : g > r && g > b ? 'green' : g > 80 ? 'orange' : 'red'
        colors.set(color, (colors.get(color) || 0) + 1)
        count++
      }
      if (count) rows.push(count)
    }
    assert(rows.length > 50)
    assert.equal(colors.size, 1)
    const maximum = Math.max(...rows)
    const shape = rows[0] > maximum * 0.7 ? 'square' : rows.at(-1) > maximum * 0.7 ? 'triangle' : 'circle'
    return { shape, color: [...colors.keys()][0] }
  }
  const result = { code: digits, left: readSymbol(0, width / 2), right: readSymbol(width / 2, width) }
  assert.notEqual(result.left.shape, result.right.shape)
  assert.notEqual(result.left.color, result.right.color)
  return result
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const profile = {
    api: 'openai-completions', baseURL: 'https://vision-fixture.invalid/v1',
    headers: { 'X-Synthetic-Auth': 'private-fixture-header' }, apiKeyEnv: 'SYNTHETIC_VISION_KEY',
    apiKeyEnc: { iv: 'opaque-fixture-iv', ct: 'private-fixture-ciphertext' },
    models: [{ id: 'local-alias', requestModel: 'wire-model', input: ['text', 'image'] }, { id: 'wire-model', input: ['text', 'image'] }],
  }
  const docs = new Map([
    ['llm-pi-ai', { revision: 0, value: { providers: { fixture: profile } } }],
    ['dsh-model-pro', { revision: 0, value: { state: { routes: { sentinel: { retained: true } }, modelCapabilities: {} } } }],
  ])
  const state = { mode: 'correct', prepares: [], streams: [], images: [], writes: [], deadlines: [], preparedInput: ['text', 'image'], saveFails: false, credentialValue: 'private-fixture-api-key' }
  const store = {
    writable: true,
    describe: () => [...docs].map(([ns, row]) => ({ ns, revision: row.revision, value: structuredClone(row.value) })),
    async mutate(ns, ops, expectedRevision) {
      assert.equal(ns, 'dsh-model-pro', 'Verification may only write its own settings namespace')
      const row = docs.get(ns)
      assert.equal(expectedRevision, row.revision)
      if (state.saveFails) throw new Error('synthetic own-state save failure')
      const next = structuredClone(row.value)
      for (const op of ops) {
        assert.deepEqual(plain(op.path), ['state', 'imageVerifications'])
        assert.equal(op.op, 'set')
        next.state.imageVerifications = structuredClone(op.value)
      }
      row.value = next; row.revision++
      state.writes.push({ ns, ops: plain(ops) })
    },
    async replace() { throw new Error('Native settings replacement is not allowed in a vision probe') },
  }
  const savedImages = new Map()
  const attachments = {
    async saveImage(args) {
      assert(ArrayBuffer.isView(args.data))
      assert.equal(args.mediaType, 'image/png')
      const answer = readChallenge(args.data)
      const hash = createHash('sha256').update(args.data).digest('hex')
      const ref = { attachmentId: `sha256:${hash}`, mediaType: 'image/png', width: 384, height: 288 }
      savedImages.set(ref.attachmentId, answer)
      state.images.push({ hash, answer, name: args.name })
      await state.onImage?.(state.images.length)
      return ref
    },
  }
  const timer = {
    timeout(fn, ms) {
      assert.equal(ms, 60000)
      const entry = { fn, cancelled: false }
      state.deadlines.push(entry)
      return () => { entry.cancelled = true }
    },
  }
  const llm = {
    async prepareCall(config) {
      state.prepares.push(plain(config))
      await state.onPrepare?.(state.prepares.length)
      const preparedConfig = { ...config, temperature: 0.125, maxTokens: 384, maxOutputTokens: 384, resolvedMarker: { test: 'resolved-configuration' } }
      return {
        config: preparedConfig,
        inputModalities: state.preparedInput,
        async *stream(options) {
          state.streams.push(options)
          for (const [key, value] of Object.entries(preparedConfig)) assert.deepEqual(plain(options[key]), plain(value), `Resolved config field ${key} must reach the adapter unchanged`)
          assert.equal(options.messages.length, 1)
          const content = options.messages[0].content
          assert.deepEqual(plain(content.map(({ type }) => type)), ['text', 'image'])
          const answer = savedImages.get(content[1].attachment.attachmentId)
          assert(answer)
          assert(!content[0].text.includes(answer.code), 'No expected answer may be leaked into the textual prompt')
          state.enteredStream?.resolve()
          await state.onStream?.(state.streams.length)
          if (state.mode === 'timeout') await state.releaseStream.promise
          if (state.mode === 'throw') throw new Error('synthetic private provider request error')
          if (state.mode === 'finish-error') { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PRIVATE_PROVIDER_FAILURE' } } }; return }
          const correct = state.mode !== 'wrong' && !(state.mode === 'partial' && state.streams.length === 2)
          const reply = correct ? JSON.stringify(answer) : JSON.stringify({ ...answer, code: 'incorrect' })
          yield { type: 'text-delta', text: reply.slice(0, 8) }
          yield { type: 'text-delta', text: reply.slice(8) }
          yield { type: 'finish', reason: { kind: state.mode === 'unfinished' ? 'max-tokens' : 'stop' } }
        },
      }
    },
  }
  const credentials = { async resolve(ref) { assert.equal(typeof ref, 'string'); return { value: ref === 'SYNTHETIC_VISION_KEY' ? state.credentialValue : 'other-reference-fixture-key' } } }
  const ctx = { get: (name) => ({ settings: store, llm, attachments, timer, credentials })[name] }
  const native = () => docs.get('llm-pi-ai').value
  const own = () => docs.get('dsh-model-pro').value.state
  const model = () => native().providers.fixture.models[0]
  const verify = () => api.verifyImageInput(ctx, { route: 'fixture', model: 'local-alias' })
  const evidence = async () => api.savedImageVerification(store, 'fixture', native().providers.fixture, model(), await api.resolvedImageVerificationBinding(ctx, native().providers.fixture, model()))
  return { state, store, ctx, native, own, model, verify, evidence }
}

// SHA-256 与标准实现一致；绑定不重复保存请求头/密钥/加密配置内容。
for (const text of ['', 'abc', '认证🔑\ud800']) assert.equal(api.verificationDigest(text), createHash('sha256').update(text).digest('hex'))
const validAnswer = { code: '0042', left: { shape: 'circle', color: 'red' }, right: { shape: 'square', color: 'blue' } }
assert(api.matchesVisionAnswer(JSON.stringify(validAnswer), validAnswer))
assert(api.matchesVisionAnswer(`\`\`\`json\n${JSON.stringify(validAnswer)}\n\`\`\``, validAnswer))
for (const reply of [
  `Answer: ${JSON.stringify(validAnswer)}`, `${JSON.stringify(validAnswer)} trailing text`,
  JSON.stringify({ ...validAnswer, code: 42 }), JSON.stringify({ ...validAnswer, code: '42' }),
  JSON.stringify({ ...validAnswer, left: validAnswer.right, right: validAnswer.left }),
  JSON.stringify({ ...validAnswer, left: { ...validAnswer.left, color: 'green' } }),
]) assert(!api.matchesVisionAnswer(reply, validAnswer), `Strict visual answer must reject ${reply}`)

{
  const f = fixture(), before = JSON.stringify(f.native()), beforeOtherState = plain(f.own())
  const result = await f.verify()
  assert.equal(result.ok, true, result.error)
  assert.equal(result.saved, true)
  assert.equal(result.verification.status, 'verified')
  assert.equal(result.verification.passed, 2)
  assert.equal(result.verification.total, 2)
  assert.equal(f.state.streams.length, 2)
  assert.equal(f.state.images.length, 2)
  assert.notEqual(f.state.images[0].hash, f.state.images[1].hash, 'Challenges must not use one fixed image')
  assert(f.state.prepares.every(({ model }) => model === 'wire-model'))
  assert.equal(JSON.stringify(f.native()), before, 'Verification must not change model input or other native settings')
  assert.deepEqual(plain(await f.evidence()), plain(result.verification))
  assert.deepEqual(plain(Object.fromEntries(Object.entries(f.own()).filter(([key]) => key !== 'imageVerifications'))), beforeOtherState)
  const saved = f.own().imageVerifications.fixture['local-alias']
  assert.match(saved.binding, /^[0-9a-f]{64}$/)
  for (const secret of ['private-fixture-header', 'SYNTHETIC_VISION_KEY', 'private-fixture-ciphertext', 'opaque-fixture-iv', 'private-fixture-api-key']) assert(!JSON.stringify(f.own().imageVerifications).includes(secret))
  assert(f.state.deadlines.every(({ cancelled }) => cancelled))
  for (const change of [
    () => { f.native().providers.fixture.baseURL += '/changed' },
    () => { f.model().requestModel = 'new-wire' },
    () => { f.native().providers.fixture.headers['X-Synthetic-Auth'] = 'rotated' },
    () => { f.native().providers.fixture.apiKeyEnv = 'NEW_REF' },
    () => { f.model().input = ['text'] },
  ]) {
    const profile = structuredClone(f.native().providers.fixture)
    change()
    assert.equal(await f.evidence(), undefined, 'Configuration changes must invalidate previous evidence')
    f.native().providers.fixture = profile
    assert(await f.evidence())
  }
  const described = await api.getProvider(f.ctx, { route: 'fixture' })
  assert.equal(described.models[0].capabilityVerification.status, 'verified')
  f.state.credentialValue = 'rotated-fixture-api-key'
  assert.equal(await f.evidence(), undefined, 'Rotating the value behind the same credential reference invalidates evidence')
  assert.equal((await api.getProvider(f.ctx, { route: 'fixture' })).models[0].capabilityVerification, undefined)
}

for (const mode of ['wrong', 'partial', 'throw', 'finish-error', 'unfinished']) {
  const f = fixture(), before = JSON.stringify(f.native())
  f.state.mode = mode
  const result = await f.verify()
  assert.equal(result.ok, true, result.error)
  assert.equal(result.saved, true)
  assert.equal(result.verification.status, 'unconfirmed', mode)
  assert.equal(result.verification.passed, mode === 'partial' ? 1 : 0)
  assert.equal(JSON.stringify(f.native()), before)
  assert.equal((await f.evidence()).status, 'unconfirmed')
  assert(!JSON.stringify(f.own()).includes('PRIVATE_PROVIDER_FAILURE'))
}

{
  const f = fixture(), entered = deferred()
  f.state.mode = 'timeout'; f.state.enteredStream = entered; f.state.releaseStream = deferred()
  const pending = f.verify()
  await entered.promise
  for (const deadline of f.state.deadlines) if (!deadline.cancelled) deadline.fn()
  const result = await pending
  assert.equal(result.verification.status, 'unconfirmed')
  assert.equal(result.verification.passed, 0)
  assert.match(result.verification.message, /超时/)
  assert.equal((await f.evidence()).status, 'unconfirmed')
  const blocked = await f.verify()
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /正在验证/)
  f.state.mode = 'correct'
  f.state.releaseStream.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await f.verify()).verification.status, 'verified', 'A completed late call must release its in-flight slot')
}

for (const phase of ['prepare', 'upload']) {
  const f = fixture(), entered = deferred(), release = deferred()
  const pause = async () => { entered.resolve(); await release.promise }
  if (phase === 'prepare') f.state.onPrepare = pause
  else f.state.onImage = pause
  const pending = f.verify()
  await entered.promise
  for (const deadline of f.state.deadlines) if (!deadline.cancelled) deadline.fn()
  const result = await pending
  assert.equal(result.verification.status, 'unconfirmed', `${phase} must be covered by the deadline`)
  assert.equal(f.state.streams.length, 0)
  assert.equal((await f.verify()).ok, false, 'A late preparation/upload must retain the in-flight slot')
  release.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.state.streams.length, 0, `A timed-out ${phase} must not dispatch a late image request`)
  assert.equal(f.state.images.length, phase === 'prepare' ? 0 : 1)
  f.state.onPrepare = undefined; f.state.onImage = undefined
  assert.equal((await f.verify()).verification.status, 'verified')
}

{
  const f = fixture(), before = JSON.stringify(f.native())
  f.model().input = []
  const emptyInput = JSON.stringify(f.native())
  const result = await f.verify()
  assert.equal(result.verification.status, 'verified', 'Schema-default empty input must allow the runtime image capability')
  assert.equal(JSON.stringify(f.native()), emptyInput)
  assert.notEqual(emptyInput, before)
}

for (const localGuard of ['selected-text', 'runtime-text']) {
  const f = fixture()
  if (localGuard === 'selected-text') f.model().input = ['text']
  else f.state.preparedInput = ['text']
  const result = await f.verify()
  assert.equal(result.ok, false)
  assert.match(result.error, /尚未发出图片请求/)
  assert.equal(f.state.streams.length, 0)
  assert.equal(f.state.images.length, 0)
  assert.equal(f.state.writes.length, 0)
}

for (const change of [
  (f) => { f.native().providers.fixture.baseURL += '/changed' },
  (f) => { f.model().requestModel = 'changed-wire' },
  (f) => { f.model().input = ['text'] },
]) {
  const f = fixture()
  f.state.onImage = () => change(f)
  const result = await f.verify()
  assert.equal(result.saved, false)
  assert.equal(f.state.streams.length, 0)
  assert.equal(f.state.writes.length, 0)
  assert.equal(await f.evidence(), undefined)
}

{
  const f = fixture()
  f.state.onStream = (attempt) => { if (attempt === 2) f.native().providers.fixture.headers['X-Synthetic-Auth'] = 'changed-after-stream-start' }
  const result = await f.verify()
  assert.equal(result.saved, false)
  assert.equal(f.state.writes.length, 0)
  assert.equal(await f.evidence(), undefined)
}
{
  const f = fixture()
  f.state.onStream = (attempt) => { if (attempt === 2) f.state.credentialValue = 'rotated-during-probe' }
  const result = await f.verify()
  assert.equal(result.saved, false, 'Rotating a credential value during the probe must reject stale evidence')
  assert.equal(f.state.writes.length, 0)
  assert.equal(await f.evidence(), undefined)
}
{
  const f = fixture()
  f.state.saveFails = true
  const result = await f.verify()
  assert.equal(result.ok, true)
  assert.equal(result.verification.status, 'verified')
  assert.equal(result.saved, false)
  assert.equal(await f.evidence(), undefined)
}
{
  const f = fixture(), prepareEntered = deferred(), release = deferred()
  f.state.onPrepare = async (attempt) => { if (attempt === 1) { prepareEntered.resolve(); await release.promise } }
  const first = f.verify()
  await prepareEntered.promise
  const duplicate = await f.verify()
  assert.equal(duplicate.ok, false)
  assert.match(duplicate.error, /正在验证/)
  assert.equal(f.state.prepares.length, 1)
  release.resolve()
  assert.equal((await first).verification.status, 'verified')
  assert.equal((await f.verify()).verification.status, 'verified')
}

console.log('PASS: isolated Host VM without Node/Web globals; PNG pixel challenges and strict answers, unchanged native input, resolved config, independent evidence and safe bindings, errors/timeouts/local guards, stale config rejection, save failures and duplicate in-flight protection')
