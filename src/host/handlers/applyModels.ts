/** 模型能力保存原生 input；人工与自动来源另存插件状态，允许显式复核旧配置。 */
import { NS } from '../../shared/constants'
import type { HostCtx, SettingsService } from '../utils'
import { readProviders, readDisabled, readProfile, checkWritable, writeSection } from '../utils'
import type { ModelEntry, ModelCapabilitySummary } from '../../shared/types'
import { normalizeModelInput, describeModelInput, detectModelInputs } from '../modelCapabilities'
import { readCapabilityState, capabilityRecord, capabilityWireId, stateForCapabilities, saveCapabilities, withCapabilityWrite, type CapabilityRecord } from '../capabilityStore'

type ApplyMode = 'replace' | 'merge' | 'remove' | 'identify'
interface ApplyArgs { route?: string; models?: unknown[]; mode?: string; recheckLegacy?: boolean }
const toEntry = (m: unknown): ModelEntry => m && typeof m === 'object' && !Array.isArray(m) ? { ...m } as ModelEntry : { id: String(m) }
const sameInput = (a: unknown, b: unknown): boolean => normalizeModelInput(a)?.join() === normalizeModelInput(b)?.join()
const stripDisplay = (entry: ModelEntry): ModelEntry => {
  const out = { ...entry }
  delete out.capabilitySource; delete out.capabilityConflict; delete out.capabilityReference
  delete out.inputMode; delete out.inputModalities
  return out
}

function checkedPatch(raw: unknown): ModelEntry {
  const patch = toEntry(raw)
  if (typeof patch.id !== 'string' || !patch.id.trim()) throw new Error('模型 ID 必须是非空字符串')
  const empty = Array.isArray(patch.input) && patch.input.length === 0
  if (patch.input != null && !empty && !normalizeModelInput(patch.input)) throw new Error('输入能力只支持 text / image 列表')
  if (patch.requestModel != null && typeof patch.requestModel !== 'string') throw new Error('转发名必须是字符串')
  if (patch.inputMode !== undefined && patch.inputMode !== 'manual' && patch.inputMode !== 'auto') throw new Error('能力设置模式必须是 manual / auto')
  if (patch.inputMode === 'manual' && !normalizeModelInput(patch.input)) throw new Error('手工能力设置必须包含有效的 input')
  return patch
}

export async function applyModels(ctx: HostCtx, args: ApplyArgs) {
  const st = ctx.get('settings')
  if (!st) return { ok: false as const, error: 'settings 服务不可用' }
  if (!checkWritable(st)) return { ok: false as const, error: '设置只读' }
  return withCapabilityWrite(st, () => applyModelsLocked(ctx, st, args))
}

