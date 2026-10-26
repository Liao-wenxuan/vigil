<script setup lang="ts">
/**
 * 设置页。
 *
 * 管理的是**租户结构**（组织 → 项目 → 环境 / 版本）和**项目密钥**。
 *
 * 密钥是这个页面最要紧的东西：两把密钥只在创建 / 轮换的那一刻返回一次，
 * 所以界面必须明确告诉用户「现在不保存就没了」。
 */
import { computed, inject, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  createEnvironment,
  createOrganization,
  createProject,
  createRelease,
  getProject,
  listOrganizations,
  listProjects,
  rotateProjectKey
} from '../api/client'
import { formatDate } from '../format'
import {
  PANEL_CONTEXT,
  type EnvironmentRow,
  type OrganizationRow,
  type ProjectRow,
  type ReleaseRow
} from '../types'
import PanelSection from '../components/PanelSection.vue'

const ctx = inject(PANEL_CONTEXT)!
const route = useRoute()

const organizations = ref<OrganizationRow[]>([])
const projects = ref<ProjectRow[]>([])
const environments = ref<EnvironmentRow[]>([])
const releases = ref<ReleaseRow[]>([])
const loading = ref(false)

const orgVisible = ref(false)
const orgName = ref('')

const projectVisible = ref(false)
const projectForm = ref({
  organizationId: undefined as number | undefined,
  name: '',
  slug: '',
  platform: 'javascript',
  retentionDays: 90,
  eventQuota: 1_000_000
})

const environmentVisible = ref(false)
const environmentForm = ref({ slug: '', name: '', isProduction: false })

const releaseVisible = ref(false)
const releaseForm = ref({ version: '', commitSha: '' })

/** 只显示一次的密钥 —— 用一个专门的弹窗承载 */
const secretVisible = ref(false)
const secretTitle = ref('')
const secrets = ref<Array<{ label: string; value: string }>>([])

/** 侧边导航的「环境与版本」入口会带上 ?section=environments —— 这里高亮对应区块 */
const activeSection = computed(() =>
  typeof route.query.section === 'string' ? route.query.section : ''
)

const currentProject = computed(() => ctx.project)

