/** 模型能力使用明确配置或运行时目录；不按名称猜测未知模型是否支持图片。 */
import { NS } from '../shared/constants'
import type { ModelEntry, ModelInput, ModelCapabilitySource } from '../shared/types'
import type { HostCtx, LLMService } from './utils'
import { readProviders, readDisabled, readProfile } from './utils'

interface CatalogInputs {
  byRoute: Map<string, Map<string, ModelInput[] | null>>
  byId: Map<string, ModelInput[] | null>
  complete: boolean
}

const catalogs = new WeakMap<LLMService, Promise<CatalogInputs>>()

/** 不把未知/音频/视频能力截断为“仅文本”，避免误判接口尚不支持的模型。 */
export function normalizeModelInput(value: unknown): ModelInput[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => v !== 'text' && v !== 'image')) return undefined
  return (['text', 'image'] as const).filter((v) => value.includes(v))
}

function declaredDefaultInput(ctx: HostCtx, route: string): ModelInput[] | undefined {
  const st = ctx.get('settings')
  if (!st) return undefined
  const fromSection = (section: unknown): ModelInput[] | undefined => {
    if (!section || typeof section !== 'object') return undefined
    const providers = (section as Record<string, unknown>).providers
    if (!providers || typeof providers !== 'object') return undefined
    const profile = (providers as Record<string, unknown>)[route]
    return profile && typeof profile === 'object' ? normalizeModelInput((profile as Record<string, unknown>).defaultInput) : undefined
  }
  try {
    if (typeof st.get === 'function') return fromSection(st.get(NS)) ?? normalizeModelInput(readProfile(readDisabled(st), route)?.defaultInput)
    // value 含 schema 自动填充的 text，不能把它当作用户声明；user 保留原始字段。
    const user = fromSection(st.describe?.().find((row) => row.ns === NS)?.user)
    if (user) return user
    const editor = ctx.get('configEditor') as { configuration?: () => Array<{ entry: { options: { id?: string } }; override: unknown; inherited: unknown }> } | undefined
    const layers = editor?.configuration?.().find((row) => row.entry.options.id === NS)
    const raw = layers && (fromSection(layers.override) ?? fromSection(layers.inherited))
    if (raw) return raw
    const resolved = normalizeModelInput((readProfile(readProviders(st), route) ?? readProfile(readDisabled(st), route))?.defaultInput)
    // 图片不是 schema 默认，可确认来源；缺少原始层时仍不把默认 text 当作已确认。
    return resolved?.includes('image') ? resolved : undefined
  } catch { return undefined }
}

async function catalogInputs(llm: LLMService): Promise<CatalogInputs> {
  let pending = catalogs.get(llm)
  if (!pending) {
    pending = (async () => {
      const result: CatalogInputs = { byRoute: new Map(), byId: new Map(), complete: true }
      const providers = llm.listConfigurableProviders().filter((p) => p.settingsNs === NS && p.declared !== true)
      const names = [...new Set(providers.map((p) => p.provider))]
      for (const provider of names) {
        try {
          // 只有 provider，没有 baseURL：pi-ai 返回内置目录，缺失目录时直接失败，不触网。
          const models = await llm.discoverModels(NS, { provider })
          const route = new Map<string, ModelInput[] | null>()
          for (const model of models) {
            const input = normalizeModelInput(model.inputModalities ?? model.input)
            if (!input) {
              route.set(model.id, null)
              result.byId.set(model.id, null)
              continue
            }
            route.set(model.id, input)
            const prior = result.byId.get(model.id)
            result.byId.set(model.id, prior === null || (prior && prior.join() !== input.join()) ? null : input)
          }
          result.byRoute.set(provider, route)
        } catch { result.complete = false }
      }
      // 缺失某个目录时无法排除同名冲突，只允许仍可验证的同供应商匹配。
      if (!result.complete) result.byId.clear()
      return result
    })().catch(() => {
      catalogs.delete(llm)
      return { byRoute: new Map(), byId: new Map(), complete: false }
    })
    catalogs.set(llm, pending)
  }
  const result = await pending
  // 就绪前的空目录或暂时失败允许下次重试，不能将“未确认”缓存到重启。
  if (!result.complete || result.byRoute.size === 0) catalogs.delete(llm)
  return result
}

export async function resolveModelInput(ctx: HostCtx, route: string, entry: ModelEntry): Promise<ModelInput[] | undefined> {
  const configured = normalizeModelInput(entry.input)
  if (configured) return configured
  // Harness 的 schema 会为缺失数组生成 []；与原生 declaredInput 一样视为未声明。
  if (entry.input !== undefined && !(Array.isArray(entry.input) && entry.input.length === 0)) return undefined
  const llm = ctx.get('llm')
  if (!llm) return declaredDefaultInput(ctx, route)
  const catalog = await catalogInputs(llm)
  const id = typeof entry.requestModel === 'string' && entry.requestModel.trim() ? entry.requestModel.trim() : entry.id
  const own = catalog.byRoute.get(route)
  if (own?.has(id)) return own.get(id) ?? undefined
  const providerDefault = declaredDefaultInput(ctx, route)
  if (providerDefault) return providerDefault
  return catalog.byId.get(id) ?? undefined
}

/** 按钮显式请求一次目录识别，使用同一份快照处理全部模型，不发推理请求。 */
export async function detectModelInputs(ctx: HostCtx, route: string, entries: ModelEntry[]): Promise<{
  inputs: Map<string, ModelInput[]>
  catalogUnavailable: boolean
}> {
  const inputs = new Map<string, ModelInput[]>()
  if (!entries.length) return { inputs, catalogUnavailable: false }
  const llm = ctx.get('llm')
  if (llm) catalogs.delete(llm)
  const catalog = llm ? await catalogInputs(llm) : undefined
  const providerDefault = declaredDefaultInput(ctx, route)
  for (const entry of entries) {
    const id = typeof entry.requestModel === 'string' && entry.requestModel.trim() ? entry.requestModel.trim() : entry.id
    const own = catalog?.byRoute.get(route)
    const input = own?.has(id) ? own.get(id) : catalog?.byId.get(id)
    // defaultInput:text 可能是此前保存时带入的 schema 默认，不能阻止按型号补齐。
    // 已明确声明图片默认时，未知目录型号仍可沿用该声明。
    const resolved = input ?? (providerDefault?.includes('image') ? providerDefault : undefined)
    if (resolved && !(own?.has(id) && own.get(id) === null)) inputs.set(entry.id, [...resolved])
  }
  return { inputs, catalogUnavailable: !catalog || !catalog.complete || catalog.byRoute.size === 0 }
}

/** 读操作附加展示来源；apply-models 只持久化 input，不持久化来源标签。 */
export async function describeModelInput(ctx: HostCtx, route: string, entry: ModelEntry, explicitSource: ModelCapabilitySource = 'configured'): Promise<ModelEntry> {
  const explicit = normalizeModelInput(entry.input)
  const input = explicit ?? await resolveModelInput(ctx, route, entry)
  const out = { ...entry }
  delete out.capabilitySource
  delete out.input
  if (input) {
    out.input = [...input]
    out.capabilitySource = explicit ? explicitSource : 'catalog'
  }
  return out
}
