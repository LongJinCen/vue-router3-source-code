/* @flow */

import { _Vue } from '../install'
import type Router from '../index'
import { inBrowser } from '../util/dom'
import { runQueue } from '../util/async'
import { warn } from '../util/warn'
import { START, isSameRoute, handleRouteEntered } from '../util/route'
import {
  flatten,
  flatMapComponents,
  resolveAsyncComponents
} from '../util/resolve-components'
import {
  createNavigationDuplicatedError,
  createNavigationCancelledError,
  createNavigationRedirectedError,
  createNavigationAbortedError,
  isError,
  isNavigationFailure,
  NavigationFailureType
} from '../util/errors'
import { handleScroll } from '../util/scroll'

export class History {
  router: Router
  base: string
  current: Route
  pending: ?Route
  cb: (r: Route) => void
  ready: boolean
  readyCbs: Array<Function>
  readyErrorCbs: Array<Function>
  errorCbs: Array<Function>
  listeners: Array<Function>
  cleanupListeners: Function

  // implemented by sub-classes
  +go: (n: number) => void
  +push: (loc: RawLocation, onComplete?: Function, onAbort?: Function) => void
  +replace: (
    loc: RawLocation,
    onComplete?: Function,
    onAbort?: Function
  ) => void
  +ensureURL: (push?: boolean) => void
  +getCurrentLocation: () => string
  +setupListeners: Function

  constructor (router: Router, base: ?string) {
    this.router = router
    this.base = normalizeBase(base)
    // start with a route object that stands for "nowhere"
    this.current = START
    this.pending = null
    this.ready = false
    this.readyCbs = []
    this.readyErrorCbs = []
    this.errorCbs = []
    this.listeners = []
  }

  listen (cb: Function) {
    this.cb = cb
  }

  onReady (cb: Function, errorCb: ?Function) {
    if (this.ready) {
      cb()
    } else {
      this.readyCbs.push(cb)
      if (errorCb) {
        this.readyErrorCbs.push(errorCb)
      }
    }
  }

  onError (errorCb: Function) {
    this.errorCbs.push(errorCb)
  }
  // 跳转到指定路由, location 是 target 路由
  transitionTo (
    location: RawLocation, // hash url，也就是 # 后面的路径
    onComplete?: Function, // 跳转成功的回调
    onAbort?: Function // 跳转失败的回调 
  ) {
    let route
    // catch redirect option https://github.com/vuejs/vue-router/issues/3201
    try {
      // 获取新的 route 对象
      route = this.router.match(location, this.current)
    } catch (e) {
      this.errorCbs.forEach(cb => {
        cb(e)
      })
      // Exception should still be thrown
      throw e
    }
    const prev = this.current
    this.confirmTransition(
      route,
      // 导航成功的回调
      () => {
        // 导航完成后更新 route 到当前路由
        this.updateRoute(route)
        onComplete && onComplete(route)
        // 更新浏览器导航栏中的 Url
        this.ensureURL()
        // 执行 route.afterEach() 注册的所有的钩子
        this.router.afterHooks.forEach(hook => {
          hook && hook(route, prev)
        })

        // fire ready cbs once
        if (!this.ready) {
          this.ready = true
          this.readyCbs.forEach(cb => {
            cb(route)
          })
        }
      },
      // 导航失败的回调
      err => {
        if (onAbort) {
          onAbort(err)
        }
        if (err && !this.ready) {
          // Initial redirection should not mark the history as ready yet
          // because it's triggered by the redirection instead
          // https://github.com/vuejs/vue-router/issues/3225
          // https://github.com/vuejs/vue-router/issues/3331
          if (!isNavigationFailure(err, NavigationFailureType.redirected) || prev !== START) {
            this.ready = true
            this.readyErrorCbs.forEach(cb => {
              cb(err)
            })
          }
        }
      }
    )
  }