async function applyModelsLocked(ctx: HostCtx, st: SettingsService, args: ApplyArgs) {
  const route = args?.route
  if (!route) return { ok: false as const, error: '缺少 route' }
  if (!Array.isArray(args.models)) return { ok: false as const, error: 'models 必须是数组' }
  const mode = (args.mode || 'merge') as ApplyMode
  if (!['replace', 'merge', 'remove', 'identify'].includes(mode)) return { ok: false as const, error: `未知 mode: ${mode}` }
  const p = readProfile(readProviders(st), route) ?? readProfile(readDisabled(st), route)
  if (!p) return { ok: false as const, error: `提供商 "${route}" 不存在` }
  const existing = Array.isArray(p.models) ? p.models.map(toEntry) : []
  const state = readCapabilityState(st)
  const profileSnapshot = JSON.stringify([p.api, p.baseURL, p.models])
  const sourceSnapshot = JSON.stringify(state[route] ?? null)
  const unchanged = (expectedSource = sourceSnapshot) => {
    const fresh = readProfile(readProviders(st), route) ?? readProfile(readDisabled(st), route)
    if (!fresh || JSON.stringify([fresh.api, fresh.baseURL, fresh.models]) !== profileSnapshot || JSON.stringify(readCapabilityState(st)[route] ?? null) !== expectedSource) {
      throw new Error('模型列表或能力来源已变化，请刷新后重新识别')
    }
  }
  let next: ModelEntry[]
  const records: Record<string, CapabilityRecord> = Object.create(null)
  let capabilitySummary: ModelCapabilitySummary | undefined
  try {
    const patches = args.models.map(checkedPatch)
    if (mode === 'identify') {
      const ids = new Set(patches.map((m) => m.id))
      const selected = existing.filter((entry) => ids.has(entry.id))
      if (selected.length !== ids.size) throw new Error('模型列表已变化，请刷新后重新识别')
      const canRecheck = (entry: ModelEntry) => {
        const saved = capabilityRecord(state, route, p, entry)
        return saved?.source !== 'manual' && (args.recheckLegacy === true || !!saved || !normalizeModelInput(entry.input))
      }
      const candidates = selected.filter(canRecheck)
      const detected = await detectModelInputs(ctx, route, candidates)
      capabilitySummary = { image: 0, text: 0, unknown: 0, preserved: 0, updated: 0, rechecked: candidates.length, conflicts: 0, catalogUnavailable: detected.catalogUnavailable }
      const sum = capabilitySummary
      next = existing.map((entry) => {
        const saved = capabilityRecord(state, route, p, entry)
        if (saved) records[entry.id] = saved
        if (!ids.has(entry.id)) return stripDisplay(entry)
        const detection = detected.results.get(entry.id)
        if (detection?.conflict) sum.conflicts++
        const configured = normalizeModelInput(entry.input)
        const input = canRecheck(entry) ? detection?.input ?? configured : configured
        if (!canRecheck(entry) || (!detection?.input && configured)) sum.preserved++
        if (input?.includes('image')) sum.image++
        else if (input?.includes('text')) sum.text++
        else sum.unknown++
        const out = stripDisplay(entry)
        if (detection?.input && detection.source) {
          out.input = [...detection.input]
          if (!sameInput(configured, detection.input)) sum.updated++
          records[entry.id] = { wireId: capabilityWireId(entry), input: [...detection.input], source: detection.source, ...(detection.conflict ? { conflict: true } : {}), ...(detection.reference ? { reference: detection.reference } : {}) }
        }
        return out
      })
    } else {
      const patchMap = new Map(patches.map((m) => [m.id, m]))
      if (mode === 'remove') next = existing.filter((m) => !patchMap.has(m.id))
      else if (mode === 'replace') next = patches
      else {
        next = existing.map((entry) => patchMap.has(entry.id) ? { ...entry, ...patchMap.get(entry.id) } : entry)
        next.push(...patches.filter((entry) => !existing.some((m) => m.id === entry.id)))
      }
      next = await Promise.all(next.map(async (raw) => {
        const patch = patchMap.get(raw.id)
        const prior = existing.find((entry) => entry.id === raw.id)
        const saved = prior && capabilityRecord(state, route, p, prior)
        const entry = stripDisplay(raw)
        if (mode === 'remove') { if (saved) records[entry.id] = saved; return entry }
        if (!patch) { if (saved) records[entry.id] = saved; return entry }
        if (patch.requestModel === null || patch.requestModel === '') delete entry.requestModel
        const reset = patch.inputMode === 'auto' || patch.input === null || (Array.isArray(patch.input) && !patch.input.length)
        // 兼容旧 RPC 的直接手工数组；读取附加的 configured/catalog 不当成人工意图。
        const manual = patch.inputMode === 'manual' || (!reset && patch.inputMode === undefined && !patch.capabilitySource && !!normalizeModelInput(patch.input))
        const changedWire = prior && capabilityWireId(prior) !== capabilityWireId(entry)
        if (manual) {
          entry.input = normalizeModelInput(patch.input)!
          records[entry.id] = { wireId: capabilityWireId(entry), input: [...entry.input], source: 'manual' }
          return entry
        }
        if (reset || changedWire) delete entry.input
        else if (prior && normalizeModelInput(prior.input) && (!saved || saved.source === 'manual')) {
          entry.input = prior.input
          if (saved) records[entry.id] = saved
          return entry
        } else if (saved && !patch.capabilitySource) { records[entry.id] = saved; return entry }
        // 手工重置和自动更新由后端重新判定来源；转发名改变后不使用旧型号的附加能力。
        if (patch.capabilitySource !== 'discovery' || reset || changedWire) delete entry.input
        const described = await describeModelInput(ctx, route, entry, patch.capabilitySource === 'discovery' ? 'discovery' : 'configured')
        const input = normalizeModelInput(described.input)
        if (input && described.capabilitySource && described.capabilitySource !== 'configured' && described.capabilitySource !== 'manual') {
          entry.input = input
          records[entry.id] = { wireId: capabilityWireId(entry), input: [...input], source: described.capabilitySource, ...(described.capabilityConflict ? { conflict: true } : {}), ...(described.capabilityReference ? { reference: described.capabilityReference } : {}) }
        } else delete entry.input
        return entry
      }))
    }
    if (!next.length && !ctx.get('llm')?.listConfigurableProviders().some((e) => e.settingsNs === NS && e.provider === route && e.declared !== true)) {
      throw new Error('不能删除全部模型: 自定义提供商必须至少保留一个模型条目')
    }
    unchanged()
    const before = readCapabilityState(st)
    const after = stateForCapabilities(before, route, p, records)
    const modelsChanged = JSON.stringify(next) !== JSON.stringify(p.models)
    await saveCapabilities(st, before, after, async () => {
      unchanged(JSON.stringify(after[route] ?? null))
      if (!modelsChanged) return
      const providers = { ...readProviders(st) }
      const disabled = { ...readDisabled(st) }
      // 等待目录/来源写入时，密钥引用、请求头和显示名可能已更新；只替换当前模型字段。
      const update = { ...(readProfile(providers, route) ?? readProfile(disabled, route))! }
      if (next.length) update.models = next
      else delete update.models
      if (Object.hasOwn(providers, route)) providers[route] = update
      else disabled[route] = update
      await writeSection(st, providers, disabled)
    })
    return { ok: true as const, route, count: next.length, ...(capabilitySummary ? { capabilitySummary } : {}) }
  } catch (err) { return { ok: false as const, error: String((err as Error)?.message || err) } }
}
