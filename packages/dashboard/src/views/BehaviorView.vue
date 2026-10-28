<script setup lang="ts">
/**
 * 用户行为页。
 *
 * 行为数据和错误数据是两种东西：行为量大、绝大多数正常，
 * 所以这里看的是**占比和分布**，不是绝对值排行榜。
 *
 * ## 隐私边界
 *
 * 采集端**不记录任何输入内容** —— 只记「点了某个按钮」，
 * 不记「在搜索框里输入了 xxx」。
 * 所以这一页能回答「用户点了什么」，但**永远回答不了「用户输入了什么」**。
 * 这个边界是设计出来的，不是没实现。
 */
import { computed, inject, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { getBehaviorSummary } from '../api/client'
import { PANEL_CONTEXT, resolveTimeRange, type BehaviorSummary } from '../types'
import PanelSection from '../components/PanelSection.vue'
import StatCard from '../components/StatCard.vue'
import BarList from '../components/BarList.vue'
import { formatDuration } from '../format'

const ctx = inject(PANEL_CONTEXT)!

const summary = ref<BehaviorSummary | null>(null)
const loading = ref(false)

const trendItems = computed(() =>
  (summary.value?.trend ?? []).map((row) => ({
    label: row.date,
    value: row.views
  }))
)

const clickItems = computed(() =>
  (summary.value?.clicks ?? []).map((row) => ({
    label: row.name,
    value: row.count
  }))
)

const topPages = computed(() => summary.value?.topPages ?? [])
const entryPages = computed(() => summary.value?.entryPages ?? [])
const exitPages = computed(() => summary.value?.exitPages ?? [])
const topPaths = computed(() => summary.value?.topPaths ?? [])

async function load(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null) {
    summary.value = null
    return
  }

  loading.value = true
  try {
    // 时间窗跟着顶栏的范围走 —— 访问次数必须说清是多久的
    const { since, until } = resolveTimeRange(ctx.timeRange)
    summary.value = await getBehaviorSummary(projectId, { since, until })
  } catch (error) {
    ElMessage.error(`加载行为数据失败：${error instanceof Error ? error.message : String(error)}`)
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
  <div v-loading="loading" class="behavior-page">
    <section class="stats">
      <StatCard label="访问次数" :value="summary?.pageViews ?? 0" hint="页面访问总数" />
      <StatCard label="会话数" :value="summary?.sessions ?? 0" hint="去重后的会话" />
      <StatCard label="用户数" :value="summary?.users ?? 0" hint="去重后的用户" />
      <StatCard
        label="平均停留"
        :value="summary?.avgDurationMs ?? 0"
        unit="ms"
        hint="单次事件平均间隔"
      />
    </section>

    <PanelSection title="每日访问趋势" :count="trendItems.length" hint="按天分桶">
      <BarList :items="trendItems" unit=" 次" empty-text="暂无访问记录" />
    </PanelSection>

    <PanelSection title="热门页面" :count="topPages.length" hint="按访问次数排序">
      <el-table :data="topPages" size="small">
        <el-table-column prop="path" label="页面" min-width="260" />
        <el-table-column label="访问次数" width="110" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ row.views.toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="平均停留" width="130" align="right">
          <template #default="{ row }">
            <span class="tabular strong">{{ formatDuration(row.avgDurationMs) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="跳出率" width="110" align="right">
          <template #default="{ row }">
            <span class="tabular muted">{{ Math.round(row.bounceRate * 100) }}%</span>
          </template>
        </el-table-column>
        <template #empty>
          <div class="empty-hint">暂无页面访问记录</div>
        </template>
      </el-table>
    </PanelSection>

    <div class="two-col">
      <PanelSection title="入口页" :count="entryPages.length">
        <el-table :data="entryPages" size="small">
          <el-table-column prop="path" label="页面" min-width="160" />
          <el-table-column label="次数" width="90" align="right">
            <template #default="{ row }">
              <span class="tabular">{{ row.count.toLocaleString('zh-CN') }}</span>
            </template>
          </el-table-column>
          <template #empty>
            <div class="empty-hint">暂无数据</div>
          </template>
        </el-table>
      </PanelSection>

      <PanelSection title="出口页" :count="exitPages.length">
        <el-table :data="exitPages" size="small">
          <el-table-column prop="path" label="页面" min-width="160" />
          <el-table-column label="次数" width="90" align="right">
            <template #default="{ row }">
              <span class="tabular">{{ row.count.toLocaleString('zh-CN') }}</span>
            </template>
          </el-table-column>
          <template #empty>
            <div class="empty-hint">暂无数据</div>
          </template>
        </el-table>
      </PanelSection>
    </div>

    <PanelSection title="点击分布" :count="clickItems.length" hint="只记点击目标，不记输入内容">
      <BarList :items="clickItems" unit=" 次" empty-text="暂无点击记录" />
    </PanelSection>

    <PanelSection title="访问路径" :count="topPaths.length" hint="会话前 5 步的组合">
      <el-table :data="topPaths" size="small">
        <el-table-column label="路径" min-width="360">
          <template #default="{ row }">
            <span class="path">{{ row.path.join(' → ') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="会话数" width="110" align="right">
          <template #default="{ row }">
            <span class="tabular strong">{{ row.count.toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <template #empty>
          <div class="empty-hint">暂无路径数据</div>
        </template>
      </el-table>
    </PanelSection>
  </div>
</template>

<style scoped>
.behavior-page {
  display: flex;
  flex-direction: column;
  gap: var(--vigil-space-5);
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--vigil-space-3);
}

.two-col {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--vigil-space-5);
}

.strong {
  font-weight: 500;
}

.muted {
  color: var(--vigil-text-2);
}

.path {
  font-size: var(--vigil-text-xs);
  color: var(--vigil-text-2);
}

.empty-hint {
  padding: var(--vigil-space-6);
  text-align: center;
  color: var(--vigil-text-3);
  font-size: var(--vigil-text-sm);
}

@media (max-width: 1200px) {
  .stats {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 900px) {
  .two-col {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
