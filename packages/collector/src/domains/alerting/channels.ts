import type { ChannelType } from '@vigil/protocol'

/**
 * 通知通道发送器。
 *
 * 每种通道的 payload 格式不同：
 *   - 飞书机器人：`{ msg_type: 'text', content: { text } }`
 *   - 钉钉机器人：`{ msgtype: 'text', text: { content } }`
 *   - 通用 webhook：直接发自己的 JSON
 *
 * 所以通道不是「一个 URL」那么简单 —— 格式要对，否则机器人会返回 200 但不显示。
 */

export interface ChannelConfig {
  /** 通用 webhook 的地址；飞书/钉钉的机器人 webhook */
  url?: string
  /** 邮件收件人 */
  recipients?: string[]
  /** SMTP 主机 */
  smtpHost?: string
  smtpPort?: number
  smtpUser?: string
  smtpPassword?: string
  /** 是否跳过 TLS 校验（自建邮件服务器常见） */
  smtpInsecure?: boolean
}

export interface AlertMessage {
  title: string
  body: string
  /** 关联的问题 */
  issueId?: number
  shortId?: string
  url?: string
  /** 触发时的指标值 */
  metric?: { name: string; value: number; threshold: number }
  severity?: 'info' | 'warning' | 'error'
}

export interface SendResult {
  ok: boolean
  status?: number
  error?: string
  /** 实际尝试了几次（1 = 没重试） */
  attempts?: number
}

/**
 * 单次尝试的超时。
 *
 * ⚠️ 比以前短（10s → 5s）：重试要挤在总预算里，
 * 单次给太多时间就只剩一次机会了。
 */
const ATTEMPT_TIMEOUT_MS = 5_000

/**
 * 整个发送的**总预算**（含重试与退避等待）。
 *
 * ⚠️ 告警评估是**同步等**通道结果的 —— 预算就是评估循环最多被阻塞多久。
 *    定成 10s = 和以前单次发送的耗时一样，所以加了重试也不会让评估变慢。
 */
const TOTAL_BUDGET_MS = 10_000

/** 重试之间的退避（毫秒） */
const BACKOFF_MS = [300, 1000]

/**
 * 哪些失败值得重试。
 *
 * - **网络错误**（没有 status）→ 值得重试（对方可能只是抖了一下）
 * - **5xx / 429** → 值得重试（服务端临时扛不住）
 * - **4xx（除 429）** → **不值得**：请求本身有问题，
 *   再发一百次还是同样的结果，只是白白拖慢评估。
 */
export function isRetryable(result: SendResult): boolean {
  if (result.ok) return false
  if (result.status === undefined) return true
  if (result.status === 429) return true
  return result.status >= 500
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 发一个 JSON POST，带超时与**有界重试**。
 *
 * ## 为什么重试要有总预算
 *
 * 告警评估是同步等通道结果的 —— 如果通道一直挂着，
 * 评估循环就一直等着，整个告警引擎就卡住了。
 * 所以重试不是「无限重试」，而是「在总预算内尽可能多试几次」。
 *
 * @param url 目标地址
 * @param payload 请求体
 * @param budgetMs 总预算（毫秒）
 */
export async function postJson(
  url: string,
  payload: unknown,
  budgetMs: number = TOTAL_BUDGET_MS
): Promise<SendResult> {
  const deadline = Date.now() + budgetMs
  let last: SendResult = { ok: false, error: '发送失败' }
  let attempts = 0

  for (let i = 0; i <= BACKOFF_MS.length; i++) {
    attempts++
    last = await postOnce(url, payload)
    if (last.ok) return { ...last, attempts }
    if (!isRetryable(last)) return { ...last, attempts }

    const backoff = BACKOFF_MS[i]
    if (backoff === undefined) break
    // ⚠️ 再试一次要**塞得进剩余预算**才试 —— 否则就是白等
    if (Date.now() + backoff + ATTEMPT_TIMEOUT_MS > deadline) break
    await sleep(backoff)
  }

  return { ...last, attempts }
}

/** 单次 POST */
async function postOnce(url: string, payload: unknown): Promise<SendResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    })

    if (!response.ok) {
      return { ok: false, status: response.status, error: await response.text() }
    }
    return { ok: true, status: response.status }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 通道发送器接口。
 *
 * 做成接口而不是一堆 if，是为了让**新增通道不需要改告警引擎**——
 * 告警引擎只认「把消息发出去」这一个动作。
 */
