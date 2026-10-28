<script setup lang="ts">
/**
 * 总览页。
 *
 * 回答五个问题：
 *   1. 现在有多严重？      → 统计卡片（受时间范围约束）
 *   2. 是涨了还是跌了？    → 错误趋势图 + 错误率
 *   3. 是哪几条问题在爆？  → Top 问题横向条形图
 *   4. 分布在哪儿？        → 分类分布 + Top 责任点
 *   5. 我现在该处理什么？  → 待处理问题列表
 *
 * ## 所有数字都受**时间范围**约束
 *
 * 顶栏选的时间范围是全局的，这一页所有卡片和图表都跟着它走。
 * 「累计发生」这类没有时间维度的说法会误导人 ——
 * 面板上看到的每个数字都应该能回答「这是多长时间里的」。
 */
import { computed, inject, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { getErrorTrend, getIssueStats, listIssues } from '../api/client'
import { categoryLabel } from '../format'
import {
  localTzOffsetMinutes,
  PANEL_CONTEXT,
  resolveTimeRange,
  type ErrorTrend,
  type IssueRow,
  type IssueStats
} from '../types'
import BarList from '../components/BarList.vue'
import PanelSection from '../components/PanelSection.vue'
import StatCard from '../components/StatCard.vue'
import StatusTag from '../components/StatusTag.vue'
import TrendChart from '../components/TrendChart.vue'

const ctx = inject(PANEL_CONTEXT)!
const router = useRouter()

const stats = ref<IssueStats | null>(null)
const issues = ref<IssueRow[]>([])
const trend = ref<ErrorTrend | null>(null)
const loading = ref(false)

/** 当前时间范围的档位标签 —— 卡片提示里要写清楚 */
const rangeLabel = computed(
  () => ctx.timeRangeOptions.find((option) => option.key === ctx.timeRange)?.label ?? ''
)

/**
 * 窗口内的错误率。
 *
 * 分母是**页面访问次数** —— 没有分母的错误数说明不了严重性：
 * 100 次错误可能是 1000 次访问里的 10%，也可能是 10 次访问里的 10 倍。
 *
 * 分母为 0 时是「无访问」，不是「0%」。
 */
const errorRate = computed(() => {
  const points = trend.value?.points ?? []
  const occurrences = points.reduce((sum, point) => sum + point.occurrences, 0)
  const transactions = points.reduce((sum, point) => sum + point.transactions, 0)
  if (transactions === 0) return null
  return (occurrences / transactions) * 100
})

const cards = computed(() => [
  {
    label: '去重错误',
    value: stats.value?.total ?? 0,
    hint: `${rangeLabel.value}内按指纹聚合的问题条数`
  },
  {
    label: '发生次数',
    value: stats.value?.occurrences ?? 0,
    hint: `${rangeLabel.value}内的错误发生总数`
  },
  {
    label: '错误率',
    value: errorRate.value === null ? '—' : `${errorRate.value.toFixed(2)}%`,
    hint: '发生次数 ÷ 页面访问次数'
  },
  {
    label: '待处理',
    value: stats.value?.unresolved ?? 0,
    hint: `${rangeLabel.value}内发生且尚未解决`
  },
  {
    label: '回归中',
    value: stats.value?.regressed ?? 0,
    hint: '已解决的问题在新版本再次出现'
  }
])

const topIssueBars = computed(() =>
  issues.value.map((issue) => ({
    label: issue.title,
    value: issue.window_count ?? issue.count
  }))
)

const categoryBars = computed(() =>
  (stats.value?.byCategory ?? []).map((item) => ({
    label: categoryLabel(item.category),
    value: item.occurrences
  }))
)

const culpritBars = computed(() =>
  (stats.value?.topCulprits ?? []).map((item) => ({
    label: item.culprit,
    value: item.occurrences
  }))
)

const trendPoints = computed(() => trend.value?.points ?? [])

async function load(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null) {
    stats.value = null
    issues.value = []
    trend.value = null
    return
  }

  loading.value = true
  try {
    // 时间窗每次请求都重算 —— 「最近 1 小时」必须是滚动的
    const { since, until, bucket } = resolveTimeRange(ctx.timeRange)

    const [stat, list, errorTrend] = await Promise.all([
      getIssueStats(projectId, { since, until }),
      listIssues(projectId, {
        status: 'unresolved',
        limit: 10,
        sort: 'count',
        since,
        until
      }),
      getErrorTrend(projectId, {
        since,
        until,
        bucket,
        tzOffset: localTzOffsetMinutes()
      })
    ])
    stats.value = stat
    issues.value = list.issues
    trend.value = errorTrend
  } catch (error) {
    ElMessage.error(`加载总览数据失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    loading.value = false
  }
}

function openIssue(issue: IssueRow): void {
  void router.push(`/issues/${issue.id}`)
}

watch(
  () => ctx.projectId,
  () => void load()
)
watch(
  () => ctx.refreshToken,
  () => void load()
)
// 时间范围一变就得重载 —— 换了范围还显示旧数据是最糟的情况
watch(
  () => ctx.timeRange,
  () => void load()
)
onMounted(() => void load())
</script>

<template>
  <div v-loading="loading" class="overview">
    <section class="cards">
      <StatCard
        v-for="card in cards"
        :key="card.label"
        :label="card.label"
        :value="card.value"
        :hint="card.hint"
      />
    </section>

    <PanelSection
      title="错误趋势"
      :count="trendPoints.length"
      :hint="`${rangeLabel} · 按${trend?.bucket === 'hour' ? '小时' : '天'}分桶`"
    >
      <TrendChart :points="trendPoints" :bucket="trend?.bucket ?? 'day'" unit=" 次" />
    </PanelSection>

    <PanelSection title="Top 问题" :count="topIssueBars.length" hint="按窗口内发生次数排序">
      <BarList :items="topIssueBars" unit=" 次" empty-text="当前没有待处理的问题" />
    </PanelSection>

    <div class="split">
      <PanelSection title="分类分布" :count="categoryBars.length">
        <BarList :items="categoryBars" unit=" 次" empty-text="暂无分类数据" />
      </PanelSection>

      <PanelSection title="Top 责任点" :count="culpritBars.length">
        <BarList :items="culpritBars" unit=" 次" empty-text="暂无责任点数据" />
      </PanelSection>
    </div>

    <PanelSection title="待处理问题" :count="issues.length">
      <template #actions>
        <el-button size="small" @click="router.push('/issues')">查看全部</el-button>
      </template>

      <ul v-if="issues.length > 0" class="issue-list">
        <li v-for="issue in issues" :key="issue.id" class="issue-item" @click="openIssue(issue)">
          <StatusTag :status="issue.status" :substatus="issue.substatus" />
          <span class="issue-title">{{ issue.title }}</span>
          <span class="issue-short tabular">{{ issue.short_id }}</span>
          <span class="issue-count tabular">
            {{ (issue.window_count ?? issue.count).toLocaleString('zh-CN') }} 次
          </span>
        </li>
      </ul>
      <div v-else class="empty-hint">当前没有待处理的问题</div>
    </PanelSection>
  </div>
</template>

<style scoped>
.overview {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
}

.split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}

.issue-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.issue-item {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr) 90px 90px;
  align-items: center;
  gap: 12px;
  padding: 9px 4px;
  border-bottom: 1px solid var(--vigil-border);
  cursor: pointer;
}

.issue-item:last-child {
  border-bottom: none;
}

.issue-item:hover {
  background: rgba(255, 255, 255, 0.035);
}

.issue-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--vigil-text-1);
  font-size: 13px;
}

.issue-short {
  color: var(--vigil-text-3);
  font-size: 11px;
}

.issue-count {
  color: var(--vigil-text-1);
  font-size: 13px;
  text-align: right;
}

.empty-hint {
  padding: 28px;
  text-align: center;
  color: var(--vigil-text-3);
  font-size: 13px;
}

@media (max-width: 1400px) {
  .cards {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 1200px) {
  .split {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 900px) {
  .cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
