/* @flow */

import type VueRouter from '../index'
import { parsePath, resolvePath } from './path'
import { resolveQuery } from './query'
import { fillParams } from './params'
import { warn } from './warn'
import { extend } from './misc'

// 当 raw 是一个 / 开头的根路径时，那么返回的 hash、path、query 都以新的 raw 为准
// 否则，相当于在 current 的基础上更新 path、parent、query 等
// 1. 如果 location 指定了 name，直接返回 location
// 2. 如果未指定 path，根据当前的 route 为 location 生成 name 或者 path
// 3. 如果指定了 path，那么整合 location 和 当前 route 中的 path、query、hash
export function normalizeLocation (
  raw: RawLocation,
  current: ?Route,
  append: ?boolean,
  router: ?VueRouter
): Location {
  let next: Location = typeof raw === 'string' ? { path: raw } : raw
  // named target
  // 如果已经 normalized 过了，直接返回
  if (next._normalized) {
    return next
  // 如果有 location 中指定了 name，那么直接返回
  } else if (next.name) {
    next = extend({}, raw)
    const params = next.params
    if (params && typeof params === 'object') {
      next.params = extend({}, params)
    }
    return next
  }

  // relative params
  // 如果没有指定 path，为 next 生成 name 或者 path
  if (!next.path && next.params && current) {
    next = extend({}, next)
    next._normalized = true
    // 那么更新合并以前的  current.params 和传进来的 raw.params
    const params: any = extend(extend({}, current.params), next.params)
    // 如果指定了name，将 current 上的 name 赋值给 next
    if (current.name) {
      next.name = current.name
      next.params = params
    // 如果 current 上没有name，那么为 next 生成 path
    } else if (current.matched.length) {
      const rawPath = current.matched[current.matched.length - 1].path
      // 拿到当前匹配到的 record 对应的 path，即 rawPath，使用 params 填充 rawPath
      next.path = fillParams(rawPath, params, `path ${current.path}`)
    } else if (process.env.NODE_ENV !== 'production') {
      warn(false, `relative params navigation requires a current route.`)
    }
    return next
  }
  // 下面是指定了 path 的逻辑
  const parsedPath = parsePath(next.path || '')
  const basePath = (current && current.path) || '/'
  // 拼接传进来的 path 和 current.path
  const path = parsedPath.path
    ? resolvePath(parsedPath.path, basePath, append || next.append)
    : basePath
  // 合并传入的 path 上的 query 和 next.query 
  const query = resolveQuery(
    parsedPath.query,
    next.query,
    router && router.options.parseQuery
  )
  
  let hash = next.hash || parsedPath.hash
  if (hash && hash.charAt(0) !== '#') {
    hash = `#${hash}`
  }

  return {
    _normalized: true,
    path,
    query,
    hash
  }
}
