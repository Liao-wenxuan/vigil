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
  Fold,
  Odometer,
  Pointer,
  Refresh,
  Setting,
  TrendCharts,
  VideoCamera,
  Warning
} from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { listOrganizations, listProjects } from '../api/client'
import {
  DEFAULT_TIME_RANGE,
  PANEL_CONTEXT,
  TIME_RANGE_OPTIONS,
  type PanelContext,
  type ProjectRow,
  type TimeRangeKey
} from '../types'

const STORAGE_PROJECT = 'vigil.projectId'
const STORAGE_RANGE = 'vigil.timeRange'
const REFRESH_INTERVAL = 10_000
/** 窄屏断点：侧边导航收成抽屉 */
const NARROW_QUERY = '(max-width: 1023px)'

const route = useRoute()

const navItems = [
  { to: '/', label: '总览', icon: Odometer, section: '' },
  { to: '/issues', label: '问题', icon: Warning, section: '' },
  { to: '/performance', label: '性能', icon: TrendCharts, section: '' },
  { to: '/sessions', label: '会话回放', icon: VideoCamera, section: '' },
  { to: '/behavior', label: '用户行为', icon: Pointer, section: '' },
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
  timeRange: DEFAULT_TIME_RANGE,
  timeRangeOptions: TIME_RANGE_OPTIONS,
  selectOrganization: () => undefined,
  selectProject: () => undefined,
  requestRefresh: () => undefined,
  setTimeRange: () => undefined
})

provide(PANEL_CONTEXT, context)

/** 项目选择器按组织分组 */
const projectGroups = computed(() =>
  context.organizations.map((org) => ({
    org,
    projects: context.projects.filter((project) => project.organization_id === org.id)
  }))
)

const pageTitle = computed(() => (typeof route.meta.title === 'string' ? route.meta.title : ''))

const pageDesc = computed(() => (typeof route.meta.desc === 'string' ? route.meta.desc : ''))

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

