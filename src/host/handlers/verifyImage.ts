/** 图片实测与能力声明独立：只有两张随机挑战图均正确，才保存已验证证据。 */
import type { ImageVerification, ModelEntry, ProviderProfile } from '../../shared/types'
import { capabilityWireId, withCapabilityWrite } from '../capabilityStore'
import { imageVerificationBinding, resolvedImageVerificationBinding, saveImageVerification } from '../imageVerificationStore'
import { createVisionChallenge, matchesVisionAnswer } from '../visionChallenge'
import { checkWritable, readDisabled, readProfile, readProviders, type HostCtx, type SettingsService } from '../utils'

interface ImageRef { attachmentId: string; mediaType: string; width: number; height: number }
interface Attachments { saveImage(args: { data: Uint8Array; mediaType: string; name: string }): Promise<ImageRef> }
interface Chunk { type: string; text?: string; reason?: { kind?: string; failure?: { code?: string } } }
interface PreparedCall {
  inputModalities?: string[]
  config: Record<string, unknown>
  stream(args: Record<string, unknown>): AsyncIterable<Chunk>
}
interface ProbeLlm { prepareCall(config: Record<string, unknown>, signal?: AbortSignal): Promise<PreparedCall> }
interface Timer { timeout(callback: () => void, ms: number): () => void }
const inFlight = new WeakMap<SettingsService, Set<string>>()
const PROMPT = '请只根据图片返回一个 JSON 对象：code 是上方四位数字字符串（保留前导零）；left 和 right 描述下方左侧和右侧图形，包含 shape 和 color。shape 用 circle、square 或 triangle；color 用 red、green、blue 或 orange。只返回 JSON，不要解释。'

function currentModel(st: SettingsService, route: string, model: string): { profile: ProviderProfile; entry: ModelEntry } | undefined {
  if (Object.hasOwn(readDisabled(st), route)) return undefined
  const profile = readProfile(readProviders(st), route)
  const entry = profile?.models?.find((entry) => entry && typeof entry === 'object' && entry.id === model)
  return profile && entry ? { profile, entry } : undefined
}

