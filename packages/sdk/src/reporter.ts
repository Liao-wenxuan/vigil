import type { ErrorCategory, ErrorKind, HttpInfo, ResourceInfo, StackFrame } from '@vigil/protocol'

/**
 * 采集器 → SDK 主体的统一入口。
 *
 * 所有采集器只负责「发现错误并描述它」，不关心指纹、脱敏、队列、上报。
 * 这样新增一个采集源只需要写「怎么描述」，不用碰其他任何环节。
 */
export interface ReportInput {
  category: ErrorCategory
  kind: ErrorKind
  name?: string
  message: string
  stack?: string
  frames?: StackFrame[]
  resource?: ResourceInfo
  http?: HttpInfo
  /** 补充的业务上下文 */
  context?: Record<string, unknown>
  /**
   * 自定义指纹（原始字符串，内部会做哈希）。
   *
   * SDK 自动算不出稳定指纹时由业务侧指定 —— 比如 Worker 里的错误没有栈。
   */
  fingerprint?: string
}

export type Reporter = (input: ReportInput) => void

/** 采集器的统一卸载接口：调用它就能把监听器摘干净 */
export type Teardown = () => void

/** 组合多个卸载函数 */
export function combineTeardowns(teardowns: Teardown[]): Teardown {
  return () => {
    for (const teardown of teardowns) {
      try {
        teardown()
      } catch {
        // 卸载失败不能影响其他卸载
      }
    }
  }
}
