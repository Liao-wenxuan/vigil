<script setup lang="ts">
/**
 * 总览页。
 *
 * 回答四个问题：
 *   1. 现在有多严重？      → 4 张统计卡片
 *   2. 是哪几条问题在爆？  → Top 问题横向条形图
 *   3. 分布在哪儿？        → 分类分布 + Top 责任点
 *   4. 我现在该处理什么？  → 待处理问题列表
 */
import { computed, inject, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { getIssueStats, listIssues } from '../api/client'
import { categoryLabel } from '../format'
import { PANEL_CONTEXT, type IssueRow, type IssueStats } from '../types'
import BarList from '../components/BarList.vue'
import PanelSection from '../components/PanelSection.vue'
import StatCard from '../components/StatCard.vue'
import StatusTag from '../components/StatusTag.vue'

const ctx = inject(PANEL_CONTEXT)!
const router = useRouter()

const stats = ref<IssueStats | null>(null)
const issues = ref<IssueRow[]>([])
const loading = ref(false)

const cards = computed(() => [
  {
    label: '去重错误',
    value: stats.value?.total ?? 0,
    hint: '按指纹聚合后的问题条数'
  },
  {
    label: '累计发生',
    value: stats.value?.occurrences ?? 0,
    hint: '所有问题的发生次数总和'
  },
  {
    label: '待处理',
    value: stats.value?.unresolved ?? 0,
    hint: '尚未解决的问题'
  },
  {
    label: '回归中',
    value: stats.value?.regressed ?? 0,
    hint: '已解决的问题在新版本再次出现'
  }
])

const topIssueBars = computed(() =>
  issues.value.map((issue) => ({ label: issue.title, value: issue.count }))
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

async function load(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null) {
    stats.value = null
    issues.value = []
    return
  }

  loading.value = true
  try {
    const [stat, list] = await Promise.all([
      getIssueStats(projectId),
      listIssues(projectId, { status: 'unresolved', limit: 10, sort: 'count' })
    ])
    stats.value = stat
    issues.value = list.issues
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

    <PanelSection title="Top 问题" :count="topIssueBars.length" hint="按发生次数排序">
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
          <span class="issue-count tabular">{{ issue.count.toLocaleString('zh-CN') }} 次</span>
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
  grid-template-columns: repeat(4, 1fr);
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

@media (max-width: 1200px) {
  .cards {
    grid-template-columns: repeat(2, 1fr);
  }

  .split {
    grid-template-columns: 1fr;
  }
}
</style>
