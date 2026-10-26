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
  value: number
  hint?: string
  unit?: string
}>()

const display = computed(() => props.value.toLocaleString('zh-CN'))
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
  border-radius: 4px;
  padding: 15px 17px;
}

.stat-label {
  font-size: 12px;
  color: var(--vigil-text-3);
  letter-spacing: 0.03em;
}

.stat-value {
  font-size: 28px;
  font-weight: 500;
  line-height: 1.25;
  margin-top: 6px;
  color: var(--vigil-text-1);
}

.stat-unit {
  font-size: 13px;
  color: var(--vigil-text-3);
  margin-left: 4px;
}

.stat-hint {
  font-size: 11px;
  color: var(--vigil-text-3);
  margin-top: 4px;
}
</style>