export async function verifyImageInput(ctx: HostCtx, args: { route?: string; model?: string }) {
  const st = ctx.get('settings')
  const route = args?.route
  const model = args?.model
  if (!st || !route || !model) return { ok: false as const, error: '缺少供应商、模型或设置服务' }
  if (!checkWritable(st)) return { ok: false as const, error: '设置只读，不能保存图片验证结果' }
  const selected = currentModel(st, route, model)
  if (!selected) return { ok: false as const, error: '模型不存在或供应商已禁用，请刷新后重试' }
  const llm = ctx.get('llm') as unknown as ProbeLlm | undefined
  const attachments = ctx.get('attachments') as Attachments | undefined
  const timer = ctx.get('timer') as Timer | undefined
  if (!llm?.prepareCall || !attachments?.saveImage || !timer?.timeout) return { ok: false as const, error: '当前 Harness 缺少图片附件或测试计时服务' }
  const key = JSON.stringify([route, model])
  const running = inFlight.get(st) ?? new Set<string>()
  if (running.has(key)) return { ok: false as const, error: '这个模型正在验证图片能力' }
  inFlight.set(st, running)
  running.add(key)
  const configBinding = imageVerificationBinding(selected.profile, selected.entry)
  const unchanged = () => {
    const current = currentModel(st, route, model)
    if (!current || imageVerificationBinding(current.profile, current.entry) !== configBinding) throw new Error('测试期间连接或模型配置已变化，请刷新后重新验证')
  }
  const start = Date.now()
  let passed = 0
  let message = ''
  let unfinished: Promise<unknown> | undefined
  try {
    const binding = await resolvedImageVerificationBinding(ctx, selected.profile, selected.entry)
    const unchangedCredential = async () => {
      unchanged()
      const current = currentModel(st, route, model)!
      if (await resolvedImageVerificationBinding(ctx, current.profile, current.entry) !== binding) throw new Error('测试期间凭据已变化')
      unchanged()
    }
    // 先核对实际转发型号；运行时可能把仅文本模型的图片静默转成文本提示。
    const wireModel = capabilityWireId(selected.entry)
    for (let attempt = 0; attempt < 2; attempt++) {
      unchanged()
      const controller = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : undefined
      let iterator: AsyncIterator<Chunk> | undefined
      let cancelled = false
      let timedOut = false
      let cancelDeadline: (() => void) | undefined
      const cancelAttempt = () => {
        cancelled = true
        controller?.abort()
        // 老版沙箱没有 AbortController；仍请求迭代器收尾，并拒绝超时后的晚结果。
        try { void iterator?.return?.().catch(() => {}) } catch { /* 收尾失败不能覆盖测试结果。 */ }
      }
      const active = () => { if (cancelled) throw new Error('VISION_PROBE_CANCELLED'); unchanged() }
      const deadline = new Promise<never>((_, reject) => {
        cancelDeadline = timer.timeout(() => { timedOut = true; cancelAttempt(); reject(new Error('VISION_PROBE_TIMEOUT')) }, 60000)
      })
      const run = (async () => {
        await unchangedCredential()
        active()
        const prepared = await llm.prepareCall({ provider: route, model: wireModel, maxTokens: 512, temperature: 0 }, controller?.signal)
        active()
        if ((!!selected.entry.input?.length && !selected.entry.input.includes('image')) || !prepared.inputModalities?.includes('image')) return { blocked: true, matched: false }
        const challenge = createVisionChallenge()
        const ref = await attachments.saveImage({ data: challenge.data, mediaType: 'image/png', name: 'model-pro-vision-probe.png' })
        await unchangedCredential()
        active()
        iterator = prepared.stream({ ...prepared.config, ...(controller ? { signal: controller.signal } : {}), messages: [{ role: 'user', content: [
          { type: 'text', text: PROMPT }, { type: 'image', attachment: ref },
        ] }] })[Symbol.asyncIterator]()
        let reply = '', finish: string | undefined
        while (true) {
          const next = await iterator.next()
          active()
          if (next.done) break
          const chunk = next.value
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            reply += chunk.text
            if (reply.length > 16384) throw new Error('VISION_PROBE_RESPONSE_LIMIT')
          }
          if (chunk.type === 'finish') {
            finish = chunk.reason?.kind
            if (finish === 'error') throw new Error('VISION_PROBE_REQUEST_FAILED')
          }
        }
        return { blocked: false, matched: finish === 'stop' && matchesVisionAnswer(reply, challenge.expected) }
      })()
      run.catch(() => {})
      try {
        const result = await Promise.race([run, deadline])
        if (result.blocked) return { ok: false as const, model, error: '尚未发出图片请求：请先为该模型及实际转发型号保存「文本＋图片」能力，再验证' }
        if (result.matched) passed++
        else message = '图片回答与测试图不符，尚不能确认图片能力'
      } catch {
        if (timedOut) unfinished = run
        message = timedOut ? '图片测试超时，未确认；超时不代表仅支持文本' : '图片测试失败或返回异常，未确认；失败不代表仅支持文本'
        break
      } finally { cancelDeadline?.(); cancelAttempt() }
    }
    const verification: ImageVerification = { status: passed === 2 ? 'verified' : 'unconfirmed', checkedAt: new Date().toISOString(), passed, total: 2, latencyMs: Date.now() - start, ...(message ? { message } : {}) }
    try {
      await withCapabilityWrite(st, async () => { await unchangedCredential(); await saveImageVerification(st, route, model, binding, verification) })
      return { ok: true as const, model, verification, saved: true }
    } catch {
      return { ok: true as const, model, verification, saved: false, error: '测试已完成，但配置已变化或结果保存失败；请刷新后重试' }
    }
  } catch {
    return { ok: false as const, model, error: '图片测试准备失败或配置已变化，请刷新并检查图片能力设置后重试' }
  } finally {
    // 无法立即中止的原生调用未结束前，阻止同模型重试叠加请求。
    if (unfinished) void unfinished.finally(() => running.delete(key)).catch(() => {})
    else running.delete(key)
  }
}
