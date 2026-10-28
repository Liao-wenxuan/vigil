/**
 * 等待若干 URL 就绪。
 *
 * ## 为什么需要它
 *
 * CI 里「先起服务、再跑测试」必须放在**同一个 step**：
 * GitHub Actions 每个 `run` 块是独立的 shell，块结束时
 * 里面用 `&` 起的后台进程**会被杀掉**。
 *
 * 所以要么用 `services:` 容器，要么把「起服务 + 等就绪 + 跑测试」
 * 全塞进一个 step。这个脚本负责中间那一步。
 *
 * 用法：
 *   node scripts/wait-for.mjs http://127.0.0.1:4318/api/health http://localhost:5174/
 */
const urls = process.argv.slice(2)

if (urls.length === 0) {
  console.error('用法：node scripts/wait-for.mjs <url> [<url> ...]')
  process.exit(1)
}

const TIMEOUT_MS = Number(process.env.WAIT_FOR_TIMEOUT_MS ?? 60_000)
const INTERVAL_MS = 500

async function waitFor(url) {
  const deadline = Date.now() + TIMEOUT_MS

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (response.ok) {
        console.log(`  ✓ ${url} → HTTP ${response.status}`)
        return
      }
      console.log(`  · ${url} → HTTP ${response.status}，继续等`)
    } catch (error) {
      console.log(`  · ${url} 连不上（${error instanceof Error ? error.message : String(error)}）`)
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS))
  }

  throw new Error(`等待超时（${TIMEOUT_MS}ms）：${url}`)
}

for (const url of urls) {
  await waitFor(url)
}
