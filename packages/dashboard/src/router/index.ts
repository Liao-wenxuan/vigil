/**
 * 面板路由。
 *
 * 全部页面都挂在 AppLayout 下面 —— 侧边导航、顶栏、项目上下文由布局持有，
 * 页面只负责自己的数据。
 */

import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import AppLayout from '../layouts/AppLayout.vue'
import AlertsView from '../views/AlertsView.vue'
import IssueDetailView from '../views/IssueDetailView.vue'
import IssuesView from '../views/IssuesView.vue'
import OverviewView from '../views/OverviewView.vue'
import PerformanceView from '../views/PerformanceView.vue'
import SettingsView from '../views/SettingsView.vue'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: AppLayout,
    children: [
      {
        path: '',
        name: 'overview',
        component: OverviewView,
        meta: { title: '总览', desc: '当前项目的错误与性能全貌' }
      },
      {
        path: 'issues',
        name: 'issues',
        component: IssuesView,
        meta: { title: '问题', desc: '按指纹聚合的未解决问题，可标记解决与回归' }
      },
      {
        path: 'issues/:id',
        name: 'issue-detail',
        component: IssueDetailView,
        meta: { title: '问题详情', desc: '单个问题的生命周期、活动流与现场上下文' }
      },
      {
        path: 'performance',
        name: 'performance',
        component: PerformanceView,
        meta: { title: '性能', desc: '真实用户的加载与交互体验（Web Vitals）' }
      },
      {
        path: 'alerts',
        name: 'alerts',
        component: AlertsView,
        meta: { title: '告警', desc: '规则、通知通道与触发历史' }
      },
      {
        path: 'settings',
        name: 'settings',
        component: SettingsView,
        meta: { title: '设置', desc: '项目、环境、版本与密钥' }
      }
    ]
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/'
  }
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

export default router
