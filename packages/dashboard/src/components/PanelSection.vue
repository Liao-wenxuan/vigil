<script setup lang="ts">
/**
 * 内容区块容器。
 *
 * 全站的「标题 + 计数 + 内容」结构统一走这里，
 * 免得每个页面各写一套 padding 和边框。
 */
defineProps<{
  title: string
  count?: number | string
  hint?: string
}>()
</script>

<template>
  <section class="panel" :data-panel="title">
    <header class="panel-head">
      <div class="panel-title">
        <span>{{ title }}</span>
        <span v-if="count !== undefined" class="panel-count tabular">{{ count }}</span>
      </div>
      <div v-if="hint" class="panel-hint">{{ hint }}</div>
      <div class="panel-actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="panel-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.panel {
  background: var(--vigil-bg-raised);
  border: 1px solid var(--vigil-border);
  border-radius: 4px;
  overflow: hidden;
}

.panel-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--vigil-border);
}

.panel-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 14px;
  font-weight: 500;
}

.panel-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--vigil-text-3);
}

.panel-hint {
  font-size: 12px;
  color: var(--vigil-text-3);
}

.panel-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.panel-body {
  padding: 16px;
}
</style>
