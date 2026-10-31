<script setup lang="ts">
/**
 * 性能页。
 *
 * 性能数据和错误数据是两种东西：性能量大、正常占绝大多数，
 * 所以这里看的是**分位数**（P50/P75/P95），不是平均值。
 *
 * 平均值会把长尾抹平 —— 一个 3 秒的页面配一堆 100 毫秒的页面，
 * 平均 200 毫秒看着挺好，实际上有一半用户等了三秒。
 */
import { computed, inject, onMounted, ref, watch } from 'vue'
import { getErrorPerformance, getPerformanceSummary } from '../api/client'
import {
  PANEL_CONTEXT,
  resolveTimeRange,
  type ErrorPerformanceRow,
  type PerformanceSummary
} from '../types'
import PanelSection from '../components/PanelSection.vue'
import PercentileChart from '../components/PercentileChart.vue'

const ctx = inject(PANEL_CONTEXT)!

const summary = ref<PerformanceSummary | null>(null)
const errorRows = ref<ErrorPerformanceRow[]>([])
const loading = ref(false)

interface VitalCard {
  key: string
  label: string
  unit: string
  p50: number
  p75: number
  p95: number
  count: number
}

const vitalCards = computed<VitalCard[]>(() => {
  const vitals = summary.value?.vitals
  if (!vitals) return []
  return [
    { key: 'lcp', label: 'LCP 最大内容绘制', unit: 'ms', ...pick(vitals.lcp) },
    { key: 'fcp', label: 'FCP 首次内容绘制', unit: 'ms', ...pick(vitals.fcp) },
    { key: 'inp', label: 'INP 交互延迟', unit: 'ms', ...pick(vitals.inp) },
    { key: 'cls', label: 'CLS 布局偏移', unit: '', ...pick(vitals.cls) }
  ]
})

const percentileItems = computed(() =>
  vitalCards.value.map((card) => ({
    label: card.key.toUpperCase(),
    p50: card.p50,
    p75: card.p75,
    p95: card.p95,
    unit: card.unit === 'ms' ? ' ms' : ''
  }))
)

const byNameRows = computed(() => summary.value?.byName ?? [])
const topSpans = computed(() => summary.value?.topSpans ?? [])
const slowTransactions = computed(() => summary.value?.slowTransactions ?? [])

function pick(percentiles: { p50: number; p75: number; p95: number; count: number }): {
  p50: number
  p75: number
  p95: number
  count: number
} {
  return {
    p50: percentiles.p50,
    p75: percentiles.p75,
    p95: percentiles.p95,
    count: percentiles.count
  }
}

function formatMs(value: number | null): string {
  if (value === null || value === undefined) return '—'
  return `${value.toLocaleString('zh-CN')} ms`
}

function formatScore(value: number | null): string {
  if (value === null || value === undefined) return '—'
  return value.toLocaleString('zh-CN')
}

