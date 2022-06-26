/* @flow */

import { install } from './install'
import { START } from './util/route'
import { assert, warn } from './util/warn'
import { inBrowser } from './util/dom'
import { cleanPath } from './util/path'
import { createMatcher } from './create-matcher'
import { normalizeLocation } from './util/location'
import { supportsPushState } from './util/push-state'
import { handleScroll } from './util/scroll'

import { HashHistory } from './history/hash'
import { HTML5History } from './history/html5'
import { AbstractHistory } from './history/abstract'

import type { Matcher } from './create-matcher'

import { isNavigationFailure, NavigationFailureType } from './util/errors'
// 通过 new VueRouter 创建 router 实例 
export default class VueRouter {
  static install: () => void
  static version: string
  static isNavigationFailure: Function
  static NavigationFailureType: any
  static START_LOCATION: Route

  app: any
  apps: Array<any>
  ready: boolean
  readyCbs: Array<Function>
  options: RouterOptions
  // history | hash
  mode: string
  history: HashHistory | HTML5History | AbstractHistory
  matcher: Matcher
  fallback: boolean
  // 通过 route.xxx() 注册的 hooks
  beforeHooks: Array<?NavigationGuard>
  resolveHooks: Array<?NavigationGuard>
  afterHooks: Array<?AfterNavigationHook>

  constructor (options: RouterOptions = {}) {
    if (process.env.NODE_ENV !== 'production') {
      warn(this instanceof VueRouter, `Router must be called with the new operator.`)
    }
    this.app = null
    this.apps = []
    // RouterOptions
    this.options = options
    this.beforeHooks = []
    this.resolveHooks = []
    this.afterHooks = []
    // 创建一个 matcher
    this.matcher = createMatcher(options.routes || [], this)

    let mode = options.mode || 'hash'
    // 如果浏览器不支持 history 模式，那么 fallback 为 hash
    this.fallback =
      mode === 'history' && !supportsPushState && options.fallback !== false
    if (this.fallback) {
      mode = 'hash'
    }
    if (!inBrowser) {
      mode = 'abstract'
    }
    this.mode = mode
    // 创建 histroy 实例
    switch (mode) {
      case 'history':
        this.history = new HTML5History(this, options.base)
        break
      case 'hash':
        this.history = new HashHistory(this, options.base, this.fallback)
        break
      case 'abstract':
        this.history = new AbstractHistory(this, options.base)
        break
      default:
        if (process.env.NODE_ENV !== 'production') {
          assert(false, `invalid mode: ${mode}`)
        }
    }
  }
  // 根据 raw、current 整合得到一个新的 route
  match (raw: RawLocation, current?: Route, redirectedFrom?: Location): Route {
    return this.matcher.match(raw, current, redirectedFrom)
  }
  // 返回当前的 route
  get currentRoute (): ?Route {
    return this.history && this.history.current
  }
  // new Vue 时，会执行该 init 方法
  init (app: any /* Vue component instance */) {
    process.env.NODE_ENV !== 'production' &&
      assert(
        install.installed,
        `not installed. Make sure to call \`Vue.use(VueRouter)\` ` +
          `before creating root instance.`
      )
    // app 是 new Vue 的实例
    // 多个 app 实例，也就是多个 new Vue 实例
    this.apps.push(app)

    // set up app destroyed handler
    // https://github.com/vuejs/vue-router/issues/2639
    // 监听 app 实例的销毁事件
    app.$once('hook:destroyed', () => {
      // clean out app from this.apps array once destroyed
      const index = this.apps.indexOf(app)
      if (index > -1) this.apps.splice(index, 1)
      // ensure we still have a main app or null if no apps
      // we do not release the router so it can be reused
      if (this.app === app) this.app = this.apps[0] || null

      if (!this.app) this.history.teardown()
    })

    // main app previously initialized
    // return as we don't need to set up new history listener
    if (this.app) {
      return
    }
    // app 是 new Vue 的实例
    this.app = app

    const history = this.history

    if (history instanceof HTML5History || history instanceof HashHistory) {
      const handleInitialScroll = routeOrError => {
        const from = history.current
        const expectScroll = this.options.scrollBehavior
        const supportsScroll = supportsPushState && expectScroll

        if (supportsScroll && 'fullPath' in routeOrError) {
          handleScroll(this, routeOrError, from, false)
        }
      }
      const setupListeners = routeOrError => {
        history.setupListeners()
        handleInitialScroll(routeOrError)
      }
      // 当前页面的第一次导航，根据当前页面的 url，匹配对应的组件
      history.transitionTo(
        history.getCurrentLocation(),
        setupListeners, // 导航完成后的回调，注册监听浏览器 url 变化的事件
        setupListeners // 导航失败后的回调
      )
    }
    // 当执行完一次导航后，会更新 history.current 为新的 route 对象，然后会执行 history.listen 注册的 callback
    // 取到新的 route，然后更新 app._route 属性，应为 app._route 在 install 的时候被定义为是一个响应式属性，然后就会触发 router-link 的重新渲染
    history.listen(route => {
      this.apps.forEach(app => {
        app._route = route
      })
    })
  }
  // router.beforeEach(cb) 注册钩子
  beforeEach (fn: Function): Function {
    return registerHook(this.beforeHooks, fn)
  }

