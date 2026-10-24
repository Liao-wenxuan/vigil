/**
 * 敏感信息脱敏。
 *
 * 监控系统会**原样收集用户页面上的东西**：URL、referrer、错误消息、请求体。
 * 这些地方经常混着 token、手机号、身份证号。采集端不脱敏，就等于
 * 把用户隐私复制进了一份新的数据库 —— 这在合规上是硬伤，不是 Best Practice。
 *
 * 原则：**宁可多脱一点**。误伤一个无关字段的代价（看不到 query 参数）
 * 远小于漏掉一个真实 token 的代价。
 */

/**
 * 整键精确匹配即视为敏感。
 *
 * 注意 'code' 在这里但不在下面的 PARTS 里：
 * OAuth 的 `?code=xxx` 确实是敏感的，但 JSON 里的 `statusCode` / `errorCode`
 * 绝不能被抹掉 —— 前者是整键，后者只是键的一个**词段**。
 */
const EXACT_KEYS = new Set([
  'key',
  'auth',
  'authorization',
  'pwd',
  'sig',
  'sign',
  'sid',
  'jwt',
  'secret',
  'token',
  'password',
  'passwd',
  'cookie',
  'code',
  'credential',
  'credentials'
])

/**
 * 键的**词段**命中即视为敏感。
 *
 * 之所以不直接用子串匹配：`monkey` 包含 `key`、`zipcode` 包含 `code`。
 * 子串匹配会把这些无辜字段一起抹掉。切成词段再比对，
 * `userPassword` → ['user','password'] 命中，`monkey` → ['monkey'] 不命中。
 */
const SENSITIVE_PARTS = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'privatekey',
  'authorization',
  'auth',
  'session',
  'sessionid',
  'cookie',
  'phone',
  'mobile',
  'tel',
  'email',
  'idcard',
  'bankcard',
  'cardno',
  'cvv',
  'openid',
  'unionid',
  'signature',
  'otp',
  'verifycode',
  'smscode'
])

/** 把 key 拆成小写词段：accessToken → ['access','token'] */
function splitKeyParts(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase())
}

/** 判断一个字段名是否敏感 */
export function isSensitiveKey(key: string): boolean {
  if (!key) return false
  const normalized = key.toLowerCase().replace(/[-\s]/g, '_')
  if (EXACT_KEYS.has(normalized)) return true
  const parts = splitKeyParts(key)
  return parts.some((part) => SENSITIVE_PARTS.has(part))
}

/**
 * 脱敏 URL 的 query 参数。
 *
 * 用字符串切分而不是 `new URL()` —— 因为 `new URL('/api/x?token=1', base)`
 * 会把 base 拼进结果，相对路径就变成了 `http://host/api/x?token=1`，
 * 凭空多出一段主机名。相对路径必须原样保留。
 */
export function maskUrl(raw: string): string {
  if (!raw) return raw
  const qIndex = raw.indexOf('?')
  if (qIndex === -1) return raw

  const head = raw.slice(0, qIndex)
  const rest = raw.slice(qIndex + 1)
  const hashIndex = rest.indexOf('#')
  const query = hashIndex === -1 ? rest : rest.slice(0, hashIndex)
  const hash = hashIndex === -1 ? '' : rest.slice(hashIndex)
  if (!query) return `${head}${hash}`

  const masked = query
    .split('&')
    .map((pair) => {
      if (!pair) return pair
      const eq = pair.indexOf('=')
      const rawKey = eq === -1 ? pair : pair.slice(0, eq)
      let key = rawKey
      try {
        key = decodeURIComponent(rawKey)
      } catch {
        // key 不是合法百分号编码就按原样处理，不为了脱敏把整条 URL 弄丢
      }
      return isSensitiveKey(key) ? `${rawKey}=***` : pair
    })
    .join('&')

  return `${head}?${masked}${hash}`
}

/**
 * 匹配 `key = value` / `key: value` 形式的赋值。
 *
 * 三组捕获：键、分隔符、引号。引号要用反向引用收尾，
 * 这样 `"token":"abc"` 匹配到的是完整的 `"abc"` 而不是 `abc`。
 */
/**
 * 匹配 `key = value` / `key: value` 形式的赋值。
 *
 * 三组捕获：键、分隔符、引号。引号要用反向引用收尾，
 * 这样 `"token":"abc"` 匹配到的是完整的 `"abc"` 而不是 `abc`。
 *
 * ⚠️ 这个模式**匹配不到 JSON** —— JSON 的键是带引号的 `"token"`，
 * 键和 `:` 之间还隔着一个引号。JSON 交给下面的 JSON_ASSIGN_PATTERN 处理。
 *
 * ⚠️ authorization 开头的键被负向前瞻排除：它的值可能是
 * `Bearer eyJhbGci...` 这种带空格的凭证，通用规则只会切掉 `Bearer`
 * 那一段，**真正的凭证反而留在后面**。这类交给 AUTH_PATTERN 整体处理。
 */