  confirmTransition (route: Route, onComplete: Function, onAbort?: Function) {
    const current = this.current
    // 设置当前正在导航的路由
    this.pending = route
    // 导航失败的回调
    const abort = err => {
      // changed after adding errors with
      // https://github.com/vuejs/vue-router/pull/3047 before that change,
      // redirect and aborted navigation would produce an err == null
      if (!isNavigationFailure(err) && isError(err)) {
        if (this.errorCbs.length) {
          this.errorCbs.forEach(cb => {
            cb(err)
          })
        } else {
          if (process.env.NODE_ENV !== 'production') {
            warn(false, 'uncaught error during route navigation:')
          }
          console.error(err)
        }
      }
      onAbort && onAbort(err)
    }
    // 拿到 target route 匹配的路由 index
    const lastRouteIndex = route.matched.length - 1
    // 拿到 当前 route 匹配的路由 index
    const lastCurrentIndex = current.matched.length - 1
    // 路由相等的情况
    if (
      // target route 和 current route 是否相等
      isSameRoute(route, current) &&
      // in the case the route map has been dynamically appended to
      lastRouteIndex === lastCurrentIndex &&
      route.matched[lastRouteIndex] === current.matched[lastCurrentIndex]
    ) {
      this.ensureURL()
      if (route.hash) {
        handleScroll(this.router, current, route, false)
      }
      return abort(createNavigationDuplicatedError(current, route))
    }
    // 后面为路由不相等的情况，那么就需要进行导航

    // matched 里面存储的是 record，对比 current 匹配的 record 和 target route 匹配的 route
    // 1. 对于两次都匹配到的路由，放到 updated 数组中
    // 2. 对于 current route 未匹配到的路由，放到 deactivated 数组中
    // 3. 对于 target route 新匹配到的路由，放到 activated 数组中
    const { updated, deactivated, activated } = resolveQueue(
      this.current.matched,
      route.matched
    )

    const queue: Array<?NavigationGuard> = [].concat(
      // in-component leave guards
      // 获取 deactivated 路由对应的 component，拿到组件中配置的 beforeRouteLeave 钩子，并将其 this 绑定为组件的 vm
      extractLeaveGuards(deactivated),
      // global before hooks
      // 通过 router.beforeEach(cb) 组件的所有的 cb
      this.router.beforeHooks,
      // in-component update hooks
      // 获取 updated 路由对应的 component，拿到组件中的 beforeRouteUpdate hooks，并为其绑定 this
      extractUpdateHooks(updated),
      // in-config enter guards
      // 在 route config 中定义的 beforeEnter 钩子
      activated.map(m => m.beforeEnter),
      // async components
      // 对于激活的路由，如果包含异步组件，需要等异步组件 resolve 后才能继续
      resolveAsyncComponents(activated)
    )
    
    // 调用 next 执行 queue 中的下一个路由守卫
    const iterator = (hook: NavigationGuard, next) => {
      // 如果在执行路由守卫的过程中取消了导航，那么 pending 会被置为 null，然后会停止后续一些的导航
      if (this.pending !== route) {
        return abort(createNavigationCancelledError(current, route))
      }
      try {
        // 执行用户定义的路由守卫
        hook(route, current, (to: any) => {
          // next(false)，直接停止后续导航
          if (to === false) {
            // next(false) -> abort navigation, ensure current URL
            this.ensureURL(true)
            abort(createNavigationAbortedError(current, route))
          // 如果报错，也停止导航
          } else if (isError(to)) {
            this.ensureURL(true)
            abort(to)
          // 如果 to 中制定了新的路由，那么导航到新路由
          } else if (
            typeof to === 'string' ||
            (typeof to === 'object' &&
              (typeof to.path === 'string' || typeof to.name === 'string'))
          ) {
            // next('/') or next({ path: '/' }) -> redirect
            abort(createNavigationRedirectedError(current, route))
            if (typeof to === 'object' && to.replace) {
              this.replace(to)
            } else {
              this.push(to)
            }
          // 继续当前路由导航，执行下一个路由守卫
          } else {
            // confirm transition and pass on the value
            next(to)
          }
        })
      } catch (e) {
        abort(e)
      }
    }
    // 第三个参数是在 queue 全部串行执行完毕后便会调用
    runQueue(queue, iterator, () => {
      // wait until async components are resolved before
      // extracting in-component enter guards
      // 获取 activated 路由对应的 component，拿到组件中配置的 beforeRouteLeave 钩子
      const enterGuards = extractEnterGuards(activated)
      // 拿到通过 router.beforeResolve() 注册的钩子
      const queue = enterGuards.concat(this.router.resolveHooks)
      // 继续 run queue，包含 beforeRouteLeave、beforeResolve钩子
      runQueue(queue, iterator, () => {
        // 如果路由被取消了，那么停止导航
        if (this.pending !== route) {
          return abort(createNavigationCancelledError(current, route))
        }
        // 当前 route 导航结束
        this.pending = null
        // onComplete，执行 afterEach 导航守卫，接下来就就是 dom 更新的流程
        onComplete(route)
        if (this.router.app) {
          // 在 dom 更新后的下一个 tick，执行 beforeRouteEnter 中 next(cb) 传递的 cb，cb 中可以拿到组件的实例，需要等到组件挂载后，所以在 nextTick
          this.router.app.$nextTick(() => {
            handleRouteEntered(route)
          })
        }
      })
    })
  }

