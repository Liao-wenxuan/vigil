<script setup lang="ts">
/**
 * 面板外壳：左侧固定导航 + 右侧内容区。
 *
 * 这一层持有**整个面板共享的状态**（组织、项目、当前项目、刷新节拍），
 * 通过 provide/inject 分发给子页面 —— 页面之间不互相引用，也不各自存一份项目 id。
 *
 * 自动刷新：顶栏开关默认开，每 10 秒把 refreshToken +1，
 * 页面 watch 这个计数器来决定要不要重载数据。
 */
import { computed, onMounted, onUnmounted, provide, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  Bell,
  Files,
  Odometer,
  Refresh,
  Setting,
  TrendCharts,
  Warning
} from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { listOrganizations, listProjects } from '../api/client'
import { PANEL_CONTEXT, type PanelContext, type ProjectRow } from '../types'

const STORAGE_PROJECT = 'vigil.projectId'
const REFRESH_INTERVAL = 10_000

const route = useRoute()

const navItems = [
  { to: '/', label: '总览', icon: Odometer, section: '' },
  { to: '/issues', label: '问题', icon: Warning, section: '' },
  { to: '/performance', label: '性能', icon: TrendCharts, section: '' },
  { to: '/alerts', label: '告警', icon: Bell, section: '' },
  {
    to: '/settings?section=environments',
    label: '环境与版本',
    icon: Files,
    section: 'environments'
  },
  { to: '/settings', label: '设置', icon: Setting, section: '' }
]

const context = reactive<PanelContext>({
  organizations: [],
  projects: [],
  organizationId: null,
  projectId: null,
  project: null,
  loadingProjects: false,
  projectsError: '',
  refreshToken: 0,
  selectOrganization: () => undefined,
  selectProject: () => undefined,
  requestRefresh: () => undefined
})

provide(PANEL_CONTEXT, context)

/** 项目选择器按组织分组 */
const projectGroups = computed(() =>
  context.organizations.map((org) => ({
    org,
    projects: context.projects.filter((project) => project.organization_id === org.id)
  }))
)

const breadcrumb = computed(() => {
  const title = typeof route.meta.title === 'string' ? route.meta.title : ''
  const projectName = context.project?.name ?? '未选择项目'
  return title ? [projectName, title] : [projectName]
})

const projectSlug = computed(() => context.project?.slug ?? '—')

function isActive(item: { to: string; section: string }): boolean {
  const path = item.to.split('?')[0]
  if (route.path !== path) return false
  const section = typeof route.query.section === 'string' ? route.query.section : ''
  return section === item.section
}

/** 载入组织与项目，并把选中的项目落到 localStorage（刷新页面不丢） */
async function loadProjects(): Promise<void> {
  context.loadingProjects = true
  context.projectsError = ''

  try {
    const organizations = await listOrganizations()
    const lists = await Promise.all(
      organizations.map((org) => listProjects(org.id).catch(() => [] as ProjectRow[]))
    )

    context.organizations = organizations
    context.projects = lists.flat()

    const saved = Number(localStorage.getItem(STORAGE_PROJECT) ?? '')
    const picked =
      context.projects.find((project) => project.id === saved) ?? context.projects[0] ?? null
    context.projectId = picked?.id ?? null
  } catch (error) {
    context.projectsError = error instanceof Error ? error.message : String(error)
    ElMessage.error(`加载项目列表失败：${context.projectsError}`)
  } finally {
    context.loadingProjects = false
  }
}

function selectProject(id: number | null): void {
  context.projectId = id
}

function selectOrganization(id: number | null): void {
  const first = context.projects.find((project) => project.organization_id === id)
  context.projectId = first?.id ?? null
}

function requestRefresh(): void {
  context.refreshToken += 1
}

context.selectProject = selectProject
context.selectOrganization = selectOrganization
context.requestRefresh = requestRefresh

watch(
  () => context.projectId,
  (id) => {
    const row = context.projects.find((project) => project.id === id) ?? null
    context.project = row
    context.organizationId = row?.organization_id ?? null
    if (id !== null) localStorage.setItem(STORAGE_PROJECT, String(id))
  },
  { immediate: true }
)

const autoRefresh = ref(true)

let timer: number | undefined

function restartTimer(): void {
  if (timer !== undefined) {
    window.clearInterval(timer)
    timer = undefined
  }
  if (!autoRefresh.value) return
  timer = window.setInterval(() => {
    context.refreshToken += 1
  }, REFRESH_INTERVAL)
}

watch(autoRefresh, () => restartTimer())

