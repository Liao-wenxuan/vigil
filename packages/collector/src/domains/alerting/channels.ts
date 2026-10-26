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
    return postJson(config.url, {
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
    return postJson(config.url, {
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
    return postJson(config.url, {
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
    return postJson(config.url, {
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

/** 发一个 JSON POST，带超时 */
async function postJson(url: string, payload: unknown): Promise<SendResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)

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