  updateRoute (route: Route) {
    this.current = route
    this.cb && this.cb(route)
  }

  setupListeners () {
    // Default implementation is empty
  }

  teardown () {
    // clean up event listeners
    // https://github.com/vuejs/vue-router/issues/2341
    this.listeners.forEach(cleanupListener => {
      cleanupListener()
    })
    this.listeners = []

    // reset current history route
    // https://github.com/vuejs/vue-router/issues/3294
    this.current = START
    this.pending = null
  }
}

function normalizeBase (base: ?string): string {
  if (!base) {
    if (inBrowser) {
      // respect <base> tag
      const baseEl = document.querySelector('base')
      base = (baseEl && baseEl.getAttribute('href')) || '/'
      // strip full URL origin
      base = base.replace(/^https?:\/\/[^\/]+/, '')
    } else {
      base = '/'
    }
  }
  // make sure there's the starting slash
  if (base.charAt(0) !== '/') {
    base = '/' + base
  }
  // remove trailing slash
  return base.replace(/\/$/, '')
}

function resolveQueue (
  current: Array<RouteRecord>,
  next: Array<RouteRecord>
): {
  updated: Array<RouteRecord>,
  activated: Array<RouteRecord>,
  deactivated: Array<RouteRecord>
} {
  let i
  const max = Math.max(current.length, next.length)
  for (i = 0; i < max; i++) {
    if (current[i] !== next[i]) {
      break
    }
  }
  return {
    updated: next.slice(0, i),
    activated: next.slice(i),
    deactivated: current.slice(i)
  }
}

function extractGuards (
  records: Array<RouteRecord>,
  name: string,
  bind: Function,
  reverse?: boolean
): Array<?Function> {
  const guards = flatMapComponents(records, (def, instance, match, key) => {
    // 通过为 def 组件创建一个构造函数实例，来拿到组件中定义的 key 属性
    const guard = extractGuard(def, name)
    // 如果定义了相应的钩子，钩子可以是一个数组
    if (guard) {
      return Array.isArray(guard)
        ? guard.map(guard => bind(guard, instance, match, key))
        : bind(guard, instance, match, key)
    }
  })
  // 正常来说得到的钩子顺序是是父 -> 子的顺序
  return flatten(reverse ? guards.reverse() : guards)
}

function extractGuard (
  def: Object | Function,
  key: string
): NavigationGuard | Array<NavigationGuard> {
  if (typeof def !== 'function') {
    // extend now so that global mixins are applied.
    def = _Vue.extend(def)
  }
  return def.options[key]
}

// 从组件上提取 beforeRouteLeave 钩子，顺序是从子 => 父
function extractLeaveGuards (deactivated: Array<RouteRecord>): Array<?Function> {
  return extractGuards(deactivated, 'beforeRouteLeave', bindGuard, true)
}

// 从组件上提取 beforeRouteUpdate 钩子，顺序是从父 => 子
function extractUpdateHooks (updated: Array<RouteRecord>): Array<?Function> {
  return extractGuards(updated, 'beforeRouteUpdate', bindGuard)
}

function bindGuard (guard: NavigationGuard, instance: ?_Vue): ?NavigationGuard {
  if (instance) {
    // 组件中定义的导航守卫 guard. 返回的 boundRouteGuard 是前面两个方法每一项的值
    return function boundRouteGuard () {
      return guard.apply(instance, arguments)
    }
  }
}

// 提取组件中的 beforeRouteEnter 钩子
function extractEnterGuards (
  activated: Array<RouteRecord>
): Array<?Function> {
  return extractGuards(
    activated,
    'beforeRouteEnter',
    (guard, _, match, key) => {
      return bindEnterGuard(guard, match, key)
    }
  )
}

function bindEnterGuard (
  guard: NavigationGuard,
  match: RouteRecord,
  key: string
): NavigationGuard {
  return function routeEnterGuard (to, from, next) {
    return guard(to, from, cb => {
      // 如果执行 next(cb) 那么 cb 会等到当前组件渲染后再执行
      if (typeof cb === 'function') {
        if (!match.enteredCbs[key]) {
          // 将 cb 存储到 record 上
          match.enteredCbs[key] = []
        }
        // 将 cb 存储到 record 上
        match.enteredCbs[key].push(cb)
      }
      next(cb)
    })
  }
}
