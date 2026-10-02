/**
 * dsh-model-pro — Host half entry point (static-bundle mode).
 *
 * Mounts the `modelPro` Typert Remote service (the client's RPC surface) and
 * registers its manifest, then wires up smart-routing, composites, health
 * probing, observability, and the uninstall-restore safety net — through
 * Cordis `ctx` (there is no dynamic `harness` global in a static plugin).
 *
 * Static-mounted plugins export `apply` (+ optional `name` / `inject`); the
 * loader imports this module and calls apply(ctx).
 *
 * Disabled providers are moved to a separate `disabledProviders` dict so the
 * llm-pi-ai adapter (which only reads `providers`) stops registering them.
 * Harness 0.2 stores parked profiles in this plugin's own volatile state;
 * legacy Harness keeps them beside providers. Both restore them on unload.
 */

import type { HostCtx } from './utils'
import z from '@deepseek-ai/schemastery'
import { ModelProRuntime } from './service'
import { TYPERT_MANIFEST, PACKAGE } from '../shared/contract'
import { registerRouterAdapter } from './router'
import { registerStreamRewrite } from './streamRewrite'
import { restoreDisabledOnUnload, parkDisabledProviders } from './lifecycle'
import { initHealthTracker, resetHealthSingleton } from './health'
import { resetObservabilitySingletons, hydrateObservability, persistStats } from './statsStore'

/** Loader entry id / client bundle id. */
export const name = PACKAGE

// Harness 0.2 的配置表单只接受所属 schema 的 volatile 字段。
// 禁用配置、路由和观测快照由本插件持有，避免污染 llm-pi-ai 的 schema。
export const Config = z.object({ state: z.dict(z.any()).default({}).volatile() })

/** Hard dependencies. `typert` is the RPC registry we register into. `settings`
 * and `llm` gate WHEN apply runs: cordis parks the fiber until every declared
 * service exists (dsh-cordis-host-runner: "a valid unresolved inject may remain
 * pending"), so declaring them guarantees the reinstall re-park below reads a
 * MOUNTED settings service. Without them an early apply would call
 * `ctx.get('settings')` before it is mounted, read an empty section, and the
 * re-park of marked providers would silently no-op — leaving disabled-marked
 * providers sitting in `providers`, where llm-pi-ai's resolveProfiles registers
 * them as fully active routes again (the marker means nothing to it). */
export const inject = ['typert', 'settings', 'llm']

export function apply(ctx: HostCtx) {
  const c = ctx as any

  // Mount the RPC service and register its strict manifest with the Gateway.
  new ModelProRuntime(ctx)
  c.effect(() => c.typert.register(TYPERT_MANIFEST), 'dsh-model-pro: typert manifest')

  // Rebind observability singletons to this fiber (fresh on each apply).
  resetHealthSingleton()
  resetObservabilitySingletons()
  let unloading = false
  let hydrated = false
  let hydrating = false
  const ensureStateReady = () => {
    if (hydrated) return true
    if (hydrating || unloading) return false
    hydrating = true
    try {
      const st = ctx.get('settings')
      if (st === undefined) return false
      if (typeof st.get !== 'function') {
        // Cordis 在 apply 时仍处于启动状态；新版表单只公开已就绪的 fiber。
        // 两个表单都可读后再恢复状态，避免把空统计覆盖到持久化档案。
        const forms = st.describe?.()
        if (!forms?.some((row) => row.ns === PACKAGE) || !forms.some((row) => row.ns === 'llm-pi-ai')) return false
      }
      initHealthTracker(ctx)
      hydrateObservability(ctx)
      hydrated = true
      return true
    } catch {
      return false
    } finally {
      hydrating = false
    }
  }
  // Seed the stats recorder + request-log ring from the persisted snapshot so
  // the 观测台 and the conversation route badge are populated after a page
  // refresh / host restart instead of starting blank.
  ensureStateReady()

  // Debounced persistence of the stats aggregates + a capped request-log tail
  // onto the settings snapshot, so 输入/输出 token 统计 and the routing 尾标
  // survive a reload. A burst of routed calls costs at most one write per
  // interval (the recorder's dirty flag skips no-op flushes); a final flush
  // runs on unload.
  const timer = c.get('timer') as { interval?: (fn: () => void, ms: number) => () => void } | undefined
  if (timer && typeof timer.interval === 'function') {
    timer.interval(() => { if (ensureStateReady()) void persistStats(ctx) }, 5000)
  }
  if (typeof c.effect === 'function') {
    c.effect(() => () => { if (hydrated) void persistStats(ctx, { force: true }) }, 'dsh-model-pro: stats flush')
  }

  // Smart routing: expose route combos + composites as models on the synthetic
  // "router" / "composite" routes, forwarding calls to real targets.
  registerRouterAdapter(ctx)
  // Per-provider local model mapping: select X, forward requestModel if set.
  registerStreamRewrite(ctx)

  // Reinstall recovery: parked providers keep their `disabled` marker, so on
  // startup re-park them into disabledProviders (adapter keeps ignoring them).
  //
  // 先尝试恢复；旧版 settings/updated、新版 document-updated 和自身
  // fiber 就绪事件负责重试，涵盖 llm 与自身配置表单的不同加载顺序。
  //
  // parkDisabledProviders is idempotent and writes only when a marked profile
  // actually moved, so re-firing on our own write settles after one pass.
  // The `unloading` flag stops the listener from fighting the
  // uninstall-restore: restore moves parked providers BACK into `providers`
  // (marker intact) and its write emits settings/updated — without the flag
  // this listener would immediately re-park them behind the safety net's back.
  let reparking = false
  let reparkPending = false
  let reparkTask: Promise<void> | undefined
  const reparkOnSettings = () => {
    if (unloading) return
    if (reparking) {
      reparkPending = true
      return
    }
    if (!ensureStateReady()) return
    // describe/mutate 会同步发布配置事件；串行恢复，避免重复迁移互相回滚。
    reparking = true
    reparkTask = parkDisabledProviders(ctx).then(() => {}, () => {}).finally(() => {
      reparking = false
      if (reparkPending) {
        reparkPending = false
        reparkOnSettings()
      }
    })
  }
  reparkOnSettings()
  if (typeof c.on === 'function' && typeof c.effect === 'function') {
    c.effect(() => {
      const listener = (ns: string) => {
        try {
          if (ns !== 'llm-pi-ai' && ns !== PACKAGE) return
          reparkOnSettings()
        } catch { /* ignore */ }
      }
      const off = c.on('settings/updated', listener)
      const offDocument = c.on('settings/document-updated', listener)
      const offStatus = c.on('internal/status', (fiber: { state?: number }) => {
        if (fiber === c.fiber && fiber.state === 2) reparkOnSettings()
      })
      return () => {
        try { off?.() } catch { /* ignore */ }
        try { offDocument?.() } catch { /* ignore */ }
        try { offStatus?.() } catch { /* ignore */ }
      }
    }, 'dsh-model-pro: reinstall re-park on settings/updated')
  } else {
    // Fallback for harness contexts without event plumbing: settle async.
    queueMicrotask(reparkOnSettings)
  }

  // Uninstall / disable safety net: restore disabled providers to `providers`
  // (marker travels with them) so nothing is lost when this plugin goes away.
  // We hook the fiber effect's cleanup — the same pattern dsh-settings uses.
  if (typeof c.effect === 'function') {
    c.effect(() => () => {
      unloading = true
      try {
        return Promise.resolve(reparkTask).then(() => restoreDisabledOnUnload(ctx))
      } catch {
        return undefined
      }
    })
  }
}