async function refreshAll(): Promise<void> {
  requestRefresh()
  await loadProjects()
}

onMounted(async () => {
  await loadProjects()
  restartTimer()
})

onUnmounted(() => {
  if (timer !== undefined) window.clearInterval(timer)
})
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark"></span>
        <span class="brand-name">Vigil</span>
      </div>
      <div class="brand-sub">前端错误监控</div>

      <div class="picker">
        <div class="picker-label">当前项目</div>
        <el-select
          v-model="context.projectId"
          class="project-select"
          placeholder="选择项目"
          :loading="context.loadingProjects"
          @change="selectProject"
        >
          <el-option-group
            v-for="group in projectGroups"
            :key="group.org.id"
            :label="group.org.name"
          >
            <el-option
              v-for="project in group.projects"
              :key="project.id"
              :label="project.name"
              :value="project.id"
            >
              <span class="opt-name">{{ project.name }}</span>
              <span class="opt-slug tabular">{{ project.slug }}</span>
            </el-option>
          </el-option-group>
        </el-select>
      </div>

      <nav class="nav">
        <RouterLink
          v-for="item in navItems"
          :key="`${item.to}-${item.section}`"
          :to="item.to"
          class="nav-item"
          :class="{ 'is-active': isActive(item) }"
        >
          <el-icon class="nav-icon"><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar-foot">
        <span class="foot-label">项目标识</span>
        <span class="foot-slug tabular">{{ projectSlug }}</span>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="crumbs">
          <span class="crumb-project">{{ context.project?.name ?? '未选择项目' }}</span>
          <span class="crumb-sep">/</span>
          <span class="crumb-current">{{ breadcrumb[breadcrumb.length - 1] }}</span>
        </div>

        <div class="topbar-actions">
          <el-tooltip content="每 10 秒自动刷新当前页数据" placement="bottom">
            <el-switch v-model="autoRefresh" />
          </el-tooltip>
          <el-button :icon="Refresh" @click="refreshAll">刷新</el-button>
        </div>
      </header>

      <main class="content">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  min-height: 100%;
  background: var(--vigil-bg);
}

/* ---- 侧边导航 ---- */
.sidebar {
  width: 224px;
  flex: 0 0 224px;
  min-height: 100vh;
  padding: 18px 14px;
  background: var(--vigil-bg-sunken);
  border-right: 1px solid var(--vigil-border);
  display: flex;
  flex-direction: column;
  gap: 16px;
  position: sticky;
  top: 0;
  align-self: flex-start;
}

.brand {
  display: flex;
  align-items: center;
  gap: 9px;
}

.brand-mark {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  background: var(--vigil-accent);
}

.brand-name {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.brand-sub {
  margin-top: -10px;
  font-size: 11px;
  color: var(--vigil-text-3);
}

.picker-label {
  font-size: 11px;
  color: var(--vigil-text-3);
  letter-spacing: 0.04em;
  margin-bottom: 6px;
}

.project-select {
  width: 100%;
}

.opt-name {
  margin-right: 12px;
}

.opt-slug {
  float: right;
  color: var(--vigil-text-3);
  font-size: 11px;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border-radius: 4px;
  color: var(--vigil-text-2);
  text-decoration: none;
  font-size: 13px;
  border: 1px solid transparent;
}

.nav-item:hover {
  background: var(--vigil-bg-raised);
  color: var(--vigil-text-1);
}

/* 选中态用强调色 —— 强调色只表示「当前在哪」，不表示数据大小 */
.nav-item.is-active {
  color: var(--vigil-accent);
  border-color: var(--vigil-border-strong);
  background: var(--vigil-bg-raised);
}

.nav-icon {
  font-size: 15px;
}

.sidebar-foot {
  border-top: 1px solid var(--vigil-border);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.foot-label {
  font-size: 11px;
  color: var(--vigil-text-3);
}

.foot-slug {
  font-size: 12px;
  color: var(--vigil-text-2);
  word-break: break-all;
}

/* ---- 顶栏 ---- */
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.topbar {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 22px;
  border-bottom: 1px solid var(--vigil-border);
  background: var(--vigil-bg-sunken);
  position: sticky;
  top: 0;
  z-index: 10;
}

.crumbs {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}

.crumb-project {
  color: var(--vigil-text-1);
  font-weight: 500;
}

.crumb-sep {
  color: var(--vigil-text-3);
}

.crumb-current {
  color: var(--vigil-text-2);
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.content {
  padding: 20px 22px 48px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 1680px;
  width: 100%;
}
</style>