/** 恢复上次选的时间范围 */
function restoreTimeRange(): void {
  const saved = localStorage.getItem(STORAGE_RANGE) as TimeRangeKey | null
  if (saved && TIME_RANGE_OPTIONS.some((option) => option.key === saved)) {
    context.timeRange = saved
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

/**
 * 切换时间范围。
 *
 * 存到 localStorage —— 刷新页面不丢，跟项目选择一样。
 * 换了范围要立刻重载数据，不能等下一次自动刷新（10 秒）。
 */
function setTimeRange(key: TimeRangeKey): void {
  if (context.timeRange === key) return
  context.timeRange = key
  localStorage.setItem(STORAGE_RANGE, key)
  context.refreshToken += 1
}

context.selectProject = selectProject
context.selectOrganization = selectOrganization
context.requestRefresh = requestRefresh
context.setTimeRange = setTimeRange

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

// ============================================================
// 窄屏：侧边导航收成抽屉
// ============================================================
//
// 224px 的固定侧栏在 375px 的手机上会把内容区挤到 151px ——
// 直接横向溢出。窄屏改成覆盖式抽屉，点遮罩关闭。
const isNarrow = ref(false)
const navOpen = ref(false)
let mediaQuery: MediaQueryList | null = null

function syncNarrow(event: MediaQueryList | MediaQueryListEvent): void {
  isNarrow.value = event.matches
  if (!event.matches) navOpen.value = false
}

function closeNav(): void {
  navOpen.value = false
}

onMounted(async () => {
  mediaQuery = window.matchMedia(NARROW_QUERY)
  isNarrow.value = mediaQuery.matches
  mediaQuery.addEventListener('change', syncNarrow)

  restoreTimeRange()
  await loadProjects()
  restartTimer()
})

onUnmounted(() => {
  if (timer !== undefined) window.clearInterval(timer)
  mediaQuery?.removeEventListener('change', syncNarrow)
})
</script>

<template>
  <div class="shell">
    <!-- 窄屏遮罩 -->
    <div v-if="isNarrow && navOpen" class="scrim" aria-hidden="true" @click="closeNav"></div>

    <aside class="sidebar" :class="{ 'is-open': navOpen }">
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

      <nav class="nav" @click="closeNav">
        <RouterLink
          v-for="item in navItems"
          :key="`${item.to}-${item.section}`"
          :to="item.to"
          class="nav-item"
          :class="{ 'is-active': isActive(item) }"
        >
          <el-icon class="nav-icon"><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
          <span class="nav-indicator" aria-hidden="true"></span>
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
          <el-button
            v-if="isNarrow"
            class="menu-btn"
            :icon="Fold"
            text
            aria-label="打开导航"
            @click="navOpen = true"
          ></el-button>

          <span class="crumb-project">{{ context.project?.name ?? '未选择项目' }}</span>
          <span class="crumb-sep">/</span>
          <span class="crumb-current">{{ pageTitle }}</span>
        </div>

        <div class="topbar-actions">
          <!-- 时间范围：全局控制。监控面板最常问的问题是
               「最近多久」，它得是**一眼可见**的，不能藏在某个页面里。 -->
          <div class="range">
            <span class="range-label">时间范围</span>
            <el-select v-model="context.timeRange" class="range-select" @change="setTimeRange">
              <el-option
                v-for="option in context.timeRangeOptions"
                :key="option.key"
                :label="option.label"
                :value="option.key"
              />
            </el-select>
          </div>

          <el-tooltip content="每 10 秒自动刷新当前页数据" placement="bottom">
            <el-switch v-model="autoRefresh" />
          </el-tooltip>
          <el-button :icon="Refresh" @click="refreshAll">刷新</el-button>
        </div>
      </header>

      <main class="content">
        <!-- 页面标题：每个页面都有一个真正的 h1。
             数据面板的层级不靠字号堆叠，靠的是
             「26px 标题 / 15px 区块标题 / 13px 正文 / 11px 元信息」四层。 -->
        <header class="page-head">
          <h1 class="page-title">{{ pageTitle }}</h1>
          <p v-if="pageDesc" class="page-desc">{{ pageDesc }}</p>
        </header>

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
  padding: var(--vigil-space-5) var(--vigil-space-3);
  background: var(--vigil-bg-sunken);
  border-right: 1px solid var(--vigil-border);
  display: flex;
  flex-direction: column;
  gap: var(--vigil-space-4);
  position: sticky;
  top: 0;
  align-self: flex-start;
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--vigil-space-2);
}

.brand-mark {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  background: var(--vigil-accent);
}

.brand-name {
  font-size: var(--vigil-text-md);
  font-weight: 600;
  letter-spacing: var(--vigil-tracking-tight);
}

.brand-sub {
  margin-top: -6px;
  font-size: var(--vigil-text-2xs);
  color: var(--vigil-text-3);
}

.picker-label {
  font-size: var(--vigil-text-2xs);
  color: var(--vigil-text-3);
  letter-spacing: var(--vigil-tracking-wide);
  margin-bottom: var(--vigil-space-1);
}

.project-select {
  width: 100%;
}

.opt-name {
  margin-right: var(--vigil-space-3);
}

.opt-slug {
  float: right;
  color: var(--vigil-text-3);
  font-size: var(--vigil-text-2xs);
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--vigil-space-2);
  /* 44px：主导航是面板里最高频的点击目标，鼠标和手指都要够得着 */
  min-height: 44px;
  padding: var(--vigil-space-2) var(--vigil-space-3);
  border-radius: var(--vigil-radius);
  color: var(--vigil-text-2);
  text-decoration: none;
  font-size: var(--vigil-text-sm);
  border: 1px solid transparent;
  transition:
    background var(--vigil-motion-fast) var(--vigil-ease-standard),
    color var(--vigil-motion-fast) var(--vigil-ease-standard),
    border-color var(--vigil-motion-fast) var(--vigil-ease-standard);
}

.nav-item:hover {
  background: var(--vigil-bg-raised);
  color: var(--vigil-text-1);
}

/* 选中态用强调色 —— 强调色只表示「当前在哪」，不表示数据大小。
   左侧那条竖线是「你在哪」的第二个信号：只看颜色的话，
   色觉障碍用户分不出，选中态就消失了。 */