  // router.beforeResolve(cb) 注册钩子
  beforeResolve (fn: Function): Function {
    return registerHook(this.resolveHooks, fn)
  }

  // router.afterEach(cb) 注册钩子
  afterEach (fn: Function): Function {
    return registerHook(this.afterHooks, fn)
  }

  onReady (cb: Function, errorCb?: Function) {
    this.history.onReady(cb, errorCb)
  }

  onError (errorCb: Function) {
    this.history.onError(errorCb)
  }

  // router.push(location) 导航到一个新的路由，也就是我们常用的 this.$router.push
  push (location: RawLocation, onComplete?: Function, onAbort?: Function) {
    // $flow-disable-line
    if (!onComplete && !onAbort && typeof Promise !== 'undefined') {
      return new Promise((resolve, reject) => {
        this.history.push(location, resolve, reject)
      })
    } else {
      this.history.push(location, onComplete, onAbort)
    }
  }

  // router.replace(location)，跟 push 不同的是不会产生一条浏览器记录
  replace (location: RawLocation, onComplete?: Function, onAbort?: Function) {
    // $flow-disable-line
    if (!onComplete && !onAbort && typeof Promise !== 'undefined') {
      return new Promise((resolve, reject) => {
        this.history.replace(location, resolve, reject)
      })
    } else {
      this.history.replace(location, onComplete, onAbort)
    }
  }
  // router.go()
  go (n: number) {
    this.history.go(n)
  }

  // router.back()
  back () {
    this.go(-1)
  }

  // router.forward()
  forward () {
    this.go(1)
  }
  // 根据 location 或者 route 获取 to 匹配的组件
  getMatchedComponents (to?: RawLocation | Route): Array<any> {
    const route: any = to
      ? to.matched
        ? to
        : this.resolve(to).route
      : this.currentRoute
    if (!route) {
      return []
    }
    return [].concat.apply(
      [],
      route.matched.map(m => {
        return Object.keys(m.components).map(key => {
          return m.components[key]
        })
      })
    )
  }
  // 根据 location 获取对应的 route
  resolve (
    to: RawLocation,
    current?: Route,
    append?: boolean
  ): {
    location: Location,
    route: Route,
    href: string,
    // for backwards compat
    normalizedTo: Location,
    resolved: Route
  } {
    current = current || this.history.current
    const location = normalizeLocation(to, current, append, this)
    const route = this.match(location, current)
    const fullPath = route.redirectedFrom || route.fullPath
    const base = this.history.base
    const href = createHref(base, fullPath, this.mode)
    return {
      location,
      route,
      href,
      // for backwards compat
      normalizedTo: location,
      resolved: route
    }
  }
  // 获取所有的 RouteRecord
  getRoutes () {
    return this.matcher.getRoutes()
  }
  // 添加单条 route
  addRoute (parentOrRoute: string | RouteConfig, route?: RouteConfig) {
    this.matcher.addRoute(parentOrRoute, route)
    if (this.history.current !== START) {
      this.history.transitionTo(this.history.getCurrentLocation())
    }
  }
  // 添加多条 route
  addRoutes (routes: Array<RouteConfig>) {
    if (process.env.NODE_ENV !== 'production') {
      warn(false, 'router.addRoutes() is deprecated and has been removed in Vue Router 4. Use router.addRoute() instead.')
    }
    this.matcher.addRoutes(routes)
    if (this.history.current !== START) {
      this.history.transitionTo(this.history.getCurrentLocation())
    }
  }
}

// 返回的函数可以取消注册的 hook
function registerHook (list: Array<any>, fn: Function): Function {
  list.push(fn)
  return () => {
    const i = list.indexOf(fn)
    if (i > -1) list.splice(i, 1)
  }
}

function createHref (base: string, fullPath: string, mode) {
  var path = mode === 'hash' ? '#' + fullPath : fullPath
  return base ? cleanPath(base + '/' + path) : path
}

VueRouter.install = install
VueRouter.version = '__VERSION__'
VueRouter.isNavigationFailure = isNavigationFailure
// 导航失败的枚举值
VueRouter.NavigationFailureType = NavigationFailureType
// { path: '/' }
VueRouter.START_LOCATION = START

if (inBrowser && window.Vue) {
  window.Vue.use(VueRouter)
}