const ASSIGN_PATTERN =
  /((?!(?:proxy-)?authorization\b)[A-Za-z_][A-Za-z0-9_-]{1,32})(\s*[:=]\s*)("?)([^\s"'&,;)}\]]{1,256})\3/gi

/**
 * 匹配 JSON 里的 `"key":"value"`。
 *
 * 必须单独一条规则：JSON 的键带引号，通用赋值模式匹配不到。
 */
const JSON_ASSIGN_PATTERN = /"([A-Za-z_][A-Za-z0-9_-]{1,32})"(\s*:\s*)"([^"\\\n]{1,256})"/g

/**
 * 匹配 `Authorization: Bearer <token>` / `Authorization=<token>`。
 *
 * 整段一起处理，才能既留下 `Bearer` 这个标识、又抹掉真正的凭证。
 *
 * 值里允许 `*`：CREDENTIAL_PATTERN 可能已经先把它masked成 `***`，
 * 此时这一条要能**幂等地**再匹配一次，而不是因为 `*` 不在字符类里整个失配。
 */
const AUTH_PATTERN =
  /((?:proxy-)?authorization\s*[:=]\s*)(?:"|')?((?:bearer|basic)\s+)?[A-Za-z0-9._~+/=*-]{4,}/gi

/**
 * 匹配任何位置的 `Bearer <token>` / `Basic <token>`。
 *
 * 有些地方凭证会出现在日志里而没有 Authorization 前缀。
 */
const CREDENTIAL_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi

/**
 * 脱敏一段自由文本（错误消息、栈字符串、日志内容）。
 *
 * 只处理**明确的键值对**，不碰裸值 —— 否则一串随机 token 会被误判。
 *
 * ## 顺序是有讲究的
 *
 * **AUTH 必须排在 CREDENTIAL 前面。**
 * 反过来的话，CREDENTIAL 先把凭证换成 `Bearer ***`（3 个字符），
 * 而 AUTH 的值组要求 4 个字符以上 → 方案组匹配失败 → 回退成
 * 把 `Bearer` 当成值切掉 → 结果是 `Authorization: *** ***`，
 * **凭证标识没了，真正的凭证反而留在后面**。
 */
export function scrubText(text: string): string {
  if (!text) return text

  return text
    .replace(JSON_ASSIGN_PATTERN, (match, key: string, sep: string) => {
      if (!isSensitiveKey(key)) return match
      return `"${key}"${sep}"***"`
    })
    .replace(AUTH_PATTERN, (_match, prefix: string, scheme: string | undefined) => {
      // scheme 捕获里已经带了尾随空格（`(?:bearer|basic)\s+`），
      // 这里补空格会变成「Bearer  ***」双空格
      const label = scheme ? scheme.trim() : ''
      const normalized = label ? `${label[0].toUpperCase()}${label.slice(1).toLowerCase()}` : ''
      return `${prefix}${normalized ? `${normalized} ` : ''}***`
    })
    .replace(CREDENTIAL_PATTERN, (_match, scheme: string) => `${scheme} ***`)
    .replace(ASSIGN_PATTERN, (match, key: string, sep: string, quote: string) => {
      if (!isSensitiveKey(key)) return match
      return `${key}${sep}${quote}***${quote}`
    })
}

/** 截断长文本，避免单个字段把上报体积撑爆 */
export function truncate(text: string, max: number): string {
  if (!text) return text
  if (text.length <= max) return text
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`
}

/**
 * 递归脱敏一个普通对象（用于业务自定义 context / extra）。
 *
 * 深度和键数都有上限 —— context 是用户传的，不能让它变成一个无限深的
 * 嵌套对象把序列化成本拉爆。
 */
export function maskRecord(
  input: Record<string, unknown>,
  depth = 0,
  maxDepth = 4
): Record<string, unknown> {
  if (!input || typeof input !== 'object') return input
  if (depth >= maxDepth) return { '[truncated]': true }

  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (isSensitiveKey(key)) {
      output[key] = '***'
      continue
    }
    if (typeof value === 'string') {
      output[key] = scrubText(value)
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = maskRecord(value as Record<string, unknown>, depth + 1, maxDepth)
    } else if (Array.isArray(value)) {
      output[key] = value
        .slice(0, 20)
        .map((item) =>
          typeof item === 'string'
            ? scrubText(item)
            : item && typeof item === 'object'
              ? maskRecord(item as Record<string, unknown>, depth + 1, maxDepth)
              : item
        )
    } else {
      output[key] = value
    }
  }
  return output
}