.nav-item.is-active {
  color: var(--vigil-accent);
  border-color: var(--vigil-border-strong);
  background: var(--vigil-bg-raised);
}

.nav-indicator {
  position: absolute;
  left: -13px;
  top: 50%;
  width: 2px;
  height: 18px;
  margin-top: -9px;
  border-radius: 1px;
  background: transparent;
  transition: background var(--vigil-motion-fast) var(--vigil-ease-standard);
}

.nav-item.is-active .nav-indicator {
  background: var(--vigil-accent);
}

.nav-icon {
  font-size: 15px;
}

.sidebar-foot {
  border-top: 1px solid var(--vigil-border);
  padding-top: var(--vigil-space-3);
  display: flex;
  flex-direction: column;
  gap: var(--vigil-space-1);
}

.foot-label {
  font-size: var(--vigil-text-2xs);
  color: var(--vigil-text-3);
}

.foot-slug {
  font-size: var(--vigil-text-xs);
  color: var(--vigil-text-2);
  word-break: break-all;
}

/* ---- 顶栏 ---- */
.main {
  flex: 1;
  /* 关键：不加 min-width:0，表格的最小宽度会把整个页面撑宽 */
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.topbar {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--vigil-space-4);
  padding: 0 var(--vigil-space-5);
  border-bottom: 1px solid var(--vigil-border);
  background: var(--vigil-bg-sunken);
  position: sticky;
  top: 0;
  z-index: 10;
}

.crumbs {
  display: flex;
  align-items: center;
  gap: var(--vigil-space-2);
  font-size: var(--vigil-text-sm);
  min-width: 0;
}

.menu-btn {
  margin-left: -8px;
  flex: 0 0 auto;
}

.crumb-project {
  color: var(--vigil-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.crumb-sep {
  color: var(--vigil-text-3);
}

.crumb-current {
  color: var(--vigil-text-1);
  font-weight: 500;
  white-space: nowrap;
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: var(--vigil-space-3);
  flex: 0 0 auto;
}

/* ---- 时间范围 ---- */
.range {
  display: flex;
  align-items: center;
  gap: var(--vigil-space-2);
}

.range-label {
  font-size: var(--vigil-text-2xs);
  color: var(--vigil-text-3);
  letter-spacing: var(--vigil-tracking-wide);
  white-space: nowrap;
}

.range-select {
  width: 132px;
}

/* ---- 内容区 ---- */
.content {
  padding: var(--vigil-space-6) var(--vigil-space-5) var(--vigil-space-12);
  display: flex;
  flex-direction: column;
  gap: var(--vigil-space-5);
  max-width: 1680px;
  width: 100%;
}

/* 页面标题：整个面板唯一的 26px */
.page-head {
  display: flex;
  flex-direction: column;
  gap: var(--vigil-space-1);
  padding-bottom: var(--vigil-space-1);
}

.page-title {
  margin: 0;
  font-size: var(--vigil-text-2xl);
  font-weight: 600;
  line-height: var(--vigil-leading-tight);
  letter-spacing: var(--vigil-tracking-tight);
  color: var(--vigil-text-1);
}

.page-desc {
  margin: 0;
  font-size: var(--vigil-text-sm);
  color: var(--vigil-text-3);
  line-height: var(--vigil-leading-normal);
}

/* ---- 窄屏 ---- */
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 30;
}

@media (max-width: 1023px) {
  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 40;
    transform: translateX(-100%);
    transition: transform var(--vigil-motion-standard) var(--vigil-ease-out);
  }

  .sidebar.is-open {
    transform: translateX(0);
  }

  .nav-indicator {
    display: none;
  }

  .content {
    padding: var(--vigil-space-5) var(--vigil-space-4) var(--vigil-space-10);
  }
}

/**
 * 窄屏：顶栏塞不下「时间范围」四个字了。
 *
 * 320px 下多出的 48px 横向溢出就是它造成的 ——
 * 标签本身是冗余的：选择器里写着「最近 7 天」，意思已经自明。
 */
@media (max-width: 768px) {
  .range-label {
    display: none;
  }

  .range-select {
    width: 112px;
  }
}
</style>
