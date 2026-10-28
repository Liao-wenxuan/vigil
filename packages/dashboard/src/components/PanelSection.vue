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
  border-radius: var(--vigil-radius);
  overflow: hidden;
}

.panel-head {
  display: flex;
  align-items: center;
  gap: var(--vigil-space-3);
  padding: var(--vigil-space-3) var(--vigil-space-4);
  border-bottom: 1px solid var(--vigil-border);
}

/* 区块标题：15px / 600 —— 和 26px 的页面标题拉开一档，
   和 13px 的正文也拉开一档。层级是三层的，不是两层的。 */
.panel-title {
  display: flex;
  align-items: baseline;
  gap: var(--vigil-space-2);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: var(--vigil-tracking-tight);
  color: var(--vigil-text-1);
}

.panel-count {
  font-size: var(--vigil-text-xs);
  font-weight: 400;
  color: var(--vigil-text-3);
}

.panel-hint {
  font-size: var(--vigil-text-xs);
  color: var(--vigil-text-3);
}

.panel-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--vigil-space-2);
}

.panel-body {
  padding: var(--vigil-space-4);
}
</style>
