/**
 * 领域错误。
 *
 * 带 HTTP 状态码和机器可读的 code ——
 * 前端能据此做分支处理，而不是去匹配错误消息字符串。
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'AppError'
  }

  static notFound(what: string): AppError {
    return new AppError(404, 'not_found', `${what}不存在`)
  }

  static unauthorized(message = '未认证'): AppError {
    return new AppError(401, 'unauthorized', message)
  }

  static forbidden(message = '没有权限'): AppError {
    return new AppError(403, 'forbidden', message)
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, 'bad_request', message, details)
  }

  static conflict(message: string): AppError {
    return new AppError(409, 'conflict', message)
  }

  static tooManyRequests(message = '超出配额'): AppError {
    return new AppError(429, 'rate_limited', message)
  }
}
