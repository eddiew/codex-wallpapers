// Runs in an isolated world in each frame of the ChatGPT desktop app. Only the
// main window (app://-/index.html with no initialRoute, which marks overlays
// and detached windows) gets a wallpaper.
const { ipcRenderer } = require('electron')

const isMainWindow =
  location.protocol === 'app:' &&
  window.top === window &&
  location.pathname === '/index.html' &&
  !new URLSearchParams(location.search).has('initialRoute')

if (isMainWindow) {
  const invoke = (channel, ...args) => ipcRenderer.invoke(`codex-wallpapers:${channel}`, ...args)
  let settings = null
  let fileUrl = null // Blob URL for a local file wallpaper.

  const CSS = `
:root[data-cw-on], :root[data-cw-on] body { background: transparent !important; }
#cw-backdrop { position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden;
  background: var(--color-surface); opacity: 0; transition: opacity 300ms ease; }
:root[data-cw-on] #cw-backdrop { opacity: 1; }
/* Blurred so text stays legible over any photo; scaled so the blur's soft edges fall outside the window. */
#cw-backdrop img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
  object-position: 50% 40%; opacity: 0; transition: opacity 700ms ease, filter 200ms ease;
  filter: blur(calc(var(--cw-blur, 16) * 1px)); transform: scale(calc(1 + var(--cw-blur, 16) * 0.004)); }
#cw-backdrop img[data-shown] { opacity: 1; }
#cw-backdrop .cw-veil { position: absolute; inset: 0;
  background: color-mix(in oklab, var(--color-surface) calc(var(--cw-dim, 0.25) * 100%), transparent); }

/* Conversations and other pages: the main panel frosts the photo. */
:root[data-cw-on] main[data-app-shell-main-surface] {
  background-color: color-mix(in oklab, var(--color-surface) calc(var(--cw-frost, 0.72) * 100%), transparent) !important;
  backdrop-filter: blur(40px) saturate(1.2);
}
/* Pages inside the panel (Settings, for one) that paint their own solid surface. */
:root[data-cw-on] main[data-app-shell-main-surface] [class~="electron:bg-surface"] {
  background-color: transparent !important;
}
/* The sidebar frosts it too, a little lighter. */
:root[data-cw-on] aside.app-shell-left-panel {
  background-color: color-mix(in oklab, var(--color-surface) calc(var(--cw-frost, 0.72) * 90%), transparent) !important;
  backdrop-filter: blur(30px) saturate(1.3);
}
/* Home: the photo shows through behind the greeting and composer. */
:root[data-cw-on]:has([data-composer-placement="home"]) main[data-app-shell-main-surface] {
  background-color: transparent !important;
  backdrop-filter: none;
}
/* A soft halo in the surface color keeps the greeting legible over bright photos. */
:root[data-cw-on] [class~="group/home-composer-layout"] > :first-child {
  text-shadow: 0 0 28px var(--color-surface), 0 1px 3px color-mix(in oklab, var(--color-surface) 80%, transparent);
}
:root[data-cw-on]:has([data-composer-placement="home"]) [data-composer-rail-item] {
  background-color: color-mix(in oklab, var(--color-surface) 70%, transparent);
  backdrop-filter: blur(20px);
}
:root[data-cw-on]:has([data-composer-placement="home"])[data-cw-sharp-home] #cw-backdrop img { filter: none; transform: none; }
/* Fades that paint the solid surface color (above and below the conversation)
   show hard edges over the glass, so they go while a wallpaper is on. */
:root[data-cw-on] [class*="_MainContentTopFade_"],
:root[data-cw-on] .pointer-events-none.bg-gradient-to-t.from-surface { display: none; }
/* Fills behind the main panel's rounded corner; with a wallpaper it shows as an untextured strip. */
:root[data-cw-on] aside.app-shell-left-panel::after { display: none; }

/* Picker */
#cw-panel { position: fixed; top: 52px; right: 12px; z-index: 2147483000; width: 400px;
  max-height: calc(100vh - 72px); display: flex; flex-direction: column; overflow: hidden;
  border-radius: 16px; border: 1px solid color-mix(in oklab, currentColor 14%, transparent);
  background: color-mix(in oklab, var(--color-surface) 82%, transparent);
  backdrop-filter: blur(40px) saturate(1.4); color: inherit;
  box-shadow: 0 24px 64px rgb(0 0 0 / 0.35); font: 13px/1.4 system-ui, -apple-system, sans-serif;
  animation: cw-in 160ms ease; }
#cw-panel[hidden] { display: none; }
/* Native popups (the select lists) follow the app's theme, and their options
   use the system's matching text and background instead of the panel's. */
:root[data-theme="dark"] #cw-panel { color-scheme: dark; }
:root[data-theme="light"] #cw-panel { color-scheme: light; }
#cw-panel select option { color: CanvasText; background-color: Canvas; }
@keyframes cw-in { from { opacity: 0; transform: translateY(-6px) scale(0.98); } }
#cw-panel * { box-sizing: border-box; }
#cw-panel header { display: flex; align-items: center; gap: 10px; padding: 14px 14px 10px; }
#cw-panel header h2 { margin: 0; flex: 1; font-size: 14px; font-weight: 600; }
#cw-panel .cw-body { overflow-y: auto; padding: 0 14px 14px; display: flex; flex-direction: column; gap: 12px; }
#cw-panel button, #cw-panel select, #cw-panel input[type="text"], #cw-panel input[type="search"] {
  font: inherit; color: inherit; border-radius: 8px; border: 1px solid color-mix(in oklab, currentColor 14%, transparent);
  background: color-mix(in oklab, currentColor 6%, transparent); padding: 5px 9px; outline: none; }
#cw-panel button { cursor: pointer; }
#cw-panel button:hover { background: color-mix(in oklab, currentColor 12%, transparent); }
#cw-panel button[aria-pressed="true"] { background: color-mix(in oklab, currentColor 22%, transparent); }
#cw-panel input:focus, #cw-panel select:focus { border-color: color-mix(in oklab, currentColor 40%, transparent); }
#cw-panel .cw-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
#cw-panel .cw-row > input[type="search"], #cw-panel .cw-row > input[type="text"] { flex: 1; min-width: 0; }
#cw-panel .cw-close { border: 0; background: transparent; font-size: 18px; line-height: 1; padding: 2px 6px; opacity: 0.7; }
#cw-panel .cw-current { position: relative; height: 150px; border-radius: 12px; overflow: hidden;
  background: color-mix(in oklab, currentColor 8%, transparent) center / cover no-repeat; }
#cw-panel .cw-current .cw-actions { position: absolute; right: 8px; bottom: 8px; display: flex; gap: 6px; }
#cw-panel .cw-current .cw-actions button { background: rgb(0 0 0 / 0.55); color: #fff; border-color: rgb(255 255 255 / 0.2); }
#cw-panel .cw-current a { position: absolute; left: 10px; bottom: 10px; color: #fff; font-size: 11px;
  text-shadow: 0 1px 4px rgb(0 0 0 / 0.8); text-decoration: none; opacity: 0.85; }
#cw-panel .cw-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
#cw-panel .cw-grid button { padding: 0; border: 2px solid transparent; aspect-ratio: 16 / 10; overflow: hidden;
  background: color-mix(in oklab, currentColor 8%, transparent) center / cover no-repeat; border-radius: 8px; }
#cw-panel .cw-grid button:hover { border-color: color-mix(in oklab, currentColor 45%, transparent); }
#cw-panel .cw-grid button[aria-current="true"] { border-color: currentColor; }
#cw-panel .cw-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.55; }
#cw-panel .cw-setting { display: grid; grid-template-columns: 110px 1fr; align-items: center; gap: 8px; }
#cw-panel .cw-body > * { flex-shrink: 0; }
#cw-panel .cw-value { opacity: 0.55; font-variant-numeric: tabular-nums; }
#cw-panel .cw-check { display: flex; align-items: center; gap: 6px; }
/* The app's CSS strips native checkbox styling, so draw it here. */
#cw-panel .cw-check input { -webkit-appearance: none; appearance: none; flex: none; margin: 0; width: 16px; height: 16px;
  border-radius: 4px; border: 1px solid color-mix(in oklab, currentColor 35%, transparent);
  background: color-mix(in oklab, currentColor 6%, transparent) center / 12px no-repeat; cursor: pointer; }
#cw-panel .cw-check input:checked { background-color: #34c759; border-color: #34c759;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6.2l2.3 2.3 4.7-5' fill='none' stroke='white' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }
#cw-panel input[type="range"] { -webkit-appearance: none; appearance: none; width: 100%; height: 4px; margin: 8px 0;
  border-radius: 2px; background: color-mix(in oklab, currentColor 22%, transparent); }
#cw-panel input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px;
  border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgb(0 0 0 / 0.4); cursor: pointer; }
#cw-panel .cw-status { font-size: 12px; opacity: 0.65; min-height: 16px; }
#cw-panel .cw-footer { font-size: 11px; opacity: 0.5; }
#cw-panel .cw-footer a { color: inherit; }
#cw-panel .cw-switch { position: relative; width: 34px; height: 20px; border-radius: 10px; padding: 0; border: 0;
  background: color-mix(in oklab, currentColor 20%, transparent); }
#cw-panel .cw-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: #fff; transition: transform 150ms ease; box-shadow: 0 1px 2px rgb(0 0 0 / 0.3); }
#cw-panel .cw-switch[aria-checked="true"] { background: #34c759; }
#cw-panel .cw-switch[aria-checked="true"]::after { transform: translateX(14px); }
@media (prefers-reduced-motion: reduce) { #cw-backdrop img, #cw-backdrop, #cw-panel { transition: none; animation: none; } }
`

  // A tiny element helper: h('div', { class: 'x', onclick }, ...children)
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value)
      else el.setAttribute(key, value === true ? '' : value)
    }
    el.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false))
    return el
  }

  // Backdrop ------------------------------------------------------------------

  const style = h('style', { id: 'cw-style' }, CSS)
  const veil = h('div', { class: 'cw-veil' })
  const backdrop = h('div', { id: 'cw-backdrop', 'aria-hidden': 'true' }, veil)
  let shownKey = null

  function attach() {
    if (!style.isConnected) document.head.append(style)
    if (!backdrop.isConnected) document.body.prepend(backdrop)
  }

  async function imageUrl(image) {
    if (image.source !== 'file') return image.url
    const file = await invoke('read-file', image.id)
    if (!file) return null
    if (fileUrl) URL.revokeObjectURL(fileUrl)
    fileUrl = URL.createObjectURL(new Blob([file.bytes], { type: file.type }))
    return fileUrl
  }

  async function render() {
    if (!settings) return
    const root = document.documentElement
    root.style.setProperty('--cw-dim', String(settings.dim))
    root.style.setProperty('--cw-frost', String(settings.frost))
    root.style.setProperty('--cw-blur', String(settings.blur))
    root.toggleAttribute('data-cw-sharp-home', settings.sharpHome)
    const image = settings.enabled ? settings.image : null
    if (!image) {
      delete root.dataset.cwOn
      shownKey = null
      return
    }
    const key = `${image.source}:${image.id}`
    if (key === shownKey) {
      root.dataset.cwOn = ''
      return
    }
    shownKey = key
    const url = await imageUrl(image)
    if (!url || shownKey !== key) return
    const img = h('img', { alt: '', decoding: 'async' })
    img.src = url
    try {
      await img.decode()
    } catch {
      return // Leave the current wallpaper up.
    }
    if (shownKey !== key) return
    veil.before(img)
    root.dataset.cwOn = ''
    requestAnimationFrame(() => img.setAttribute('data-shown', ''))
    // Crossfade, then drop the old photos.
    setTimeout(() => {
      for (const old of backdrop.querySelectorAll('img')) if (old !== img) old.remove()
    }, 800)
  }

  // Picker --------------------------------------------------------------------

  const panel = h('div', { id: 'cw-panel', hidden: true, role: 'dialog', 'aria-label': 'Wallpaper' })
  // Keep typing in the panel away from the app's own shortcuts.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    panel.addEventListener(type, (event) => {
      if (event.key !== 'Escape') event.stopPropagation()
    })
  }
  let results = []
  let page = 1
  let lastPage = 1
  let searching = false
  let status = ''

  const CATEGORIES = [
    ['General', 0],
    ['Anime', 1],
    ['People', 2],
  ]
  const SORTS = [
    ['toplist', 'Top this month'],
    ['hot', 'Hot'],
    ['random', 'Random'],
    ['date_added', 'Latest'],
    ['views', 'Most viewed'],
  ]
  const SHUFFLES = [
    [0, 'Off'],
    [15, 'Every 15 minutes'],
    [60, 'Every hour'],
    [240, 'Every 4 hours'],
    [1440, 'Every day'],
  ]

  async function runSearch({ more = false } = {}) {
    if (searching) return
    searching = true
    status = 'Searching Wallhaven…'
    drawPanel()
    try {
      const next = more ? page + 1 : 1
      const result = await invoke('search', settings.filters, next)
      results = more ? [...results, ...result.images] : result.images
      page = next
      lastPage = result.lastPage
      status = results.length ? '' : 'No wallpapers match that search.'
    } catch (error) {
      status = cleanError(error)
    } finally {
      searching = false
      drawPanel()
    }
  }

  const cleanError = (error) => String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

  async function act(fn) {
    try {
      status = ''
      await fn()
    } catch (error) {
      status = cleanError(error)
      drawPanel()
    }
  }

  function drawPanel() {
    if (panel.hidden || !settings) return
    const { filters } = settings
    const focusedName = document.activeElement?.closest?.('#cw-panel') ? document.activeElement.getAttribute('name') : null
    const scrollTop = panel.querySelector('.cw-body')?.scrollTop ?? 0
    const current = settings.image
    const preview = current?.source === 'file' ? fileUrl : current?.thumb ?? current?.url

    const categoryBits = filters.categories.split('')
    const categoryButtons = CATEGORIES.map(([label, bit]) =>
      h(
        'button',
        {
          'aria-pressed': String(categoryBits[bit] === '1'),
          onclick: () => {
            const bits = [...categoryBits]
            bits[bit] = bits[bit] === '1' ? '0' : '1'
            if (!bits.includes('1')) return
            act(async () => {
              await invoke('set', { filters: { categories: bits.join('') } })
              runSearch()
            })
          },
        },
        label,
      ),
    )

    const body = h(
      'div',
      { class: 'cw-body' },
      h(
        'div',
        { class: 'cw-current', style: preview ? { backgroundImage: `url("${preview}")` } : {} },
        current?.page ? h('a', { href: current.page, target: '_blank', rel: 'noreferrer' }, `wallhaven ${current.id}`) : null,
        current?.source === 'file' ? h('a', {}, current.name ?? 'Your image') : null,
        h('div', { class: 'cw-actions' }, h('button', { onclick: () => act(() => invoke('shuffle')) }, 'Next ↻')),
      ),
      h(
        'form',
        {
          class: 'cw-row',
          onsubmit: (event) => {
            event.preventDefault()
            const query = new FormData(event.target).get('query')
            act(async () => {
              await invoke('set', { filters: { query } })
              runSearch()
            })
          },
        },
        h('input', { type: 'search', name: 'query', placeholder: 'Search Wallhaven (e.g. mountains, city night)', value: filters.query }),
        h('button', { type: 'submit' }, 'Search'),
      ),
      h(
        'div',
        { class: 'cw-row' },
        categoryButtons,
        h(
          'select',
          {
            name: 'sorting',
            style: { marginLeft: 'auto' },
            onchange: (event) =>
              act(async () => {
                await invoke('set', { filters: { sorting: event.target.value } })
                runSearch()
              }),
          },
          SORTS.map(([value, label]) => h('option', { value, selected: value === filters.sorting }, label)),
        ),
      ),
      h(
        'div',
        { class: 'cw-grid' },
        results.map((image) =>
          h('button', {
            title: `${image.resolution} · wallhaven ${image.id}`,
            'aria-current': String(image.id === current?.id),
            style: { backgroundImage: `url("${image.thumb}")` },
            onclick: () => act(() => invoke('choose', image)),
          }),
        ),
      ),
      page < lastPage && results.length
        ? h('button', { onclick: () => runSearch({ more: true }), disabled: searching }, searching ? 'Loading…' : 'More')
        : null,
      h('div', { class: 'cw-status' }, status),
      h('div', { class: 'cw-label' }, 'Settings'),
      h(
        'label',
        { class: 'cw-setting' },
        'Shuffle',
        h(
          'select',
          { name: 'shuffle', onchange: (event) => act(() => invoke('set', { shuffleMinutes: Number(event.target.value) })) },
          SHUFFLES.map(([value, label]) => h('option', { value, selected: value === settings.shuffleMinutes }, label)),
        ),
      ),
      h(
        'label',
        { class: 'cw-setting' },
        h('span', {}, 'Blur ', h('span', { class: 'cw-value' }, settings.blur ? `${settings.blur}px` : 'off')),
        h('input', {
          type: 'range', name: 'blur', min: 0, max: 48, step: 2, value: settings.blur,
          oninput: (event) => {
            document.documentElement.style.setProperty('--cw-blur', event.target.value)
            event.target.previousElementSibling.lastChild.textContent = Number(event.target.value) ? `${event.target.value}px` : 'off'
          },
          onchange: (event) => act(() => invoke('set', { blur: Number(event.target.value) })),
        }),
      ),
      h(
        'label',
        { class: 'cw-setting' },
        'Home screen',
        h(
          'span',
          { class: 'cw-check' },
          h('input', {
            type: 'checkbox', name: 'sharpHome', checked: settings.sharpHome,
            onchange: (event) => act(() => invoke('set', { sharpHome: event.target.checked })),
          }),
          'Sharp, no blur',
        ),
      ),
      h(
        'label',
        { class: 'cw-setting' },
        'Dim photo',
        h('input', {
          type: 'range', name: 'dim', min: 0, max: 0.9, step: 0.05, value: settings.dim,
          oninput: (event) => document.documentElement.style.setProperty('--cw-dim', event.target.value),
          onchange: (event) => act(() => invoke('set', { dim: Number(event.target.value) })),
        }),
      ),
      h(
        'label',
        { class: 'cw-setting' },
        'Glass tint',
        h('input', {
          type: 'range', name: 'frost', min: 0.2, max: 0.95, step: 0.05, value: settings.frost,
          oninput: (event) => document.documentElement.style.setProperty('--cw-frost', event.target.value),
          onchange: (event) => act(() => invoke('set', { frost: Number(event.target.value) })),
        }),
      ),
      h(
        'form',
        {
          class: 'cw-row',
          onsubmit: (event) => {
            event.preventDefault()
            const url = String(new FormData(event.target).get('url') ?? '').trim()
            if (url) act(() => invoke('choose', { source: 'url', url }))
          },
        },
        h('input', { type: 'text', name: 'url', placeholder: 'https://… image URL' }),
        h('button', { type: 'submit' }, 'Use'),
        h('button', { type: 'button', onclick: () => act(() => invoke('choose-file')) }, 'Choose file…'),
      ),
      h(
        'div',
        { class: 'cw-footer' },
        'Photos from ',
        h('a', { href: 'https://wallhaven.cc', target: '_blank', rel: 'noreferrer' }, 'wallhaven.cc'),
        ' · Codex Wallpapers is unofficial and not affiliated with OpenAI.',
      ),
    )

    panel.replaceChildren(
      h(
        'header',
        {},
        h('h2', {}, 'Wallpaper'),
        h('button', {
          class: 'cw-switch',
          role: 'switch',
          name: 'enabled',
          'aria-label': 'Show wallpaper',
          'aria-checked': String(settings.enabled),
          onclick: () => act(() => invoke('set', { enabled: !settings.enabled })),
        }),
        h('button', { class: 'cw-close', 'aria-label': 'Close', onclick: closePanel }, '×'),
      ),
      body,
    )
    body.scrollTop = scrollTop
    if (focusedName) panel.querySelector(`[name="${focusedName}"]`)?.focus()
  }

  function openPanel() {
    attach()
    if (!panel.isConnected) document.body.append(panel)
    panel.hidden = false
    drawPanel()
    if (!results.length) runSearch()
  }

  function closePanel() {
    panel.hidden = true
  }

  function togglePanel() {
    if (panel.hidden) openPanel()
    else closePanel()
  }

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && !panel.hidden) {
        event.stopPropagation()
        closePanel()
      }
    },
    true,
  )
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!panel.hidden && !panel.contains(event.target)) closePanel()
    },
    true,
  )

  // Wiring --------------------------------------------------------------------

  ipcRenderer.on('codex-wallpapers:changed', (_event, next) => {
    settings = next
    render()
    drawPanel()
  })
  ipcRenderer.on('codex-wallpapers:open', togglePanel)

  function start() {
    attach()
    // React owns #root, not <body>, but keep our nodes attached regardless.
    new MutationObserver(attach).observe(document.documentElement, { childList: true, subtree: false })
    new MutationObserver(attach).observe(document.body, { childList: true })
    invoke('get').then((initial) => {
      settings = initial
      render()
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
}
