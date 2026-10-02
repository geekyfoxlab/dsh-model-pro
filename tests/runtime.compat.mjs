/**
 * 使用 Harness 自带的真实 Typert / SettingsForms / schema，配置写入仅在内存测试档案中发生。
 * DSH_RUNTIME_ROOT 指向运行时 dsh 目录；用 Electron Node 模式读取 asar 时需 --expose-internals。
 * 可选 MODEL_PRO_ACTUAL_PLUGIN 指向可解析运行时依赖的 dist/host.js，启用真实 Cordis 生命周期。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'

const root = process.env.DSH_RUNTIME_ROOT
if (!root) throw new Error('DSH_RUNTIME_ROOT must point at the bundled dsh directory')
const load = (name) => import(pathToFileURL(`${root}/node_modules/@deepseek-ai/${name}/lib/index.js`).href)
const [{ Context }, { TypertRegistry }, { SettingsForms }, { Config: PiConfig }] = await Promise.all([
  load('cordis'), load('dsh-typert-registry'), load('dsh-settings'), load('dsh-llm-pi-ai'),
])
const { default: z } = await import(pathToFileURL(`${root}/node_modules/@deepseek-ai/schemastery/lib/index.mjs`).href)
let code = readFileSync(process.env.MODEL_PRO_HOST_BUNDLE || new URL('../dist/host.js', import.meta.url), 'utf8')
code = code.replace(/^import .* from ["']@deepseek-ai\/[^"']+["'];?$/gm, '')
code = code.replace(/export\s*\{[\s\S]*?\};?\s*$/m, '')
const runtimes = []
const sandbox = { z, console, setTimeout, clearTimeout, AbortController, TextEncoder, TextDecoder, crypto: globalThis.crypto,
  TypertRemoteService: class { constructor(ctx) { this.ctx = ctx; runtimes.push(this) } },
}
const api = vm.runInNewContext(`(() => { ${code}; return { apply, Config: typeof Config === 'undefined' ? undefined : Config, TYPERT_MANIFEST }; })()`, sandbox)
const registry = new TypertRegistry(new Context())
if (process.env.EXPECT_INCOMPATIBLE === '1') {
  assert.throws(() => registry.register(api.TYPERT_MANIFEST), /strict codec has no create\(\) factory/)
  console.log('PASS: reproduced installed 1.1.8 failure with Harness 0.2.0-rc.2 Typert registry')
  process.exit(0)
}
registry.register(api.TYPERT_MANIFEST)
assert.equal(registry.local.list().length, 25)
for (const descriptor of api.TYPERT_MANIFEST.invocations) {
  assert.throws(() => descriptor.parameters[0].codec.create().parse([]))
  assert.throws(() => descriptor.result.create().parse({}))
}

// 实际 SettingsForms 执行 schema 投影、volatile 校验、合并及 revision 冲突检查。
const markedProvider = { api: 'openai-completions', baseURL: 'https://marked.invalid/v1', models: [{ id: 'marked-model' }], disabled: true }
const initial = { providers: {
  existing: { api: 'openai-completions', baseURL: 'https://existing.invalid/v1', apiKeyEnv: 'EXISTING_KEY', models: [{ id: 'original' }], headers: { 'X-Preserve': 'yes' } },
  'marked-at-start': markedProvider,
} }
const priorStats = { calls: 4, errors: 0, latencySum: 20, latencyN: 4, tokensIn: 8, tokensOut: 12 }
const pluginConfig = { state: { routeStats: {
  byTarget: { ['existing\u0000original']: priorStats }, byRoute: { 'prior-auto': priorStats }, health: {},
  logs: [{ ts: 1, route: 'prior-auto', target: { provider: 'existing', model: 'original' }, status: 'ok', tryIndex: 1, latencyMs: 5, tokens: { in: 2, out: 3 } }],
} } }
const entries = [
  { id: 'llm-pi-ai', options: { id: 'llm-pi-ai', config: structuredClone(initial) }, fiber: { uid: 1, state: 2, runtime: { Config: PiConfig }, config: PiConfig(initial), ctx: new Context() } },
  { id: 'dsh-model-pro', options: { id: 'dsh-model-pro', config: structuredClone(pluginConfig) }, fiber: { uid: 2, state: 2, runtime: { Config: api.Config }, config: api.Config(pluginConfig), ctx: new Context() } },
]
let actualRoot, actualFiber, actualModule
const st = Object.create(SettingsForms.prototype)
Object.assign(st, { revisions: new Map(), presentations: new Map(), ownerContext: {
  // 保留真实描述/写入时发出的同步文档事件，覆盖就绪逻辑的重入与串行约束。
  emit(...args) { actualRoot?.emit(...args) },
  configEditor: {
    entries: () => entries,
    configuration: () => entries.map((entry) => ({ entry, inherited: {}, override: entry.options.config })),
    async edit(entry, change) {
      const next = change(entry.options.config, {})
      entry.fiber.config = entry.fiber.runtime.Config(next)
      entry.options.config = next
    },
  },
} })
assert.equal(typeof st.get, 'undefined')
const before = JSON.stringify(st.describe().find((x) => x.ns === 'llm-pi-ai').value.providers.existing)
const secrets = new Map([['EXISTING_KEY', 'existing-test-secret']])
const cleanups = []
const ctx = { get(name) {
  if (name === 'settings') return st
  if (name === 'llm') return { listConfigurableProviders: () => [], registerAdapter: () => () => {}, listModels: async () => [] }
  if (name === 'credentials') return { resolve: async (ref) => ({ value: secrets.get(ref) }), set: async (ref, value) => secrets.set(ref, value), unset: async (ref) => secrets.delete(ref) }
}, typert: { register() { return () => {} } }, effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup }, on() { return () => {} } }
if (process.env.MODEL_PRO_ACTUAL_PLUGIN) {
  actualModule = await import(pathToFileURL(process.env.MODEL_PRO_ACTUAL_PLUGIN).href)
  actualRoot = new Context()
  new TypertRegistry(actualRoot)
  for (const name of ['settings', 'llm', 'credentials']) actualRoot.provide(name, ctx.get(name))
  // 使用实际 fiber.state；apply 期间 state=1 的自身表单不可读，不能以伪 state=2 掩盖就绪时序。
  actualFiber = actualRoot.plugin(actualModule, entries[1].options.config)
  entries[1].fiber = actualFiber
  await actualFiber
  assert(actualRoot.get('modelPro'), 'Actual plugin Remote service did not start')
} else api.apply(ctx)
const rpc = (method, args = {}) => (actualRoot ? actualRoot.get('modelPro') : runtimes.at(-1))[method](args)
const section = (ns) => st.describe().find((x) => x.ns === ns).value
await new Promise((resolve) => setTimeout(resolve, 5))
assert(!section('llm-pi-ai').providers['marked-at-start'], 'Marked provider was not parked after the own settings form became ready')
assert(section('dsh-model-pro').state.disabledProviders['marked-at-start'])
assert.equal((await rpc('getRouteStats')).byTarget['existing\u0000original'].calls, 4, 'Own-form readiness must rehydrate persisted stats')
assert((await rpc('listRequestLogs')).entries.some((entry) => entry.route === 'prior-auto'), 'Own-form readiness must rehydrate persisted logs')
let r = await rpc('listProviders')
assert.equal(r.providers.length, 2)
assert(r.providers.some((provider) => provider.route === 'existing' && !provider.disabled))
assert(r.providers.some((provider) => provider.route === 'marked-at-start' && provider.disabled))
r = await rpc('createProvider', { route: 'compat-test', api: 'openai-completions', baseURL: 'https://test.invalid/v1', displayName: 'Compatibility test' })
assert.equal(r.ok, true, r.error)
r = await rpc('updateField', { route: 'compat-test', field: 'displayName', value: 'Updated' })
assert.equal(r.ok, true, r.error)
r = await rpc('updateHeaders', { route: 'compat-test', headers: [{ name: 'X-Test', value: 'compat' }] })
assert.equal(r.ok, true, r.error)
r = await rpc('applyModels', { route: 'compat-test', mode: 'replace', models: [{ id: 'test-model', requestModel: 'wire-model' }] })
assert.equal(r.ok, true, r.error)
r = await rpc('setApiKey', { route: 'compat-test', apiKey: 'synthetic-test-key' })
assert.equal(r.ok, true, r.error)
assert.equal(secrets.get('DSH_COMPAT_TEST_API_KEY'), 'synthetic-test-key')
assert(!JSON.stringify(entries.map((x) => x.options.config)).includes('synthetic-test-key'))
r = await rpc('getProvider', { route: 'compat-test', includeSecret: true })
assert.equal(r.secret, 'synthetic-test-key')
for (const enabled of [false, true, false, true]) {
  r = await rpc('toggleProvider', { route: 'compat-test', enabled })
  assert.equal(r.ok, true, r.error)
  assert.equal(!!section('llm-pi-ai').providers['compat-test'], enabled)
  assert.equal(!!section('dsh-model-pro').state.disabledProviders['compat-test'], !enabled)
}
r = await rpc('setRoute', { alias: 'test-auto', strategy: 'priority', targets: [{ provider: 'compat-test', model: 'test-model' }] })
assert.equal(r.ok, true, r.error)
assert(section('dsh-model-pro').state.routes['test-auto'])
r = await rpc('setComposite', { name: 'test-composite', members: ['existing', 'compat-test'], mode: 'union' })
assert.equal(r.ok, true, r.error)
assert(section('dsh-model-pro').state.composites['test-composite'])
r = await rpc('setUiPrefs', { prefs: { showRouteBadge: false } })
assert.equal(r.ok, true, r.error)
assert.equal((await rpc('getUiPrefs')).prefs.showRouteBadge, false)

// 注入一次真实配置写入失败，确认启用中的供应商不丢失且禁用状态回滚。
const realMutate = st.mutate.bind(st)
let failOnce = true
st.mutate = async (ns, ...args) => {
  if (ns === 'llm-pi-ai' && failOnce) { failOnce = false; throw new Error('injected provider write failure') }
  return realMutate(ns, ...args)
}
r = await rpc('toggleProvider', { route: 'compat-test', enabled: false })
assert.equal(r.ok, false)
assert(section('llm-pi-ai').providers['compat-test'])
assert(!section('dsh-model-pro').state.disabledProviders['compat-test'])
st.mutate = realMutate
// 卸载时表单已撤下，仍还原完整供应商；重装后恢复禁用状态。
r = await rpc('toggleProvider', { route: 'compat-test', enabled: false })
assert.equal(r.ok, true, r.error)
if (actualFiber) await actualFiber.dispose()
else {
  entries[1].fiber.state = 3
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
}
assert(section('llm-pi-ai').providers['compat-test'])
assert.equal(section('llm-pi-ai').providers['compat-test'].headers['X-Test'], 'compat')
if (actualRoot) {
  actualFiber = actualRoot.plugin(actualModule, entries[1].options.config)
  entries[1].fiber = actualFiber
  await actualFiber
} else {
  entries[1].fiber.state = 2
  api.apply(ctx)
}
await new Promise((resolve) => setTimeout(resolve, 5))
assert(!section('llm-pi-ai').providers['compat-test'])
assert(section('dsh-model-pro').state.disabledProviders['compat-test'])
r = await rpc('toggleProvider', { route: 'compat-test', enabled: true })
assert.equal(r.ok, true, r.error)
r = await rpc('deleteProvider', { route: 'compat-test' })
assert.equal(r.ok, true, r.error)
assert(!section('llm-pi-ai').providers['compat-test'])
assert.equal(JSON.stringify(section('llm-pi-ai').providers.existing), before)
assert.equal(secrets.get('EXISTING_KEY'), 'existing-test-secret')
assert.deepEqual(Object.keys(section('llm-pi-ai')), ['providers'])
// 新版接口拒绝越界字段和过期 revision，本修复保留这些约束。
await assert.rejects(st.replace('llm-pi-ai', { disabledProviders: {} }), /not volatile/)
await assert.rejects(st.mutate('llm-pi-ai', [{ op: 'set', path: ['providers'], value: {} }], -1), /revision|conflict/i)
console.log('PASS: real Harness 0.2.0-rc.2 registry and SettingsForms; provider CRUD, headers, models, encryption, toggle, routing, composites, rollback, revision conflict and existing-data preservation')
