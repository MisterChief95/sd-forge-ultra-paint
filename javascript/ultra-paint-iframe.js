Promise.resolve().then(async () => {
  const delay = (timeout = 0) => new Promise((resolve) => setTimeout(resolve, timeout))
  const asyncCheck = async (getter, checkSize = 100, timeout = 1000) => {
    let target = getter()
    let num = 0
    while (checkSize * num < timeout && (target === undefined || target === null)) {
      await delay(checkSize)
      target = getter()
      num++
    }
    return target
  }

  const wrap = await asyncCheck(
    () => gradioApp().querySelector('#upaint-iframe-wrapper'),
    500,
    Infinity
  )
  wrap.childNodes.forEach((child) => wrap.removeChild(child))

  const iframe = document.createElement('iframe')
  iframe.src = window.location.origin + '/ultra_paint/app/'
  iframe.style = 'width: 100%; height: 100vh; border: none; display: block;'
  wrap.appendChild(iframe)

  // `height: 100vh` alone overflows the actual visible viewport by however
  // tall Gradio's own top tab bar is (the iframe starts partway down the
  // page, not at y=0), so the bottom of the app is cut off behind the fold
  // instead of ending at the window edge. Pin the wrapper to the remaining
  // viewport below the tab bar once this tab is actually active, same idiom
  // `sd-webui-infinite-image-browsing`'s `javascript/index.js` uses (its
  // `onUiTabChange` "maximize" block) -- not ported when this file was first
  // written, added back once this exact symptom showed up live.
  //
  // `topOffset` is measured once, before `wrap` is ever taken out of normal
  // flow, and reused on every later tab switch -- recomputing
  // `getBoundingClientRect()` after `position: fixed` is already applied
  // would read back a stale/zeroed value instead of the tab bar's real
  // height, since `wrap` is no longer where flow layout would place it.
  let topOffset = null

  onUiTabChange(() => {
    const current = get_uiCurrentTabContent()
    if (!current || !current.id || !current.id.includes('ultra_paint')) return
    try {
      if (topOffset === null) {
        topOffset = wrap.getBoundingClientRect().top
      }
      wrap.style.position = 'fixed'
      wrap.style.top = `${topOffset}px`
      wrap.style.left = '0'
      wrap.style.right = '0'
      wrap.style.bottom = '0'
      wrap.style.zIndex = '100'
      iframe.style.width = '100%'
      iframe.style.height = '100%'
    } catch (error) {
      console.error('[ultra-paint] failed to size the iframe to the viewport', error)
    }
  })
})
