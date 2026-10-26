<script setup lang="ts">
/**
 * 分位数区间图（SVG 手写）。
 *
 * 画的是 p50 → p95 的一段区间：
 * - 区间底色用白色半透明 —— 它是**数据**
 * - p95 端点用强调色 —— 它是「这条线的警戒位」
 * - 数字一律白色
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    items: Array<{
      label: string
      p50: number
      p75: number
      p95: number
      unit?: string
      max?: number
    }>
    emptyText?: string
  }>(),
  { emptyText: '暂无性能数据' }
)

const ROW_HEIGHT = 46
const WIDTH = 900
const LABEL_WIDTH = 130
const VALUE_WIDTH = 130
const BAR_WIDTH = WIDTH - LABEL_WIDTH - VALUE_WIDTH

const height = computed(() => Math.max(ROW_HEIGHT, props.items.length * ROW_HEIGHT))

function scaleMax(item: { p95: number; max?: number }): number {
  return item.max ?? Math.max(item.p95 * 1.3, 1)
}

function x(value: number, max: number): number {
  return LABEL_WIDTH + (value / max) * BAR_WIDTH
}

function format(value: number): string {
  return value.toLocaleString('zh-CN')
}
</script>

<template>
  <div v-if="items.length === 0" class="pc-empty">{{ emptyText }}</div>
  <svg
    v-else
    class="pc-chart"
    :viewBox="`0 0 ${WIDTH} ${height}`"
    preserveAspectRatio="xMinYMin meet"
    role="img"
  >
    <g
      v-for="(item, index) in items"
      :key="item.label"
      :transform="`translate(0, ${index * ROW_HEIGHT})`"
    >
      <text class="pc-label" :x="0" :y="18">{{ item.label }}</text>
      <text class="pc-sub tabular" :x="0" :y="34">
        p50 {{ format(item.p50) }}{{ item.unit ?? '' }}
      </text>

      <rect class="pc-track" :x="LABEL_WIDTH" :y="12" :width="BAR_WIDTH" height="12" rx="2" />

      <rect
        class="pc-band"
        :x="x(item.p50, scaleMax(item))"
        :y="12"
        :width="Math.max(2, x(item.p95, scaleMax(item)) - x(item.p50, scaleMax(item)))"
        height="12"
        rx="2"
      />

      <line
        class="pc-p50"
        :x1="x(item.p50, scaleMax(item))"
        :x2="x(item.p50, scaleMax(item))"
        :y1="8"
        :y2="28"
      />

      <line
        class="pc-p95"
        :x1="x(item.p95, scaleMax(item))"
        :x2="x(item.p95, scaleMax(item))"
        :y1="6"
        :y2="30"
      />

      <text class="pc-value tabular" :x="LABEL_WIDTH + BAR_WIDTH + 10" :y="22">
        p95 {{ format(item.p95) }}{{ item.unit ?? '' }}
      </text>
    </g>
  </svg>
</template>

<style scoped>
.pc-chart {
  width: 100%;
  min-width: 520px;
  height: auto;
  display: block;
}

.pc-label {
  fill: var(--vigil-text-1);
  font-size: 13px;
  font-weight: 500;
}

.pc-sub {
  fill: var(--vigil-text-3);
  font-size: 11px;
}

.pc-track {
  fill: rgba(255, 255, 255, 0.05);
}

.pc-band {
  fill: rgba(255, 255, 255, 0.22);
}

.pc-p50 {
  stroke: var(--vigil-text-2);
  stroke-width: 1;
}

.pc-p95 {
  stroke: var(--vigil-accent);
  stroke-width: 2;
}

.pc-value {
  fill: var(--vigil-text-1);
  font-size: 12px;
}

.pc-empty {
  padding: 28px;
  text-align: center;
  color: var(--vigil-text-3);
  font-size: 13px;
}
</style>
