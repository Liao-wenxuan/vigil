<script setup lang="ts">
/**
 * 统计卡片。
 *
 * 数字一律白色（--vigil-text-1）—— 强调色只留给状态，
 * 一屏数字全黄绿就分不出重点了。
 */
import { computed } from 'vue'

const props = defineProps<{
  label: string
  /** 数字会被千分位格式化；比率这类需要自定义格式的传字符串 */
  value: number | string
  hint?: string
  unit?: string
}>()

const display = computed(() =>
  typeof props.value === 'number' ? props.value.toLocaleString('zh-CN') : props.value
)
</script>

<template>
  <div class="stat-card">
    <div class="stat-label">{{ label }}</div>
    <div class="stat-value tabular">
      {{ display }}<span v-if="unit" class="stat-unit">{{ unit }}</span>
    </div>
    <div v-if="hint" class="stat-hint">{{ hint }}</div>
  </div>
</template>

<style scoped>
.stat-card {
  background: var(--vigil-bg-raised);
  border: 1px solid var(--vigil-border);
  border-radius: var(--vigil-radius);
  padding: var(--vigil-space-4) var(--vigil-space-4);
  /* 卡片本身不做位移+阴影的「通用悬浮」——
     那样每个卡片都在喊，等于什么都没说。
     这里只让**边框**亮一档：它表达的是「这块可看」，不是「这块特别重要」。 */
  transition:
    border-color var(--vigil-motion-fast) var(--vigil-ease-standard),
    background var(--vigil-motion-fast) var(--vigil-ease-standard);
}

.stat-card:hover {
  border-color: var(--vigil-border-strong);
  background: #232327;
}

.stat-label {
  font-size: var(--vigil-text-xs);
  color: var(--vigil-text-3);
  letter-spacing: var(--vigil-tracking-wide);
}

/* 数字是这个面板里第二大的东西 —— 26px。页面标题 30px 领头，
   数字跟着它，但不能跟它一样大，否则层级就平了。
   纯字重不够：黑体大字重在深底上会糊，所以字重 500 + 更亮的白。 */
.stat-value {
  font-size: var(--vigil-text-xl);
  font-weight: 500;
  line-height: var(--vigil-leading-tight);
  letter-spacing: var(--vigil-tracking-tight);
  margin-top: var(--vigil-space-1);
  color: var(--vigil-text-1);
}

.stat-unit {
  font-size: var(--vigil-text-sm);
  color: var(--vigil-text-3);
  margin-left: var(--vigil-space-1);
  font-weight: 400;
}

.stat-hint {
  font-size: var(--vigil-text-2xs);
  color: var(--vigil-text-3);
  margin-top: var(--vigil-space-1);
  line-height: var(--vigil-leading-normal);
}
</style>