async function load(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null) {
    summary.value = null
    errorRows.value = []
    return
  }

  loading.value = true
  try {
    // 时间窗跟着顶栏的范围走 —— 性能数据的「P95」必须说清是多久的 P95
    const { since, until } = resolveTimeRange(ctx.timeRange)
    const [perf, correlation] = await Promise.all([
      getPerformanceSummary(projectId, { since, until }),
      getErrorPerformance(projectId, since)
    ])
    summary.value = perf
    errorRows.value = correlation
  } catch (error) {
    ElMessage.error(`加载性能数据失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    loading.value = false
  }
}

watch(
  () => ctx.projectId,
  () => void load()
)
watch(
  () => ctx.refreshToken,
  () => void load()
)
watch(
  () => ctx.timeRange,
  () => void load()
)
onMounted(() => void load())
</script>

<template>
  <div v-loading="loading" class="perf-page">
    <section class="vitals">
      <div v-for="card in vitalCards" :key="card.key" class="vital-card">
        <div class="vital-label">{{ card.label }}</div>
        <div class="vital-p95 tabular">
          {{ formatScore(card.p95) }}<span class="vital-unit">{{ card.unit }}</span>
        </div>
        <div class="vital-rows">
          <div class="vital-row">
            <span>P50</span>
            <span class="tabular">{{ formatScore(card.p50) }}{{ card.unit }}</span>
          </div>
          <div class="vital-row">
            <span>P75</span>
            <span class="tabular">{{ formatScore(card.p75) }}{{ card.unit }}</span>
          </div>
          <div class="vital-row">
            <span>样本</span>
            <span class="tabular">{{ card.count.toLocaleString('zh-CN') }}</span>
          </div>
        </div>
      </div>
    </section>

    <PanelSection title="分位数区间" hint="P50 → P95 的分布区间">
      <PercentileChart :items="percentileItems" />
    </PanelSection>

    <PanelSection title="页面维度" :count="byNameRows.length">
      <el-table :data="byNameRows" size="small">
        <el-table-column prop="name" label="页面 / 路由" min-width="220" />
        <el-table-column label="事务数" width="110" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ row.transactions.toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="LCP P95" width="130" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ formatMs(row.lcp.p95) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="耗时 P95" width="130" align="right">
          <template #default="{ row }">
            <span class="tabular strong">{{ formatMs(row.duration.p95) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="耗时 P50" width="130" align="right">
          <template #default="{ row }">
            <span class="tabular muted">{{ formatMs(row.duration.p50) }}</span>
          </template>
        </el-table-column>
        <template #empty>
          <div class="empty-hint">暂无性能事务数据</div>
        </template>
      </el-table>
    </PanelSection>

    <PanelSection title="最慢接口" :count="topSpans.length" hint="按 P95 排序">
      <el-table :data="topSpans" size="small">
        <el-table-column prop="name" label="名称" min-width="220" />
        <el-table-column prop="type" label="类型" width="96" />
        <el-table-column label="次数" width="100" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ row.count.toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="平均" width="120" align="right">
          <template #default="{ row }">
            <span class="tabular muted">{{ formatMs(row.avg) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="P95" width="120" align="right">
          <template #default="{ row }">
            <span class="tabular strong">{{ formatMs(row.p95) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最大" width="120" align="right">
          <template #default="{ row }">
            <span class="tabular muted">{{ formatMs(row.max) }}</span>
          </template>
        </el-table-column>
        <template #empty>
          <div class="empty-hint">暂无接口耗时数据</div>
        </template>
      </el-table>
    </PanelSection>

    <PanelSection title="慢页面" :count="slowTransactions.length">
      <el-table :data="slowTransactions" size="small">
        <el-table-column prop="name" label="页面 / 路由" min-width="200" />
        <el-table-column label="耗时" width="130" align="right">
          <template #default="{ row }">
            <span class="tabular strong">{{ formatMs(row.duration_ms) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="LCP" width="130" align="right">
          <template #default="{ row }">
            <span class="tabular muted">{{ formatMs(row.lcp) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="page_url" label="页面地址" min-width="260" />
        <template #empty>
          <div class="empty-hint">暂无慢页面记录</div>
        </template>
      </el-table>
    </PanelSection>

    <PanelSection title="错误与性能关联" :count="errorRows.length" hint="报错时页面的 LCP 平均值">
      <el-table :data="errorRows" size="small">
        <el-table-column prop="title" label="问题" min-width="260" />
        <el-table-column label="发生次数" width="110" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ row.count.toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="平均 LCP" width="130" align="right">
          <template #default="{ row }">
            <span class="tabular strong">{{ formatMs(row.avgLcp) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="fingerprint" label="指纹" min-width="200" />
        <template #empty>
          <div class="empty-hint">暂无关联数据（上报时带上性能快照才会出现）</div>
        </template>
      </el-table>
    </PanelSection>
  </div>
</template>

<style scoped>
.perf-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.vitals {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.vital-card {
  background: var(--vigil-bg-raised);
  border: 1px solid var(--vigil-border);
  border-radius: 4px;
  padding: 15px 17px;
}

.vital-label {
  font-size: 12px;
  color: var(--vigil-text-3);
}

.vital-p95 {
  font-size: 26px;
  font-weight: 500;
  color: var(--vigil-text-1);
  margin: 6px 0 8px;
  line-height: 1.2;
}

.vital-unit {
  font-size: 13px;
  color: var(--vigil-text-3);
  margin-left: 3px;
}

.vital-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px solid var(--vigil-border);
  padding-top: 8px;
}

.vital-row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--vigil-text-3);
}

.vital-row span:last-child {
  color: var(--vigil-text-2);
}

.strong {
  font-weight: 500;
}

.muted {
  color: var(--vigil-text-2);
}

.empty-hint {
  padding: 28px;
  text-align: center;
  color: var(--vigil-text-3);
  font-size: 13px;
}

@media (max-width: 1200px) {
  .vitals {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