export interface ChannelSender {
  readonly type: ChannelType
  send(config: ChannelConfig, message: AlertMessage): Promise<SendResult>
}

/** 通用 webhook：直接把消息 JSON 发出去 */
class WebhookSender implements ChannelSender {
  readonly type: ChannelType = 'webhook'

  async send(config: ChannelConfig, message: AlertMessage): Promise<SendResult> {
    if (!config.url) return { ok: false, error: '缺少 webhook 地址' }
    return await postJson(config.url, {
      title: message.title,
      body: message.body,
      issueId: message.issueId,
      url: message.url,
      severity: message.severity,
      metric: message.metric
    })
  }
}

/** 飞书群机器人 */
class FeishuSender implements ChannelSender {
  readonly type: ChannelType = 'feishu'

  async send(config: ChannelConfig, message: AlertMessage): Promise<SendResult> {
    if (!config.url) return { ok: false, error: '缺少飞书机器人 webhook' }
    return await postJson(config.url, {
      msg_type: 'text',
      content: { text: `${message.title}\n${message.body}` }
    })
  }
}

/** 钉钉群机器人 */
class DingtalkSender implements ChannelSender {
  readonly type: ChannelType = 'dingtalk'

  async send(config: ChannelConfig, message: AlertMessage): Promise<SendResult> {
    if (!config.url) return { ok: false, error: '缺少钉钉机器人 webhook' }
    return await postJson(config.url, {
      msgtype: 'text',
      text: { content: `${message.title}\n${message.body}` }
    })
  }
}

/**
 * 邮件通道。
 *
 * SMTP 需要一个客户端库。这里用**动态 import** —— 没装 nodemailer 时
 * 邮件通道返回明确错误，而不是让整个 Collector 起不来。
 */
class EmailSender implements ChannelSender {
  readonly type: ChannelType = 'email'

  async send(config: ChannelConfig, message: AlertMessage): Promise<SendResult> {
    if (!config.smtpHost) return { ok: false, error: '缺少 SMTP 主机配置' }
    if (!config.recipients?.length) return { ok: false, error: '缺少收件人' }

    let nodemailer: typeof import('nodemailer')
    try {
      nodemailer = (await import('nodemailer')).default
    } catch {
      return { ok: false, error: '未安装 nodemailer，无法发送邮件' }
    }

    const transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort ?? 587,
      secure: config.smtpPort === 465,
      ignoreTLS: config.smtpInsecure,
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined
    })

    try {
      await transport.sendMail({
        from: config.smtpUser ?? 'vigil@localhost',
        to: config.recipients.join(', '),
        subject: message.title,
        text: message.body
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/** Slack incoming webhook */
class SlackSender implements ChannelSender {
  readonly type: ChannelType = 'slack'

  async send(config: ChannelConfig, message: AlertMessage): Promise<SendResult> {
    if (!config.url) return { ok: false, error: '缺少 Slack webhook' }
    return await postJson(config.url, {
      text: `*${message.title}*\n${message.body}`
    })
  }
}

const SENDERS: Record<ChannelType, ChannelSender> = {
  webhook: new WebhookSender(),
  feishu: new FeishuSender(),
  dingtalk: new DingtalkSender(),
  email: new EmailSender(),
  slack: new SlackSender()
}

export function getSender(type: ChannelType): ChannelSender {
  return SENDERS[type] ?? SENDERS.webhook
}
