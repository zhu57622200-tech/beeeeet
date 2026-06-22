// 数字滚动动画：from→to easeOutCubic，一次性 RAF 播完即停，返回 cancel()。
// 纯回调、无 DOM 依赖：onFrame 收到当前帧的整数值，由调用方写入响应式 ref。
// 无 RAF 环境（测试/SSR）直接跳到终值，保证行为确定。
export function countUp(from, to, durMs, onFrame) {
  if (typeof requestAnimationFrame !== 'function' || typeof performance === 'undefined' || !(durMs > 0)) {
    onFrame(to)
    return () => {}
  }
  const t0 = performance.now()
  let raf = 0
  let fallback = 0
  const stop = () => { cancelAnimationFrame(raf); clearTimeout(fallback) }
  const step = (t) => {
    const p = Math.min(1, (t - t0) / durMs)
    const e = 1 - Math.pow(1 - p, 3)
    onFrame(Math.round(from + (to - from) * e))
    if (p < 1) raf = requestAnimationFrame(step)
    else clearTimeout(fallback)
  }
  raf = requestAnimationFrame(step)
  // 后台标签页 RAF 会被暂停：超时兜底强制落到终值，防显示值冻结在中间数
  fallback = setTimeout(() => { stop(); onFrame(to) }, durMs + 150)
  return stop
}

// 装饰动画是否应禁用（prefers-reduced-motion）。无 matchMedia 环境视为禁用。
export function prefersReducedMotion() {
  return typeof matchMedia !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches
}
