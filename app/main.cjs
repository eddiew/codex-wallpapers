// Runs in the ChatGPT desktop app's main process before the app itself loads.
// It owns wallpaper settings, Wallhaven searches (Wallhaven sends no CORS
// headers, so the page can't fetch it directly) and shuffle, and seats the
// preload that draws the wallpaper in the window.
const fs = require('node:fs')
const path = require('node:path')
const electron = require('electron')

const WALLHAVEN = 'https://wallhaven.cc/api/v1/search'
const SHUFFLE_PAGES = 5
const RECENT_LIMIT = 30
const RETRY_MS = 5 * 60_000

const DEFAULTS = {
  enabled: true,
  image: null, // { id, url, thumb, source: 'wallhaven' | 'url' | 'file', colors? }
  filters: { query: '', categories: '100', sorting: 'toplist', topRange: '1M' },
  shuffleMinutes: 0,
  shuffledAt: 0,
  blur: 16,
  sharpHome: false,
  dim: 0.3,
  frost: 0.72,
  recent: [],
}

module.exports = function codexWallpapers({ appName, version, isolateProfile = true }) {
  const { app, dialog, ipcMain, Menu, powerMonitor, session, webContents } = electron

  // A standalone copy gets an independent profile: its own storage and
  // single-instance lock, so it runs beside the official app instead of
  // handing off to it. Layered onto another patched copy (--onto), the host
  // already has its own profile and keeps it.
  if (isolateProfile) {
    const profile = path.join(app.getPath('appData'), appName)
    const setPath = app.setPath.bind(app)
    app.setPath = (name, value) => setPath(name, name === 'userData' ? profile : value)
    setPath('userData', profile)
  }

  // Resolved on use: a host app may set its user-data path after this runs.
  const settingsPath = () => path.join(app.getPath('userData'), 'wallpaper.json')
  const filesDir = () => path.join(app.getPath('userData'), 'wallpapers')
  let settings = structuredClone(DEFAULTS)
  let timer
  let retryAt = 0
  let shuffling = null

  function load() {
    try {
      const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
      settings = { ...DEFAULTS, ...saved, filters: { ...DEFAULTS.filters, ...saved.filters } }
    } catch {
      settings = structuredClone(DEFAULTS)
    }
  }

  function save() {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
  }

  const windows = () =>
    webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && isAppPage(contents.getURL()))
  const isAppPage = (url) => url.startsWith('app://')

  function publish() {
    save()
    for (const contents of windows()) contents.send('codex-wallpapers:changed', settings)
    const toggle = Menu.getApplicationMenu()?.getMenuItemById('codex-wallpapers-show')
    if (toggle) toggle.checked = settings.enabled
    schedule()
  }

  function update(patch) {
    settings = { ...settings, ...patch, filters: { ...settings.filters, ...patch.filters } }
    publish()
  }

  function show(image) {
    const recent = image.source === 'wallhaven' ? [image.id, ...settings.recent.filter((id) => id !== image.id)] : settings.recent
    update({ image, enabled: true, shuffledAt: Date.now(), recent: recent.slice(0, RECENT_LIMIT) })
  }

  // Wallhaven -----------------------------------------------------------------

  async function search(filters, page = 1) {
    const params = new URLSearchParams({
      q: String(filters.query ?? '').slice(0, 100),
      categories: /^[01]{3}$/.test(filters.categories) && filters.categories !== '000' ? filters.categories : '100',
      purity: '100', // Safe for work, always.
      sorting: ['toplist', 'hot', 'random', 'date_added', 'favorites', 'views'].includes(filters.sorting)
        ? filters.sorting
        : 'toplist',
      order: 'desc',
      atleast: '1920x1080',
      ratios: 'landscape',
      page: String(Math.max(1, Math.min(page, 100))),
    })
    if (params.get('sorting') === 'toplist') params.set('topRange', filters.topRange || '1M')
    // Node's fetch, not net.fetch: the app's session blocks hosts it doesn't expect.
    const response = await fetch(`${WALLHAVEN}?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': `codex-wallpapers/${version}` },
    })
    if (response.status === 429) throw new Error('Wallhaven is limiting searches. Try again in a minute.')
    if (!response.ok) throw new Error(`Wallhaven search failed (${response.status}).`)
    const body = await response.json()
    return {
      lastPage: body.meta?.last_page ?? 1,
      images: (body.data ?? [])
        .filter((item) => item.purity === 'sfw')
        .map((item) => ({
          id: item.id,
          url: item.path,
          thumb: item.thumbs?.large ?? item.thumbs?.original,
          colors: item.colors ?? [],
          resolution: item.resolution,
          page: item.url,
          source: 'wallhaven',
        })),
    }
  }

  function shuffle() {
    shuffling ??= (async () => {
      try {
        const { filters } = settings
        const first = await search(filters, 1)
        const page = filters.sorting === 'random' ? 1 : 1 + Math.floor(Math.random() * Math.min(first.lastPage, SHUFFLE_PAGES))
        const { images } = page === 1 ? first : await search(filters, page)
        const fresh = images.filter((image) => image.id !== settings.image?.id)
        const unseen = fresh.filter((image) => !settings.recent.includes(image.id))
        const choices = unseen.length ? unseen : fresh
        const next = choices[Math.floor(Math.random() * choices.length)]
        retryAt = 0
        if (next) show(next)
      } catch (error) {
        retryAt = Date.now() + RETRY_MS
        schedule()
        throw error
      }
    })().finally(() => {
      shuffling = null
    })
    return shuffling
  }

  function report(error) {
    console.error('[codex-wallpapers]', error)
  }

  function schedule() {
    clearTimeout(timer)
    if (!settings.enabled) return
    let due
    if (!settings.image) due = Date.now()
    else if (settings.shuffleMinutes > 0) due = settings.shuffledAt + settings.shuffleMinutes * 60_000
    else return
    const delay = Math.min(Math.max(Math.max(due, retryAt) - Date.now(), 0), 2 ** 31 - 1)
    timer = setTimeout(() => shuffle().catch(report), delay)
  }

  // Local files ---------------------------------------------------------------

  const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.heic': 'image/heic' }

  async function chooseFile(owner) {
    const result = await dialog.showOpenDialog(owner, {
      title: 'Choose a wallpaper',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: Object.keys(IMAGE_TYPES).map((ext) => ext.slice(1)) }],
    })
    if (result.canceled || !result.filePaths[0]) return
    const source = result.filePaths[0]
    const ext = path.extname(source).toLowerCase()
    if (!IMAGE_TYPES[ext]) throw new Error('That file is not a supported image.')
    fs.mkdirSync(filesDir(), { recursive: true })
    const id = `file-${Date.now()}${ext}`
    fs.copyFileSync(source, path.join(filesDir(), id))
    // Keep only the most recent few copied files.
    for (const stale of fs.readdirSync(filesDir()).sort().slice(0, -5)) fs.rmSync(path.join(filesDir(), stale), { force: true })
    show({ id, source: 'file', name: path.basename(source) })
  }

  function readFile(id) {
    if (typeof id !== 'string' || !/^file-\d+\.\w+$/.test(id)) return null
    const ext = path.extname(id).toLowerCase()
    try {
      return { bytes: fs.readFileSync(path.join(filesDir(), id)), type: IMAGE_TYPES[ext] ?? 'image/jpeg' }
    } catch {
      return null
    }
  }

  // IPC -----------------------------------------------------------------------

  const trusted = (event) => isAppPage(event.senderFrame?.url ?? event.sender.getURL())
  const handle = (channel, handler) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!trusted(event)) throw new Error('Not allowed.')
      return handler(event, ...args)
    })

  handle('codex-wallpapers:get', () => settings)
  handle('codex-wallpapers:search', (_event, filters, page) => search({ ...settings.filters, ...filters }, page))
  handle('codex-wallpapers:shuffle', () => shuffle())
  handle('codex-wallpapers:read-file', (_event, id) => readFile(id))
  handle('codex-wallpapers:choose-file', (event) => chooseFile(electron.BrowserWindow.fromWebContents(event.sender)))
  handle('codex-wallpapers:choose', (_event, image) => {
    if (image?.source === 'wallhaven' && /^https:\/\/w\.wallhaven\.cc\//.test(image.url)) return show(image)
    if (image?.source === 'url' && /^https:\/\//.test(image.url)) return show({ id: image.url, url: image.url, source: 'url' })
    throw new Error('Wallpapers must be https URLs.')
  })
  handle('codex-wallpapers:set', (_event, patch) => {
    const clean = {}
    if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled
    if ([0, 15, 60, 240, 1440].includes(patch.shuffleMinutes)) clean.shuffleMinutes = patch.shuffleMinutes
    if (typeof patch.dim === 'number') clean.dim = Math.min(Math.max(patch.dim, 0), 0.9)
    if (typeof patch.sharpHome === 'boolean') clean.sharpHome = patch.sharpHome
    if (typeof patch.blur === 'number') clean.blur = Math.min(Math.max(Math.round(patch.blur), 0), 48)
    if (typeof patch.frost === 'number') clean.frost = Math.min(Math.max(patch.frost, 0.2), 0.95)
    if (patch.filters && typeof patch.filters === 'object') {
      const { query, categories, sorting, topRange } = patch.filters
      clean.filters = {}
      if (typeof query === 'string') clean.filters.query = query.slice(0, 100)
      if (typeof categories === 'string') clean.filters.categories = categories
      if (typeof sorting === 'string') clean.filters.sorting = sorting
      if (typeof topRange === 'string') clean.filters.topRange = topRange
    }
    if (clean.shuffleMinutes !== undefined) clean.shuffledAt = Date.now()
    update(clean)
  })

  // Menu: a Wallpaper menu beside the app's own, whenever it sets its menu.
  const sendToFocused = (channel) => {
    // The focused window, else the main one: the app also keeps hidden
    // overlay windows, which load index.html with an initialRoute.
    const isMain = (window) => window.webContents.getURL() === 'app://-/index.html'
    const focused = electron.BrowserWindow.getFocusedWindow()
    const target = focused && isMain(focused) ? focused : electron.BrowserWindow.getAllWindows().find(isMain)
    target?.webContents.send(channel)
  }
  const wallpaperMenu = () =>
    new electron.MenuItem({
      label: 'Wallpaper',
      id: 'codex-wallpapers',
      submenu: [
        { label: 'Choose Wallpaper…', accelerator: 'Command+Control+B', click: () => sendToFocused('codex-wallpapers:open') },
        { label: 'Next Wallpaper', accelerator: 'Command+Control+N', click: () => shuffle().catch(report) },
        {
          label: 'Show Wallpaper',
          id: 'codex-wallpapers-show',
          type: 'checkbox',
          checked: settings.enabled,
          click: (item) => update({ enabled: item.checked }),
        },
        { type: 'separator' },
        { label: `Codex Wallpapers ${version}`, enabled: false },
      ],
    })
  const setApplicationMenu = Menu.setApplicationMenu.bind(Menu)
  Menu.setApplicationMenu = (menu) => {
    if (menu && !menu.getMenuItemById('codex-wallpapers')) {
      const windowIndex = menu.items.findIndex((item) => item.role === 'windowmenu' || item.role === 'windowMenu')
      menu.insert(windowIndex === -1 ? menu.items.length : windowIndex, wallpaperMenu())
    }
    return setApplicationMenu(menu)
  }

  // The preload draws the wallpaper; it checks for itself that it's in the
  // app's main window before doing anything.
  const preload = path.join(__dirname, 'preload.cjs')
  const seated = new WeakSet()
  const seat = (target) => {
    if (seated.has(target)) return
    seated.add(target)
    target.registerPreloadScript({ type: 'frame', id: 'codex-wallpapers', filePath: preload })
  }
  app.on('session-created', seat)
  app
    .whenReady()
    .then(() => {
      load()
      seat(session.defaultSession)
      schedule()
      // Timers don't advance through sleep.
      powerMonitor.on('resume', schedule)
    })
    .catch(report)
}
