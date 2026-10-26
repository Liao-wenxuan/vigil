/** URL 工具 */

/**
 * 取 URL 的路径部分（去 origin、去 query、去 hash）。
 *
 * 相对路径原样返回 —— 不能用 `new URL()`，它会拼上 base 的主机名，
 * 相对路径就变成了 `http://host/api/x`。
 */
export function pathOf(url: string): string {
  if (!url) return ''

  let s = url.split('?')[0].split('#')[0]
  const schemeEnd = s.indexOf('://')
  if (schemeEnd !== -1) {
    const slash = s.indexOf('/', schemeEnd + 3)
    s = slash === -1 ? '/' : s.slice(slash)
  }
  return s || '/'
}
