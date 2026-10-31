import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
// Element Plus 的基础样式（reset）与暗色变量。
// ⚠️ 按需引入只带**用到的组件**的样式，base.css 和变量表必须手动补 ——
//    少了它们，组件里引用的 --el-* 变量会取到空值，
//    浏览器回退到初始色 → 页面颜色变多、样式变乱。
import 'element-plus/theme-chalk/base.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
// ⚠️ **面板自己的 token 必须最后导入**。
//    theme.css 里的 `html.dark { --el-* }` 与 Element Plus 的暗色变量表
//    **特异度完全相同**（都是 0,1,1）—— 谁的规则写在后面谁赢。
//    排错了面板就用不上自己的色板，页面上会多出七八种 EP 默认色。
import './theme.css'

// ⚠️ **不要** `app.use(ElementPlus)` —— 那会把整个库（1.1MB）+ 全部样式打进包。
// 面板只用了 24 个组件，剩下的靠 vite 的按需引入插件自动处理。
createApp(App).use(router).mount('#app')
