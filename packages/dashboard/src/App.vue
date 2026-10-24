<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Refresh, Warning } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { fetchApps, fetchErrors, fetchStats } from './api'
import { categoryLabel, categoryType, relativeTime } from './format'
import type { AppInfo, ErrorRow, Stats } from './types'
import ErrorDetailDrawer from './components/ErrorDetailDrawer.vue'

const apps = ref<AppInfo[]>([])
const currentAppId = ref('')
const errors = ref<ErrorRow[]>([])
const total = ref(0)
const stats = ref<Stats | null>(null)
const loading = ref(false)
const loadError = ref('')
const keyword = ref('')
const categoryFilter = ref('')
const autoRefresh = ref(true)
const drawerOpen = ref(false)
const selected = ref<ErrorRow | null>(null)

/** 统计卡片 —— 数字一律白色，强调色只用于状态 */
const cards = computed(() => {
  const s = stats.value
  return [
    { label: '去重错误', value: s?.totals.distinct_errors ?? 0, hint: '按指纹聚合后的条数' },
    { label: '累计发生', value: s?.totals.occurrences ?? 0, hint: '所有错误的发生次数总和' },
    { label: '受影响接口', value: s?.topEndpoints.length ?? 0, hint: '返回错误的接口数量' },
    { label: '覆盖浏览器', value: s?.browsers.length ?? 0, hint: '出现过错误的浏览器种类' }
  ]
})

const currentApp = computed(() => apps.value.find((app) => app.app_id === currentAppId.value))

async function loadApps() {
  const result = await fetchApps()
  apps.value = result.apps
  if (!currentAppId.value && apps.value.length > 0) {
    currentAppId.value = apps.value[0].app_id
  }
}

