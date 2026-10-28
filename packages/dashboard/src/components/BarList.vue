<script setup lang="ts">
/**
 * 横向条形图。
 *
 * ## 为什么不是 SVG
 *
 * 上一版是 SVG + `preserveAspectRatio="xMinYMin meet"` + `width: 100%`。
 * 看起来没问题，实测有两个硬伤：
 *
 * 1. **字号被面板宽度缩放。** SVG 里的 `font-size: 12px` 是 **viewBox 单位**，
 *    实际渲染大小 = `12 × (面板宽 / 900)`。
 *    同屏两个宽度不同的面板，同一个「12px」渲染出来大小不同 ——
 *    截图里「分类分布」的标签明显比「Top 问题」的小。
 * 2. **条形起点对不齐。** 标签列是固定的 viewBox 比例，
 *    面板一窄，标签列就跟着缩，两张图看起来像不同的坐标系。
 *
 * 改成 HTML/CSS：字号是真实 px，标签列用**百分比**固定，
 * 同屏所有图表的条形起点一致。
 *
 * ## 动效预算
 *
 * 条形长度用 `transform: scaleX()` 而不是 `width` ——
 * `width` 会触发 layout，`transform` 走合成层。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    items: Array<{ label: string; value: number; hint?: string }>
    unit?: string
    emptyText?: string
  }>(),
  {
    unit: '',
    emptyText: '暂无数据'
  }
)

const max = computed(() => Math.max(1, ...props.items.map((item) => item.value)))

function ratio(value: number): number {
  return Math.max(0.004, value / max.value)
}

function format(value: number): string {
  return value.toLocaleString('zh-CN')
}
</script>

<template>
  <div v-if="items.length === 0" class="bar-empty">{{ emptyText }}</div>

  <div v-else class="bar-list">
    <div v-for="(item, index) in items" :key="`${item.label}-${index}`" class="bar-row">
      <span class="bar-label" :title="item.label">{{ item.label }}</span>

      <span class="bar-track">
        <span class="bar-fill" :style="{ transform: `scaleX(${ratio(item.value)})` }"></span>
      </span>

      <span class="bar-value tabular">{{ format(item.value) }}{{ unit }}</span>
    </div>
  </div>
</template>

<style scoped>
.bar-list {
  display: flex;
  flex-direction: column;
  /* 行的间距用节奏档位，不写散值 */
  gap: var(--vigil-space-2);
}

.bar-row {
  /* 标签列固定百分比 → 同屏所有图表的条形起点一致 */
  display: grid;
  grid-template-columns: minmax(0, 44%) 1fr auto;
  gap: var(--vigil-space-3);
  align-items: center;
  min-height: 24px;
}

.bar-label {
  font-size: var(--vigil-text-xs);
  color: var(--vigil-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar-track {
  height: 10px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: var(--vigil-radius-sm);
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  width: 100%;
  background: var(--vigil-accent);
  border-radius: var(--vigil-radius-sm);
  transform-origin: left center;
  transition: transform var(--vigil-motion-standard) var(--vigil-ease-out);
}

.bar-value {
  font-size: var(--vigil-text-xs);
  color: var(--vigil-text-1);
  min-width: 52px;
  text-align: right;
  white-space: nowrap;
}

.bar-empty {
  padding: var(--vigil-space-6);
  text-align: center;
  color: var(--vigil-text-3);
  font-size: var(--vigil-text-sm);
}
</style>
