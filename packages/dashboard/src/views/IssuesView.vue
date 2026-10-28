<script setup lang="ts">
/**
 * 问题列表页 —— 面板的核心页面。
 *
 * 「问题」不是错误流水，是工单：一条指纹聚合出来的问题带着完整生命周期。
 * 所以这一页的重点不是把行显示出来，而是**批量处理**：
 * 一次选中若干条，一起解决 / 归档 / 收藏 / 标记已阅。
 */
import { computed, inject, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type TableInstance } from 'element-plus'
import { bulkIssueAction, listIssues } from '../api/client'
import { categoryLabel, relativeTime } from '../format'
import {
  ISSUE_LEVEL_LABELS,
  PANEL_CONTEXT,
  resolveTimeRange,
  type ArchiveStrategy,
  type IssueBulkAction,
  type IssueCategory,
  type IssueLevel,
  type IssueRow,
  type IssueSort,
  type IssueStatus,
  type IssueSubstatus
} from '../types'
import PanelSection from '../components/PanelSection.vue'
import StatusTag from '../components/StatusTag.vue'

const ctx = inject(PANEL_CONTEXT)!
const router = useRouter()

interface TabDef {
  key: string
  label: string
  query: { status?: IssueStatus; substatus?: IssueSubstatus }
}

const tabs: TabDef[] = [
  { key: 'unresolved', label: '待处理', query: { status: 'unresolved' } },
  { key: 'new', label: '新建', query: { status: 'unresolved', substatus: 'new' } },
  { key: 'regressed', label: '回归', query: { status: 'unresolved', substatus: 'regressed' } },
  { key: 'escalating', label: '升级', query: { status: 'unresolved', substatus: 'escalating' } },
  { key: 'resolved', label: '已解决', query: { status: 'resolved' } },
  { key: 'archived', label: '已归档', query: { status: 'archived' } },
  { key: 'all', label: '全部', query: {} }
]

const SORT_OPTIONS: Array<{ value: IssueSort; label: string }> = [
  { value: 'priority', label: '优先级' },
  { value: 'last_seen', label: '最近出现' },
  { value: 'count', label: '发生次数' },
  { value: 'user_count', label: '受影响用户' }
]

const CATEGORY_OPTIONS: Array<{ value: IssueCategory; label: string }> = [
  { value: 'javascript', label: 'JS 错误' },
  { value: 'resource', label: '资源加载' },
  { value: 'http', label: '接口错误' }
]

const activeTab = ref('unresolved')
const keyword = ref('')
const category = ref<'' | IssueCategory>('')
const sort = ref<IssueSort>('priority')
const page = ref(1)
const pageSize = ref(50)

const issues = ref<IssueRow[]>([])
const total = ref(0)
const loading = ref(false)
const selected = ref<IssueRow[]>([])

const tableRef = ref<TableInstance | null>(null)

const bulkResolveVisible = ref(false)
const bulkResolveRelease = ref('')
const bulkArchiveVisible = ref(false)
const bulkArchiveStrategy = ref<ArchiveStrategy>('forever')

const activeTabLabel = computed(
  () => tabs.find((tab) => tab.key === activeTab.value)?.label ?? '全部'
)

function levelType(level: string): 'danger' | 'warning' | 'info' {
  if (level === 'fatal') return 'danger'
  if (level === 'error') return 'warning'
  return 'info'
}

