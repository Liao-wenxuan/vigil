/** 时间工具 */

/** 当前 epoch 毫秒 */
export function now(): number {
  return Date.now()
}

/** 秒 → 毫秒 */
export function seconds(value: number): number {
  return value * 1000
}

/** 天 → 毫秒 */
export function days(value: number): number {
  return value * 24 * 3600 * 1000
}

/**
 * 按时间桶分组，用于趋势图。
 *
 * @param from 起始时刻
 * @param to 结束时刻
 * @param bucketMinutes 桶大小（分钟）
 * @returns 每个桶的起止时间戳
 */
export function timeBuckets(
  from: number,
  to: number,
  bucketMinutes: number
): Array<{ start: number; end: number }> {
  const size = bucketMinutes * 60 * 1000
  const buckets: Array<{ start: number; end: number }> = []

  // 对齐到桶边界
  let cursor = Math.floor(from / size) * size
  while (cursor <= to) {
    buckets.push({ start: cursor, end: cursor + size })
    cursor += size
  }

  return buckets
}

/** 判断时间戳是否在闭区间内 */
export function inRange(value: number, start: number, end: number): boolean {
  return value >= start && value < end
}