async function loadData() {
  if (!currentAppId.value) return
  loading.value = true
  loadError.value = ''

  try {
    const [list, stat] = await Promise.all([
      fetchErrors(currentAppId.value, {
        limit: 100,
        q: keyword.value || undefined,
        category: categoryFilter.value || undefined
      }),
      fetchStats(currentAppId.value)
    ])
    errors.value = list.errors
    total.value = list.total
    stats.value = stat
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

async function refreshAll() {
  try {
    await loadApps()
    await loadData()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

function openDetail(row: ErrorRow) {
  selected.value = row
  drawerOpen.value = true
}

function onAppChange() {
  void loadData()
}

function onSearch() {
  void loadData()
}

let timer: ReturnType<typeof setInterval> | null = null

function restartTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (autoRefresh.value) {
    timer = setInterval(() => {
      void loadData()
    }, 10000)
  }
}

onMounted(async () => {
  await refreshAll()
  restartTimer()
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="vigil-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark"></span>
        <span class="brand-name">Vigil</span>
        <span class="brand-sub">前端错误监控</span>
      </div>

      <div class="topbar-right">
        <el-select
          v-model="currentAppId"
          class="app-select"
          placeholder="选择应用"
          @change="onAppChange"
        >
          <el-option v-for="app in apps" :key="app.app_id" :label="app.name" :value="app.app_id">
            <span>{{ app.name }}</span>
            <span class="option-id tabular">{{ app.app_id }}</span>
          </el-option>
        </el-select>

        <el-input
          v-model="keyword"
          class="search-input"
          placeholder="搜索消息或路径"
          clearable
          @keyup.enter="onSearch"
          @clear="onSearch"
        />

        <el-select
          v-model="categoryFilter"
          class="category-select"
          placeholder="全部分类"
          clearable
          @change="onSearch"
        >
          <el-option label="JS 错误" value="javascript" />
          <el-option label="资源加载" value="resource" />
          <el-option label="接口错误" value="http" />
        </el-select>

        <el-tooltip content="每 10 秒自动刷新" placement="bottom">
          <el-switch v-model="autoRefresh" @change="restartTimer" />
        </el-tooltip>

        <el-button :icon="Refresh" :loading="loading" @click="refreshAll">刷新</el-button>
      </div>
    </header>

    <main class="content">
      <div v-if="loadError" class="load-error">
        <el-icon><Warning /></el-icon>
        <span>{{ loadError }}</span>
      </div>

      <section class="cards">
        <div v-for="card in cards" :key="card.label" class="card">
          <div class="card-label">{{ card.label }}</div>
          <div class="card-value tabular">{{ card.value.toLocaleString('zh-CN') }}</div>
          <div class="card-hint">{{ card.hint }}</div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div class="panel-title">
            错误列表
            <span class="panel-count tabular">共 {{ total }} 条去重错误</span>
          </div>
          <div v-if="currentApp" class="panel-meta">
            <span>{{ currentApp.name }}</span>
            <span class="dot">·</span>
            <span class="tabular">{{ currentApp.app_id }}</span>
          </div>
        </div>

        <el-table
          v-loading="loading"
          :data="errors"
          row-key="fingerprint"
          size="default"
          @row-click="openDetail"
        >
          <el-table-column label="分类" width="110">
            <template #default="{ row }">
              <el-tag :type="categoryType(row.category)" size="small" effect="plain">
                {{ categoryLabel(row.category) }}
              </el-tag>
            </template>
          </el-table-column>

          <el-table-column label="错误" min-width="420">
            <template #default="{ row }">
              <div class="err-name">{{ row.name || row.kind }}</div>
              <div class="err-msg">{{ row.message }}</div>
            </template>
          </el-table-column>

          <el-table-column
            label="次数"
            width="90"
            align="right"
            sortable
            :sort-by="(row: ErrorRow) => row.count"
          >
            <template #default="{ row }">
              <span class="tabular err-count">{{ row.count }}</span>
            </template>
          </el-table-column>

          <el-table-column label="最近出现" width="130">
            <template #default="{ row }">
              <span class="tabular muted">{{ relativeTime(row.last_seen) }}</span>
            </template>
          </el-table-column>

          <el-table-column label="浏览器" width="110">
            <template #default="{ row }">
              <span class="muted">{{ row.browser || '未知' }}</span>
            </template>
          </el-table-column>

          <el-table-column label="页面" min-width="200">
            <template #default="{ row }">
              <span class="muted path">{{ row.url_path || row.url || '—' }}</span>
            </template>
          </el-table-column>

          <el-table-column label="版本" width="100">
            <template #default="{ row }">
              <span class="tabular muted">{{ row.release || '—' }}</span>
            </template>
          </el-table-column>

          <template #empty>
            <div class="empty-hint">没有匹配的错误</div>
          </template>
        </el-table>
      </section>

      <section v-if="stats" class="panel">
        <div class="panel-head">
          <div class="panel-title">分布</div>
        </div>

        <div class="dist-grid">
          <div class="dist-block">
            <div class="dist-title">按分类</div>
            <div v-for="item in stats.byCategory" :key="item.category" class="dist-row">
              <span class="dist-label">{{ categoryLabel(item.category) }}</span>
              <div class="dist-bar">
                <div
                  class="dist-bar-fill"
                  :style="{
                    width: `${
                      (item.occurrences / Math.max(...stats.byCategory.map((c) => c.occurrences))) *
                      100
                    }%`
                  }"
                ></div>
              </div>
              <span class="tabular dist-value">{{ item.occurrences }}</span>
            </div>
          </div>

          <div class="dist-block">
            <div class="dist-title">按接口</div>
            <div v-for="item in stats.topEndpoints" :key="item.url_path" class="dist-row">
              <span class="dist-label path">{{ item.url_path }}</span>
              <div class="dist-bar">
                <div
                  class="dist-bar-fill"
                  :style="{
                    width: `${
                      (item.occurrences /
                        Math.max(...stats.topEndpoints.map((c) => c.occurrences))) *
                      100
                    }%`
                  }"
                ></div>
              </div>
              <span class="tabular dist-value">{{ item.occurrences }}</span>
            </div>
          </div>

          <div class="dist-block">
            <div class="dist-title">按浏览器</div>
            <div v-for="item in stats.browsers" :key="item.browser" class="dist-row">
              <span class="dist-label">{{ item.browser }}</span>
              <div class="dist-bar">
                <div
                  class="dist-bar-fill"
                  :style="{
                    width: `${(item.n / Math.max(...stats.browsers.map((c) => c.n))) * 100}%`
                  }"
                ></div>
              </div>
              <span class="tabular dist-value">{{ item.n }}</span>
            </div>
          </div>
        </div>
      </section>
    </main>

    <ErrorDetailDrawer
      v-model="drawerOpen"
      :app-id="currentAppId"
      :error="selected"
      @changed="loadData"
    />
  </div>
</template>

<style scoped>
.vigil-shell {
  min-height: 100%;
  background: var(--vigil-bg);
}

/* ---- 顶栏 ---- */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 0 24px;
  height: 60px;
  border-bottom: 1px solid var(--vigil-border);
  background: var(--vigil-bg-sunken);
  position: sticky;
  top: 0;
  z-index: 10;
}

.brand {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.brand-mark {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  background: var(--vigil-accent);
  align-self: center;
}

.brand-name {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.brand-sub {
  font-size: 12px;
  color: var(--vigil-text-3);
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.app-select {
  width: 190px;
}
.search-input {
  width: 220px;
}
.category-select {
  width: 130px;
}

.option-id {
  float: right;
  color: var(--vigil-text-3);
  font-size: 11px;
  margin-left: 16px;
}

/* ---- 内容 ---- */
.content {
  padding: 20px 24px 48px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 1600px;
  margin: 0 auto;
}

.load-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border: 1px solid var(--vigil-danger);
  border-radius: 4px;
  color: var(--vigil-danger);
  font-size: 13px;
}

/* ---- 统计卡片 ---- */
.cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.card {
  background: var(--vigil-bg-raised);
  border: 1px solid var(--vigil-border);
  border-radius: 4px;
  padding: 16px 18px;
}

.card-label {
  font-size: 12px;
  color: var(--vigil-text-3);
  letter-spacing: 0.03em;
}

.card-value {
  font-size: 30px;
  font-weight: 500;
  line-height: 1.25;
  margin-top: 6px;
  color: var(--vigil-text-1);
}

.card-hint {
  font-size: 11px;
  color: var(--vigil-text-3);
  margin-top: 4px;
}

/* ---- 面板 ---- */
.panel {
  background: var(--vigil-bg-raised);
  border: 1px solid var(--vigil-border);
  border-radius: 4px;
  overflow: hidden;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--vigil-border);
}

.panel-title {
  font-size: 14px;
  font-weight: 500;
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.panel-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--vigil-text-3);
}

.panel-meta {
  font-size: 12px;
  color: var(--vigil-text-3);
  display: flex;
  gap: 6px;
}

.dot {
  opacity: 0.5;
}

/* ---- 表格内文字 ---- */
.err-name {
  font-size: 12px;
  color: var(--vigil-text-3);
  margin-bottom: 2px;
}

.err-msg {
  color: var(--vigil-text-1);
  word-break: break-word;
}

.err-count {
  font-weight: 500;
  font-size: 15px;
}

.muted {
  color: var(--vigil-text-2);
}

.path {
  font-family: 'SF Mono', 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
}

.empty-hint {
  padding: 32px;
  color: var(--vigil-text-3);
  font-size: 13px;
}

/* ---- 分布 ---- */
.dist-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0;
}

.dist-block {
  padding: 16px 18px;
  border-right: 1px solid var(--vigil-border);
}

.dist-block:last-child {
  border-right: none;
}

.dist-title {
  font-size: 12px;
  color: var(--vigil-text-3);
  margin-bottom: 12px;
  letter-spacing: 0.03em;
}

.dist-row {
  display: grid;
  grid-template-columns: 150px 1fr 52px;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.dist-label {
  font-size: 12px;
  color: var(--vigil-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dist-bar {
  height: 6px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 3px;
  overflow: hidden;
}

.dist-bar-fill {
  height: 100%;
  background: var(--vigil-accent);
  border-radius: 3px;
  transition: width 0.25s ease;
}

.dist-value {
  font-size: 12px;
  text-align: right;
  color: var(--vigil-text-1);
}

@media (max-width: 1200px) {
  .cards {
    grid-template-columns: repeat(2, 1fr);
  }
  .dist-grid {
    grid-template-columns: 1fr;
  }
  .dist-block {
    border-right: none;
    border-bottom: 1px solid var(--vigil-border);
  }
}
</style>
