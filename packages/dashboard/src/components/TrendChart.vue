<script setup lang="ts">
/**
 * 时间趋势柱状图。
 *
 * ## 为什么还是 HTML/CSS 而不是 SVG
 *
 * 上一版的 SVG 用 `preserveAspectRatio` + `width: 100%`，
 * 字号是 **viewBox 单位**，实际渲染 = 字号 × (面板宽 / 900) ——
 * 同屏两个宽度不同的面板，同一个「12px」渲染出来就是两个大小。
 * 图表改回 SVG 就会把这个坑再踩一遍。
 *
 * 柱子是 HTML 元素，文字是 HTML 元素 —— 字号是真实 px。
 */
import { computed } from 'vue'
import type { TrendPoint } from '../types'

const props = defineProps<{
  points: TrendPoint[]
  bucket: 'hour' | 'day'
  /** 纵轴单位 */
  unit?: string
}>()

const max = computed(() => Math.max(1, ...props.points.map((p) => p.occurrences)))

function ratio(value: number): number {
  return Math.max(0.004, value / max.value)
}

/** 桶标签：按天显示「MM-DD」，按小时显示「HH:mm」 */
function label(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (props.bucket === 'hour') {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 悬停提示：把该桶的关键数字一次说清楚 */
function describe(point: TrendPoint): string {
  const rate = point.errorRate === null ? '无访问' : `${(point.errorRate * 100).toFixed(2)}%`
  return [
    `${label(point.timestamp)}`,
    `发生 ${point.occurrences} 次`,
    `新增 ${point.newIssues} 个问题`,
    `影响 ${point.users} 人`,
    `页面访问 ${point.transactions} 次`,
    `错误率 ${rate}`
  ].join(' · ')
}
</script>

<template>
  <div v-if="points.length === 0" class="trend-empty">暂无趋势数据</div>

  <div v-else class="trend">
    <div class="trend-row">
      <div
        v-for="(point, index) in points"
        :key="point.timestamp"
        class="trend-col"
        :title="describe(point)"
      >
        <div class="trend-bar-wrap">
          <div class="trend-bar" :style="{ height: `${ratio(point.occurrences) * 100}%` }"></div>
        </div>
        <span class="trend-label">{{ label(point.timestamp) }}</span>
        <span v-if="index === points.length - 1" class="trend-value tabular">
          {{ point.occurrences.toLocaleString('zh-CN') }}{{ unit ?? '' }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trend {
  display: flex;
  flex-direction: column;
  gap: var(--vigil-space-2);
}

.trend-row {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  /* 柱子区固定高度 —— 数值变化时布局不跳 */
  height: 120px;
}

.trend-col {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  gap: var(--vigil-space-1);
  height: 100%;
}

.trend-bar-wrap {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  min-height: 0;
}

.trend-bar {
  width: 100%;
  background: var(--vigil-accent);
  border-radius: var(--vigil-radius-sm) var(--vigil-radius-sm) 0 0;
  min-height: 2px;
  transition: height var(--vigil-motion-standard) var(--vigil-ease-out);
}

.trend-label {
  font-size: var(--vigil-text-2xs);
  color: var(--vigil-text-3);
  white-space: nowrap;
}

.trend-value {
  font-size: var(--vigil-text-2xs);
  color: var(--vigil-text-2);
  white-space: nowrap;
}

.trend-empty {
  padding: var(--vigil-space-8);
  text-align: center;
  color: var(--vigil-text-3);
  font-size: var(--vigil-text-sm);
}
</style>
