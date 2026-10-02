import type { ImageVerification, ModelEntry, ProviderProfile } from '../shared/types'
import { capabilityWireId } from './capabilityStore'
import { verificationDigest } from './visionChallenge'
import { readOwnedStateKey, writeOwnedStateKey, type HostCtx, type SettingsService } from './utils'

export const IMAGE_VERIFICATIONS_KEY = 'imageVerifications'
interface VerificationRecord { binding: string; verification: ImageVerification }
type VerificationState = Record<string, Record<string, VerificationRecord>>
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** 请求头可能包含认证值；只保存不可逆指纹，不把原始字段复制进验证档案。 */
export function imageVerificationBinding(profile: ProviderProfile, model: ModelEntry): string {
  const wireId = capabilityWireId(model)
  const wireEntry = profile.models?.find((entry) => entry && typeof entry === 'object' && entry.id === wireId)
  const headers = Object.entries(profile.headers ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return verificationDigest(JSON.stringify([profile.api, profile.baseURL, wireId, headers, profile.apiKeyEnv, profile.apiKeyEnc, profile.defaultInput, model.input, wireEntry?.input]))
}

/** 同名凭据引用也可能换值；解析值只参与内存摘要，绝不复制到持久化状态。 */
export async function resolvedImageVerificationBinding(ctx: HostCtx, profile: ProviderProfile, model: ModelEntry): Promise<string> {
  const binding = imageVerificationBinding(profile, model)
  if (!profile.apiKeyEnv) return binding
  const credentials = ctx.get('credentials') as { resolve(ref: string): Promise<{ value?: string } | undefined> } | undefined
  if (!credentials?.resolve) throw new Error('图片验证无法核对当前凭据')
  const resolved = await credentials.resolve(profile.apiKeyEnv)
  if (!resolved?.value) throw new Error('图片验证无法解析当前凭据')
  return verificationDigest(JSON.stringify([binding, resolved.value]))
}

function readState(st: SettingsService): VerificationState {
  const state = readOwnedStateKey(st, IMAGE_VERIFICATIONS_KEY)
  return isRecord(state) ? state as VerificationState : {}
}

export function savedImageVerification(st: SettingsService, route: string, profile: ProviderProfile, model: ModelEntry, binding = imageVerificationBinding(profile, model)): ImageVerification | undefined {
  const state = readState(st)
  const models = Object.hasOwn(state, route) ? state[route] : undefined
  const saved = models && Object.hasOwn(models, model.id) ? models[model.id] : undefined
  const verification = saved?.verification
  if (!saved || saved.binding !== binding || !verification || !['verified', 'unconfirmed'].includes(verification.status)) return undefined
  if (typeof verification.checkedAt !== 'string' || !Number.isFinite(Date.parse(verification.checkedAt)) || verification.total !== 2 || ![0, 1, 2].includes(verification.passed) || !Number.isFinite(verification.latencyMs)) return undefined
  if (verification.status === 'verified' && verification.passed !== 2) return undefined
  return { ...verification }
}

/** 调用方在来源写入队列内复核当前连接，再合并单个模型，保留其它供应商结果。 */
export async function saveImageVerification(st: SettingsService, route: string, model: string, binding: string, verification: ImageVerification): Promise<void> {
  const state = readState(st)
  const current = Object.hasOwn(state, route) && isRecord(state[route]) ? state[route] : {}
  await writeOwnedStateKey(st, IMAGE_VERIFICATIONS_KEY, { ...state, [route]: { ...current, [model]: { binding, verification } } })
}
