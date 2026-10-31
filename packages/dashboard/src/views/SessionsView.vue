<script setup lang="ts">
/**
 * 会话回放页。
 *
 * ## 播放器为什么自己画控制条
 *
 * `rrweb-player` 自带的控制条是一块**浅色**的第三方组件，
 * 类名带 Svelte 的 hash（`.rr-controller.svelte-1difoxs`）——
 * 想改它的颜色只能靠猜 hash，rrweb-player 一升级就失效。
 *
 * 所以这里关掉自带控制条（`showController: false`），
 * 用播放器的公开 API 自己画：播放 / 暂停、倍速、拖动定位、时间读数。
 *
 * 好处不止是好看：**面板的界面闸门量的是我们自己的 UI**，
 * 不是第三方组件的颜色和字号。
 *
 * ## 流的合法性要先验
 *
 * rrweb 的回放是「一个全量快照 + 一串增量」。
 * 快照不在流里的话，播放器**不会报错，只会静默播不出来**。
 * 所以挂载前先验一遍，缺快照就把话说清楚，而不是给一个空白框。
 */
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { VideoPause, VideoPlay } from '@element-plus/icons-vue'
import type PlayerClass from 'rrweb-player'
import 'rrweb-player/dist/style.css'
import { getSessionReplay, listSessions } from '../api/client'
import { PANEL_CONTEXT, type ReplayStreamEvent, type SessionRow } from '../types'
import PanelSection from '../components/PanelSection.vue'
import StatCard from '../components/StatCard.vue'
import { formatBytes, formatDate, formatDuration, relativeTime } from '../format'

/** rrweb 的全量快照事件类型 —— 增量链的起点 */
const FULL_SNAPSHOT_TYPE = 2

/** 播放器画布高度 */
const PLAYER_HEIGHT = 420

/** 倍速档位 */
const SPEEDS = [0.5, 1, 2, 4]

/** 播放器接受的事件类型来自 @rrweb/types，这里不直接依赖它 */
type PlayerEvents = ConstructorParameters<typeof PlayerClass>[0]['props']['events']

/**
 * 播放器的销毁方法。
 *
 * `Player` 继承自 Svelte 组件，而 svelte 只是 rrweb-player 的**构建期**依赖
 * （运行时没装），所以 `$destroy` 不在它的类型声明里。
 */
type DestroyablePlayer = PlayerClass & { $destroy?: () => void }

const ctx = inject(PANEL_CONTEXT)!

const sessions = ref<SessionRow[]>([])
const total = ref(0)
const loading = ref(false)

// ---- 抽屉与播放器 ----
const drawerOpen = ref(false)
const activeSession = ref<SessionRow | null>(null)
const stream = ref<ReplayStreamEvent[]>([])
const loadingReplay = ref(false)
const playerHost = ref<HTMLElement | null>(null)

let player: DestroyablePlayer | null = null
let ticker: number | undefined

const totalTime = ref(0)
const position = ref(0)
const playing = ref(false)
const speed = ref(1)

/** 流里有没有全量快照 —— 没有就播不出来 */
const hasSnapshot = computed(() => stream.value.some((e) => e.type === FULL_SNAPSHOT_TYPE))

/** 流里的增量事件数 */
const incrementalCount = computed(() => stream.value.filter((e) => e.type === 3).length)

// ---- 统计 ----
const withReplay = computed(() => sessions.value.filter((s) => s.hasReplay).length)
const withErrors = computed(() => sessions.value.filter((s) => s.errorCount > 0).length)
const avgDuration = computed(() => {
  if (sessions.value.length === 0) return 0
  const sum = sessions.value.reduce((acc, s) => acc + s.durationMs, 0)
  return Math.round(sum / sessions.value.length)
})

function deviceLabel(row: SessionRow): string {
  return [row.browser, row.os, row.device].filter(Boolean).join(' · ') || '—'
}