function showSecrets(title: string, items: Array<{ label: string; value: string }>): void {
  secretTitle.value = title
  secrets.value = items
  secretVisible.value = true
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const orgs = await listOrganizations()
    organizations.value = orgs

    const lists = await Promise.all(orgs.map((org) => listProjects(org.id).catch(() => [])))
    projects.value = lists.flat()

    const projectId = ctx.projectId
    if (projectId === null) {
      environments.value = []
      releases.value = []
      return
    }

    const detail = await getProject(projectId)
    environments.value = detail.environments
    releases.value = detail.releases
  } catch (error) {
    ElMessage.error(`加载设置数据失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    loading.value = false
  }
}

async function submitOrganization(): Promise<void> {
  const name = orgName.value.trim()
  if (name === '') {
    ElMessage.warning('请填写组织名称')
    return
  }

  try {
    await createOrganization(name)
    ElMessage.success('组织已创建')
    orgVisible.value = false
    orgName.value = ''
    await load()
    ctx.requestRefresh()
  } catch (error) {
    ElMessage.error(`创建组织失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function submitProject(): Promise<void> {
  const form = projectForm.value
  const organizationId = form.organizationId ?? organizations.value[0]?.id
  const name = form.name.trim()

  if (organizationId === undefined) {
    ElMessage.warning('请先创建组织')
    return
  }
  if (name === '') {
    ElMessage.warning('请填写项目名称')
    return
  }

  try {
    const created = await createProject(organizationId, {
      name,
      ...(form.slug.trim() ? { slug: form.slug.trim() } : {}),
      platform: form.platform,
      retentionDays: form.retentionDays,
      eventQuota: form.eventQuota
    })

    showSecrets('项目已创建 —— 两把密钥只显示这一次', [
      { label: '运行时密钥（上报用）', value: created.runtimeKey },
      { label: '上传密钥（sourcemap 用）', value: created.uploadKey }
    ])

    projectVisible.value = false
    projectForm.value = {
      organizationId,
      name: '',
      slug: '',
      platform: 'javascript',
      retentionDays: 90,
      eventQuota: 1_000_000
    }
    await load()
    ctx.requestRefresh()
  } catch (error) {
    ElMessage.error(`创建项目失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function submitEnvironment(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null) return

  const slug = environmentForm.value.slug.trim()
  const name = environmentForm.value.name.trim()
  if (slug === '' || name === '') {
    ElMessage.warning('请填写环境标识与名称')
    return
  }

  try {
    await createEnvironment(projectId, {
      slug,
      name,
      isProduction: environmentForm.value.isProduction
    })
    ElMessage.success('环境已创建')
    environmentVisible.value = false
    environmentForm.value = { slug: '', name: '', isProduction: false }
    await load()
  } catch (error) {
    ElMessage.error(`创建环境失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function submitRelease(): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null) return

  const version = releaseForm.value.version.trim()
  if (version === '') {
    ElMessage.warning('请填写版本号')
    return
  }

  try {
    await createRelease(projectId, {
      version,
      ...(releaseForm.value.commitSha.trim()
        ? { commitSha: releaseForm.value.commitSha.trim() }
        : {})
    })
    ElMessage.success('版本已登记')
    releaseVisible.value = false
    releaseForm.value = { version: '', commitSha: '' }
    await load()
  } catch (error) {
    ElMessage.error(`登记版本失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function rotate(kind: 'runtime' | 'upload'): Promise<void> {
  const projectId = ctx.projectId
  if (projectId === null) return

  const label = kind === 'runtime' ? '运行时密钥' : '上传密钥'
  try {
    await ElMessageBox.confirm(
      `轮换${label}后，旧密钥立即失效，所有使用旧密钥的上报都会失败。确认轮换？`,
      `轮换${label}`,
      { type: 'warning', confirmButtonText: '确认轮换', cancelButtonText: '取消' }
    )
  } catch {
    return
  }

  try {
    const result = await rotateProjectKey(projectId, kind)
    showSecrets(`${label}已轮换 —— 新密钥只显示这一次`, [{ label, value: result.key }])
    await load()
  } catch (error) {
    ElMessage.error(`轮换密钥失败：${error instanceof Error ? error.message : String(error)}`)
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

onMounted(async () => {
  await load()
})
</script>

<template>
  <div v-loading="loading" class="settings-page">
    <PanelSection title="组织" :count="organizations.length">
      <template #actions>
        <el-button size="small" type="primary" @click="orgVisible = true">新建组织</el-button>
      </template>

      <el-table :data="organizations" size="default">
        <el-table-column prop="name" label="名称" min-width="180" />
        <el-table-column prop="slug" label="标识" min-width="160">
          <template #default="{ row }">
            <span class="tabular muted">{{ row.slug }}</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">
            <span class="tabular muted">{{ formatDate(row.created_at) }}</span>
          </template>
        </el-table-column>
        <template #empty>
          <div class="empty-hint">还没有组织</div>
        </template>
      </el-table>
    </PanelSection>

    <PanelSection title="项目" :count="projects.length">
      <template #actions>
        <el-button size="small" type="primary" @click="projectVisible = true">新建项目</el-button>
      </template>

      <el-table :data="projects" size="default">
        <el-table-column prop="name" label="名称" min-width="180" />
        <el-table-column prop="slug" label="标识" min-width="150">
          <template #default="{ row }">
            <span class="tabular muted">{{ row.slug }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="platform" label="平台" width="110" />
        <el-table-column label="保留天数" width="100" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ row.retention_days.toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="事件配额" width="120" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ row.event_quota.toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">
            <span class="tabular muted">{{ formatDate(row.created_at) }}</span>
          </template>
        </el-table-column>
        <template #empty>
          <div class="empty-hint">还没有项目</div>
        </template>
      </el-table>
    </PanelSection>

    <div class="section-anchor" :class="{ 'is-highlighted': activeSection === 'environments' }">
      <PanelSection title="环境" :count="environments.length" hint="仅当前项目">
        <template #actions>
          <el-button size="small" type="primary" @click="environmentVisible = true">
            新建环境
          </el-button>
        </template>

        <el-table :data="environments" size="default">
          <el-table-column prop="name" label="名称" min-width="180" />
          <el-table-column prop="slug" label="标识" min-width="150">
            <template #default="{ row }">
              <span class="tabular muted">{{ row.slug }}</span>
            </template>
          </el-table-column>
          <el-table-column label="生产环境" width="110">
            <template #default="{ row }">
              <el-tag :type="row.is_production ? 'danger' : 'info'" size="small" effect="plain">
                {{ row.is_production ? '生产' : '非生产' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="创建时间" width="170">
            <template #default="{ row }">
              <span class="tabular muted">{{ formatDate(row.created_at) }}</span>
            </template>
          </el-table-column>
          <template #empty>
            <div class="empty-hint">当前项目还没有环境</div>
          </template>
        </el-table>
      </PanelSection>
    </div>

    <PanelSection title="版本" :count="releases.length" hint="仅当前项目，回归判定的锚">
      <template #actions>
        <el-button size="small" type="primary" @click="releaseVisible = true">新建版本</el-button>
      </template>

      <el-table :data="releases" size="default">
        <el-table-column prop="version" label="版本号" min-width="160" />
        <el-table-column label="提交" min-width="220">
          <template #default="{ row }">
            <span class="mono muted">{{ row.commit_sha ?? '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="登记时间" width="170">
          <template #default="{ row }">
            <span class="tabular muted">{{ formatDate(row.created_at) }}</span>
          </template>
        </el-table-column>
        <template #empty>
          <div class="empty-hint">当前项目还没有版本</div>
        </template>
      </el-table>
    </PanelSection>

    <PanelSection title="项目密钥" hint="仅当前项目">
      <template #actions>
        <el-button size="small" @click="rotate('runtime')">轮换运行时密钥</el-button>
        <el-button size="small" @click="rotate('upload')">轮换上传密钥</el-button>
      </template>

      <div class="secret-hint">
        <div class="secret-line">
          <span class="secret-label">运行时密钥</span>
          <span class="secret-desc">进前端代码，用于错误上报。拿它只能刷数据。</span>
        </div>
        <div class="secret-line">
          <span class="secret-label">上传密钥</span>
          <span class="secret-desc">只在 CI 里，用于上传 sourcemap。拿它能污染别人的错误栈。</span>
        </div>
        <p class="secret-note">
          两把密钥在数据库里只存哈希，明文只在创建 / 轮换时返回一次。轮换后旧密钥立即失效。
        </p>
        <p v-if="currentProject" class="secret-project tabular">
          当前项目：{{ currentProject.name }}（{{ currentProject.slug }}）
        </p>
      </div>
    </PanelSection>

    <el-dialog v-model="orgVisible" title="新建组织" width="420px">
      <el-form label-width="88px">
        <el-form-item label="组织名称">
          <el-input v-model="orgName" placeholder="例如：前端平台组" clearable />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="orgVisible = false">取消</el-button>
        <el-button type="primary" @click="submitOrganization">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="projectVisible" title="新建项目" width="520px">
      <el-form label-width="104px">
        <el-form-item label="所属组织">
          <el-select v-model="projectForm.organizationId" class="full-width" placeholder="选择组织">
            <el-option
              v-for="org in organizations"
              :key="org.id"
              :label="org.name"
              :value="org.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="项目名称">
          <el-input v-model="projectForm.name" placeholder="例如：内容分享平台" clearable />
        </el-form-item>
        <el-form-item label="项目标识">
          <el-input v-model="projectForm.slug" placeholder="留空则按名称自动生成" clearable />
        </el-form-item>
        <el-form-item label="平台">
          <el-select v-model="projectForm.platform" class="full-width">
            <el-option label="JavaScript" value="javascript" />
            <el-option label="TypeScript" value="typescript" />
            <el-option label="Vue" value="vue" />
            <el-option label="React" value="react" />
          </el-select>
        </el-form-item>
        <el-form-item label="保留天数">
          <el-input-number v-model="projectForm.retentionDays" :min="1" :controls="false" />
        </el-form-item>
        <el-form-item label="事件配额">
          <el-input-number
            v-model="projectForm.eventQuota"
            :min="1000"
            :step="10000"
            :controls="false"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="projectVisible = false">取消</el-button>
        <el-button type="primary" @click="submitProject">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="environmentVisible" title="新建环境" width="440px">
      <el-form label-width="104px">
        <el-form-item label="环境标识">
          <el-input v-model="environmentForm.slug" placeholder="例如 production" clearable />
        </el-form-item>
        <el-form-item label="环境名称">
          <el-input v-model="environmentForm.name" placeholder="例如 生产环境" clearable />
        </el-form-item>
        <el-form-item label="是否生产">
          <el-switch v-model="environmentForm.isProduction" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="environmentVisible = false">取消</el-button>
        <el-button type="primary" @click="submitEnvironment">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="releaseVisible" title="登记版本" width="440px">
      <el-form label-width="104px">
        <el-form-item label="版本号">
          <el-input v-model="releaseForm.version" placeholder="例如 1.4.3" clearable />
        </el-form-item>
        <el-form-item label="提交哈希">
          <el-input v-model="releaseForm.commitSha" placeholder="选填" clearable />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="releaseVisible = false">取消</el-button>
        <el-button type="primary" @click="submitRelease">登记</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="secretVisible" :title="secretTitle" width="560px">
      <el-alert
        type="warning"
        show-icon
        :closable="false"
        title="只显示一次，请立即保存"
        description="关闭这个弹窗后无法再次查看 —— 服务端只存哈希，不存明文。"
      />
      <div v-for="secret in secrets" :key="secret.label" class="secret-item">
        <div class="secret-item-label">{{ secret.label }}</div>
        <div class="secret-item-value mono">{{ secret.value }}</div>
      </div>
      <template #footer>
        <el-button type="primary" @click="secretVisible = false">我已保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.settings-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.section-anchor {
  scroll-margin-top: 70px;
}

.section-anchor.is-highlighted :deep(.panel) {
  border-color: var(--vigil-accent);
}

.mono {
  font-family: 'SF Mono', 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}

.muted {
  color: var(--vigil-text-2);
}

.full-width {
  width: 100%;
}

.secret-hint {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.secret-line {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.secret-label {
  font-size: 13px;
  color: var(--vigil-text-1);
  min-width: 92px;
}

.secret-desc {
  font-size: 12px;
  color: var(--vigil-text-2);
}

.secret-note {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--vigil-text-3);
  line-height: 1.6;
}

.secret-project {
  margin: 0;
  font-size: 12px;
  color: var(--vigil-text-2);
}

.secret-item {
  margin-top: 14px;
}

.secret-item-label {
  font-size: 12px;
  color: var(--vigil-text-3);
}

.secret-item-value {
  margin-top: 4px;
  padding: 10px 12px;
  background: var(--vigil-bg-sunken);
  border: 1px solid var(--vigil-border);
  border-radius: 4px;
  color: var(--vigil-text-1);
  word-break: break-all;
}

.empty-hint {
  padding: 28px;
  text-align: center;
  color: var(--vigil-text-3);
  font-size: 13px;
}
</style>
