/** apply-models handler — replace/merge/remove models on a provider. */

import { NS } from '../../shared/constants'
import type { HostCtx } from '../utils'
import { readProviders, readDisabled, readProfile, checkWritable, writeSection } from '../utils'
import type { ModelEntry, ModelCapabilitySummary } from '../../shared/types'
import { normalizeModelInput, resolveModelInput, detectModelInputs } from '../modelCapabilities'

type ApplyMode = 'replace' | 'merge' | 'remove' | 'identify'

const toEntry = (m: unknown): ModelEntry =>
  m && typeof m === 'object' && !Array.isArray(m) ? { ...m } as ModelEntry : { id: String(m) }

const wireId = (entry: ModelEntry): string => entry.requestModel?.trim() || entry.id

function patchEntry(raw: unknown, previous?: ModelEntry): ModelEntry {
  const patch = toEntry(raw)
  if (typeof patch.id !== 'string' || !patch.id.trim()) throw new Error('模型 ID 必须是非空字符串')
  const incoming = patch as Record<string, unknown>
  const emptyInput = Array.isArray(incoming.input) && incoming.input.length === 0
  if (incoming.input != null && !emptyInput && !normalizeModelInput(incoming.input)) throw new Error('输入能力只支持 text / image 列表')
  if (incoming.requestModel != null && typeof incoming.requestModel !== 'string') throw new Error('转发名必须是字符串')
  const resetInput = incoming.input === null || emptyInput
  const resetWire = incoming.requestModel === null
  if (incoming.input == null || emptyInput) delete patch.input
  if (incoming.requestModel == null) delete patch.requestModel
  const next = { ...previous, ...patch }
  // 目录刷新不能覆盖手动确认过的模型能力；null 或框架空列表请求自动重置。
  if (!resetInput && (patch.capabilitySource === 'catalog' || patch.capabilitySource === 'discovery') && normalizeModelInput(previous?.input)) next.input = previous!.input
  if (resetInput) delete next.input
  if (resetWire) delete next.requestModel
  // 未保存的目录识别属于旧转发型号，修改转发名后必须重新识别。
  if (previous && patch.capabilitySource === 'catalog' && !normalizeModelInput(previous.input) && wireId(previous) !== wireId(next)) delete next.input
  delete next.capabilitySource
  delete next.inputModalities
  return next
}