async function load(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null) {
    issues.value = []
    total.value = 0
    return
  }

  loading.value = true
  try {
    const tab = tabs.find((item) => item.key === activeTab.value)
    // 时间窗跟着顶栏的范围走 —— 列表里的「发生次数」也要是窗口内的
    const { since, until } = resolveTimeRange(ctx.timeRange)
    const list = await listIssues(projectId, {
      ...tab?.query,
      q: keyword.value || undefined,
      category: category.value || undefined,
      sort: sort.value,
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
      since,
      until
    })
    issues.value = list.issues
    total.value = list.total
  } catch (error) {
    ElMessage.error(`加载问题列表失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    loading.value = false
  }
}

function reloadFromFirstPage(): void {
  page.value = 1
  void load()
}

function onTabChange(): void {
  reloadFromFirstPage()
}

function onSearch(): void {
  reloadFromFirstPage()
}

function onSortChange(): void {
  reloadFromFirstPage()
}

function onSelectionChange(rows: IssueRow[]): void {
  selected.value = rows
}

function openIssue(issue: IssueRow): void {
  void router.push(`/issues/${issue.id}`)
}

async function runBulk(action: IssueBulkAction, extra: Record<string, string> = {}): Promise<void> {
  const projectId = ctx.projectId
  const ids = selected.value.map((issue) => issue.id)
  if (projectId === null || ids.length === 0) return

  try {
    const affected = await bulkIssueAction(projectId, { issueIds: ids, action, ...extra })
    ElMessage.success(`已处理 ${affected} 条问题`)
    selected.value = []
    tableRef.value?.clearSelection()
    await load()
  } catch (error) {
    ElMessage.error(`批量操作失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function bulkResolve(): Promise<void> {
  if (bulkResolveRelease.value.trim() === '') {
    await ElMessageBox.alert(
      '没有填写解决版本时，问题仍处于待处理状态，回归判定将失去锚点。',
      '确认未填写解决版本？',
      { confirmButtonText: '继续', cancelButtonText: '返回填写', type: 'warning' }
    )
  }
  const release = bulkResolveRelease.value.trim()
  bulkResolveVisible.value = false
  bulkResolveRelease.value = ''
  await runBulk('resolve', release ? { release } : {})
}

async function bulkArchive(): Promise<void> {
  const strategy = bulkArchiveStrategy.value
  bulkArchiveVisible.value = false
  await runBulk('archive', { archiveStrategy: strategy })
}

watch(
  () => ctx.projectId,
  () => reloadFromFirstPage()
)
watch(
  () => ctx.refreshToken,
  () => void load()
)
// 时间范围变了，列表要跟着变（而且回到第一页 —— 页码在新的结果集里没有意义）
watch(
  () => ctx.timeRange,
  () => reloadFromFirstPage()
)
onMounted(() => void load())
</script>

<template>
  <div class="issues-page">
    <el-tabs v-model="activeTab" class="status-tabs" @tab-change="onTabChange">
      <el-tab-pane v-for="tab in tabs" :key="tab.key" :label="tab.label" :name="tab.key" />
    </el-tabs>

    <div class="toolbar">
      <el-input
        v-model="keyword"
        class="search-input"
        placeholder="搜索标题 / 消息 / 责任点"
        clearable
        @keyup.enter="onSearch"
        @clear="onSearch"
      />

      <el-select
        v-model="category"
        class="category-select"
        placeholder="全部分类"
        clearable
        @change="onSearch"
      >
        <el-option
          v-for="option in CATEGORY_OPTIONS"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>

      <el-select v-model="sort" class="sort-select" @change="onSortChange">
        <el-option
          v-for="option in SORT_OPTIONS"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>

      <div class="toolbar-count tabular">
        共 {{ total.toLocaleString('zh-CN') }} 条 · {{ activeTabLabel }}
      </div>
    </div>

    <div v-if="selected.length > 0" class="bulk-bar">
      <span class="bulk-count tabular">已选 {{ selected.length }} 条</span>
      <el-button size="small" type="primary" @click="bulkResolveVisible = true">批量解决</el-button>
      <el-button size="small" @click="bulkArchiveVisible = true">批量归档</el-button>
      <el-button size="small" @click="runBulk('bookmark')">批量收藏</el-button>
      <el-button size="small" @click="runBulk('mark_seen')">批量标记已阅</el-button>
    </div>

    <PanelSection title="问题列表" :count="total">
      <el-table
        ref="tableRef"
        v-loading="loading"
        :data="issues"
        row-key="id"
        size="default"
        @selection-change="onSelectionChange"
        @row-click="openIssue"
      >
        <el-table-column type="selection" width="42" />

        <el-table-column label="状态" width="86">
          <template #default="{ row }">
            <StatusTag :status="row.status" :substatus="row.substatus" />
          </template>
        </el-table-column>

        <el-table-column label="级别" width="72">
          <template #default="{ row }">
            <el-tag :type="levelType(row.level)" size="small" effect="plain">
              {{ ISSUE_LEVEL_LABELS[row.level as IssueLevel] ?? row.level }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="问题" min-width="340">
          <template #default="{ row }">
            <div class="issue-name">{{ row.title }}</div>
            <div class="issue-message">{{ row.message || '—' }}</div>
          </template>
        </el-table-column>

        <el-table-column label="分类" width="92">
          <template #default="{ row }">
            <span class="muted">{{ categoryLabel(row.category) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="责任点" min-width="180">
          <template #default="{ row }">
            <span class="path">{{ row.culprit || '—' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="次数" width="86" align="right">
          <template #default="{ row }">
            <span class="tabular strong">
              {{ (row.window_count ?? row.count).toLocaleString('zh-CN') }}
            </span>
          </template>
        </el-table-column>

        <el-table-column label="用户" width="78" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ row.user_count.toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>

        <el-table-column label="最近出现" width="120">
          <template #default="{ row }">
            <span class="tabular muted">{{ relativeTime(row.last_seen) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="环境" width="96">
          <template #default="{ row }">
            <span class="muted">{{ row.environment || '—' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="版本" width="96">
          <template #default="{ row }">
            <span class="tabular muted">{{ row.release || '—' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="80" fixed="right">
          <template #default="{ row }">
            <el-button link size="small" @click.stop="openIssue(row)">详情</el-button>
          </template>
        </el-table-column>

        <template #empty>
          <div class="empty-hint">没有匹配当前筛选条件的问题</div>
        </template>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="total"
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          background
          @current-change="load"
          @size-change="reloadFromFirstPage"
        />
      </div>
    </PanelSection>

    <el-dialog v-model="bulkResolveVisible" title="批量标记已解决" width="420px">
      <el-form label-width="88px">
        <el-form-item label="解决版本">
          <el-input
            v-model="bulkResolveRelease"
            placeholder="例如 1.4.3（回归判定的锚）"
            clearable
          />
        </el-form-item>
      </el-form>
      <p class="dialog-hint">
        填写解决版本后，这条问题在更新的版本里再次出现时会被判定为<b>回归</b>。
      </p>
      <template #footer>
        <el-button @click="bulkResolveVisible = false">取消</el-button>
        <el-button type="primary" @click="bulkResolve">确认解决</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="bulkArchiveVisible" title="批量归档" width="420px">
      <el-form label-width="88px">
        <el-form-item label="归档策略">
          <el-select v-model="bulkArchiveStrategy" class="full-width">
            <el-option label="永久归档" value="forever" />
            <el-option label="直到错误量突增" value="until_escalating" />
            <el-option label="直到发生 N 次" value="until_count" />
            <el-option label="直到影响 N 个用户" value="until_user_count" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="bulkArchiveVisible = false">取消</el-button>
        <el-button type="primary" @click="bulkArchive">确认归档</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.issues-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 标签页只当筛选器用：内容统一在下面的表格里，不重复渲染 N 份 */
.status-tabs :deep(.el-tabs__content) {
  display: none;
}

.status-tabs :deep(.el-tabs__header) {
  margin-bottom: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.search-input {
  width: 280px;
}

.category-select {
  width: 140px;
}

.sort-select {
  width: 150px;
}

.toolbar-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--vigil-text-3);
}

.bulk-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border: 1px solid var(--vigil-border-strong);
  border-radius: 4px;
  background: var(--vigil-bg-raised);
}

.bulk-count {
  font-size: 13px;
  color: var(--vigil-text-1);
}

.issue-name {
  font-size: 12px;
  color: var(--vigil-text-3);
  margin-bottom: 2px;
}

.issue-message {
  color: var(--vigil-text-1);
  word-break: break-word;
}

.strong {
  font-weight: 500;
  font-size: 14px;
}

.muted {
  color: var(--vigil-text-2);
}

.path {
  font-family: 'SF Mono', 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  color: var(--vigil-text-2);
  word-break: break-all;
}

.empty-hint {
  padding: 28px;
  color: var(--vigil-text-3);
  font-size: 13px;
}

.pager {
  display: flex;
  justify-content: flex-end;
  padding-top: 14px;
}

.full-width {
  width: 100%;
}

.dialog-hint {
  margin: 0;
  font-size: 12px;
  color: var(--vigil-text-3);
  line-height: 1.6;
}
</style>
