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
const [{ Context }, { TypertRegistry }, { LlmRuntime, LlmAdapter }, { Config: PiConfig, apply: applyPi }] = await Promise.all([
  load('cordis'), load('dsh-typert-registry'), load('dsh-llm'), load('dsh-llm-pi-ai'),
])
const { default: z } = await import(pathToFileURL(`${root}/node_modules/@deepseek-ai/schemastery/lib/index.mjs`).href)
const plain = (value) => JSON.parse(JSON.stringify(value))

let code = readFileSync(process.env.MODEL_PRO_HOST_BUNDLE || new URL('../dist/host.js', import.meta.url), 'utf8')
code = code.replace(/^import .* from ["']@deepseek-ai\/[^"']+["'];?$/gm, '')
code = code.replace(/export\s*\{[\s\S]*?\};?\s*$/m, '')
const api = vm.runInNewContext(`(() => { ${code}; return { makeRouterAdapter, resolveModelInput }; })()`, {
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
const rawProfile = { models: [{ id: 'gpt-4o' }] }
const modernSettings = { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { custom: { ...rawProfile, defaultInput: ['text'] } } }, user: { providers: { custom: rawProfile } } }] }
const modernCtx = { get: (name) => name === 'settings' ? modernSettings : name === 'llm' ? catalogService : undefined }
assert.deepEqual(plain(await api.resolveModelInput(modernCtx, 'custom', { id: 'gpt-4o' })), ['text', 'image'], 'Schema-generated text default must not suppress catalog detection')
rawProfile.defaultInput = ['text']
assert.deepEqual(plain(await api.resolveModelInput(modernCtx, 'custom', { id: 'gpt-4o' })), ['text'], 'Explicit provider default must be respected')
rawProfile.defaultInput = ['text', 'image']
assert.deepEqual(plain(await api.resolveModelInput(modernCtx, 'custom', { id: 'unlisted-model' })), ['text', 'image'])

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
console.log('PASS: actual PiConfig / PiAiAdapter image metadata and base64 conversion, exact wire-id capability, LlmRuntime virtual-route preparation, image-target dispatch and composite modalities')
