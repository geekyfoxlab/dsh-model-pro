/**
 * 用真实 Harness schema / PiAiAdapter / LlmRuntime 验证图片能力与虚拟路由派发。
 * 所有配置、凭据和图片均为内存夹具；后端事件源替换为本地 stub，不发网络请求。
 * DSH_RUNTIME_ROOT 指向运行时 dsh 目录，asar 读取需 Electron Node 模式及 --expose-internals。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'

const root = process.env.DSH_RUNTIME_ROOT
if (!root) throw new Error('DSH_RUNTIME_ROOT must point at the bundled dsh directory')
const load = (name) => import(pathToFileURL(`${root}/node_modules/@deepseek-ai/${name}/lib/index.js`).href)
const [{ Context }, { TypertRegistry }, { LlmRuntime, LlmAdapter }, { Config: PiConfig, apply: applyPi }, { SettingsForms }] = await Promise.all([
  load('cordis'), load('dsh-typert-registry'), load('dsh-llm'), load('dsh-llm-pi-ai'), load('dsh-settings'),
])
const { default: z } = await import(pathToFileURL(`${root}/node_modules/@deepseek-ai/schemastery/lib/index.mjs`).href)
const plain = (value) => JSON.parse(JSON.stringify(value))

let code = readFileSync(process.env.MODEL_PRO_HOST_BUNDLE || new URL('../dist/host.js', import.meta.url), 'utf8')
code = code.replace(/^import .* from ["']@deepseek-ai\/[^"']+["'];?$/gm, '')
code = code.replace(/export\s*\{[\s\S]*?\};?\s*$/m, '')
const api = vm.runInNewContext(`(() => { ${code}; return { makeRouterAdapter, resolveModelInput, applyModels, Config }; })()`, {
  z, console, setTimeout, clearTimeout, AbortController, TextEncoder, TextDecoder, crypto: globalThis.crypto,
  TypertRemoteService: class {},
})

// PiConfig 的 input 字段决定真实服务描述符；同名模型处于自定义 route 时没有目录继承。
let piAdapter, discover, directory
const dispose = () => {}
dispose.replace = () => {}
const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk5kAAAAASUVORK5CYII=', 'base64')
const attachments = {
  imageHostPath() { return undefined },
  async readImageRequest() { return { data: pixels, bytes: pixels.length, width: 1, height: 1, mediaType: 'image/png' } },
}
const piCtx = {
  fiber: { entry: { options: { id: 'llm-pi-ai' } } },
  get: (name) => name === 'attachments' ? attachments : undefined,
  inject() {}, on() {},
  llm: {
    registerConfigurableProviders(entries) { directory = entries; return dispose },
    registerModelDiscovery(_ns, fn) { discover = fn; return dispose },
    registerAdapter(_routes, next) { piAdapter = next; return dispose },
  }, logger: { error() {}, warn() {} },
}
applyPi(piCtx, PiConfig({ providers: { 'custom-route': {
  api: 'openai-completions', baseURL: 'https://multimodal-test.invalid/v1',
  models: [{ id: 'gpt-4o' }, { id: 'custom-image', input: ['text', 'image'] }, { id: 'explicit-text', input: ['text'] }],
} } }))
assert.deepEqual((await piAdapter.listModels('custom-route')).map((model) => model.inputModalities), [['text'], ['text', 'image'], ['text']])
assert.deepEqual((await piAdapter.resolveModel('custom-route', 'custom-image')).inputModalities, ['text', 'image'])
const catalog = await discover({ provider: 'openai' })
assert(catalog.find((model) => model.id === 'gpt-4o')?.inputModalities.includes('image'))
assert.throws(() => PiConfig({ providers: { bad: { models: [{ id: 'bad', input: ['audio'] }] } } }), /expected "text" \| "image"/)
const catalogService = {
  listConfigurableProviders: () => directory,
  discoverModels: (_ns, request) => discover(request),
}
const catalogCtx = { get: (name) => name === 'llm' ? catalogService : undefined }
assert.deepEqual(plain(await api.resolveModelInput(catalogCtx, 'custom-route', { id: 'local-alias', requestModel: 'gpt-4o' })), ['text', 'image'])
const schemaDefaultEntry = PiConfig({ providers: { custom: { models: [{ id: 'gpt-4o' }] } } }).providers.get().custom.models[0]
assert.deepEqual(schemaDefaultEntry.input, [])
assert.deepEqual(plain(await api.resolveModelInput(catalogCtx, 'custom', schemaDefaultEntry)), ['text', 'image'], 'Schema-generated empty input is equivalent to an absent declaration')
const rawProfile = { models: [{ id: 'gpt-4o' }] }
const modernSettings = { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { custom: { ...rawProfile, defaultInput: ['text'] } } }, user: { providers: { custom: rawProfile } } }] }
const modernCtx = { get: (name) => name === 'settings' ? modernSettings : name === 'llm' ? catalogService : undefined }
assert.deepEqual(plain(await api.resolveModelInput(modernCtx, 'custom', { id: 'gpt-4o' })), ['text', 'image'], 'Schema-generated text default must not suppress catalog detection')
rawProfile.defaultInput = ['text']
assert.deepEqual(plain(await api.resolveModelInput(modernCtx, 'custom', { id: 'gpt-4o' })), ['text'], 'Explicit provider default must be respected')
rawProfile.defaultInput = ['text', 'image']
assert.deepEqual(plain(await api.resolveModelInput(modernCtx, 'custom', { id: 'unlisted-model' })), ['text', 'image'])

// 按钮经真实 SettingsForms 读到 schema 默认 []，专用识别不能把它当作手工能力。
const identifyOriginal = { providers: {
  target: { api: 'openai-completions', baseURL: 'https://identify-fixture.invalid/v1', defaultInput: ['text'], headers: { 'X-Preserve': 'yes' }, models: [
    { id: 'gpt-4o' }, { id: 'manual-text', input: ['text'] }, { id: 'wire-alias', requestModel: 'gpt-4o' }, { id: 'unknown-id' },
  ] },
  unknown: { api: 'openai-completions', baseURL: 'https://unknown-fixture.invalid/v1', models: [{ id: 'recovered-image' }] },
  existing: { api: 'openai-completions', baseURL: 'https://existing-fixture.invalid/v1', apiKeyEnv: 'SYNTHETIC_EXISTING_REF', headers: { 'X-Original': 'keep' }, models: [{ id: 'original-model', input: ['text'] }] },
} }
const identifyEntries = [
  { id: 'llm-pi-ai', options: { id: 'llm-pi-ai', config: structuredClone(identifyOriginal) }, fiber: { uid: 11, state: 2, runtime: { Config: PiConfig }, config: PiConfig(structuredClone(identifyOriginal)), ctx: new Context() } },
  { id: 'dsh-model-pro', options: { id: 'dsh-model-pro', config: { state: {} } }, fiber: { uid: 12, state: 2, runtime: { Config: api.Config }, config: api.Config({ state: {} }), ctx: new Context() } },
]
let identifyWrites = 0
const identifyEditor = {
  entries: () => identifyEntries,
  configuration: () => identifyEntries.map((entry) => ({ entry, inherited: {}, override: entry.options.config })),
  async edit(entry, change) {
    identifyWrites++
    const next = change(entry.options.config, {})
    entry.fiber.config = entry.fiber.runtime.Config(next)
    entry.options.config = next
  },
}
const identifySettings = Object.create(SettingsForms.prototype)
Object.assign(identifySettings, { revisions: new Map(), presentations: new Map(), ownerContext: { emit() {}, configEditor: identifyEditor } })
const identifySection = () => identifySettings.describe().find(({ ns }) => ns === 'llm-pi-ai').value
const identifyRevision = () => identifySettings.describe().find(({ ns }) => ns === 'llm-pi-ai').revision
let discoveryMode = 'ready'
let identifyReads = 0
const identifyService = {
  listConfigurableProviders: () => discoveryMode === 'empty' ? [] : [{ settingsNs: 'llm-pi-ai', provider: 'openai', declared: false }],
  async discoverModels() {
    identifyReads++
    if (discoveryMode === 'failed') throw new Error('synthetic directory not ready')
    if (discoveryMode === 'concurrent') {
      // 目录读取尚未完成时，另一个会话保存了同一模型的名称、转发名和手工文本能力。
      const current = structuredClone(identifySection().providers.target.models)
      const index = current.findIndex(({ id }) => id === 'unknown-id')
      current[index] = { ...current[index], name: 'Concurrent user edit', requestModel: 'new-wire-id', input: ['text'] }
      await identifySettings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'target', 'models'], value: current }], identifyRevision())
    }
    return [{ id: 'gpt-4o', inputModalities: ['text', 'image'] }, { id: 'manual-text', inputModalities: ['text', 'image'] },
      ...(discoveryMode === 'recovered' ? [{ id: 'recovered-image', inputModalities: ['text', 'image'] }] : []),
      ...(discoveryMode === 'concurrent' ? [{ id: 'unknown-id', inputModalities: ['text', 'image'] }] : [])]
  },
}
const identifyCtx = { get: (name) => name === 'settings' ? identifySettings : name === 'llm' ? identifyService : name === 'configEditor' ? identifyEditor : undefined }
assert.deepEqual(identifySection().providers.target.models[0].input, [])
assert.equal(await api.resolveModelInput(identifyCtx, 'unknown', identifySection().providers.unknown.models[0]), undefined)
const originalExisting = JSON.stringify(identifySection().providers.existing)
const targetOtherFields = JSON.stringify(Object.fromEntries(Object.entries(identifySection().providers.target).filter(([key]) => key !== 'models')))
const identifyRequest = { route: 'target', mode: 'identify', models: identifyOriginal.providers.target.models.map(({ id }) => ({ id })) }
let detected = await api.applyModels(identifyCtx, identifyRequest)
assert.equal(detected.ok, true, detected.error)
assert.deepEqual(plain(detected.capabilitySummary), { image: 2, text: 1, unknown: 1, preserved: 1, updated: 2, catalogUnavailable: false })
assert.equal(identifyReads, 2, 'Explicit identify refreshes a previously read directory, then shares it across target models')
let targetModels = identifySection().providers.target.models
assert.deepEqual(plain(targetModels.find(({ id }) => id === 'gpt-4o').input), ['text', 'image'])
assert.deepEqual(plain(targetModels.find(({ id }) => id === 'wire-alias').input), ['text', 'image'])
assert.equal(targetModels.find(({ id }) => id === 'wire-alias').requestModel, 'gpt-4o')
assert.deepEqual(plain(targetModels.find(({ id }) => id === 'manual-text').input), ['text'])
assert.deepEqual(plain(targetModels.find(({ id }) => id === 'unknown-id').input), [])
assert.equal(JSON.stringify(Object.fromEntries(Object.entries(identifySection().providers.target).filter(([key]) => key !== 'models'))), targetOtherFields)
assert.equal(JSON.stringify(identifySection().providers.existing), originalExisting)
const settledWrites = identifyWrites
const settledRevision = identifyRevision()
const settledRaw = JSON.stringify(identifyEntries.map((entry) => entry.options.config))
detected = await api.applyModels(identifyCtx, identifyRequest)
assert.equal(detected.ok, true, detected.error)
assert.equal(detected.capabilitySummary.updated, 0)
assert.equal(detected.capabilitySummary.preserved, 3)
assert.equal(detected.capabilitySummary.unknown, 1)
assert.equal(identifyWrites, settledWrites)
assert.equal(identifyRevision(), settledRevision)
assert.equal(JSON.stringify(identifyEntries.map((entry) => entry.options.config)), settledRaw)
for (const mode of ['empty', 'failed']) {
  discoveryMode = mode
  detected = await api.applyModels(identifyCtx, { route: 'unknown', mode: 'identify', models: [{ id: 'recovered-image' }] })
  assert.equal(detected.ok, true, detected.error)
  assert.equal(detected.capabilitySummary.unknown, 1)
  assert.equal(detected.capabilitySummary.updated, 0)
  assert.equal(detected.capabilitySummary.catalogUnavailable, true)
  assert.equal(identifyWrites, settledWrites)
  assert.equal(identifyRevision(), settledRevision)
}
const noLlmCtx = { get: (name) => name === 'settings' ? identifySettings : name === 'configEditor' ? identifyEditor : undefined }
detected = await api.applyModels(noLlmCtx, { route: 'unknown', mode: 'identify', models: [{ id: 'recovered-image' }] })
assert.equal(detected.ok, true, detected.error)
assert.equal(detected.capabilitySummary.catalogUnavailable, true)
assert.equal(detected.capabilitySummary.unknown, 1)
assert.equal(identifyWrites, settledWrites)
discoveryMode = 'recovered'
detected = await api.applyModels(identifyCtx, { route: 'unknown', mode: 'identify', models: [{ id: 'recovered-image' }] })
assert.equal(detected.ok, true, detected.error)
assert.equal(detected.capabilitySummary.updated, 1)
assert.equal(detected.capabilitySummary.image, 1)
assert.equal(detected.capabilitySummary.catalogUnavailable, false)
assert.deepEqual(plain(identifySection().providers.unknown.models[0].input), ['text', 'image'])

discoveryMode = 'concurrent'
detected = await api.applyModels(identifyCtx, { route: 'target', mode: 'identify', models: [{ id: 'unknown-id' }] })
assert.equal(detected.ok, false, 'Identify must not overwrite model edits committed while catalog discovery awaited')
assert.match(detected.error, /模型|刷新|变化|conflict|revision/i)
const concurrentModel = identifySection().providers.target.models.find(({ id }) => id === 'unknown-id')
assert.equal(concurrentModel.name, 'Concurrent user edit')
assert.equal(concurrentModel.requestModel, 'new-wire-id')
assert.deepEqual(plain(concurrentModel.input), ['text'])
discoveryMode = 'ready'

// 普通保存的空 input 按 Pi 原生语义回到自动模式，不能因 schema 默认数组被拒绝。
detected = await api.applyModels(identifyCtx, { route: 'target', mode: 'merge', models: [{ id: 'manual-text', input: [] }] })
assert.equal(detected.ok, true, detected.error)
assert.deepEqual(plain(identifySection().providers.target.models.find(({ id }) => id === 'manual-text').input), ['text'])
assert.equal(JSON.stringify(identifySection().providers.existing), originalExisting)

// 替换最低层事件源，保留真实 PiAiAdapter 的附件准备、base64 与 PiContext 转换。
let backendContext
const answer = {
  role: 'assistant', content: [{ type: 'text', text: 'seen' }], api: 'openai-completions',
  provider: 'custom-route', model: 'custom-image', stopReason: 'stop', timestamp: 0,
  usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
}
piAdapter.current().models.streamSimple = async function* (_model, context) {
  backendContext = context
  yield { type: 'text_delta', contentIndex: 0, delta: 'seen', partial: answer }
  yield { type: 'done', reason: 'stop', message: answer }
}
const messages = [{ role: 'user', content: [
  { type: 'text', text: 'Describe the image' },
  { type: 'image', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, width: 1, height: 1, mediaType: 'image/png' } },
] }]
const piChunks = []
for await (const chunk of piAdapter.stream({ provider: 'custom-route', model: 'custom-image', messages })) piChunks.push(chunk)
const piImage = backendContext.messages[0].content.find((block) => block.type === 'image')
assert.equal(piImage.mimeType, 'image/png')
assert.equal(piImage.data, pixels.toString('base64'))
assert.equal(piChunks.at(-1).reason.kind, 'stop')

// 虚拟路由在真实 core.prepareCall() 中不能提前剥图，实际派发必须跳过仅文本目标。
const doc = {
  providers: {
    text: { models: [{ id: 'shared', input: ['text'] }] },
    vision: { models: [{ id: 'shared', input: ['text', 'image'] }] },
    unknown: { models: [{ id: 'shared' }] },
    override: { modelOverrides: { shared: { input: ['text'] } } },
  },
  routes: {
    mixed: { strategy: 'priority', targets: [{ provider: 'text', model: 'shared' }, { provider: 'vision', model: 'shared' }] },
    uncertain: { strategy: 'priority', targets: [{ provider: 'text', model: 'shared' }, { provider: 'unknown', model: 'shared' }] },
    textOnly: { strategy: 'priority', targets: [{ provider: 'text', model: 'shared' }, { provider: 'vision', model: 'shared', enabled: false }] },
    overrideOnly: { strategy: 'priority', targets: [{ provider: 'override', model: 'shared' }] },
  },
  composites: { combined: { route: 'combined', members: ['text', 'vision'], mode: 'union', strategy: 'priority' } },
}
const st = { get: (ns) => ns === 'llm-pi-ai' ? doc : undefined, writable: true }
const runtimeCtx = new Context()
new TypertRegistry(runtimeCtx)
const llm = new LlmRuntime(runtimeCtx)
llm.registerModelDiscovery('llm-pi-ai', async () => [])
const received = []
class Backend extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'shared', name: 'shared', inputModalities: provider === 'vision' ? ['text', 'image'] : ['text'] }] }
  async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: provider === 'vision' ? ['text', 'image'] : ['text'], context: { contextWindow: 100000 } } }
  async *stream(options) {
    received.push(options)
    yield { type: 'text-delta', index: 0, text: 'seen' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
llm.registerAdapter(['text', 'vision', 'unknown', 'override'], new Backend())
const routerCtx = { get: (name) => name === 'settings' ? st : name === 'llm' ? llm : undefined }
const router = api.makeRouterAdapter(routerCtx)
llm.registerAdapter(['router', 'composite'], router)

const listed = await llm.listModels('router')
assert.deepEqual(listed.find((model) => model.id === 'mixed').inputModalities, ['text', 'image'])
assert.equal(listed.find((model) => model.id === 'uncertain').inputModalities, undefined)
assert.deepEqual(listed.find((model) => model.id === 'textOnly').inputModalities, ['text'])
assert.deepEqual(listed.find((model) => model.id === 'overrideOnly').inputModalities, ['text'])
assert.deepEqual((await llm.resolveModelInfo('router', 'mixed')).inputModalities, ['text', 'image'])
assert.equal((await llm.resolveModelInfo('router', 'uncertain')).inputModalities, undefined)
assert.deepEqual((await llm.listModels('composite'))[0].inputModalities, ['text', 'image'])
assert.equal(llm.imageRequestPricing('router', 'mixed'), undefined)

const prepared = await llm.prepareCall({ provider: 'router', model: 'mixed' })
assert.deepEqual(prepared.inputModalities, ['text', 'image'])
const chunks = []
for await (const chunk of prepared.stream({ ...prepared.config, messages })) chunks.push(chunk)
assert.equal(received.length, 1)
assert.equal(received[0].provider, 'vision')
assert.equal(received[0].messages[0].content[1].type, 'image')
assert(chunks.some((chunk) => chunk.type === 'text-delta'))
assert.equal(chunks.at(-1).reason.kind, 'stop')
await assert.rejects(async () => { for await (const _chunk of router.stream({ provider: 'router', model: 'textOnly', messages })) {} }, /没有支持图片输入/)
console.log('PASS: actual SettingsForms capability-button identification, schema-default empty input, idempotence and catalog recovery; PiConfig / PiAiAdapter metadata and base64 conversion, exact wire-id capability, LlmRuntime virtual-route preparation and image dispatch')
