<script setup lang="ts">
/**
 * 分位数区间图（p50 → p95）。
 *
 * ## 为什么不用 SVG
 *
 * 和 BarList 同样的问题：SVG 里的 `font-size` 是 **viewBox 单位**，
 * 实际渲染大小 = `字号 × (面板宽 / 900)`。
 * 面板宽度一变，标签字号就跟着变 —— 同一个「13px」在两个面板里不是一个大小。
 *
 * 改成 HTML/CSS：字号是真实 px，位置用百分比。
 *
 * ## 动效预算
 *
 * 区间条用 `translateX + scaleX` 定位 —— 全是 transform，不触发 layout。
 * 端点竖线用 `left: X%` + `translateX(-50%)` 居中。
 */
// 模板里直接用 props 的字段（<script setup> 会自动解包），
// 所以这里不需要把 props 赋给一个变量
withDefaults(
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

function scaleMax(item: { p95: number; max?: number }): number {
  return item.max ?? Math.max(item.p95 * 1.3, 1)
}

/** 区间起点的百分比 */
function start(item: { p50: number; p95: number; max?: number }): string {
  return `${(item.p50 / scaleMax(item)) * 100}%`
}

/** 区间宽度的百分比（相对轨道全宽） */
function span(item: { p50: number; p95: number; max?: number }): string {
  return `${((item.p95 - item.p50) / scaleMax(item)) * 100}%`
}

/** 端点的百分比位置 */
function at(item: { p50: number; p95: number; max?: number }, value: number): string {
  return `${(value / scaleMax(item)) * 100}%`
}

function format(value: number): string {
  return value.toLocaleString('zh-CN')
}
</script>

<template>
  <div v-if="items.length === 0" class="pc-empty">{{ emptyText }}</div>

  <div v-else class="pc-list">
    <div v-for="(item, index) in items" :key="`${item.label}-${index}`" class="pc-row">
      <div class="pc-names">
        <span class="pc-label">{{ item.label }}</span>
        <span class="pc-sub tabular"> p50 {{ format(item.p50) }}{{ item.unit ?? '' }} </span>
      </div>

      <div class="pc-track">
        <span
          class="pc-band"
          :style="{ transform: `translateX(${start(item)}) scaleX(${span(item)})` }"
        ></span>
        <span class="pc-mark pc-p50" :style="{ left: at(item, item.p50) }"></span>
        <span class="pc-mark pc-p95" :style="{ left: at(item, item.p95) }"></span>
      </div>

      <span class="pc-value tabular">p95 {{ format(item.p95) }}{{ item.unit ?? '' }}</span>
    </div>
  </div>
</template>

<style scoped>
.pc-list {
  display: flex;
  flex-direction: column;
  gap: var(--vigil-space-3);
}

.pc-row {
  display: grid;
  grid-template-columns: minmax(0, 30%) 1fr auto;
  gap: var(--vigil-space-3);
  align-items: center;
}

.pc-names {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.pc-label {
  font-size: var(--vigil-text-sm);
  font-weight: 500;
  color: var(--vigil-text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pc-sub {
  font-size: var(--vigil-text-2xs);
  color: var(--vigil-text-3);
}

.pc-track {
  position: relative;
  height: 14px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: var(--vigil-radius-sm);
}

.pc-band {
  position: absolute;
  left: 0;
  top: 1px;
  width: 100%;
  height: 12px;
  background: rgba(255, 255, 255, 0.22);
  border-radius: var(--vigil-radius-sm);
  transform-origin: left center;
  transition: transform var(--vigil-motion-standard) var(--vigil-ease-out);
}

.pc-mark {
  position: absolute;
  top: -2px;
  width: 2px;
  height: 18px;
  border-radius: 1px;
  transform: translateX(-50%);
}

.pc-p50 {
  background: var(--vigil-text-2);
}

.pc-p95 {
  background: var(--vigil-accent);
  width: 2px;
  height: 20px;
  top: -3px;
}

.pc-value {
  font-size: var(--vigil-text-xs);
  color: var(--vigil-text-1);
  min-width: 96px;
  text-align: right;
  white-space: nowrap;
}

.pc-empty {
  padding: var(--vigil-space-6);
  text-align: center;
  color: var(--vigil-text-3);
  font-size: var(--vigil-text-sm);
}
</style>
