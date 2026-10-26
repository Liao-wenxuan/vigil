/**
 * User-Agent 解析。
 *
 * 自己写而不是引 ua-parser-js：
 *   - 只要 browser / os / device 三个粗粒度字段
 *   - 少一个依赖，Collector 的安装和启动都更轻
 *
 * 顺序很重要：Edge 的 UA 里含 "Chrome"，Opera 的含 "Chrome" 和 "Safari"。
 * 必须先判 Edge / Opera，否则它们会被识别成 Chrome / Safari。
 */
export interface UserAgentInfo {
  browser?: string
  os?: string
  device: 'desktop' | 'mobile' | 'tablet' | 'unknown'
}

export function parseUserAgent(ua: string): UserAgentInfo {
  if (!ua) return { device: 'unknown' }

  return {
    browser: detectBrowser(ua),
    os: detectOs(ua),
    device: detectDevice(ua)
  }
}

function detectBrowser(ua: string): string | undefined {
  // 顺序即优先级
  if (ua.includes('Edg/')) return 'Edge'
  if (ua.includes('OPR/') || ua.includes('Opera')) return 'Opera'
  if (ua.includes('SamsungBrowser')) return 'Samsung Internet'
  if (ua.includes('Firefox/')) return 'Firefox'
  if (ua.includes('Chrome/')) return 'Chrome'
  if (ua.includes('Safari/') && ua.includes('Version/')) return 'Safari'
  if (ua.includes('Safari/')) return 'Safari'
  if (ua.includes('MSIE') || ua.includes('Trident/')) return 'IE'
  return undefined
}

function detectOs(ua: string): string | undefined {
  if (ua.includes('Windows NT 10')) return 'Windows 10+'
  if (ua.includes('Windows NT 6.3')) return 'Windows 8.1'
  if (ua.includes('Windows NT 6.1')) return 'Windows 7'
  if (ua.includes('Windows')) return 'Windows'
  if (ua.includes('Android')) return 'Android'
  if (ua.includes('iPhone') || ua.includes('iPad') || ua.includes('iPod')) return 'iOS'
  if (ua.includes('Mac OS X')) return 'macOS'
  if (ua.includes('CrOS')) return 'ChromeOS'
  if (ua.includes('Linux')) return 'Linux'
  return undefined
}

function detectDevice(ua: string): 'desktop' | 'mobile' | 'tablet' | 'unknown' {
  if (ua.includes('iPad') || ua.includes('Tablet')) return 'tablet'
  if (ua.includes('Mobi') || ua.includes('iPhone') || ua.includes('Android')) return 'mobile'
  if (ua.includes('Mac OS X') || ua.includes('Windows') || ua.includes('Linux')) return 'desktop'
  return 'unknown'
}
