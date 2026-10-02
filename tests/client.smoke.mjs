/**
 * Client half structural smoke test (static-bundle mode).
 *
 * Loads the REAL built `dist/client.js`. In static-bundle mode that file is a
 * `window.__ModuleLoader__.load({ id, factory })` call; the factory receives a
 * synchronous `require` and returns the CJS module (exporting apply). We
 * provide `require` (React + externals), a minimal `document` for CSS
 * adoption, and a `ctx` whose `remote.$mount` + `reflect.get` expose a mocked
 * `modelPro` remote. The remote's methods return the Gateway envelope
 * `{ ok, value }` wrapping the business `{ ok, ... }` payload — exactly what
 * rpc.ts unwraps. Then renders the registered `settings.section` slot through
 * a tiny React renderer and asserts the redesigned dashboard constructs.
 *
 * Run: `npm test`  (build must be current: `npm run build`)
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_BUNDLE = path.join(__dirname, '..', 'dist', 'client.js')

// ---------------------------------------------------------------------------
// tiny React: createElement + function-component renderer with hooks
// (useState persists per instance; useEffect runs once per instance).
// ---------------------------------------------------------------------------
class FakeReact {
  constructor() {
    this.Fragment = Symbol('fragment')
    this.current = null
    this.instances = new Map()
    this.rerender = null
  }

  createElement(type, props, ...children) {
    const flat = []
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue
      if (Array.isArray(c)) flat.push(...c.flat(Infinity).filter(Boolean))
      else flat.push(c)
    }
    return { type, props: props || {}, children: flat }
  }

  useState(init) {
    const inst = this.current
    const i = inst.hookIdx++
    if (i >= inst.hooks.length) inst.hooks.push(typeof init === 'function' ? init() : init)
    const update = (v) => {
      inst.hooks[i] = typeof v === 'function' ? v(inst.hooks[i]) : v
      if (this.rerender) this.rerender()
    }
    return [inst.hooks[i], update]
  }

  useEffect(fn) {
    const inst = this.current
    if (!inst.effectsRun) inst.effects.push(fn)
  }

  useCallback(fn) {
    return fn
  }

  useMemo(fn) {
    return fn()
  }

  clone() {
    return Object.create(this)
  }
}

function renderAt(rootVNode, fake, path, out) {
  // Falsy children (&& patterns, ternaries) are legal React — skip them.
  if (!rootVNode || typeof rootVNode !== 'object' || typeof rootVNode.type === 'undefined') return
  const { type, props, children } = rootVNode
  if (type === fake.Fragment) {
    for (let i = 0; i < children.length; i++) renderAt(children[i], fake, `${path}:${i}`, out)
    return
  }
  if (typeof type === 'string') {
    // Keep form events and values too, so capability changes exercise the RPC.
    out.push({ tag: type, className: props?.className || '', text: collectText(children), onClick: props?.onClick, onChange: props?.onChange, props })
    for (let i = 0; i < children.length; i++) renderAt(children[i], fake, `${path}:${i}`, out)
    return
  }
  // function component
  const key = `${path}:${type.name || 'anon'}`
  let inst = fake.instances.get(key)
  if (!inst) { inst = { hooks: [], effects: [], effectsRun: false }; fake.instances.set(key, inst) }
  inst.hookIdx = 0
  const prev = fake.current
  fake.current = inst
  let rendered
  try {
    rendered = type(props)
  } finally {
    fake.current = prev
  }
  inst.effectsRun = true
  const pending = inst.effects.splice(0)
  for (const fn of pending) fn()
  if (rendered && typeof rendered === 'object' && 'type' in rendered) {
    renderAt(rendered, fake, `${key}`, out)
  }
}

function collectText(children) {
  let s = ''
  for (const c of children) {
    if (typeof c === 'string' || typeof c === 'number') s += String(c) + ' '
    else if (c && typeof c === 'object' && 'type' in c) {
      if (typeof c.type === 'string') s += collectText(c.children || [])
    }
  }
  return s.trim()
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`)
}

// ---------------------------------------------------------------------------
// injected client globals
// ---------------------------------------------------------------------------
const testProviders = [
  { route: 'deepseek', displayName: 'DeepSeek', declared: true, api: 'openai-completions', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DS_KEY', disabled: false, hasHeaders: true, headerCount: 1, modelCount: 2, usesCatalog: false },
  { route: 'my-gw', displayName: 'My Gateway', declared: true, api: 'anthropic-messages', baseURL: 'https://gw.example.com/v1', apiKeyEnv: '', disabled: true, hasHeaders: false, headerCount: 0, modelCount: 0, usesCatalog: true },
]

// ---------------------------------------------------------------------------
// mocked remote: camelCase methods returning the Gateway envelope
// { ok, value } wrapping the business { ok, ... } payload.
// ---------------------------------------------------------------------------
const uiPrefsState = { showRouteBadge: true }
let modelState = [
  { id: 'deepseek-chat', input: ['text'], requestModel: 'wire-chat' },
  { id: 'known-image-model', input: ['text', 'image'], capabilitySource: 'catalog' },
  { id: 'custom-vision-name' },
]
const discoveredState = [
  { id: 'remote-text', name: 'Remote text', input: ['text'] },
  { id: 'remote-image', name: 'Remote image', input: ['text', 'image'] },
  { id: 'unknown-vision', name: 'Unknown vision' },
]
const remoteCalls = []
let identifySummary = { image: 1, text: 1, unknown: 1, preserved: 1, updated: 1, catalogUnavailable: false }
let identifyError = ''
let providerRefreshError = ''
const businessFor = (method, payload) => {
  if (method === 'listProviders') return { ok: true, providers: testProviders, protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'], writable: true }
  if (method === 'listRoutes') return { ok: true, routes: { auto: { strategy: 'priority', targets: [{ provider: 'deepseek', model: 'deepseek-chat' }] } } }
  if (method === 'getProvider') return providerRefreshError
    ? { ok: false, error: providerRefreshError }
    : { ok: true, route: payload?.route || 'deepseek', models: modelState.map((m) => ({ ...m })), availableModels: [] }
  if (method === 'discoverModels') return { ok: true, models: discoveredState }
  if (method === 'applyModels') {
    // Identify has its own authoritative result; this client mock does not
    // repeat the host's catalog matching or preservation algorithm.
    if (payload.mode === 'identify') return identifyError
      ? { ok: false, error: identifyError }
      : { ok: true, count: modelState.length, ...(identifySummary ? { capabilitySummary: { ...identifySummary } } : {}) }
    const incoming = (payload.models || []).map((m) => {
      const entry = { ...m }
      if (entry.input === null) delete entry.input
      if (entry.requestModel === null) delete entry.requestModel
      return entry
    })
    if (payload.mode === 'replace') modelState = incoming
    else if (payload.mode === 'remove') modelState = modelState.filter((m) => !incoming.some((other) => other.id === m.id))
    else {
      const entries = new Map(modelState.map((m) => [m.id, m]))
      for (const m of incoming) entries.set(m.id, m)
      modelState = [...entries.values()]
    }
    return { ok: true, count: modelState.length }
  }
  if (method === 'listComposites') return { ok: true, composites: {} }
  if (method === 'getRouteStats') return {
    ok: true,
    byRoute: { 'auto': { calls: 12, errors: 1, latencySum: 4800, latencyN: 12, tokensIn: 100, tokensOut: 200 } },
    byTarget: { 'deepseek\u0000deepseek-chat': { calls: 12, errors: 1, latencySum: 4800, latencyN: 12, tokensIn: 100, tokensOut: 200 } },
    health: { 'deepseek\u0000deepseek-chat': { provider: 'deepseek', model: 'deepseek-chat', status: 'up', latencyMs: 400, consecutiveFails: 0, lastProbeAt: 1700000000000 } },
  }
  if (method === 'getUiPrefs') return { ok: true, prefs: { ...uiPrefsState } }
  if (method === 'setUiPrefs') { Object.assign(uiPrefsState, (payload && payload.prefs) || {}); return { ok: true, prefs: { ...uiPrefsState } } }
  if (method === 'listRequestLogs') return { ok: true, entries: [{ ts: 1700000000000, sessionId: 'sess-x', route: 'auto', target: { provider: 'deepseek', model: 'deepseek-chat' }, status: 'ok', tryIndex: 1, latencyMs: 400, tokens: { in: 100, out: 200 } }] }
  return { ok: true }
}

// The remote handle: one async method per camelCase RPC name.
const remoteMethods = [
  'listProviders', 'toggleProvider', 'getProvider', 'discoverModels', 'createProvider',
  'deleteProvider', 'updateField', 'updateHeaders', 'applyModels', 'testProvider',
  'setApiKey', 'listRoutes', 'setRoute', 'deleteRoute', 'listComposites', 'setComposite',
  'deleteComposite', 'previewComposite', 'getRouteStats', 'listRequestLogs',
  'clearRequestLogs', 'probeTarget', 'probeAll', 'getUiPrefs', 'setUiPrefs',
]
const remoteHandle = {}
for (const m of remoteMethods) {
  remoteHandle[m] = async (payload) => {
    remoteCalls.push({ method: m, payload: payload && JSON.parse(JSON.stringify(payload)) })
    return { ok: true, value: businessFor(m, payload) }
  }
}

const structures = []
const fake = new FakeReact()
const slotsByName = new Map()
let registeredLocale = null
const translatedKeys = new Set(['statusCapabilities', 'statusCapabilitiesCurrent', 'capabilitiesUnconfirmed', 'capabilityCatalogUnavailable', 'inputCapabilityHint'])

const ctx = {
  get: (name) => {
    if (name === 'locale') return {
      register: (_ns, dictionaries) => { registeredLocale = dictionaries },
      // Use the real registered English copy for count/status assertions;
      // other keys stay stable for existing structural and event selectors.
      bind: () => (k) => (k === 'badgeRoutePrefix' ? '路由' : translatedKeys.has(k) ? registeredLocale?.en?.[k] || k : k),
    }
    if (name === 'slots') return {
      inject: (slotName, fn) => fn(),
      // Multiple slots coexist (settings page + conversation turnTail badge).
      register: (meta, render) => { slotsByName.set(meta.name, { label: meta, render }); return { id: meta.id } },
    }
    return undefined
  },
  // API Gateway remote surface used by the static-bundle client.
  remote: { $mount: async () => () => {} },
  reflect: { get: (key) => (key === 'remote.modelPro' ? remoteHandle : undefined) },
  effect: (fn) => { const c = fn(); if (typeof c === 'function') c(); return c },
}

// document shim for adoptStyles() (the client injects a <style> element).
const documentShim = {
  getElementById: () => null,
  createElement: () => ({ set textContent(v) { structures.push(v) }, get textContent() { return '' } }),
  head: { appendChild: () => {} },
}

// Synchronous require the __ModuleLoader__ factory expects.
const requireShim = (spec) => {
  if (spec === 'react') return fake
  if (spec === 'react-dom' || spec === 'react/jsx-runtime') return {}
  throw new Error(`client smoke: unexpected require(${spec})`)
}

const sandbox = {
  console,
  Promise,
  setTimeout,
  clearTimeout,
  Date,
  document: documentShim,
  window: {},
}
sandbox.globalThis = sandbox
// The factory registers itself here; capture it.
let captured = null
sandbox.window.__ModuleLoader__ = {
  load: ({ id, factory }) => { captured = { id, factory } },
}

const code = readFileSync(CLIENT_BUNDLE, 'utf8')
vm.runInContext(code, vm.createContext(sandbox), { filename: 'model-pro-client.js' })
assert(captured && captured.id === 'dsh-model-pro', 'client bundle registered under its package id')
const moduleExports = captured.factory(requireShim)
const plugin = moduleExports.apply ? moduleExports : moduleExports.default
const badgeMod = moduleExports
plugin.apply(ctx)

const settingsSlot = slotsByName.get('settings.section')
const badgeSlot = slotsByName.get('conversation.chat.turnTail')
assert(settingsSlot && typeof settingsSlot.render === 'function', 'settings.section slot rendered')
assert(settingsSlot.label && typeof settingsSlot.label.label === 'function', 'slot label registered')
assert(badgeSlot && typeof badgeSlot.render === 'function' && typeof badgeSlot.label.select === 'function', 'turnTail badge slot registered with a select')

// let the async remote $mount effect resolve so `remote` is wired before the
// dashboard's first refresh() fires (the client mounts the remote in an async
// effect; reflect.get is synchronous but the await yields a microtask).
await new Promise((r) => setTimeout(r, 10))

// render the dashboard; allow the async refresh() to settle (the fake remote
// call resolves on a macrotask, not just the microtask queue)
const out = []
fake.rerender = () => {}
let tree = settingsSlot.render()
renderAt(tree, fake, 'root', out)
await new Promise((r) => setTimeout(r, 10))
renderAt(tree, fake, 'root', out)
await new Promise((r) => setTimeout(r, 10))

const allClassNames = new Set(out.map((n) => n.className).filter(Boolean))
const all = out.map((n) => n.className)

// -- structure assertions on the REBUILT bundle --
const css = structures.join('\n')
for (const rule of ['.mpro-root', '.mpro-segs', '.mpro-pc', '.mpro-pcActive', '.mpro-pcOff', '.mpro-pill', '.mpro-pillActive', '.mpro-pillOff', '.mpro-verdictOk', '.mpro-discoverBar', '.mpro-step', '.mpro-setupCard', '.mpro-routesTab', '.mpro-statCard', '.mpro-hdotUp', '.mpro-routeRow', '.mpro-targetRow']) {
  assert(css.includes(rule), `styles include ${rule}`)
}

// -- i18n safety copy present in bundle (esbuild escapes non-ASCII as \uXXXX
// with UPPERCASE hex; match raw and escaped forms case-insensitively) --
assert(code.includes('卸载') || /\\u5378\\u8f7d/i.test(code), 'bundle carries uninstall-safety copy')
assert(code.includes('测试') || /\\u6d4b\\u8bd5/i.test(code), 'bundle carries test-model copy')

const rendered = JSON.stringify(out)
assert(rendered.includes('mpro-root'), 'renders mpro-root')
assert(all.some((c) => c.includes('mpro-segs')), 'renders segment bar')
assert(all.includes('mpro-pc'), 'renders enabled rail card (plain .mpro-pc)')
assert(all.some((c) => c.includes('mpro-pcOff')), 'renders disabled rail card')
assert(all.some((c) => c.includes('mpro-pillOff')), 'renders disabled pill')
assert(out.some((n) => n.tag === 'button' && /test|测试/i.test(n.text)), 'renders a Test action')

// -- smart-routing page: switch to the routes tab and assert the redesigned UI --
const routesTab = out.find((n) => n.tag === 'button' && /tabRoutes/i.test(n.text || ''))
assert(routesTab && typeof routesTab.onClick === 'function', 'smart-routing tab button present')
routesTab.onClick()
const outR = []
renderAt(tree, fake, 'root', outR)
await new Promise((r) => setTimeout(r, 10))
renderAt(tree, fake, 'root', outR)
assert(outR.some((n) => String(n.className).includes('mpro-routesTabs')), 'renders the 4-tab smart-routing shell')
assert(outR.some((n) => String(n.className).includes('mpro-routesRoot')), 'renders routes root')
assert(outR.some((n) => String(n.className).includes('mpro-routeRow')), 'renders a route row from list-routes')
assert(outR.some((n) => /tabComposites/i.test(n.text || '')), 'renders composite-tab button')
assert(outR.some((n) => /tabObservability/i.test(n.text || '')), 'renders observability-tab button')
assert(outR.some((n) => /tabProbe/i.test(n.text || '')), 'renders probe-tab button')

// -- observability tab renders stat cards + request-log table area --
const obsTab = outR.find((n) => n.tag === 'button' && /tabObservability/i.test(n.text || ''))
assert(obsTab && typeof obsTab.onClick === 'function', 'observability tab clickable')
obsTab.onClick()
const outO = []
renderAt(tree, fake, 'root', outO)
await new Promise((r) => setTimeout(r, 10))
renderAt(tree, fake, 'root', outO)
assert(outO.some((n) => String(n.className).includes('mpro-statCard')), 'observability renders stat cards')
assert(outO.some((n) => String(n.className).includes('mpro-tblWrap')), 'observability renders tables')
assert(outO.some((n) => String(n.className).includes('mpro-logOk') || String(n.className).includes('mpro-logErr')), 'request-log status styling present')

// -- probe tab renders target health rows with status dots --
const probeTab = outO.find((n) => n.tag === 'button' && /tabProbe/i.test(n.text || ''))
assert(probeTab && typeof probeTab.onClick === 'function', 'probe tab clickable')
probeTab.onClick()
const outP = []
renderAt(tree, fake, 'root', outP)
await new Promise((r) => setTimeout(r, 10))
renderAt(tree, fake, 'root', outP)
assert(outP.some((n) => String(n.className).includes('mpro-hdotUp')), 'probe tab renders health dots')
assert(outP.some((n) => /probeProbe/i.test(n.text || '')), 'probe tab renders per-target probe buttons')

// -- models tab: search inputs, custom-model add form, current-list bulk ops --
// back to the providers dashboard first
const provTab = outP.find((n) => n.tag === 'button' && /tabProviders/i.test(n.text || ''))
assert(provTab && typeof provTab.onClick === 'function', 'providers tab clickable')
provTab.onClick()
const outD = []
renderAt(tree, fake, 'root', outD)
await new Promise((r) => setTimeout(r, 10))
renderAt(tree, fake, 'root', outD)
// open the editor for the first provider card
const editBtn = outD.find((n) => n.tag === 'button' && /^edit$/i.test((n.text || '').trim()))
assert(editBtn && typeof editBtn.onClick === 'function', 'provider card Edit button present')
editBtn.onClick()
const outE = []
renderAt(tree, fake, 'root', outE)
await new Promise((r) => setTimeout(r, 10))
renderAt(tree, fake, 'root', outE)
// switch to the Models tab
const modelsTab = outE.find((n) => n.tag === 'button' && /tabModels/i.test(n.text || ''))
assert(modelsTab && typeof modelsTab.onClick === 'function', 'models tab clickable')
modelsTab.onClick()
const outM = []
renderAt(tree, fake, 'root', outM)
await new Promise((r) => setTimeout(r, 10))
renderAt(tree, fake, 'root', outM)
const searchInputs = outM.filter((n) => n.tag === 'input' && String(n.className).includes('mpro-searchInput'))
assert(searchInputs.length >= 1, `models tab renders search input(s), got ${searchInputs.length}`)
assert(outM.some((n) => n.tag === 'button' && /^selectAll$/i.test((n.text || '').trim())), 'current list renders select-all')
const renderModels = () => {
  const nodes = []
  renderAt(tree, fake, 'root', nodes)
  return nodes
}
const settle = () => new Promise((r) => setTimeout(r, 10))
const formControl = (nodes, tag, label) => nodes.find((n) => n.tag === tag && n.props?.['aria-label'] === label)
const buttonByText = (nodes, text) => nodes.find((n) => n.tag === 'button' && n.text === text)
const lastApply = () => remoteCalls.filter((c) => c.method === 'applyModels').at(-1)
let modelNodes = renderModels()
assert(modelNodes.some((n) => n.tag === 'span' && n.text === 'inputTextOnly'), 'known text models have a text-only badge')
assert(modelNodes.some((n) => n.tag === 'span' && n.text === 'inputTextImage'), 'known image models have an image-capability badge')
assert(modelNodes.some((n) => n.tag === 'span' && n.text === 'inputUnknown'), 'missing capability is unconfirmed, not text-only')
assert(formControl(modelNodes, 'select', 'inputCapabilityCol: custom-vision-name')?.props.value === 'auto', 'vision-like names without metadata stay automatic/unconfirmed')

// Manual capability is carried in the saved model, and automatic reset has an
// explicit null rather than disappearing during JSON serialization.
formControl(modelNodes, 'select', 'inputCapabilityCol: custom-vision-name').onChange({ target: { value: 'image' } })
formControl(modelNodes, 'select', 'inputCapabilityCol: known-image-model').onChange({ target: { value: 'text' } })
modelNodes = renderModels()
assert(buttonByText(modelNodes, 'identifyCapabilities').props.disabled && buttonByText(modelNodes, 'identifyCapabilities').props.title === 'saveModelConfigFirst', 'capability backfill waits for unsaved manual choices')
buttonByText(modelNodes, 'saveModelConfig').onClick()
await settle()
assert(JSON.stringify(lastApply().payload.models.find((m) => m.id === 'custom-vision-name').input) === JSON.stringify(['text', 'image']), 'manual image support is sent to apply-models')
assert(JSON.stringify(lastApply().payload.models.find((m) => m.id === 'known-image-model').input) === JSON.stringify(['text']), 'manual text-only support is sent to apply-models')
assert(!Object.hasOwn(lastApply().payload.models.find((m) => m.id === 'known-image-model'), 'capabilitySource'), 'manual capability edits do not retain automatic detection source')
modelNodes = renderModels()
formControl(modelNodes, 'select', 'inputCapabilityCol: custom-vision-name').onChange({ target: { value: 'auto' } })
modelNodes = renderModels()
buttonByText(modelNodes, 'saveModelConfig').onClick()
await settle()
assert(lastApply().payload.models.find((m) => m.id === 'custom-vision-name').input === null, 'automatic reset sends input:null')

// Clearing the last wire mapping must leave a reachable save action.
modelNodes = renderModels()
formControl(modelNodes, 'input', 'reqModelField: deepseek-chat').onChange({ target: { value: '' } })
modelNodes = renderModels()
assert(buttonByText(modelNodes, 'saveModelConfig'), 'save action remains available after clearing the last mapping')
assert(buttonByText(modelNodes, 'identifyCapabilities').props.disabled, 'capability backfill waits for an unsaved mapping change')
buttonByText(modelNodes, 'saveModelConfig').onClick()
await settle()
assert(lastApply().payload.models.find((m) => m.id === 'deepseek-chat').requestModel === null, 'clearing a mapping sends requestModel:null')

// Identification sends only IDs so displayed/inferred capabilities cannot be
// mistaken for manual choices. Counts come from the authoritative host result.
modelState = modelState.map((m) => m.id === 'known-image-model' ? { ...m, input: ['text', 'image'] } : m)
modelNodes = renderModels()
buttonByText(modelNodes, 'identifyCapabilities').onClick()
assert(buttonByText(renderModels(), 'identifyCapabilities').props.disabled, 'identify button is disabled while the request is in flight')
await settle()
assert(lastApply().payload.mode === 'identify' && lastApply().payload.models.length === 3, 'detect-and-save invokes the dedicated identify mode')
assert(lastApply().payload.route === 'deepseek' && lastApply().payload.models.every((m) => Object.keys(m).length === 1 && typeof m.id === 'string'), 'identify payload contains only the current model IDs')
modelNodes = renderModels()
const inlineStatus = (nodes) => nodes.find((n) => n.className.includes('mpro-inlineStatus'))
assert(inlineStatus(modelNodes)?.text.includes('1 text + image, 1 text only, 1 unconfirmed') && inlineStatus(modelNodes).text.includes('Kept 1 existing settings; updated 1 models'), 'identify reports image, text, unknown, preserved and updated counts')
assert(inlineStatus(modelNodes).text.includes('Set unconfirmed input capabilities manually'), 'unknown models receive a manual-setting explanation')
assert(!buttonByText(modelNodes, 'identifyCapabilities').props.disabled, 'identify button restores enabled state after success')
assert(modelNodes.some((n) => n.text.includes('does not send an image test request')), 'catalog identification is distinguished from a real image test')

// A successful write with zero recognized models must describe that outcome.
identifySummary = { image: 0, text: 0, unknown: 3, preserved: 0, updated: 0, catalogUnavailable: false }
modelState = modelState.map(({ input: _input, ...m }) => m)
buttonByText(modelNodes, 'identifyCapabilities').onClick()
await settle()
modelNodes = renderModels()
assert(inlineStatus(modelNodes)?.text.includes('0 text + image, 0 text only, 3 unconfirmed') && inlineStatus(modelNodes).text.includes('updated 0 models'), 'all-unknown zero-update outcome is visible rather than a generic total model count')

identifySummary = { ...identifySummary, catalogUnavailable: true }
buttonByText(modelNodes, 'identifyCapabilities').onClick()
await settle()
modelNodes = renderModels()
assert(inlineStatus(modelNodes)?.className.includes('mpro-inlineStatusErr') && inlineStatus(modelNodes).text.includes('temporarily unavailable. Try again later'), 'unavailable catalog shows a visible retry message')
assert(!buttonByText(modelNodes, 'identifyCapabilities').props.disabled, 'catalog failure does not leave the button busy')

// RPC failures must remain visible on the editor, whose parent dashboard is
// replaced while selected. This reproduced the previously silent failure.
identifyError = 'simulated identification failure'
buttonByText(modelNodes, 'identifyCapabilities').onClick()
await settle()
modelNodes = renderModels()
assert(inlineStatus(modelNodes)?.className.includes('mpro-inlineStatusErr') && inlineStatus(modelNodes).text.includes(identifyError), 'identify business error is displayed in the current editor')
assert(!buttonByText(modelNodes, 'identifyCapabilities').props.disabled, 'identify button restores enabled state after business failure')
identifyError = ''

providerRefreshError = 'simulated model refresh failure'
buttonByText(modelNodes, 'identifyCapabilities').onClick()
await settle()
modelNodes = renderModels()
assert(inlineStatus(modelNodes)?.className.includes('mpro-inlineStatusErr') && inlineStatus(modelNodes).text.includes(providerRefreshError), 'refresh failure replaces summary with a visible editor error')
assert(!buttonByText(modelNodes, 'identifyCapabilities').props.disabled, 'refresh failure does not leave the button busy')
providerRefreshError = ''

// Hosts without an identification summary can still show the freshly read
// current capabilities, without inventing update counts or a live-test verdict.
identifySummary = null
modelState = modelState.map((m) => m.id === 'deepseek-chat' ? { ...m, input: ['text'] } : m.id === 'known-image-model' ? { ...m, input: ['text', 'image'] } : m)
buttonByText(modelNodes, 'identifyCapabilities').onClick()
await settle()
modelNodes = renderModels()
assert(inlineStatus(modelNodes)?.text.includes('Current list: 1 text + image, 1 text only, 1 unconfirmed') && !inlineStatus(modelNodes).text.includes('updated'), 'legacy response falls back to refreshed capability counts without claiming updates')

// Remote badges also preserve the distinction between absent metadata and text.
modelNodes = renderModels()
buttonByText(modelNodes, 'discover').onClick()
await settle()
modelNodes = renderModels()
const remoteUnknown = modelNodes.find((n) => n.tag === 'tr' && n.text.includes('unknown-vision'))
assert(remoteUnknown?.text.includes('inputUnknown') && !remoteUnknown.text.includes('inputTextOnly'), 'discovery does not infer capability from a vision-like name')
assert(modelNodes.some((n) => n.tag === 'tr' && n.text.includes('remote-image') && n.text.includes('inputTextImage')), 'discovery displays known image capability')
// open the add-model form and assert its fields + submit button render
const addToggle = outM.find((n) => n.tag === 'button' && /addModelToggle|addModelHide/i.test(n.text || ''))
assert(addToggle && typeof addToggle.onClick === 'function', 'custom-model add toggle present')
addToggle.onClick()
const outA = []
renderAt(tree, fake, 'root', outA)
await new Promise((r) => setTimeout(r, 10))
renderAt(tree, fake, 'root', outA)
assert(outA.some((n) => String(n.className).includes('mpro-addBar')), 'add-model form panel renders')
assert(outA.some((n) => n.tag === 'button' && /addModelBtn/i.test(n.text || '')), 'add-model submit button renders')
modelNodes = renderModels()
const newCapability = formControl(modelNodes, 'select', 'addModelInputLabel')
assert(newCapability?.props.value === 'auto', 'custom model capability defaults to automatic detection')
const newId = modelNodes.find((n) => n.tag === 'input' && n.props?.placeholder === 'addModelIdPlaceholder')
newId.onChange({ target: { value: 'my-custom-model' } })
newCapability.onChange({ target: { value: 'image' } })
modelNodes = renderModels()
buttonByText(modelNodes, 'addModelBtn').onClick()
await settle()
assert(lastApply().payload.models[0].id === 'my-custom-model' && JSON.stringify(lastApply().payload.models[0].input) === JSON.stringify(['text', 'image']), 'custom model add saves manual image capability')
modelNodes = renderModels()
modelNodes.find((n) => n.tag === 'input' && n.props?.placeholder === 'addModelIdPlaceholder').onChange({ target: { value: 'automatic-custom-model' } })
modelNodes = renderModels()
buttonByText(modelNodes, 'addModelBtn').onClick()
await settle()
assert(!Object.hasOwn(lastApply().payload.models[0], 'input'), 'custom model add with automatic detection omits input rather than resetting it')

// -- conversation badge (turnTail): select + render pipeline --
{
  const sel = badgeSlot.label.select({ turn: { turn: 7, start: { time: 1700000000000 - 5000 }, end: { time: 1700000000000 } }, seq: 42 })
  assert(sel && typeof sel.from === 'number' && typeof sel.to === 'number' && sel.from < 1700000000000 && sel.to >= 1700000000000, 'badge select derives the turn window: ' + JSON.stringify(sel))
  assert(badgeSlot.label.select({}) === null, 'badge select declines turns without boundaries')
  assert(badgeSlot.label.select(null) === null, 'badge select declines a missing owner')

  // positive render: the mocked log entry (sessionId sess-x) sits inside sel.
  const badgeOut = []
  fake.rerender = () => {}
  let btree = badgeSlot.render({ matched: sel, sessionId: 'sess-x' })
  renderAt(btree, fake, 'badge', badgeOut)
  await new Promise((r) => setTimeout(r, 10))
  btree = badgeSlot.render({ matched: sel, sessionId: 'sess-x' })
  renderAt(btree, fake, 'badge', badgeOut)
  await new Promise((r) => setTimeout(r, 10))
  assert(badgeOut.some((n) => String(n.className).includes('mpro-badgeRow')), 'badge row renders for a routed turn')
  assert(badgeOut.some((n) => (n.text || '') === '路由'), 'badge renders the TRANSLATED label, not the raw dictionary key')
  assert(badgeOut.some((n) => String(n.className).includes('mpro-badgeChip') && /deepseek-chat/.test(n.text || '')), 'badge names the serving target: ' + JSON.stringify(badgeOut.filter((n) => String(n.className).includes('mpro-badge')).map((n) => n.text)))

  // a turn outside the window renders nothing
  const far = { from: sel.to + 60_000, to: sel.to + 120_000 }
  const badgeOut2 = []
  let btree2 = badgeSlot.render({ matched: far, sessionId: 'sess-x' })
  renderAt(btree2, fake, 'badgeFar', badgeOut2)
  await new Promise((r) => setTimeout(r, 10))
  btree2 = badgeSlot.render({ matched: far, sessionId: 'sess-x' })
  renderAt(btree2, fake, 'badgeFar', badgeOut2)
  await new Promise((r) => setTimeout(r, 10))
  assert(!badgeOut2.some((n) => String(n.className).includes('mpro-badgeRow')), 'badge stays hidden for turns the router did not serve')

  // -- precise per-turn attribution: the window must end at the NEXT turn's
  // start, never overlap it. Overlapping ±slack windows were the cause of
  // "有时候有有时候没有" (adjacent turns stealing/dropping each others' logs). --
  assert(typeof sel.turn === 'number', 'badge select carries the turn number for precise correlation')

  // turnTimings: turn 1 starts at T, turn 2 starts at T+30s.
  const T = 1700000000000
  const timings = new Map([
    [1, { startTime: T, endTime: T + 20_000 }],
    [2, { startTime: T + 30_000, endTime: T + 50_000 }],
  ])
  const snap = { chat: { turnTimings: timings } }
  const useSession = (fn) => fn(snap)

  const k1 = badgeMod.preciseWindowKey(snap, 1)
  const [f1, t1] = k1.split('|').map(Number)
  assert(t1 === T + 30_000, `turn 1 window ends exactly at turn 2 start, got ${t1 - T}ms offset`)
  assert(f1 === T - 1_000, `turn 1 window starts at its own start (small lead-in), got ${f1 - T}`)

  const k2 = badgeMod.preciseWindowKey(snap, 2)
  const [f2, t2b] = k2.split('|').map(Number)
  assert(f2 === T + 29_000, 'turn 2 window starts at its own start')
  assert(t2b > T + 50_000, 'latest turn keeps an open-ended window so late logs still land')
  assert(f2 >= t1 - 1_000, 'adjacent turn windows do not overlap materially')

  // The REAL DSH source is snapshot.chat.timeline.turns (turn objects with
  // start:{time}), not a turnTimings map — reading only the map was why the
  // precise window silently fell back to the coarse ±slack window on the live
  // build. This asserts the timeline.turns path works identically.
  const turnsMap = new Map([
    [1, { turn: 1, start: { time: T }, end: { time: T + 20_000 }, status: 'closed' }],
    [2, { turn: 2, start: { time: T + 30_000 }, status: 'open' }],
  ])
  const snapTimeline = { chat: { timeline: { turns: turnsMap } } }
  const kt1 = badgeMod.preciseWindowKey(snapTimeline, 1)
  const [ft1, tt1] = kt1.split('|').map(Number)
  assert(tt1 === T + 30_000 && ft1 === T - 1_000, 'timeline.turns path yields the same precise window as turnTimings: ' + kt1)
  // legacy.turnTimings path too.
  const snapLegacy = { chat: { legacy: { turnTimings: timings } } }
  assert(badgeMod.preciseWindowKey(snapLegacy, 1) === k1, 'legacy.turnTimings path yields the same precise window')

  assert(badgeMod.preciseWindowKey({}, 1) === '', 'precise window declines a snapshot without any timing source (falls back)')
  assert(badgeMod.preciseWindowKey(snap, 99) === '', 'precise window declines an unknown turn')
  assert(badgeMod.preciseWindowKey(null, 1) === '', 'precise window is throw-free on a missing snapshot')

  // The component must PREFER the precise window over the coarse `matched`:
  // the mocked log entry sits inside sel, but we pass a precise timeline that
  // places this turn's window far away — the badge must then stay hidden.
  const badgeOut3 = []
  const farTimings = new Map([[sel.turn, { startTime: T + 600_000 }], [sel.turn + 1, { startTime: T + 700_000 }]])
  const farUseSession = (fn) => fn({ chat: { turnTimings: farTimings } })
  let btree3 = badgeSlot.render({ matched: sel, sessionId: 'sess-x', useSession: farUseSession })
  renderAt(btree3, fake, 'badgePrecise', badgeOut3)
  await new Promise((r) => setTimeout(r, 10))
  btree3 = badgeSlot.render({ matched: sel, sessionId: 'sess-x', useSession: farUseSession })
  renderAt(btree3, fake, 'badgePrecise', badgeOut3)
  await new Promise((r) => setTimeout(r, 10))
  assert(!badgeOut3.some((n) => String(n.className).includes('mpro-badgeRow')),
    'precise timeline window overrides the coarse window (no cross-turn attribution)')

  // ...and with a precise window that DOES contain the entry, it renders again.
  const badgeOut4 = []
  const nearTimings = new Map([[sel.turn, { startTime: sel.from + 4_000 }]])
  const nearUseSession = (fn) => fn({ chat: { turnTimings: nearTimings } })
  let btree4 = badgeSlot.render({ matched: sel, sessionId: 'sess-x', useSession: nearUseSession })
  renderAt(btree4, fake, 'badgeNear', badgeOut4)
  await new Promise((r) => setTimeout(r, 10))
  btree4 = badgeSlot.render({ matched: sel, sessionId: 'sess-x', useSession: nearUseSession })
  renderAt(btree4, fake, 'badgeNear', badgeOut4)
  await new Promise((r) => setTimeout(r, 10))
  assert(badgeOut4.some((n) => String(n.className).includes('mpro-badgeRow')),
    'badge renders when the precise window contains the routed call')
}

console.log('PASS: client structural smoke — slot registered and redesigned dashboard rendered')
console.log('  nodes:', out.length, '| classes seen:', [...allClassNames].filter((c) => c.includes('mpro-')).slice(0, 8).join(', '))
