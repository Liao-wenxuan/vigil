<script setup lang="ts">
/**
 * 横向条形图（SVG 手写，不引图表库）。
 *
 * 条形是「量级」的可视化 —— 用强调色画条，
 * 但**数字仍然是白色**（--vigil-text-1）：
 * 强调色表达的是「这一条有多长」，不是「这个数字有多重要」。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    items: Array<{ label: string; value: number; hint?: string }>
    unit?: string
    emptyText?: string
    labelChars?: number
  }>(),
  {
    unit: '',
    emptyText: '暂无数据',
    labelChars: 30
  }
)

const ROW_HEIGHT = 26
const WIDTH = 900
const LABEL_WIDTH = 300
const VALUE_WIDTH = 76
const BAR_WIDTH = WIDTH - LABEL_WIDTH - VALUE_WIDTH

const max = computed(() => Math.max(1, ...props.items.map((item) => item.value)))
const height = computed(() => Math.max(ROW_HEIGHT, props.items.length * ROW_HEIGHT))

function barWidth(value: number): number {
  return Math.max(2, (value / max.value) * BAR_WIDTH)
}

function shortLabel(label: string): string {
  return label.length > props.labelChars ? `${label.slice(0, props.labelChars)}…` : label
}

function format(value: number): string {
  return value.toLocaleString('zh-CN')
}
</script>

<template>
  <div v-if="items.length === 0" class="bar-empty">{{ emptyText }}</div>
  <svg
    v-else
    class="bar-chart"
    :viewBox="`0 0 ${WIDTH} ${height}`"
    preserveAspectRatio="xMinYMin meet"
    role="img"
  >
    <g
      v-for="(item, index) in items"
      :key="`${item.label}-${index}`"
      :transform="`translate(0, ${index * ROW_HEIGHT})`"
    >
      <text class="bar-label" :x="0" :y="ROW_HEIGHT / 2 + 4">{{ shortLabel(item.label) }}</text>
      <rect
        class="bar-track"
        :x="LABEL_WIDTH"
        :y="ROW_HEIGHT / 2 - 5"
        :width="BAR_WIDTH"
        height="10"
        rx="2"
      />
      <rect
        class="bar-fill"
        :x="LABEL_WIDTH"
        :y="ROW_HEIGHT / 2 - 5"
        :width="barWidth(item.value)"
        height="10"
        rx="2"
      />
      <text class="bar-value tabular" :x="LABEL_WIDTH + BAR_WIDTH + 8" :y="ROW_HEIGHT / 2 + 4">
        {{ format(item.value) }}{{ unit }}
      </text>
    </g>
  </svg>
</template>

<style scoped>
.bar-chart {
  width: 100%;
  min-width: 520px;
  height: auto;
  display: block;
}

.bar-label {
  fill: var(--vigil-text-2);
  font-size: 12px;
}

.bar-track {
  fill: rgba(255, 255, 255, 0.05);
}

.bar-fill {
  fill: var(--vigil-accent);
}

.bar-value {
  fill: var(--vigil-text-1);
  font-size: 12px;
}

.bar-empty {
  padding: 28px;
  text-align: center;
  color: var(--vigil-text-3);
  font-size: 13px;
}
</style>
