import type { Slo, SloEvaluation, SloStatus } from '@vigil/protocol'

/**
 * 发布闸门：把 SLO 状态翻译成「能不能发版」。
 *
 * ## 为什么策略要放在领域层
 *
 * 因为「什么情况阻断发布」是**业务规则**，不是命令行细节。
 * 放在脚本里就没法测 —— 每次改都要手工跑一遍命令看退出码。
 * 这里做成纯函数，规则一目了然，也能被 CI 和面板共用。
 *
 * ## 默认规则
 *
 * | 状态 | 阻断？ | 理由 |
 * |---|---|---|
 * | `exhausted` | **阻断** | 错误预算已耗尽 —— SRE 手册的规矩：预算烧光就该停发布 |
 * | `at_risk` | 提示 | 没达标或烧得快，但预算还在 —— 值得知道，不值得拦人 |
 * | `healthy` | 通过 | |
 * | 无数据 | 提示 | 没流量就判不了，不该因为「没数据」拦发版 |
 *
 * ⚠️ **「无数据」不等于「没问题」** ——
 *    所以有 `--require-data`：SDK 挂了导致没数据时，用它把闸门变成严格的。
 */
export interface SloGateOptions {
  /** 把「有风险」也当成阻断 */
  strict?: boolean
  /** 没有任何可判定的数据时也算失败 */
  requireData?: boolean
  /** 项目必须至少有一条 SLO 才算通过（没定义目标就等于没闸门） */
  requireSlo?: boolean
}

/** 单条 SLO 的判定结果 */
export interface SloGateEntry {
  sloId: number
  name: string
  status: SloStatus
  /** 是否阻断发布 */
  blocking: boolean
  /** 阻断或提示的原因 */
  reason: string
  /** 达标率（时间口径）。没有可判定的步时是 null */
  sli: number | null
  /** 整体错误率（事件口径） */
  errorRatio: number | null
  /** 剩余预算 */
  budgetRemaining: number
  /** 燃烧率 */
  burnRate: number | null
}

/** 闸门总结果 */
export interface SloGateResult {
  /** true = 允许发布 */
  passed: boolean
  entries: SloGateEntry[]
  /** 一行结论 */
  summary: string
}

/**
 * 判定一批 SLO 能不能放行发布。
 *
 * @param items SLO 定义 + 当前状态
 */
export function decideSloGate(
  items: Array<{ slo: Slo; evaluation: SloEvaluation }>,
  options: SloGateOptions = {}
): SloGateResult {
  const entries: SloGateEntry[] = items.map(({ slo, evaluation }) => {
    const base = {
      sloId: slo.id,
      name: slo.name,
      status: evaluation.status,
      sli: evaluation.sli,
      errorRatio: evaluation.errorRatio,
      budgetRemaining: evaluation.budgetRemaining,
      burnRate: evaluation.burnRate
    }

    // 预算烧光 —— 直接拦
    if (evaluation.status === 'exhausted') {
      return { ...base, blocking: true, reason: '错误预算已耗尽' }
    }

    // 有风险 —— 默认只提示
    if (evaluation.status === 'at_risk') {
      return {
        ...base,
        blocking: options.strict === true,
        reason: options.strict === true ? 'SLO 有风险（严格模式阻断）' : 'SLO 有风险（不阻断）'
      }
    }

    // 没有可判定的数据
    if (evaluation.sli === null) {
      return {
        ...base,
        blocking: options.requireData === true,
        reason:
          options.requireData === true
            ? '没有可判定的数据（严格模式阻断）'
            : '没有可判定的数据（跳过）'
      }
    }

    return { ...base, blocking: false, reason: '达标' }
  })

  const blocking = entries.filter((e) => e.blocking)

  // 没定义任何 SLO —— 等于没闸门。
  // ⚠️ 默认**不阻断**：没配 SLO 的项目不该被拦住。
  //    但要求配 SLO 的场景（受管控的生产项目）要用 requireSlo。
  if (entries.length === 0 && options.requireSlo === true) {
    return {
      passed: false,
      entries,
      summary: '没有 SLO —— 被阻断（requireSlo 模式）'
    }
  }

  const passed = blocking.length === 0

  const summary = passed
    ? entries.length === 0
      ? '没有 SLO —— 跳过（用 --require-slo 可要求至少有一条）'
      : `全部通过（${entries.length} 条 SLO）`
    : `被 ${blocking.length} 条 SLO 阻断：${blocking.map((e) => e.name).join('、')}`

  return { passed, entries, summary }
}