async function load(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null) {
    sessions.value = []
    total.value = 0
    return
  }

  loading.value = true
  try {
    const result = await listSessions(projectId, { limit: 50 })
    sessions.value = result.sessions
    total.value = result.total
  } catch (error) {
    ElMessage.error(`加载会话失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    loading.value = false
  }
}

// ============================================================
// 播放器
// ============================================================

function destroyPlayer(): void {
  if (ticker !== undefined) {
    window.clearInterval(ticker)
    ticker = undefined
  }
  if (player) {
    try {
      player.$destroy?.()
    } catch {
      // 播放器已经被卸载过了 —— 忽略
    }
    player = null
  }
}

async function mountPlayer(events: ReplayStreamEvent[]): Promise<void> {
  destroyPlayer()
  const host = playerHost.value
  if (!host || events.length === 0) return

  const width = Math.max(320, host.clientWidth)

  try {
    // 播放器**动态加载**：rrweb-player 连同 svelte 有几百 KB，
    // 而它只有真的打开回放时才用得上 —— 不该拖慢每一次面板打开。
    const { default: PlayerCtor } = await import('rrweb-player')

    player = new PlayerCtor({
      target: host,
      props: {
        events: events as unknown as PlayerEvents,
        width,
        height: PLAYER_HEIGHT,
        autoPlay: false,
        showController: false,
        showCaptions: false
      }
    })
  } catch (error) {
    ElMessage.error(`回放挂载失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const data = player.getMetaData()
  totalTime.value = data.totalTime
  position.value = 0

  // 播放时读数要跟着走
  ticker = window.setInterval(() => {
    if (!player) return
    const current = player.getReplayer().getCurrentTime()
    position.value = current
    if (current >= totalTime.value && playing.value) playing.value = false
  }, 120)
}

async function openReplay(row: SessionRow): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null) return

  activeSession.value = row
  drawerOpen.value = true
  loadingReplay.value = true
  stream.value = []
  position.value = 0
  totalTime.value = 0
  playing.value = false

  try {
    const result = await getSessionReplay(projectId, row.sessionId)
    stream.value = result.stream
    await nextTick()
    await mountPlayer(result.stream)
  } catch (error) {
    ElMessage.error(`加载回放失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    loadingReplay.value = false
  }
}

function closeDrawer(): void {
  drawerOpen.value = false
  destroyPlayer()
}

function togglePlay(): void {
  if (!player) return
  if (playing.value) {
    player.pause()
    playing.value = false
    return
  }
  // 播完了再按播放 → 从头开始
  if (position.value >= totalTime.value) {
    player.goto(0, true)
    position.value = 0
  } else {
    player.play()
  }
  playing.value = true
}

function changeSpeed(value: number): void {
  speed.value = value
  player?.setSpeed(value)
}

function onSeek(event: Event): void {
  const target = event.target as HTMLInputElement
  const value = Number(target.value)
  position.value = value
  player?.goto(value, playing.value)
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// ============================================================
// 生命周期
// ============================================================

watch(
  () => ctx.projectId,
  () => void load()
)
watch(
  () => ctx.refreshToken,
  () => void load()
)
onMounted(() => void load())
onUnmounted(() => destroyPlayer())
</script>

<template>
  <div v-loading="loading" class="sessions-page">
    <section class="stats">
      <StatCard label="会话总数" :value="total" hint="去重后的访问会话" />
      <StatCard label="有回放" :value="withReplay" hint="带 rrweb 事件流的会话" />
      <StatCard label="平均时长" :value="avgDuration" unit="ms" hint="单次会话平均停留" />
      <StatCard label="报错会话" :value="withErrors" hint="出现过错误的会话" />
    </section>

    <PanelSection title="会话列表" :count="total" hint="按开始时间倒序">
      <el-table :data="sessions" size="small">
        <el-table-column label="会话 ID" min-width="200">
          <template #default="{ row }">
            <span class="mono session-id">{{ row.sessionId }}</span>
          </template>
        </el-table-column>
        <el-table-column label="用户" width="120">
          <template #default="{ row }">
            <span class="tabular">{{ row.userId ?? '匿名' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="设备" min-width="180">
          <template #default="{ row }">
            <span class="muted">{{ deviceLabel(row as SessionRow) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="开始时间" width="150">
          <template #default="{ row }">
            <span :title="formatDate(row.startedAt)">{{ relativeTime(row.startedAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="时长" width="120" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ formatDuration(row.durationMs) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="页面" width="80" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ row.pageViews }}</span>
          </template>
        </el-table-column>
        <el-table-column label="错误" width="80" align="right">
          <template #default="{ row }">
            <span class="tabular" :class="{ danger: row.errorCount > 0 }">{{
              row.errorCount
            }}</span>
          </template>
        </el-table-column>
        <el-table-column label="回放" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.hasReplay" type="info" size="small" effect="plain">
              {{ row.replayEvents }} 事件
            </el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110" align="right">
          <template #default="{ row }">
            <el-button
              size="small"
              :icon="VideoPlay"
              :disabled="!row.hasReplay"
              @click="openReplay(row as SessionRow)"
            >
              回放
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="empty-hint">暂无会话数据（SDK 接入行为插件后开始上报）</div>
        </template>
      </el-table>
    </PanelSection>

    <el-drawer
      v-model="drawerOpen"
      size="min(880px, 94vw)"
      :with-header="true"
      direction="rtl"
      @closed="closeDrawer"
    >
      <template #header>
        <div class="drawer-head">
          <span class="drawer-title">会话回放</span>
          <span class="drawer-sub mono">{{ activeSession?.sessionId ?? '—' }}</span>
        </div>
      </template>

      <div v-loading="loadingReplay" class="replay">
        <div v-if="activeSession" class="replay-meta">
          <span>{{ deviceLabel(activeSession) }}</span>
          <span>{{ formatDuration(activeSession.durationMs) }}</span>
          <span>{{ activeSession.pageViews }} 次页面访问</span>
          <span v-if="activeSession.errorCount > 0" class="danger">
            {{ activeSession.errorCount }} 次错误
          </span>
          <span v-if="activeSession.hasReplay" class="muted">
            {{ activeSession.replayEvents }} 个回放事件 ·
            {{ formatBytes(activeSession.replayBytes) }}
          </span>
        </div>

        <div v-if="stream.length === 0 && !loadingReplay" class="replay-empty">
          这个会话没有回放数据
        </div>

        <div v-else-if="stream.length > 0 && !hasSnapshot" class="replay-empty replay-broken">
          <strong>回放流不完整，播不出来</strong>
          <p>
            增量事件必须有一个全量快照打底。这条流里没有快照 （共
            {{ stream.length }} 个事件，其中增量 {{ incrementalCount }} 个）——
            多半是采集端在录制中途丢了开头。
          </p>
        </div>

        <template v-else>
          <div ref="playerHost" class="player-host"></div>

          <div class="controls">
            <el-button
              class="play-btn"
              :icon="playing ? VideoPause : VideoPlay"
              @click="togglePlay"
            >
              {{ playing ? '暂停' : '播放' }}
            </el-button>

            <input
              class="seek"
              type="range"
              min="0"
              :max="Math.max(1, totalTime)"
              :value="position"
              aria-label="回放进度"
              @input="onSeek"
            />

            <span class="clock tabular"
              >{{ formatClock(position) }} / {{ formatClock(totalTime) }}</span
            >

            <el-select v-model="speed" class="speed" size="small" @change="changeSpeed">
              <el-option
                v-for="option in SPEEDS"
                :key="option"
                :label="`${option}×`"
                :value="option"
              />
            </el-select>
          </div>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.sessions-page {
  display: flex;
  flex-direction: column;
  gap: var(--vigil-space-5);
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--vigil-space-3);
}

.session-id {
  font-size: var(--vigil-text-xs);
  color: var(--vigil-text-2);
}

.muted {
  color: var(--vigil-text-3);
}

.danger {
  color: var(--vigil-danger);
}

.empty-hint {
  padding: var(--vigil-space-8);
  text-align: center;
  color: var(--vigil-text-3);
  font-size: var(--vigil-text-sm);
}

.drawer-head {
  display: flex;
  align-items: baseline;
  gap: var(--vigil-space-3);
}

.drawer-title {
  font-size: var(--vigil-text-md);
  font-weight: 600;
  color: var(--vigil-text-1);
}

.drawer-sub {
  font-size: var(--vigil-text-xs);
  color: var(--vigil-text-3);
}

.replay {
  display: flex;
  flex-direction: column;
  gap: var(--vigil-space-4);
}

.replay-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--vigil-space-4);
  font-size: var(--vigil-text-xs);
  color: var(--vigil-text-2);
}

.replay-empty {
  padding: var(--vigil-space-8);
  text-align: center;
  color: var(--vigil-text-3);
  font-size: var(--vigil-text-sm);
  border: 1px solid var(--vigil-border);
  border-radius: var(--vigil-radius);
}

.replay-broken {
  text-align: left;
  border-color: var(--vigil-warn);
}

.replay-broken strong {
  display: block;
  color: var(--vigil-warn);
  font-size: var(--vigil-text-sm);
  margin-bottom: var(--vigil-space-2);
}

.replay-broken p {
  margin: 0;
  font-size: var(--vigil-text-xs);
  line-height: var(--vigil-leading-normal);
}

/* ---- 播放器 ---- */
.player-host {
  background: var(--vigil-bg-sunken);
  border: 1px solid var(--vigil-border);
  border-radius: var(--vigil-radius);
  overflow: hidden;
  min-height: 420px;
}

/* ---- 控制条 ---- */
.controls {
  display: flex;
  align-items: center;
  gap: var(--vigil-space-3);
}

.play-btn {
  flex: 0 0 auto;
}

.seek {
  flex: 1;
  min-width: 0;
  /* 目标尺寸闸门：原生 range 的默认高度只有 16px，点不准 */
  height: 32px;
  accent-color: var(--vigil-accent);
  background: transparent;
}

/* 键盘可达时必须有可见焦点环 */
.seek:focus {
  outline: 2px solid var(--vigil-accent);
  outline-offset: 2px;
  border-radius: var(--vigil-radius-sm);
}

.clock {
  flex: 0 0 auto;
  font-size: var(--vigil-text-xs);
  color: var(--vigil-text-2);
}

.speed {
  flex: 0 0 auto;
  width: 88px;
}

@media (max-width: 1200px) {
  .stats {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 768px) {
  /* 触摸场景：进度条也要够得着 */
  .seek {
    height: 44px;
  }

  .controls {
    flex-wrap: wrap;
  }
}
</style>

<style>
/**
 * rrweb-player 的鼠标指示器是**蓝紫色**的（`rgb(73,80,246)`），
 * 和面板的黄绿强调色不是一回事。
 *
 * 它的类名带 Svelte hash，猜 hash 改颜色太脆 ——
 * 这里改的是伪元素，颜色规则本来就少，冲突面最小。
 */
.replayer-mouse::after {
  background: var(--vigil-accent);
}
</style>
