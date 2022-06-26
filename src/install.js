import View from './components/view'
import Link from './components/link'

// 其他文件可能会用到
export let _Vue

export function install (Vue) {
  // 防止重复安装
  if (install.installed && _Vue === Vue) return
  install.installed = true
  // 当前的 Vue 构造函数
  _Vue = Vue

  const isDef = v => v !== undefined
  // 注册当前组件的实例到 record 上
  const registerInstance = (vm, callVal) => {
    let i = vm.$options._parentVnode
    if (isDef(i) && isDef(i = i.data) && isDef(i = i.registerRouteInstance)) {
      i(vm, callVal)
    }
  }
  // 全局混入 beforeCreate 和 destroyed，每个组件都有这两个钩子函数
  Vue.mixin({
    beforeCreate () {
      // 通过 new Vue({ router }) 传入的 router 实例
      if (isDef(this.$options.router)) {
        this._routerRoot = this
        // 将 router 实例挂载到 vm._router 上
        this._router = this.$options.router
        this._router.init(this)
        // 将 vm._route 定义为响应式
        Vue.util.defineReactive(this, '_route', this._router.history.current)
      // 由于组件上在实例化时，不会继承 new Vue(options) 中的 options
      } else {
        // 每个组件上的 _routerRoot 指向跟 new Vue 实例，这样就能通过 _routerRoot 拿到根 Vue 实例上定义的 _router、_route 等对象
        this._routerRoot = (this.$parent && this.$parent._routerRoot) || this
      } 
      registerInstance(this, this)
    },
    destroyed () {
      registerInstance(this)
    }
  })
  // 将 $router 定义到 Vue 的原型上，这样每个组件实例上都能拿到 $router
  Object.defineProperty(Vue.prototype, '$router', {
    get () { return this._routerRoot._router }
  })
  // 将 $router 定义到 Vue 的原型上，这样每个组件实例上都能拿到 $route
  Object.defineProperty(Vue.prototype, '$route', {
    get () { return this._routerRoot._route }
  })
  // 全局安装 Router-View 和 Router-Link 两个组件
  Vue.component('RouterView', View)
  Vue.component('RouterLink', Link)

  const strats = Vue.config.optionMergeStrategies
  // use the same hook merging strategy for route hooks
  strats.beforeRouteEnter = strats.beforeRouteLeave = strats.beforeRouteUpdate = strats.created
}
