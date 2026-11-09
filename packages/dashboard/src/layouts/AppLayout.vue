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
  Warning,
  Aim
} from '@element-plus/icons-vue'
import {
  fetchCurrentPrincipal,
  listOrganizations,
  listProjects,
  MEMBER_TOKEN_STORAGE,
  type CurrentPrincipal
} from '../api/client'
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
  { to: '/slo', label: 'SLO 与预算', icon: Aim, section: '' },
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

// ---- 成员凭据（只读演示 / 个人登录）----
//
// 访客默认带「只读演示令牌」看演示数据（由 nginx 注入 window.VIGIL_DEMO_MEMBER_TOKEN）；
// 拿到自己 vmk_ 令牌的人可以在这里登录，以成员身份看自己组织的数据。
// 管理员走 Basic Auth，不经过这套 UI。
//
// ⚠️ 身份**以后端返回为准**，不靠 localStorage 猜。
// 靠猜会出这种错：管理员在浏览器里登录了面板密码（Basic Auth），
// 但 localStorage 里没有成员令牌，界面就会显示「只读演示」——
// 实际上他是管理员。反过来，管理员的浏览器里往往**同时**存着
// 演示令牌，光看令牌也判断不出真实权限。
const userMemberToken = ref<string | null>(localStorage.getItem(MEMBER_TOKEN_STORAGE))

/** 后端认定的身份。null = 没登录成功（连只读演示都没生效） */
const principal = ref<CurrentPrincipal | null>(null)

/**
 * 界面上的身份标签。
 *
 * - admin：面板登录（Basic Auth）成功 → 超管
 * - user：用自己的成员令牌登录 → 显示脱敏后的令牌
 * - demo：匿名访客用部署时注入的只读令牌 → 只读
 * - none：什么都拿不到
 */
const authMode = computed<'admin' | 'user' | 'demo' | 'none'>(() => {
  if (principal.value?.kind === 'superadmin') return 'admin'
  if (userMemberToken.value) return 'user'
  if (principal.value?.kind === 'member') return 'demo'
  return 'none'
})

const loginOpen = ref(false)
const loginInput = ref('')

/** 把 vmk_ 遮成 vmk_****abcd，避免令牌全文泄露在界面上 */
const maskedUserToken = computed(() => {
  const t = userMemberToken.value ?? ''
  return t.length > 8 ? `${t.slice(0, 8)}…${t.slice(-4)}` : t
})

/** 面板登录后（Basic Auth）浏览器会带上凭据，重新问一次后端就能确认身份 */
async function refreshPrincipal(): Promise<void> {
  principal.value = await fetchCurrentPrincipal()
}

function loginWithToken(): void {
  const value = loginInput.value.trim()
  if (!value) return
  if (!value.startsWith('vmk_')) {
    window.alert('成员令牌应以 vmk_ 开头')
    return
  }
  localStorage.setItem(MEMBER_TOKEN_STORAGE, value)
  // 换身份后整个面板重新拉数据，最简单也最不容易漏
  window.location.reload()
}

function logoutMember(): void {
  localStorage.removeItem(MEMBER_TOKEN_STORAGE)
  window.location.reload()
}

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
  // 身份要先问清楚：面板登录（Basic Auth）和只读演示都走同一个 /api，
  // 只有后端知道这次请求到底算谁。
  await refreshPrincipal()
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

          <!-- 成员身份：只读演示 / 个人登录 / 管理员 -->
          <el-tag v-if="authMode === 'demo'" type="info" effect="plain" size="small">
            只读演示
          </el-tag>
          <el-tag v-else-if="authMode === 'user'" type="success" effect="plain" size="small">
            成员 {{ maskedUserToken }}
          </el-tag>
          <el-tag v-else-if="authMode === 'admin'" type="warning" effect="plain" size="small">
            管理员
          </el-tag>

          <el-popover v-model:visible="loginOpen" :width="320" trigger="click" placement="bottom">
            <template #reference>
              <el-button v-if="authMode !== 'user'" size="small">登录成员</el-button>
              <el-button v-else size="small" @click="logoutMember">退出</el-button>
            </template>
            <div class="member-login">
              <p class="member-login-tip">
                粘贴你的 <code>vmk_</code> 成员令牌，以成员身份查看自己组织的数据。
                管理员请在浏览器弹出的登录框输入面板密码。
              </p>
              <el-input
                v-model="loginInput"
                size="small"
                placeholder="vmk_…"
                @keyup.enter="loginWithToken"
              />
              <div class="member-login-actions">
                <el-button size="small" @click="loginOpen = false">取消</el-button>
                <el-button type="primary" size="small" @click="loginWithToken">登录</el-button>
              </div>
            </div>
          </el-popover>

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

/* ---- 成员登录弹层 ---- */
.member-login {
  display: flex;
  flex-direction: column;
  gap: var(--vigil-space-3);
}

.member-login-tip {
  margin: 0;
  font-size: var(--vigil-text-2xs);
  line-height: 1.5;
  color: var(--vigil-text-3);
}

.member-login-tip code {
  font-family: var(--vigil-mono);
  background: var(--vigil-bg-2);
  padding: 0 4px;
  border-radius: 4px;
}

.member-login-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--vigil-space-2);
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
 * 窄屏：顶栏塞不下「时间范围」四个字了 —— 标签冗余，选择器里写着
 * 「最近 7 天」，意思已经自明。
 *
 * ⚠️ 更正旧注释：早期 320px 只多出 48px，是标签造成的；v0.5 加了
 *    「身份标签 + 登录成员」之后，右侧固定宽度涨到约 464px，
 *    溢出变成 464 − 视口宽（320→+144 / 375→+89 / 414→+50 / 768→0），
 *    八个页面一起挂 —— 因为顶栏是共用外壳。
 *    根因是 .topbar-actions 的 `flex: 0 0 auto` 死不收缩。
 *    所以窄屏改成**换行**而不是继续藏控件：功能一个不少，宽度不再硬撑。
 */
@media (max-width: 768px) {
  .range-label {
    display: none;
  }

  .range-select {
    width: 112px;
  }

  .topbar {
    height: auto;
    min-height: 56px;
    flex-direction: column;
    align-items: stretch;
    justify-content: flex-start;
    gap: var(--vigil-space-2);
    padding: var(--vigil-space-2) var(--vigil-space-3);
  }

  .crumbs,
  .topbar-actions {
    width: 100%;
  }

  .topbar-actions {
    flex-wrap: wrap;
    gap: var(--vigil-space-2);
  }
}
</style>