export async function applyModels(
  ctx: HostCtx,
  args: { route?: string; models?: unknown[]; mode?: string },
) {
  const st = ctx.get('settings')
  if (st === undefined) return { ok: false as const, error: 'settings 服务不可用' }
  if (!checkWritable(st)) return { ok: false as const, error: '设置只读' }

  const route = args?.route
  if (!route) return { ok: false as const, error: '缺少 route' }

  const models = args?.models
  if (!Array.isArray(models)) return { ok: false as const, error: 'models 必须是数组' }

  const mode = (args.mode || 'merge') as ApplyMode
  const providers = readProviders(st)
  const disabled = readDisabled(st)
  const p = readProfile(providers, route) || readProfile(disabled, route)
  if (!p) return { ok: false as const, error: `提供商 "${route}" 不存在` }

  const existing = Array.isArray(p.models) ? p.models.map(toEntry) : []
  const modelSnapshot = JSON.stringify(p.models)
  const ensureUnchangedModels = (profile: typeof p | null | undefined) => {
    if (!profile || JSON.stringify(profile.models) !== modelSnapshot) throw new Error('模型列表已变化，请刷新后重新识别')
  }

  let next: ModelEntry[]
  let capabilitySummary: ModelCapabilitySummary | undefined
  try {
    if (mode === 'identify') {
      const ids = new Set(models.map((model) => patchEntry(model).id))
      const selected = existing.filter((entry) => ids.has(entry.id))
      if (selected.length !== ids.size) throw new Error('模型列表已变化，请刷新后重新识别')
      const missing = selected.filter((entry) => !normalizeModelInput(entry.input))
      const detected = await detectModelInputs(ctx, route, missing)
      const summary: ModelCapabilitySummary = { image: 0, text: 0, unknown: 0, preserved: 0, updated: 0, catalogUnavailable: detected.catalogUnavailable }
      capabilitySummary = summary
      next = existing.map((entry) => {
        if (!ids.has(entry.id)) return entry
        const configured = normalizeModelInput(entry.input)
        const input = configured ?? detected.inputs.get(entry.id)
        if (configured) summary.preserved++
        if (input?.includes('image')) summary.image++
        else if (input?.includes('text')) summary.text++
        else summary.unknown++
        if (!configured && input) summary.updated++
        // 未确认或已确认的模型保持原样，不把表单默认写成新声明。
        return !configured && input ? { ...entry, input } : entry
      })
      if (!summary.updated) {
        ensureUnchangedModels(readProfile(readProviders(st), route) || readProfile(readDisabled(st), route))
        return { ok: true as const, route, count: next.length, capabilitySummary }
      }
    } else if (mode === 'replace') {
      next = models.map((m) => {
        const patch = toEntry(m)
        const prior = existing.find((e) => e.id === patch.id)
        const entry = patchEntry(m)
        if (patch.input !== null && !(Array.isArray(patch.input) && patch.input.length === 0) && (patch.capabilitySource === 'catalog' || patch.capabilitySource === 'discovery') && normalizeModelInput(prior?.input)) entry.input = prior!.input
        if (prior && patch.capabilitySource === 'catalog' && !normalizeModelInput(prior.input) && wireId(prior) !== wireId(entry)) delete entry.input
        return entry
      })
    } else if (mode === 'merge') {
      next = [...existing]
      for (const m of models) {
        const e = toEntry(m)
        const idx = next.findIndex((x) => x.id === e.id)
        if (idx >= 0) next[idx] = patchEntry(m, next[idx])
        else next.push(patchEntry(m))
      }
    } else if (mode === 'remove') {
      const toRemove = new Set(models.map((m) => toEntry(m).id))
      next = existing.filter((m) => !toRemove.has(m.id))
    } else {
      return { ok: false as const, error: `未知 mode: ${mode}` }
    }
    if (mode !== 'remove' && mode !== 'identify') {
      next = await Promise.all(next.map(async (entry) => {
        const input = await resolveModelInput(ctx, route, entry)
        const saved = { ...entry }
        delete saved.capabilitySource
        delete saved.inputModalities
        delete saved.input
        if (input) saved.input = [...input]
        return saved
      }))
    }
  } catch (err) {
    return { ok: false as const, error: String((err as Error)?.message || err) }
  }

  // Prevent removing all models from custom providers
  if (next.length === 0) {
    const llm = ctx.get('llm')
    let inCatalog = false
    if (llm !== undefined) {
      try {
        inCatalog = llm
          .listConfigurableProviders()
          .some((e) => e.settingsNs === NS && e.provider === route && e.declared !== true)
      } catch { /* ignore */ }
    }
    if (!inCatalog)
      return { ok: false as const, error: '不能删除全部模型: 自定义提供商必须至少保留一个模型条目' }
  }

  const applyMutation = (src: Record<string, unknown>): Record<string, unknown> => {
    const cur: Record<string, unknown> = {}
    for (const fk of Object.keys(src)) cur[fk] = src[fk]
    if (next.length === 0) delete cur.models
    else cur.models = next
    return cur
  }

  try {
    // Re-read fresh state in case it changed
    const srcP2 = readProviders(st)
    const srcD2 = readDisabled(st)
    // 等待目录期间可能有其他编辑；拒绝旧识别结果，保留用户的新配置。
    if (mode === 'identify') ensureUnchangedModels(readProfile(srcP2, route) || readProfile(srcD2, route))
    const nextProviders: Record<string, unknown> = {}
    for (const k of Object.keys(srcP2)) {
      nextProviders[k] = k === route ? applyMutation(srcP2[k] as any) : (srcP2 as any)[k]
    }
    const nextDisabled: Record<string, unknown> = {}
    for (const k of Object.keys(srcD2)) {
      nextDisabled[k] = k === route ? applyMutation(srcD2[k] as any) : (srcD2 as any)[k]
    }
    await writeSection(st, nextProviders as any, nextDisabled as any)
  } catch (err) {
    return { ok: false as const, error: String((err as Error)?.message || err) }
  }

  return { ok: true as const, route, count: next.length, ...(capabilitySummary ? { capabilitySummary } : {}) }
}
