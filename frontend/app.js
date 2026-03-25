/**
 * Receipt Vault — Frontend Application
 * Single-page PWA: Auth, Dashboard, Scan, Browse, Detail, Export, Settings
 */

'use strict'

// ── Constants ──────────────────────────────────────────────────────────────────

const API_BASE = (window.VAULT_CONFIG?.API_URL ?? 'http://localhost:8787').replace(/\/$/, '')

const CATEGORIES = [
  'Food & Ingredients',
  'Alcohol & Beverages',
  'Kitchen Equipment',
  'Cleaning & Supplies',
  'Packaging & Takeout',
  'Utilities',
  'Rent',
  'Insurance',
  'Marketing',
  'Maintenance & Repair',
  'Licensing & Permits',
  'Delivery & Transport',
  'Other',
]

const PAYMENT_METHODS = ['cash', 'debit', 'credit', 'e-transfer', 'unknown']

const CATEGORY_BADGE = {
  'Food & Ingredients':   'amber',
  'Alcohol & Beverages':  'purple',
  'Kitchen Equipment':    'blue',
  'Cleaning & Supplies':  'teal',
  'Packaging & Takeout':  'orange',
  'Utilities':            'amber',
  'Rent':                 'red',
  'Insurance':            'blue',
  'Marketing':            'purple',
  'Maintenance & Repair': 'orange',
  'Licensing & Permits':  'muted',
  'Delivery & Transport': 'green',
  'Other':                'muted',
}

// ── Formatters ─────────────────────────────────────────────────────────────────

const fmt = {
  currency(amount) {
    if (amount == null || amount === '') return '—'
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)
  },

  date(dateStr) {
    if (!dateStr) return '—'
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-CA', {
      year: 'numeric', month: 'short', day: 'numeric',
    })
  },

  dateInput(dateStr) {
    if (!dateStr) return ''
    return dateStr.slice(0, 10)
  },

  capitalize(str) {
    if (!str) return ''
    return str.charAt(0).toUpperCase() + str.slice(1)
  },
}

// ── API client ─────────────────────────────────────────────────────────────────

const api = {
  async request(method, path, body = null, isFormData = false) {
    const headers = {}
    const token = auth.getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
    if (!isFormData && body) headers['Content-Type'] = 'application/json'

    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: isFormData ? body : (body ? JSON.stringify(body) : undefined),
    })

    if (res.status === 401) {
      auth.clear()
      router.navigate('/')
      throw new Error('Session expired. Please sign in again.')
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }))
      const error = new Error(err.error ?? `Request failed (${res.status})`)
      error.status = res.status
      error.data = err
      throw error
    }

    return res.json()
  },

  login(passphrase) {
    const payload = { passphrase }
    const siteKey = window.VAULT_CONFIG?.TURNSTILE_SITE_KEY
    if (siteKey && window.turnstile) {
      payload.turnstileToken = window.turnstile.getResponse()
    }
    return this.request('POST', '/auth/login', payload)
  },

  extractReceipt(file) {
    const fd = new FormData()
    fd.append('file', file)
    return this.request('POST', '/api/receipts/extract', fd, true)
  },

  uploadReceiptImage(file) {
    const fd = new FormData()
    fd.append('file', file)
    return this.request('POST', '/api/receipts/upload', fd, true)
  },

  discardPending(imageKey) {
    return this.request('POST', '/api/receipts/discard', { imageKey })
  },

  createReceipt(data) {
    return this.request('POST', '/api/receipts', data)
  },

  importEmail(data) {
    return this.request('POST', '/api/receipts/import', data)
  },

  getSources() {
    return this.request('GET', '/api/sources')
  },

  listReceipts(filters = {}) {
    const params = new URLSearchParams()
    Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, String(v)) })
    return this.request('GET', `/api/receipts?${params}`)
  },

  getReceipt(id) {
    return this.request('GET', `/api/receipts/${id}`)
  },

  updateReceipt(id, data) {
    return this.request('PUT', `/api/receipts/${id}`, data)
  },

  deleteReceipt(id) {
    return this.request('DELETE', `/api/receipts/${id}`)
  },

  getStats() {
    return this.request('GET', '/api/stats')
  },

  exportReceipts(filters = {}) {
    const params = new URLSearchParams()
    Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, String(v)) })
    return this.request('GET', `/api/export?${params}`)
  },

  // Fetch an auth-gated image and return a blob URL
  async fetchImage(receiptId) {
    const token = auth.getToken()
    const res = await fetch(`${API_BASE}/api/receipts/${receiptId}/image`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) return null
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  },
}

// ── Auth ───────────────────────────────────────────────────────────────────────

const auth = {
  TOKEN_KEY: 'vault:token',
  REMEMBER_KEY: 'vault:remember',

  getToken() {
    // Prefer sessionStorage so tokens don't persist indefinitely on shared devices.
    return sessionStorage.getItem(this.TOKEN_KEY) || localStorage.getItem(this.TOKEN_KEY)
  },

  isLoggedIn() {
    return !!this.getToken()
  },

  async login(passphrase) {
    const { token } = await api.login(passphrase)
    const remember = localStorage.getItem(this.REMEMBER_KEY) === '1'
    if (remember) {
      localStorage.setItem(this.TOKEN_KEY, token)
      sessionStorage.removeItem(this.TOKEN_KEY)
    } else {
      sessionStorage.setItem(this.TOKEN_KEY, token)
      localStorage.removeItem(this.TOKEN_KEY)
    }
  },

  clear() {
    sessionStorage.removeItem(this.TOKEN_KEY)
    localStorage.removeItem(this.TOKEN_KEY)
  },

  logout() {
    this.clear()
    router.navigate('/')
  },
}

// ── Router ─────────────────────────────────────────────────────────────────────

const router = {
  routes: [
    { re: /^\/$/, view: 'home' },
    { re: /^\/scan$/, view: 'scan' },
    { re: /^\/browse$/, view: 'browse' },
    { re: /^\/import$/, view: 'import' },
    { re: /^\/receipt\/([^/]+)$/, view: 'detail', param: 1 },
    { re: /^\/export$/, view: 'export' },
    { re: /^\/settings$/, view: 'settings' },
  ],

  intendedPath: null,

  init() {
    window.addEventListener('hashchange', () => this.dispatch())
    this.dispatch()
  },

  navigate(path) {
    const newHash = '#' + path
    if (window.location.hash === newHash) {
      // Hash won't change → hashchange won't fire → dispatch manually
      this.dispatch()
    } else {
      window.location.hash = newHash
    }
  },

  dispatch() {
    const path = window.location.hash.replace(/^#/, '') || '/'

    if (!auth.isLoggedIn()) {
      // Remember where they wanted to go (e.g. a direct link from Excel)
      if (path !== '/' && path !== '') this.intendedPath = path
      views.render('auth')
      return
    }

    for (const route of this.routes) {
      const m = path.match(route.re)
      if (m) {
        const param = route.param ? m[route.param] : null
        views.render(route.view, param)
        return
      }
    }

    this.navigate('/')
  },
}

// ── Image optimizer (client-side) ──────────────────────────────────────────────

const imgUtils = {
  async getJpegOrientation(file) {
    if (!file.type.includes('jpeg') && !file.type.includes('jpg')) return 1

    const buf = await file.arrayBuffer()
    const view = new DataView(buf)
    if (view.getUint16(0, false) !== 0xFFD8) return 1

    let offset = 2
    while (offset < view.byteLength) {
      const marker = view.getUint16(offset, false)
      offset += 2
      if (marker === 0xFFE1) {
        const length = view.getUint16(offset, false)
        offset += 2
        if (view.getUint32(offset, false) !== 0x45786966) return 1 // "Exif"
        offset += 6

        const little = view.getUint16(offset, false) === 0x4949
        const firstIfd = view.getUint32(offset + 4, little)
        let dirOffset = offset + firstIfd
        const entries = view.getUint16(dirOffset, little)
        dirOffset += 2

        for (let i = 0; i < entries; i++) {
          const entryOffset = dirOffset + i * 12
          if (view.getUint16(entryOffset, little) === 0x0112) {
            return view.getUint16(entryOffset + 8, little)
          }
        }
        return 1
      }
      if ((marker & 0xFF00) !== 0xFF00) break
      offset += view.getUint16(offset, false)
    }
    return 1
  },

  async loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image()
      const url = URL.createObjectURL(file)
      img.onload = () => {
        URL.revokeObjectURL(url)
        resolve(img)
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('Failed to load image'))
      }
      img.src = url
    })
  },

  drawWithOrientation(ctx, img, width, height, orientation) {
    switch (orientation) {
      case 2:
        ctx.translate(width, 0)
        ctx.scale(-1, 1)
        break
      case 3:
        ctx.translate(width, height)
        ctx.rotate(Math.PI)
        break
      case 4:
        ctx.translate(0, height)
        ctx.scale(1, -1)
        break
      case 5:
        ctx.rotate(0.5 * Math.PI)
        ctx.scale(1, -1)
        break
      case 6:
        ctx.rotate(0.5 * Math.PI)
        ctx.translate(0, -height)
        break
      case 7:
        ctx.rotate(0.5 * Math.PI)
        ctx.translate(width, -height)
        ctx.scale(-1, 1)
        break
      case 8:
        ctx.rotate(-0.5 * Math.PI)
        ctx.translate(-width, 0)
        break
      default:
        break
    }
    ctx.drawImage(img, 0, 0, width, height)
  },

  async transform(file, options = {}) {
    if (file.type === 'application/pdf') return file

    const {
      rotation = 0,
      crop = { top: 0, right: 0, bottom: 0, left: 0 },
      maxPx = 1400,
      quality = 0.82,
      forceJpeg = true,
    } = options

    const img = await this.loadImage(file)
    const orientation = await this.getJpegOrientation(file)
    const rotatedByExif = orientation >= 5 && orientation <= 8
    const orientedWidth = rotatedByExif ? img.naturalHeight : img.naturalWidth
    const orientedHeight = rotatedByExif ? img.naturalWidth : img.naturalHeight

    const baseCanvas = document.createElement('canvas')
    baseCanvas.width = orientedWidth
    baseCanvas.height = orientedHeight
    const baseCtx = baseCanvas.getContext('2d')
    baseCtx.save()
    this.drawWithOrientation(baseCtx, img, img.naturalWidth, img.naturalHeight, orientation)
    baseCtx.restore()

    const cropLeft = Math.round(baseCanvas.width * (crop.left ?? 0))
    const cropRight = Math.round(baseCanvas.width * (crop.right ?? 0))
    const cropTop = Math.round(baseCanvas.height * (crop.top ?? 0))
    const cropBottom = Math.round(baseCanvas.height * (crop.bottom ?? 0))
    const sourceWidth = Math.max(32, baseCanvas.width - cropLeft - cropRight)
    const sourceHeight = Math.max(32, baseCanvas.height - cropTop - cropBottom)
    const quarterTurns = ((rotation % 360) + 360) % 360 / 90
    const turns = [0, 1, 2, 3].includes(quarterTurns) ? quarterTurns : 0

    const targetMax = Math.max(sourceWidth, sourceHeight) > maxPx
      ? maxPx / Math.max(sourceWidth, sourceHeight)
      : 1
    const drawWidth = Math.max(1, Math.round(sourceWidth * targetMax))
    const drawHeight = Math.max(1, Math.round(sourceHeight * targetMax))
    const swapAxes = turns % 2 === 1

    const finalCanvas = document.createElement('canvas')
    finalCanvas.width = swapAxes ? drawHeight : drawWidth
    finalCanvas.height = swapAxes ? drawWidth : drawHeight

    const finalCtx = finalCanvas.getContext('2d')
    finalCtx.fillStyle = '#f5f5f5'
    finalCtx.fillRect(0, 0, finalCanvas.width, finalCanvas.height)
    finalCtx.save()
    if (turns === 1) {
      finalCtx.translate(finalCanvas.width, 0)
      finalCtx.rotate(Math.PI / 2)
    } else if (turns === 2) {
      finalCtx.translate(finalCanvas.width, finalCanvas.height)
      finalCtx.rotate(Math.PI)
    } else if (turns === 3) {
      finalCtx.translate(0, finalCanvas.height)
      finalCtx.rotate(-Math.PI / 2)
    }
    finalCtx.drawImage(
      baseCanvas,
      cropLeft,
      cropTop,
      sourceWidth,
      sourceHeight,
      0,
      0,
      drawWidth,
      drawHeight,
    )
    finalCtx.restore()

    const mimeType = forceJpeg ? 'image/jpeg' : file.type
    const ext = mimeType === 'image/png' ? 'png' : 'jpg'
    const fileName = file.name.replace(/\.[^.]+$/, '') + `.${ext}`

    return new Promise(resolve => {
      finalCanvas.toBlob(blob => {
        resolve(new File([blob], fileName, { type: mimeType }))
      }, mimeType, quality)
    })
  },

  /**
   * Resize + JPEG compress an image file.
   * Uses progressive quality reduction to guarantee the result stays under
   * TARGET_KB. Receipts are text-heavy so 1200 px / 75 % quality is sharp
   * enough for both OCR and on-screen reading while being ~4× smaller than
   * the previous 1600 px / 88 % default.
   */
  optimize(file, maxPx = 1400, quality = 0.82, edits = {}) {
    const TARGET_KB = 800
    return new Promise(resolve => {
      // PDFs pass through unchanged
      if (file.type === 'application/pdf') { resolve(file); return }

      const tryEncode = async q => {
        try {
          const nextFile = await this.transform(file, {
            rotation: edits.rotation ?? 0,
            crop: edits.crop ?? { top: 0, right: 0, bottom: 0, left: 0 },
            maxPx,
            quality: q,
          })
          if (nextFile.size > TARGET_KB * 1024 && q > 0.62) {
            tryEncode(Math.round((q - 0.06) * 100) / 100)
          } else {
            resolve(nextFile)
          }
        } catch {
          resolve(file)
        }
      }
      tryEncode(quality)
    })
  },

  dataUrl(file) {
    return new Promise(resolve => {
      const reader = new FileReader()
      reader.onload = e => resolve(e.target.result)
      reader.readAsDataURL(file)
    })
  },

  /**
   * Stitch multiple images vertically into a single JPEG.
   * Each image is scaled to a common max width, with a thin dividing line between them.
   * Returns a single File ready to upload.
   */
  stitch(files, maxWidth = 1400, quality = 0.80) {
    return new Promise((resolve, reject) => {
      const nonPdf = files.filter(f => f.type !== 'application/pdf')
      if (nonPdf.length === 1) { resolve(nonPdf[0]); return }
      if (nonPdf.length === 0) { resolve(files[0]); return }

      let loaded = 0
      const imgs = new Array(nonPdf.length)

      nonPdf.forEach((file, i) => {
        const img = new Image()
        const url = URL.createObjectURL(file)
        img.onload = () => {
          URL.revokeObjectURL(url)
          imgs[i] = img
          if (++loaded === nonPdf.length) compose()
        }
        img.onerror = () => reject(new Error(`Failed to load image ${i + 1}`))
        img.src = url
      })

      function compose() {
        const SEP = 4 // px divider between parts

        // Scale each image to fit maxWidth
        const scaled = imgs.map(img => {
          const r = img.naturalWidth > maxWidth ? maxWidth / img.naturalWidth : 1
          return { img, w: Math.round(img.naturalWidth * r), h: Math.round(img.naturalHeight * r) }
        })

        const canvasW = Math.max(...scaled.map(s => s.w))
        const canvasH = scaled.reduce((sum, s) => sum + s.h, 0) + SEP * (scaled.length - 1)

        const canvas = document.createElement('canvas')
        canvas.width = canvasW
        canvas.height = canvasH
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#f5f5f5'
        ctx.fillRect(0, 0, canvasW, canvasH)

        let y = 0
        scaled.forEach((s, i) => {
          const x = Math.round((canvasW - s.w) / 2) // center narrower parts
          ctx.drawImage(s.img, x, y, s.w, s.h)
          if (i < scaled.length - 1) {
            y += s.h
            ctx.fillStyle = '#cccccc'
            ctx.fillRect(0, y, canvasW, SEP)
            y += SEP
          }
        })

        canvas.toBlob(
          blob => resolve(new File([blob], 'receipt-stitched.jpg', { type: 'image/jpeg' })),
          'image/jpeg',
          quality,
        )
      }
    })
  },
}

// ── Toast notifications ────────────────────────────────────────────────────────

const toast = {
  show(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toasts')
    if (!container) return

    const el = document.createElement('div')
    el.className = `toast toast--${type}`
    el.textContent = message
    container.appendChild(el)

    const remove = () => {
      el.classList.add('toast--out')
      el.addEventListener('animationend', () => el.remove(), { once: true })
    }

    const timer = setTimeout(remove, duration)
    el.addEventListener('click', () => { clearTimeout(timer); remove() })
  },

  success(msg) { this.show(msg, 'success') },
  error(msg)   { this.show(msg, 'error', 5000) },
  info(msg)    { this.show(msg, 'info') },
}

// ── Views ──────────────────────────────────────────────────────────────────────

const views = {
  _current: null,
  _blobUrls: [], // track for cleanup

  get main() { return document.getElementById('main') },

  render(viewName, param = null) {
    // Cleanup previous view's blob URLs
    this._blobUrls.forEach(u => URL.revokeObjectURL(u))
    this._blobUrls = []

    const fn = this[viewName]
    if (!fn) return

    document.body.dataset.view = viewName
    this._current = viewName
    fn.call(this, param)

    this._updateNav(viewName)
    this._updateShell()
  },

  _updateNav(viewName) {
    document.querySelectorAll('[data-nav]').forEach(el => {
      el.classList.toggle('active', el.dataset.nav === viewName)
    })
  },

  _updateShell() {
    const loggedIn = auth.isLoggedIn()
    const sidebar = document.getElementById('sidebar')
    const bottomNav = document.getElementById('bottom-nav')
    if (sidebar)   sidebar.hidden   = !loggedIn
    if (bottomNav) bottomNav.hidden = !loggedIn

    const logoutBtn = document.getElementById('logout-btn')
    if (logoutBtn) {
      logoutBtn.onclick = () => auth.logout()
    }
  },

  // ── Auth ─────────────────────────────────────────────────────────────────────

  auth() {
    this.main.innerHTML = /* html */`
      <div class="auth-screen">
        <div class="auth-card">
          <div class="auth-card__brand">
            <span class="auth-card__logo">VAULT</span>
            <span class="auth-card__subtitle">Receipt Archive System</span>
          </div>
          <div class="auth-card__divider"></div>
          <form id="login-form">
            <div class="field" style="margin-bottom: 20px">
              <label class="field__label" for="passphrase">Passphrase</label>
              <input
                class="field__input"
                type="password"
                id="passphrase"
                name="passphrase"
                placeholder="Enter your vault passphrase"
                autocomplete="current-password"
                autofocus
                required
              />
            </div>
            ${window.VAULT_CONFIG?.TURNSTILE_SITE_KEY ? /* html */`
              <div style="display:flex;justify-content:center;margin:0 0 14px">
                <div class="cf-turnstile" data-sitekey="${window.VAULT_CONFIG.TURNSTILE_SITE_KEY}"></div>
              </div>
            ` : ''}
            <label style="display:flex;align-items:center;gap:10px;margin:0 0 14px;font-size:13px;color:var(--clr-text-3)">
              <input type="checkbox" id="remember-me" />
              Remember this device
            </label>
            <button class="btn btn--primary btn--full" type="submit" id="login-btn">
              Enter Vault
            </button>
            <p id="login-error" class="field__error" style="margin-top:12px;text-align:center;display:none"></p>
          </form>
        </div>
      </div>
    `

    document.getElementById('login-form').addEventListener('submit', async e => {
      e.preventDefault()
      const passphrase = document.getElementById('passphrase').value
      const remember = document.getElementById('remember-me')?.checked === true
      localStorage.setItem(auth.REMEMBER_KEY, remember ? '1' : '0')
      const btn = document.getElementById('login-btn')
      const errEl = document.getElementById('login-error')

      btn.disabled = true
      btn.innerHTML = '<span class="spinner"></span>'
      errEl.style.display = 'none'

      try {
        const siteKey = window.VAULT_CONFIG?.TURNSTILE_SITE_KEY
        if (siteKey) {
          if (!window.turnstile) throw new Error('Turnstile failed to load. Please refresh and try again.')
          const t = window.turnstile.getResponse()
          if (!t) throw new Error('Please complete the Turnstile check.')
        }
        await auth.login(passphrase)
        const dest = router.intendedPath || '/'
        router.intendedPath = null
        router.navigate(dest)
      } catch (err) {
        errEl.textContent = err.message
        errEl.style.display = 'block'
        if (window.turnstile) window.turnstile.reset()
        btn.disabled = false
        btn.textContent = 'Enter Vault'
      }
    })
  },

  // ── Dashboard ────────────────────────────────────────────────────────────────

  async home() {
    this.main.innerHTML = /* html */`
      <div class="dashboard-view">
        <div class="page-header">
          <h1 class="page-title">Dashboard</h1>
        </div>
        <div id="stats-area">
          <div class="stats-grid">
            ${['This Month', 'All Time', 'Top Category'].map(l => /* html */`
              <div class="stat-card">
                <div class="stat-card__label">${l}</div>
                <div class="stat-card__value stat-card__value--accent">
                  <span class="spinner" style="width:16px;height:16px"></span>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="dashboard-cta">
          <a href="#/scan" class="btn btn--primary btn--lg">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
            Scan Receipt
          </a>
          <a href="#/browse" class="btn btn--secondary btn--lg">Browse All</a>
        </div>
        <div class="dashboard-bottom-grid">
          <div>
            <div class="section-title">Recent Receipts</div>
            <div id="recent-list" class="receipt-list">
              <div class="empty-state" style="padding:32px 0">
                <span class="spinner"></span>
              </div>
            </div>
          </div>
          <div>
            <div class="section-title">Top Categories</div>
            <div id="top-categories" class="top-categories"></div>
          </div>
        </div>
      </div>
    `

    try {
      const data = await api.getStats()

      // Stats cards
      const statsHtml = /* html */`
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-card__label">This Month</div>
            <div class="stat-card__value stat-card__value--accent amount">${fmt.currency(data.thisMonth.total)}</div>
            <div class="stat-card__sub">${data.thisMonth.count} receipt${data.thisMonth.count !== 1 ? 's' : ''}</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__label">All Time</div>
            <div class="stat-card__value amount">${fmt.currency(data.allTime.total)}</div>
            <div class="stat-card__sub">${data.allTime.count} total</div>
          </div>
          <div class="stat-card">
            <div class="stat-card__label">Top Category</div>
            <div class="stat-card__value" style="font-size:16px;font-family:var(--font-body)">
              ${data.topCategories[0]?.category ?? '—'}
            </div>
            <div class="stat-card__sub">${fmt.currency(data.topCategories[0]?.total)}</div>
          </div>
        </div>
      `
      document.getElementById('stats-area').innerHTML = statsHtml

      // Recent receipts
      const recentEl = document.getElementById('recent-list')
      if (data.recentReceipts.length === 0) {
        recentEl.innerHTML = /* html */`
          <div class="empty-state" style="padding:32px 0">
            <div class="empty-state__title">No receipts yet</div>
            <div class="empty-state__desc">Start by scanning your first receipt.</div>
          </div>
        `
      } else {
        recentEl.innerHTML = data.recentReceipts.map(r => receiptItemHtml(r)).join('')
      }

      // Top categories bar chart
      const catEl = document.getElementById('top-categories')
      if (data.topCategories.length === 0) {
        catEl.innerHTML = '<p style="font-size:13px;color:var(--clr-text-3)">No data yet.</p>'
      } else {
        const max = data.topCategories[0]?.total || 1
        catEl.innerHTML = data.topCategories.map(c => /* html */`
          <div class="category-row">
            <span class="category-row__name">${c.category}</span>
            <div class="category-row__bar-wrap">
              <div class="category-row__bar" style="width:${Math.round((c.total / max) * 100)}%"></div>
            </div>
            <span class="category-row__total amount">${fmt.currency(c.total)}</span>
          </div>
        `).join('')
      }
    } catch (err) {
      toast.error(err.message)
    }
  },

  // ── Scan ─────────────────────────────────────────────────────────────────────

  scan() {
    // files   : raw File objects (one per photo)
    // previews: data-URL strings for thumbnails
    const defaultEdits = () => ({
      rotation: 0,
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
    })

    const scanState = {
      sourceFiles: [],
      files: [],
      previews: [],
      edits: [],
      imageKey: null,
      extracted: null,
      stitchedFile: null,
    }

    this.main.innerHTML = /* html */`
      <div class="scan-view">
        <div class="page-header">
          <h1 class="page-title">Scan Receipt</h1>
        </div>
        <div id="scan-stage"></div>
      </div>
    `

    const stage = document.getElementById('scan-stage')

    let flowMode = 'ai'
    const pageTitle = this.main.querySelector('.page-title')

    const setFlowMode = (mode) => {
      flowMode = mode
      if (!pageTitle) return
      pageTitle.textContent = mode === 'manual' ? 'Add Receipt Manually' : 'Scan Receipt'
    }

    // ── Upload zone (step 1) ───────────────────────────────────────────────────

    const showUploadZone = () => {
      const hasFiles = scanState.files.length > 0
      const multiHint = hasFiles && scanState.files.length > 1
        ? `<span style="color:var(--clr-accent)">${scanState.files.length} parts</span> will be stitched`
        : 'Add more photos if the receipt is too long to fit in one shot'

      stage.innerHTML = /* html */`
        <div class="upload-zone${hasFiles ? ' upload-zone--has-files' : ''}" id="upload-zone">
          ${hasFiles ? '' : /* empty state */ `
            <div class="upload-zone__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="12" y2="13"/></svg>
            </div>
            <h2 class="upload-zone__title">Drop a receipt here</h2>
            <p class="upload-zone__sub">JPEG, PNG, WebP, or PDF · Max 20 MB per photo</p>
          `}

          ${hasFiles ? /* thumbnail strip */ `
            <div class="multi-thumbs" id="thumb-strip">
              ${scanState.previews.map((url, i) => `
                <div class="multi-thumb" data-idx="${i}">
                  <div class="multi-thumb__num">${i + 1}</div>
                  ${url
                    ? `<img src="${url}" class="multi-thumb__img" alt="Part ${i + 1}" />`
                    : `<div class="multi-thumb__pdf">PDF</div>`}
                  ${scanState.files[i]?.type !== 'application/pdf'
                    ? `<button class="multi-thumb__edit" data-idx="${i}" title="Adjust image" type="button">Adjust</button>`
                    : ''}
                  <button class="multi-thumb__remove" data-idx="${i}" title="Remove" type="button">✕</button>
                </div>
              `).join('')}
              ${scanState.files.length < 8 ? `
                <button class="multi-thumb multi-thumb--add" id="btn-add-more" type="button" title="Add another photo">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                </button>
              ` : ''}
            </div>
            <p class="upload-zone__sub" style="margin:0 0 16px">${multiHint}</p>
          ` : ''}

          <div class="upload-zone__actions">
            ${hasFiles ? `
              <button class="btn btn--primary" id="btn-extract">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                Analyze Receipt
              </button>
              <button class="btn btn--secondary" id="btn-manual" title="Skip AI extraction and fill fields yourself">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
                Add Manually
              </button>
              <button class="btn btn--secondary" id="btn-camera">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                Take Photo
              </button>
              <button class="btn btn--ghost" id="btn-clear">Clear All</button>
            ` : `
              <button class="btn btn--primary" id="btn-camera">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                Take Photo
              </button>
              <button class="btn btn--secondary" id="btn-manual" title="Skip AI extraction and fill fields yourself">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
                Add Manually
              </button>
              <button class="btn btn--secondary" id="btn-upload">Upload File</button>
            `}
          </div>
        </div>
      `

      const zone = document.getElementById('upload-zone')

      // Drag-and-drop (accepts multiple files)
      zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over') })
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
      zone.addEventListener('drop', e => {
        e.preventDefault()
        zone.classList.remove('drag-over')
        if (e.dataTransfer.files.length) handleFilesAdded(Array.from(e.dataTransfer.files))
      })

      // Remove individual thumbnails
      stage.querySelectorAll('.multi-thumb__remove').forEach(btn => {
        btn.onclick = e => {
          e.stopPropagation()
          const idx = parseInt(btn.dataset.idx)
          scanState.sourceFiles.splice(idx, 1)
          scanState.files.splice(idx, 1)
          scanState.previews.splice(idx, 1)
          scanState.edits.splice(idx, 1)
          showUploadZone()
        }
      })

      stage.querySelectorAll('.multi-thumb__edit').forEach(btn => {
        btn.onclick = e => {
          e.stopPropagation()
          const idx = parseInt(btn.dataset.idx)
          openEditor(idx)
        }
      })

      if (document.getElementById('btn-camera')) {
        document.getElementById('btn-camera').onclick = () => triggerCapture(true)
      }
      if (document.getElementById('btn-upload')) {
        document.getElementById('btn-upload').onclick = () => triggerCapture(false)
      }
      if (document.getElementById('btn-add-more')) {
        document.getElementById('btn-add-more').onclick = () => triggerCapture(false)
      }
      if (document.getElementById('btn-clear')) {
        document.getElementById('btn-clear').onclick = () => {
          resetScan()
        }
      }
      if (document.getElementById('btn-extract')) {
        document.getElementById('btn-extract').onclick = () => {
          setFlowMode('ai')
          startExtraction()
        }
      }
      if (document.getElementById('btn-manual')) {
        document.getElementById('btn-manual').onclick = async () => {
          setFlowMode('manual')
          if (scanState.files.length > 0) {
            await startManualUploadAndReview()
          } else {
            triggerCapture(true)
          }
        }
      }
    }

    // ── File input helpers ─────────────────────────────────────────────────────

    const triggerCapture = (camera) => {
      const input = document.getElementById('file-capture')
      if (camera) {
        input.setAttribute('capture', 'environment')
        input.removeAttribute('multiple')
      } else {
        input.removeAttribute('capture')
        input.setAttribute('multiple', '')
      }
      input.onchange = e => {
        const files = Array.from(e.target.files)
        input.value = ''
        if (files.length) handleFilesAdded(files)
      }
      input.click()
    }

    const handleFilesAdded = async (rawFiles) => {
      // Optimize images one by one (PDFs pass through unchanged)
      for (const raw of rawFiles) {
        if (scanState.files.length >= 8) {
          toast.info('Maximum 8 parts per receipt.')
          break
        }
        const edits = defaultEdits()
        const optimized = await imgUtils.optimize(raw, 1400, 0.82, edits)
        const preview = optimized.type !== 'application/pdf'
          ? await imgUtils.dataUrl(optimized)
          : null
        scanState.sourceFiles.push(raw)
        scanState.files.push(optimized)
        scanState.previews.push(preview)
        scanState.edits.push(edits)
      }
      if (flowMode === 'manual') {
        await startManualUploadAndReview()
      } else {
        showUploadZone()
      }
    }

    const resetScan = async ({ discardRemote = false } = {}) => {
      if (discardRemote && scanState.imageKey?.startsWith('pending/')) {
        try {
          await api.discardPending(scanState.imageKey)
        } catch {
          // Best-effort cleanup only. Cron cleanup still catches leftovers.
        }
      }
      scanState.sourceFiles = []
      scanState.files = []
      scanState.previews = []
      scanState.edits = []
      scanState.imageKey = null
      scanState.extracted = null
      scanState.stitchedFile = null
      setFlowMode('ai')
      showUploadZone()
    }

    const openEditor = async idx => {
      const sourceFile = scanState.sourceFiles[idx]
      if (!sourceFile || sourceFile.type === 'application/pdf') {
        toast.info('PDFs do not need image adjustments.')
        return
      }

      const draft = JSON.parse(JSON.stringify(scanState.edits[idx] ?? defaultEdits()))
      const overlay = document.createElement('div')
      overlay.className = 'modal-overlay modal-overlay--editor'
      overlay.innerHTML = /* html */`
        <div class="modal editor-modal">
          <div class="editor-modal__header">
            <div>
              <div class="modal__title" style="margin-bottom:4px">Adjust Receipt</div>
              <div class="editor-modal__sub">Rotate and trim edges before analysis.</div>
            </div>
            <button class="btn btn--ghost btn--sm" id="editor-close" type="button">Close</button>
          </div>
          <div class="editor-modal__preview">
            <img id="editor-preview" alt="Receipt adjustment preview" />
          </div>
          <div class="editor-modal__toolbar">
            <button class="btn btn--secondary btn--sm" id="rotate-left" type="button">Rotate Left</button>
            <button class="btn btn--secondary btn--sm" id="rotate-right" type="button">Rotate Right</button>
            <button class="btn btn--ghost btn--sm" id="editor-reset" type="button">Reset</button>
          </div>
          <div class="editor-sliders">
            ${[
              ['top', 'Trim Top'],
              ['right', 'Trim Right'],
              ['bottom', 'Trim Bottom'],
              ['left', 'Trim Left'],
            ].map(([key, label]) => /* html */`
              <label class="editor-slider">
                <span>${label}</span>
                <input type="range" id="crop-${key}" min="0" max="25" step="1" value="${Math.round((draft.crop[key] ?? 0) * 100)}" />
                <span id="crop-${key}-value">${Math.round((draft.crop[key] ?? 0) * 100)}%</span>
              </label>
            `).join('')}
          </div>
          <div class="editor-modal__actions">
            <button class="btn btn--ghost" id="editor-cancel" type="button">Cancel</button>
            <button class="btn btn--primary" id="editor-apply" type="button">Apply Changes</button>
          </div>
        </div>
      `
      document.body.appendChild(overlay)

      const closeEditor = () => overlay.remove()

      const renderPreview = async () => {
        const previewFile = await imgUtils.transform(sourceFile, {
          rotation: draft.rotation,
          crop: draft.crop,
          maxPx: 1200,
          quality: 0.9,
        })
        document.getElementById('editor-preview').src = await imgUtils.dataUrl(previewFile)
        ;['top', 'right', 'bottom', 'left'].forEach(key => {
          document.getElementById(`crop-${key}-value`).textContent = `${Math.round((draft.crop[key] ?? 0) * 100)}%`
        })
      }

      overlay.addEventListener('click', e => {
        if (e.target === overlay) closeEditor()
      })
      document.getElementById('editor-close').onclick = closeEditor
      document.getElementById('editor-cancel').onclick = closeEditor
      document.getElementById('rotate-left').onclick = async () => {
        draft.rotation = (draft.rotation + 270) % 360
        await renderPreview()
      }
      document.getElementById('rotate-right').onclick = async () => {
        draft.rotation = (draft.rotation + 90) % 360
        await renderPreview()
      }
      document.getElementById('editor-reset').onclick = async () => {
        draft.rotation = 0
        draft.crop = defaultEdits().crop
        ;['top', 'right', 'bottom', 'left'].forEach(key => {
          document.getElementById(`crop-${key}`).value = '0'
        })
        await renderPreview()
      }

      ;['top', 'right', 'bottom', 'left'].forEach(key => {
        document.getElementById(`crop-${key}`).addEventListener('input', async e => {
          draft.crop[key] = parseInt(e.target.value, 10) / 100
          await renderPreview()
        })
      })

      document.getElementById('editor-apply').onclick = async () => {
        const btn = document.getElementById('editor-apply')
        btn.disabled = true
        btn.innerHTML = '<span class="spinner"></span> Applying…'
        try {
          const optimized = await imgUtils.optimize(sourceFile, 1400, 0.82, draft)
          scanState.files[idx] = optimized
          scanState.previews[idx] = await imgUtils.dataUrl(optimized)
          scanState.edits[idx] = JSON.parse(JSON.stringify(draft))
          closeEditor()
          showUploadZone()
        } catch (err) {
          toast.error('Failed to adjust image: ' + err.message)
          btn.disabled = false
          btn.textContent = 'Apply Changes'
        }
      }

      await renderPreview()
    }

    // ── Extraction ────────────────────────────────────────────────────────────

    const startManualUploadAndReview = async () => {
      if (!scanState.files.length) return

      let fileToUpload
      let previewToShow = null

      scanState.stitchedFile = null

      if (scanState.files.length === 1) {
        fileToUpload = scanState.files[0]
        previewToShow = scanState.previews[0]
      } else {
        // Stitch all photos into one tall JPEG for a better single-image archive.
        stage.innerHTML = `
          <div style="text-align:center;padding:48px 24px;color:var(--clr-text-3)">
            <div class="spinner" style="margin:0 auto 16px"></div>
            <div style="font-size:14px">Stitching ${scanState.files.length} photos…</div>
          </div>
        `
        try {
          fileToUpload = await imgUtils.stitch(scanState.files)
          scanState.stitchedFile = fileToUpload
          previewToShow = fileToUpload.type !== 'application/pdf'
            ? await imgUtils.dataUrl(fileToUpload)
            : null
        } catch (err) {
          toast.error('Failed to combine images: ' + err.message)
          showUploadZone()
          return
        }
      }

      stage.innerHTML = /* html */`
        <div class="scan-preview" id="scan-preview-wrap">
          ${previewToShow
            ? `<img src="${previewToShow}" class="scan-preview__image" alt="Receipt preview" />`
            : `<div style="padding:64px;text-align:center;color:var(--clr-text-3)">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                <p style="margin-top:12px;font-size:14px">${fileToUpload.name}</p>
              </div>`}
          <div class="scan-preview__overlay">
            <div class="scan-line"></div>
            <div class="scan-status">
              Uploading image
              <span class="scan-status__dots"><span></span><span></span><span></span></span>
            </div>
          </div>
        </div>
      `

      try {
        const result = await api.uploadReceiptImage(fileToUpload)
        scanState.imageKey = result.imageKey
        scanState.extracted = null
        showManualReviewForm(previewToShow)
      } catch (err) {
        toast.error(err.message)
        showUploadZone()
      }
    }

    const startExtraction = async () => {
      if (!scanState.files.length) return

      let fileToSend
      let previewToShow = null

      if (scanState.files.length === 1) {
        fileToSend = scanState.files[0]
        previewToShow = scanState.previews[0]
      } else {
        // Stitch all photos into one tall JPEG
        stage.innerHTML = `
          <div style="text-align:center;padding:48px 24px;color:var(--clr-text-3)">
            <div class="spinner" style="margin:0 auto 16px"></div>
            <div style="font-size:14px">Stitching ${scanState.files.length} photos…</div>
          </div>
        `
        try {
          fileToSend = await imgUtils.stitch(scanState.files)
          previewToShow = await imgUtils.dataUrl(fileToSend)
        } catch (err) {
          toast.error('Failed to combine images: ' + err.message)
          showUploadZone()
          return
        }
      }

      scanState.stitchedFile = fileToSend
      showProcessing(fileToSend, previewToShow)
    }

    // ── Processing spinner (step 2) ───────────────────────────────────────────

    const showProcessing = (file, previewUrl) => {
      stage.innerHTML = /* html */`
        <div class="scan-preview" id="scan-preview-wrap">
          ${previewUrl
            ? `<img src="${previewUrl}" class="scan-preview__image" alt="Receipt preview" />`
            : `<div style="padding:64px;text-align:center;color:var(--clr-text-3)">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                <p style="margin-top:12px;font-size:14px">${file.name}</p>
               </div>`}
          <div class="scan-preview__overlay">
            <div class="scan-line"></div>
            <div class="scan-status">
              ${scanState.files.length > 1 ? `Analyzing ${scanState.files.length}-part receipt` : 'Extracting receipt data'}
              <span class="scan-status__dots"><span></span><span></span><span></span></span>
            </div>
          </div>
        </div>
      `

      api.extractReceipt(file)
        .then(result => {
          scanState.imageKey = result.imageKey
          scanState.extracted = result.extracted
          showReviewForm(previewUrl)
        })
        .catch(err => {
          toast.error(err.message)
          showUploadZone()
        })
    }

    // ── Manual review form (step 2, no AI) ───────────────────────────────────

    const showManualReviewForm = (previewUrl) => {
      const d = {
        date: new Date().toISOString().slice(0, 10),
        vendor: '',
        category: 'Other',
        subtotal: null,
        hst: null,
        total: null,
        payment_method: 'unknown',
        invoice_number: null,
        notes: null,
      }

      stage.innerHTML = /* html */`
        ${previewUrl
          ? `<div class="scan-preview" style="margin-bottom:24px">
               <img src="${previewUrl}" class="scan-preview__image" alt="Receipt" />
               ${scanState.files.length > 1
                 ? `<div style="text-align:center;font-size:11px;color:var(--clr-text-3);padding:6px 0">
                      ${scanState.files.length} photos stitched · scroll to view full receipt
                    </div>`
                 : ''}
             </div>`
          : ''}
        <div class="extracted-form">
          <div class="extracted-form__header">
            <span class="extracted-form__header-title">Manual Entry</span>
            <span class="extracted-badge">✓ Image captured</span>
          </div>
          <form id="save-form" class="extracted-form__body">
            <div class="form-grid">
              <div class="field">
                <label class="field__label" for="f-date">Date</label>
                <input class="field__input field__input--mono" type="date" id="f-date" name="date" value="${fmt.dateInput(d.date)}" required />
              </div>
              <div class="field">
                <label class="field__label" for="f-vendor">Vendor</label>
                <input class="field__input" type="text" id="f-vendor" name="vendor" value="${escHtml(d.vendor)}" required />
              </div>
              <div class="field span-2">
                <label class="field__label" for="f-category">Category</label>
                <select class="field__select" id="f-category" name="category">
                  ${CATEGORIES.map(c => `<option value="${c}"${c === d.category ? ' selected' : ''}>${c}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-grid form-grid--3">
              <div class="field">
                <label class="field__label" for="f-subtotal">Subtotal</label>
                <input class="field__input field__input--mono" type="number" id="f-subtotal" name="subtotal" step="0.01" value="${d.subtotal ?? ''}" placeholder="—" />
              </div>
              <div class="field">
                <label class="field__label" for="f-hst">HST (13%)</label>
                <input class="field__input field__input--mono" type="number" id="f-hst" name="hst" step="0.01" value="${d.hst ?? ''}" placeholder="—" />
              </div>
              <div class="field">
                <label class="field__label" for="f-total">Total *</label>
                <input class="field__input field__input--mono" type="number" id="f-total" name="total" step="0.01" value="${d.total ?? ''}" required />
              </div>
            </div>
            <div class="form-grid">
              <div class="field">
                <label class="field__label" for="f-payment">Payment</label>
                <select class="field__select" id="f-payment" name="payment">
                  ${PAYMENT_METHODS.map(m => `<option value="${m}"${m === d.payment_method ? ' selected' : ''}>${fmt.capitalize(m)}</option>`).join('')}
                </select>
              </div>
              <div class="field">
                <label class="field__label" for="f-invoice">Invoice #</label>
                <input class="field__input" type="text" id="f-invoice" name="invoice" value="${escHtml(d.invoice_number ?? '')}" placeholder="Optional" />
              </div>
              <div class="field span-2">
                <label class="field__label" for="f-notes">Notes</label>
                <textarea class="field__textarea" id="f-notes" name="notes" rows="2" placeholder="Optional">${escHtml(d.notes ?? '')}</textarea>
              </div>
            </div>
          </form>
          <div class="extracted-form__actions">
            <button class="btn btn--ghost" id="btn-discard" type="button">Discard</button>
            <button class="btn btn--primary" id="btn-save" type="button">Save Receipt</button>
          </div>
        </div>
      `

      document.getElementById('btn-discard').onclick = () => {
        resetScan({ discardRemote: true })
      }

      document.getElementById('btn-save').onclick = async () => {
        const form = document.getElementById('save-form')
        if (!form.checkValidity()) { form.reportValidity(); return }

        const btn = document.getElementById('btn-save')
        btn.disabled = true
        btn.innerHTML = '<span class="spinner"></span> Saving…'

        const uploadedFile = scanState.stitchedFile ?? scanState.files[0]

        try {
          const payload = {
            imageKey:         scanState.imageKey,
            originalFilename: uploadedFile.name,
            mimeType:         uploadedFile.type,
            date:             document.getElementById('f-date').value,
            vendor:           document.getElementById('f-vendor').value,
            category:         document.getElementById('f-category').value,
            subtotal:         parseFloatOrNull(document.getElementById('f-subtotal').value),
            hst:              parseFloatOrNull(document.getElementById('f-hst').value),
            total:            parseFloat(document.getElementById('f-total').value),
            paymentMethod:    document.getElementById('f-payment').value,
            invoiceNumber:    document.getElementById('f-invoice').value || null,
            notes:            document.getElementById('f-notes').value || null,
          }

          await api.createReceipt(payload)
          toast.success('Receipt saved!')
          resetScan()
        } catch (err) {
          if (err.status === 409 && err.data?.duplicates?.length) {
            const preview = err.data.duplicates
              .map(d => `${d.vendor} · ${fmt.date(d.date)} · ${fmt.currency(d.total)}`)
              .join('\n')
            const proceed = confirm(
              `Possible duplicate receipt detected:\n\n${preview}\n\nSave anyway?`,
            )
            if (proceed) {
              try {
                await api.createReceipt({
                  imageKey:         scanState.imageKey,
                  originalFilename: uploadedFile.name,
                  mimeType:         uploadedFile.type,
                  date:             document.getElementById('f-date').value,
                  vendor:           document.getElementById('f-vendor').value,
                  category:         document.getElementById('f-category').value,
                  subtotal:         parseFloatOrNull(document.getElementById('f-subtotal').value),
                  hst:              parseFloatOrNull(document.getElementById('f-hst').value),
                  total:            parseFloat(document.getElementById('f-total').value),
                  paymentMethod:    document.getElementById('f-payment').value,
                  invoiceNumber:    document.getElementById('f-invoice').value || null,
                  notes:            document.getElementById('f-notes').value || null,
                  confirmDuplicate: true,
                })
                toast.success('Receipt saved!')
                resetScan()
                return
              } catch (retryErr) {
                toast.error(retryErr.message)
              }
            }
          } else {
            toast.error(err.message)
          }
          btn.disabled = false
          btn.textContent = 'Save Receipt'
        }
      }
    }

    // ── Review form (step 3) ──────────────────────────────────────────────────

    const showReviewForm = (previewUrl) => {
      const d = scanState.extracted

      stage.innerHTML = /* html */`
        ${previewUrl
          ? `<div class="scan-preview" style="margin-bottom:24px">
               <img src="${previewUrl}" class="scan-preview__image" alt="Receipt" />
               ${scanState.files.length > 1
                 ? `<div style="text-align:center;font-size:11px;color:var(--clr-text-3);padding:6px 0">
                      ${scanState.files.length} photos stitched · scroll to view full receipt
                    </div>`
                 : ''}
             </div>`
          : ''}
        <div class="extracted-form">
          <div class="extracted-form__header">
            <span class="extracted-form__header-title">Extracted Data</span>
            <span class="extracted-badge">✓ Ready to save</span>
          </div>
          <form id="save-form" class="extracted-form__body">
            <div class="form-grid">
              <div class="field">
                <label class="field__label" for="f-date">Date</label>
                <input class="field__input field__input--mono" type="date" id="f-date" name="date" value="${fmt.dateInput(d.date)}" required />
              </div>
              <div class="field">
                <label class="field__label" for="f-vendor">Vendor</label>
                <input class="field__input" type="text" id="f-vendor" name="vendor" value="${escHtml(d.vendor)}" required />
              </div>
              <div class="field span-2">
                <label class="field__label" for="f-category">Category</label>
                <select class="field__select" id="f-category" name="category">
                  ${CATEGORIES.map(c => `<option value="${c}"${c === d.category ? ' selected' : ''}>${c}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-grid form-grid--3">
              <div class="field">
                <label class="field__label" for="f-subtotal">Subtotal</label>
                <input class="field__input field__input--mono" type="number" id="f-subtotal" name="subtotal" step="0.01" value="${d.subtotal ?? ''}" placeholder="—" />
              </div>
              <div class="field">
                <label class="field__label" for="f-hst">HST (13%)</label>
                <input class="field__input field__input--mono" type="number" id="f-hst" name="hst" step="0.01" value="${d.hst ?? ''}" placeholder="—" />
              </div>
              <div class="field">
                <label class="field__label" for="f-total">Total *</label>
                <input class="field__input field__input--mono" type="number" id="f-total" name="total" step="0.01" value="${d.total ?? ''}" required />
              </div>
            </div>
            <div class="form-grid">
              <div class="field">
                <label class="field__label" for="f-payment">Payment</label>
                <select class="field__select" id="f-payment" name="payment">
                  ${PAYMENT_METHODS.map(m => `<option value="${m}"${m === d.payment_method ? ' selected' : ''}>${fmt.capitalize(m)}</option>`).join('')}
                </select>
              </div>
              <div class="field">
                <label class="field__label" for="f-invoice">Invoice #</label>
                <input class="field__input" type="text" id="f-invoice" name="invoice" value="${escHtml(d.invoice_number ?? '')}" placeholder="Optional" />
              </div>
              <div class="field span-2">
                <label class="field__label" for="f-notes">Notes</label>
                <textarea class="field__textarea" id="f-notes" name="notes" rows="2" placeholder="Optional">${escHtml(d.notes ?? '')}</textarea>
              </div>
            </div>
          </form>
          <div class="extracted-form__actions">
            <button class="btn btn--ghost" id="btn-discard" type="button">Discard</button>
            <button class="btn btn--primary" id="btn-save" type="button">Save Receipt</button>
          </div>
        </div>
      `

      document.getElementById('btn-discard').onclick = () => {
        resetScan({ discardRemote: true })
      }

      document.getElementById('btn-save').onclick = async () => {
        const form = document.getElementById('save-form')
        if (!form.checkValidity()) { form.reportValidity(); return }

        const btn = document.getElementById('btn-save')
        btn.disabled = true
        btn.innerHTML = '<span class="spinner"></span> Saving…'

        const uploadedFile = scanState.stitchedFile ?? scanState.files[0]

        try {
          const payload = {
            imageKey:         scanState.imageKey,
            originalFilename: uploadedFile.name,
            mimeType:         uploadedFile.type,
            date:             document.getElementById('f-date').value,
            vendor:           document.getElementById('f-vendor').value,
            category:         document.getElementById('f-category').value,
            subtotal:         parseFloatOrNull(document.getElementById('f-subtotal').value),
            hst:              parseFloatOrNull(document.getElementById('f-hst').value),
            total:            parseFloat(document.getElementById('f-total').value),
            paymentMethod:    document.getElementById('f-payment').value,
            invoiceNumber:    document.getElementById('f-invoice').value || null,
            notes:            document.getElementById('f-notes').value || null,
          }

          await api.createReceipt(payload)
          toast.success('Receipt saved!')
          resetScan()
        } catch (err) {
          if (err.status === 409 && err.data?.duplicates?.length) {
            const preview = err.data.duplicates
              .map(d => `${d.vendor} · ${fmt.date(d.date)} · ${fmt.currency(d.total)}`)
              .join('\n')
            const proceed = confirm(
              `Possible duplicate receipt detected:\n\n${preview}\n\nSave anyway?`,
            )
            if (proceed) {
              try {
                await api.createReceipt({
                  imageKey:         scanState.imageKey,
                  originalFilename: uploadedFile.name,
                  mimeType:         uploadedFile.type,
                  date:             document.getElementById('f-date').value,
                  vendor:           document.getElementById('f-vendor').value,
                  category:         document.getElementById('f-category').value,
                  subtotal:         parseFloatOrNull(document.getElementById('f-subtotal').value),
                  hst:              parseFloatOrNull(document.getElementById('f-hst').value),
                  total:            parseFloat(document.getElementById('f-total').value),
                  paymentMethod:    document.getElementById('f-payment').value,
                  invoiceNumber:    document.getElementById('f-invoice').value || null,
                  notes:            document.getElementById('f-notes').value || null,
                  confirmDuplicate: true,
                })
                toast.success('Receipt saved!')
                resetScan()
                return
              } catch (retryErr) {
                toast.error(retryErr.message)
              }
            }
          } else {
            toast.error(err.message)
          }
          btn.disabled = false
          btn.textContent = 'Save Receipt'
        }
      }
    }

    showUploadZone()
  },

  // ── Import ────────────────────────────────────────────────────────────────────

  async import() {
    this.main.innerHTML = /* html */`
      <div class="scan-view">
        <div class="page-header">
          <h1 class="page-title">Import Emails</h1>
        </div>
        <div id="import-stage"></div>
      </div>
    `

    const stage = document.getElementById('import-stage')
    const state = {
      files: [],
      messages: [],
      stopRequested: false,
      running: false,
      parsedCount: 0,
      deliveredTo: null,  // detected from Delivered-To header
    }

    const renderEmpty = () => {
      stage.innerHTML = /* html */`
        <div class="upload-zone" id="import-zone">
          <div class="upload-zone__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          </div>
          <h2 class="upload-zone__title">Drop .mbox or .eml files here</h2>
          <p class="upload-zone__sub">Takeout .mbox for bulk import, or one/many .eml files.</p>
          <p class="upload-zone__sub" style="margin-top:8px">Emails already imported will be skipped automatically.</p>
          <div class="upload-zone__actions">
            <button class="btn btn--primary" id="btn-upload-mbox">Upload .mbox</button>
            <button class="btn btn--secondary" id="btn-upload-eml">Upload .eml files</button>
          </div>
        </div>
      `

      const zone = document.getElementById('import-zone')
      zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over') })
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
      zone.addEventListener('drop', e => {
        e.preventDefault()
        zone.classList.remove('drag-over')
        if (e.dataTransfer.files.length) {
          handleSelectedFiles(Array.from(e.dataTransfer.files))
        }
      })

      document.getElementById('btn-upload-mbox').onclick = () => pickFiles('.mbox,.eml', false)
      document.getElementById('btn-upload-eml').onclick = () => pickFiles('.eml', true)
    }

    const renderReady = () => {
      const accountBadge = state.deliveredTo
        ? `<div style="display:inline-flex;align-items:center;gap:6px;background:var(--clr-surface-2);border:1px solid var(--clr-border);border-radius:8px;padding:6px 12px;font-size:13px;color:var(--clr-text-2);margin-bottom:20px">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            ${escHtml(state.deliveredTo)}
          </div>`
        : ''
      stage.innerHTML = /* html */`
        <div class="card" style="padding:24px">
          <div style="font-size:14px;color:var(--clr-text-2);margin-bottom:6px">Ready to import</div>
          <div style="font-size:20px;font-weight:600;margin-bottom:8px">${state.messages.length} email message${state.messages.length !== 1 ? 's' : ''}</div>
          <div style="font-size:13px;color:var(--clr-text-3);margin-bottom:12px">Parsed from ${state.files.length} selected file${state.files.length !== 1 ? 's' : ''}.</div>
          ${accountBadge}
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn btn--primary" id="btn-start-import">Start Import</button>
            <button class="btn btn--ghost" id="btn-reset-import">Choose Different Files</button>
          </div>
        </div>
      `

      document.getElementById('btn-start-import').onclick = () => runImport()
      document.getElementById('btn-reset-import').onclick = () => {
        state.files = []
        state.messages = []
        state.stopRequested = false
        state.running = false
        state.parsedCount = 0
        renderEmpty()
      }
    }

    const renderProgress = () => {
      stage.innerHTML = /* html */`
        <div class="card" style="padding:20px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px">
            <div>
              <div style="font-size:14px;color:var(--clr-text-2)">Import in progress</div>
              <div id="import-progress-text" style="font-size:18px;font-weight:600">Importing 0 / ${state.messages.length}</div>
            </div>
            <button class="btn btn--ghost btn--sm" id="btn-stop-import">Stop</button>
          </div>
          <div style="height:8px;background:var(--clr-surface-2);border-radius:999px;overflow:hidden;margin-bottom:14px">
            <div id="import-progress-bar" style="height:100%;width:0;background:var(--clr-accent);transition:width .2s ease"></div>
          </div>
          <div id="import-summary" style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--clr-text-3);margin-bottom:12px"></div>
          <div id="import-log" style="max-height:360px;overflow:auto;border:1px solid var(--clr-border);border-radius:12px;padding:10px;background:var(--clr-surface-1);font-size:12px;font-family:var(--font-mono)"></div>
        </div>
      `
      document.getElementById('btn-stop-import').onclick = () => {
        state.stopRequested = true
      }
    }

    const pickFiles = (accept, multiple) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = accept
      if (multiple) input.multiple = true
      input.onchange = () => {
        const files = Array.from(input.files || [])
        if (files.length) handleSelectedFiles(files)
      }
      input.click()
    }

    const handleSelectedFiles = async files => {
      try {
        stage.innerHTML = `
          <div class="empty-state" style="padding:48px 0">
            <span class="spinner"></span>
            <div style="margin-top:12px;font-size:13px;color:var(--clr-text-3)">Parsing selected email file(s)…</div>
          </div>
        `
        state.files = files
        state.messages = []
        state.parsedCount = 0
        state.deliveredTo = null

        for (const file of files) {
          const name = file.name.toLowerCase()
          if (name.endsWith('.mbox')) {
            const raw = await file.text()
            const parts = splitMboxMessages(raw)
            parts.forEach((msg, idx) => {
              state.messages.push({ raw: msg, sourceFile: file.name, indexInFile: idx })
            })
          } else if (name.endsWith('.eml') || file.type === 'message/rfc822' || file.type === 'text/plain') {
            const raw = await file.text()
            state.messages.push({ raw, sourceFile: file.name, indexInFile: 0 })
          }
        }

        if (state.messages.length === 0) {
          toast.error('No .mbox or .eml messages found in selected files.')
          renderEmpty()
          return
        }

        // Detect which Gmail account this Takeout belongs to
        const firstRaw = state.messages[0]?.raw || ''
        state.deliveredTo = extractDeliveredTo(firstRaw)

        renderReady()
      } catch (err) {
        toast.error('Failed to parse selected files: ' + err.message)
        renderEmpty()
      }
    }

    const runImport = async () => {
      state.running = true
      state.stopRequested = false
      renderProgress()

      const progressText = document.getElementById('import-progress-text')
      const progressBar = document.getElementById('import-progress-bar')
      const summaryEl = document.getElementById('import-summary')
      const logEl = document.getElementById('import-log')

      const counters = { imported: 0, skipped: 0, errors: 0 }
      const appendLog = line => {
        const row = document.createElement('div')
        row.textContent = line
        logEl.prepend(row)
      }
      const updateSummary = done => {
        progressText.textContent = `Importing ${done} / ${state.messages.length}`
        progressBar.style.width = `${Math.min(100, Math.round((done / Math.max(1, state.messages.length)) * 100))}%`
        summaryEl.textContent = `Imported: ${counters.imported}  |  Skipped: ${counters.skipped}  |  Errors: ${counters.errors}`
      }

      const PostalMime = (await import('/postal-mime.js')).default

      for (let i = 0; i < state.messages.length; i++) {
        if (state.stopRequested) break
        const item = state.messages[i]
        let parsed
        try {
          parsed = await PostalMime.parse(item.raw, { attachmentEncoding: 'base64' })
        } catch (err) {
          counters.errors++
          appendLog(`[${i + 1}] parse error (${item.sourceFile}): ${err.message}`)
          updateSummary(i + 1)
          continue
        }

        let sourceId = (parsed.messageId || '').trim()
        if (!sourceId) {
          sourceId = await stableMessageId(item.raw, item.sourceFile, i)
        }

        // Build the payload client-side — worker only receives what it needs
        const textContent = emailToText(parsed)
        const imageFallback = textContent.length < 30 ? emailToImage(parsed) : null

        const payload = {
          source: state.deliveredTo ? `gmail:${state.deliveredTo}` : 'gmail',
          sourceId,
          subject:     parsed.subject ?? null,
          fromName:    parsed.from?.name ?? null,
          fromAddress: parsed.from?.address ?? null,
          date:        parsed.date ? fmt.dateInput(parsed.date) : null,
          // Text path (preferred — plain text or stripped HTML)
          textContent: textContent || null,
          // Vision fallback (image-only emails with no readable text)
          ...(imageFallback ?? {}),
        }

        try {
          const res = await api.importEmail(payload)
          const vendor = res.receipt?.vendor || parsed.from?.name || parsed.from?.address || 'Unknown'
          const amount = res.receipt?.total != null ? fmt.currency(res.receipt.total) : '—'
          if (res.skipped) {
            counters.skipped++
            appendLog(`[${i + 1}] ${vendor} · skipped (duplicate)`)
          } else {
            counters.imported++
            appendLog(`[${i + 1}] ${vendor} · ${amount} · imported`)
          }
        } catch (err) {
          counters.errors++
          appendLog(`[${i + 1}] import error: ${err.message}`)
        }

        updateSummary(i + 1)
        await sleep(80)
      }

      const done = counters.imported + counters.skipped + counters.errors
      updateSummary(done)
      state.running = false
      toast.success(`Import complete. Imported ${counters.imported}, skipped ${counters.skipped}, errors ${counters.errors}.`)
    }

    renderEmpty()
  },

  // ── Browse ────────────────────────────────────────────────────────────────────

  async browse() {
    const PAGE_SIZE = 50
    let offset = 0
    let total = 0
    let currentFilters = {}

    this.main.innerHTML = /* html */`
      <div class="browse-view">
        <div class="page-header">
          <h1 class="page-title">Browse</h1>
        </div>
        <div class="filter-bar">
          <input class="field__input" type="date" id="f-from" placeholder="From" title="From date" style="width:auto" />
          <input class="field__input" type="date" id="f-to" placeholder="To" title="To date" style="width:auto" />
          <select class="field__select" id="f-cat" style="width:auto">
            <option value="">All Categories</option>
            ${CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>
          <input class="field__input" type="search" id="f-vendor" placeholder="Search vendor…" style="flex:1;min-width:140px" />
          <button class="btn btn--secondary btn--sm" id="btn-filter">Apply</button>
          <button class="btn btn--ghost btn--sm" id="btn-reset">Reset</button>
        </div>
        <div class="browse-header">
          <span class="browse-count" id="browse-count"></span>
        </div>
        <div id="receipt-list" class="receipt-list">
          <div class="empty-state"><span class="spinner"></span></div>
        </div>
        <div class="pagination" id="pagination"></div>
      </div>
    `

    const load = async () => {
      const listEl = document.getElementById('receipt-list')
      listEl.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>'

      try {
        const data = await api.listReceipts({ ...currentFilters, limit: PAGE_SIZE, offset })
        total = data.total

        document.getElementById('browse-count').textContent =
          total > 0 ? `${total} receipt${total !== 1 ? 's' : ''}` : ''

        if (data.receipts.length === 0) {
          listEl.innerHTML = /* html */`
            <div class="empty-state">
              <div class="empty-state__title">No receipts found</div>
              <div class="empty-state__desc">Try adjusting your filters.</div>
            </div>
          `
        } else {
          listEl.innerHTML = data.receipts.map(r => receiptItemHtml(r)).join('')
        }

        // Pagination
        const pages = Math.ceil(total / PAGE_SIZE)
        const page = Math.floor(offset / PAGE_SIZE) + 1
        const pagEl = document.getElementById('pagination')
        if (pages > 1) {
          pagEl.innerHTML = /* html */`
            <button class="btn btn--secondary btn--sm" id="pg-prev" ${page === 1 ? 'disabled' : ''}>← Prev</button>
            <span class="pagination__info">Page ${page} of ${pages}</span>
            <button class="btn btn--secondary btn--sm" id="pg-next" ${page === pages ? 'disabled' : ''}>Next →</button>
          `
          document.getElementById('pg-prev').onclick = () => { offset -= PAGE_SIZE; load() }
          document.getElementById('pg-next').onclick = () => { offset += PAGE_SIZE; load() }
        } else {
          pagEl.innerHTML = ''
        }
      } catch (err) {
        toast.error(err.message)
        listEl.innerHTML = '<div class="empty-state"><div class="empty-state__title">Failed to load</div></div>'
      }
    }

    const applyFilters = () => {
      currentFilters = {
        from:     document.getElementById('f-from').value,
        to:       document.getElementById('f-to').value,
        category: document.getElementById('f-cat').value,
        vendor:   document.getElementById('f-vendor').value,
      }
      offset = 0
      load()
    }

    document.getElementById('btn-filter').onclick = applyFilters
    document.getElementById('btn-reset').onclick  = () => {
      ['f-from','f-to','f-cat','f-vendor'].forEach(id => {
        const el = document.getElementById(id)
        el.value = ''
      })
      currentFilters = {}
      offset = 0
      load()
    }
    document.getElementById('f-vendor').addEventListener('keydown', e => {
      if (e.key === 'Enter') applyFilters()
    })

    load()
  },

  // ── Detail ────────────────────────────────────────────────────────────────────

  async detail(id) {
    this.main.innerHTML = /* html */`
      <div class="detail-view">
        <div class="page-header">
          <button class="page-header__back" id="btn-back">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            Back
          </button>
        </div>
        <div id="detail-content">
          <div class="empty-state"><span class="spinner"></span></div>
        </div>
      </div>
    `

    document.getElementById('btn-back').onclick = () => history.back()

    try {
      const { receipt } = await api.getReceipt(id)
      this._renderDetail(receipt)
    } catch (err) {
      toast.error(err.message)
      document.getElementById('detail-content').innerHTML =
        '<div class="empty-state"><div class="empty-state__title">Receipt not found</div></div>'
    }
  },

  _renderDetail(receipt, editMode = false) {
    const content = document.getElementById('detail-content')
    const badgeClass = CATEGORY_BADGE[receipt.category] ?? 'muted'

    content.innerHTML = /* html */`
      <div class="detail-layout">
        <div class="detail-image-panel">
          <div class="detail-image-wrap" id="image-wrap">
            <div class="detail-image-loading">
              <span class="spinner"></span>
            </div>
          </div>
          ${receipt.is_edited ? '<p style="font-size:12px;color:var(--clr-text-3);margin-top:8px;text-align:center">Manually edited</p>' : ''}
        </div>
        <div class="detail-data-panel">
          <div class="detail-header">
            <div class="detail-vendor">${escHtml(receipt.vendor)}</div>
            <div class="detail-total amount">${fmt.currency(receipt.total)}</div>
          </div>
          <div class="detail-fields ${editMode ? 'detail-fields--edit' : ''}" id="detail-fields">
            ${editMode ? this._detailEditHtml(receipt) : this._detailReadHtml(receipt, badgeClass)}
          </div>
          <div class="detail-actions">
            ${editMode
              ? /* html */`
                  <button class="btn btn--primary" id="btn-save-edit">Save Changes</button>
                  <button class="btn btn--ghost" id="btn-cancel-edit">Cancel</button>
                `
              : /* html */`
                  <button class="btn btn--secondary" id="btn-edit">Edit</button>
                  <button class="btn btn--danger" id="btn-delete">Delete</button>
                `
            }
          </div>
          <div style="margin-top:8px">
            <p style="font-size:11px;color:var(--clr-text-3)">
              Added ${fmt.date(receipt.created_at?.slice(0, 10))}
              · ID: <span style="font-family:var(--font-mono)">${receipt.id.slice(0, 8)}</span>
            </p>
          </div>
        </div>
      </div>
    `

    // Load image asynchronously
    const imageWrap = document.getElementById('image-wrap')
    api.fetchImage(receipt.id).then(blobUrl => {
      if (!blobUrl) {
        imageWrap.innerHTML = `<div class="detail-image-loading" style="color:var(--clr-text-3);font-size:13px">Image unavailable</div>`
        return
      }
      this._blobUrls.push(blobUrl)
      imageWrap.innerHTML = `<img src="${blobUrl}" alt="Receipt image" />`
      imageWrap.querySelector('img').addEventListener('click', e => {
        e.target.classList.toggle('zoomed')
      })
    })

    // Wire buttons
    if (!editMode) {
      document.getElementById('btn-edit').onclick   = () => this._renderDetail(receipt, true)
      document.getElementById('btn-delete').onclick = () => this._confirmDelete(receipt)
    } else {
      document.getElementById('btn-save-edit').onclick = () => this._saveEdit(receipt)
      document.getElementById('btn-cancel-edit').onclick = () => this._renderDetail(receipt, false)
    }
  },

  _detailReadHtml(r, badgeClass) {
    return /* html */`
      <div class="detail-field">
        <span class="detail-field__key">Date</span>
        <span class="detail-field__val detail-field__val--mono">${fmt.date(r.date)}</span>
      </div>
      <div class="detail-field">
        <span class="detail-field__key">Category</span>
        <span class="detail-field__val"><span class="badge badge--${badgeClass}">${r.category}</span></span>
      </div>
      <div class="detail-field">
        <span class="detail-field__key">Subtotal</span>
        <span class="detail-field__val detail-field__val--mono">${fmt.currency(r.subtotal)}</span>
      </div>
      <div class="detail-field">
        <span class="detail-field__key">HST</span>
        <span class="detail-field__val detail-field__val--mono">${fmt.currency(r.hst)}</span>
      </div>
      <div class="detail-field">
        <span class="detail-field__key">Total</span>
        <span class="detail-field__val detail-field__val--mono" style="font-weight:700;color:var(--clr-accent)">${fmt.currency(r.total)}</span>
      </div>
      <div class="detail-field">
        <span class="detail-field__key">Payment</span>
        <span class="detail-field__val">${fmt.capitalize(r.payment_method)}</span>
      </div>
      ${r.invoice_number ? /* html */`
        <div class="detail-field">
          <span class="detail-field__key">Invoice #</span>
          <span class="detail-field__val detail-field__val--mono">${escHtml(r.invoice_number)}</span>
        </div>` : ''}
      ${r.notes ? /* html */`
        <div class="detail-field">
          <span class="detail-field__key">Notes</span>
          <span class="detail-field__val" style="max-width:280px;text-align:right">${escHtml(r.notes)}</span>
        </div>` : ''}
    `
  },

  _detailEditHtml(r) {
    return /* html */`
      <div class="detail-field">
        <span class="detail-field__key">Date</span>
        <input class="field__input field__input--mono" type="date" id="e-date" value="${fmt.dateInput(r.date)}" required />
      </div>
      <div class="detail-field">
        <span class="detail-field__key">Vendor</span>
        <input class="field__input" type="text" id="e-vendor" value="${escHtml(r.vendor)}" required />
      </div>
      <div class="detail-field">
        <span class="detail-field__key">Category</span>
        <select class="field__select" id="e-category">
          ${CATEGORIES.map(c => `<option value="${c}"${c === r.category ? ' selected' : ''}>${c}</option>`).join('')}
        </select>
      </div>
      <div class="detail-field">
        <span class="detail-field__key">Subtotal</span>
        <input class="field__input field__input--mono" type="number" id="e-subtotal" step="0.01" value="${r.subtotal ?? ''}" placeholder="—" />
      </div>
      <div class="detail-field">
        <span class="detail-field__key">HST</span>
        <input class="field__input field__input--mono" type="number" id="e-hst" step="0.01" value="${r.hst ?? ''}" placeholder="—" />
      </div>
      <div class="detail-field">
        <span class="detail-field__key">Total *</span>
        <input class="field__input field__input--mono" type="number" id="e-total" step="0.01" value="${r.total}" required />
      </div>
      <div class="detail-field">
        <span class="detail-field__key">Payment</span>
        <select class="field__select" id="e-payment">
          ${PAYMENT_METHODS.map(m => `<option value="${m}"${m === r.payment_method ? ' selected' : ''}>${fmt.capitalize(m)}</option>`).join('')}
        </select>
      </div>
      <div class="detail-field">
        <span class="detail-field__key">Invoice #</span>
        <input class="field__input" type="text" id="e-invoice" value="${escHtml(r.invoice_number ?? '')}" placeholder="Optional" />
      </div>
      <div class="detail-field">
        <span class="detail-field__key">Notes</span>
        <textarea class="field__textarea" id="e-notes" rows="2" placeholder="Optional">${escHtml(r.notes ?? '')}</textarea>
      </div>
    `
  },

  async _saveEdit(receipt) {
    const btn = document.getElementById('btn-save-edit')
    btn.disabled = true
    btn.innerHTML = '<span class="spinner"></span>'

    try {
      const { receipt: updated } = await api.updateReceipt(receipt.id, {
        date:          document.getElementById('e-date').value,
        vendor:        document.getElementById('e-vendor').value,
        category:      document.getElementById('e-category').value,
        subtotal:      parseFloatOrNull(document.getElementById('e-subtotal').value),
        hst:           parseFloatOrNull(document.getElementById('e-hst').value),
        total:         parseFloat(document.getElementById('e-total').value),
        paymentMethod: document.getElementById('e-payment').value,
        invoiceNumber: document.getElementById('e-invoice').value || null,
        notes:         document.getElementById('e-notes').value || null,
      })
      toast.success('Changes saved')
      this._renderDetail(updated, false)
    } catch (err) {
      toast.error(err.message)
      btn.disabled = false
      btn.textContent = 'Save Changes'
    }
  },

  async _confirmDelete(receipt) {
    if (!confirm(`Delete receipt from ${receipt.vendor} (${fmt.currency(receipt.total)})?\n\nThis cannot be undone.`)) return
    try {
      await api.deleteReceipt(receipt.id)
      toast.success('Receipt deleted')
      router.navigate('/browse')
    } catch (err) {
      toast.error(err.message)
    }
  },

  // ── Export ────────────────────────────────────────────────────────────────────

  export() {
    this.main.innerHTML = /* html */`
      <div class="export-view">
        <div class="page-header">
          <h1 class="page-title">Export</h1>
        </div>
        <div class="card" style="margin-bottom:var(--sp-4)">
          <div class="section-title" style="margin-bottom:var(--sp-5)">Filter receipts</div>
          <div class="form-grid" style="margin-bottom:var(--sp-4)">
            <div class="field">
              <label class="field__label" for="ex-from">From date</label>
              <input class="field__input" type="date" id="ex-from" />
            </div>
            <div class="field">
              <label class="field__label" for="ex-to">To date</label>
              <input class="field__input" type="date" id="ex-to" />
            </div>
          </div>
          <div class="field" style="margin-bottom:var(--sp-5)">
            <label class="field__label" for="ex-cat">Category</label>
            <select class="field__select" id="ex-cat">
              <option value="">All Categories</option>
              ${CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}
            </select>
          </div>
          <div id="ex-sources-wrap" style="margin-bottom:var(--sp-5)">
            <div class="field__label" style="margin-bottom:8px">Source</div>
            <div id="ex-sources-list" style="display:flex;flex-direction:column;gap:8px">
              <label style="display:flex;align-items:center;gap:10px;font-size:14px;color:var(--clr-text-2);cursor:pointer;user-select:none">
                <input type="checkbox" class="ex-src-cb" data-src="scanned" checked
                  style="width:16px;height:16px;accent-color:var(--clr-accent);cursor:pointer;flex-shrink:0" />
                Scanned receipts
              </label>
            </div>
          </div>
          <button class="btn btn--secondary btn--full" id="btn-preview">Preview</button>
        </div>

        <div id="export-preview" class="export-preview" style="display:none">
          <div class="export-preview__count" id="exp-count">0</div>
          <div class="export-preview__label">receipts matched</div>
          <div class="export-preview__total amount" id="exp-total"></div>
          <div class="export-preview__label">total expenditure</div>
        </div>
        <div id="export-actions" style="display:none;flex-direction:column;gap:var(--sp-3)">
          <button class="btn btn--primary btn--full btn--lg" id="btn-download">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download Excel (.xlsx)
          </button>
          <button class="btn btn--secondary btn--full btn--lg" id="btn-download-images">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            Download Images (.zip)
          </button>
        </div>
      </div>
    `

    let exportData = null

    // Load available import sources and render checkboxes
    api.getSources().then(({ sources }) => {
      if (!sources || sources.length === 0) return
      const list = document.getElementById('ex-sources-list')
      if (!list) return
      sources.forEach(src => {
        const label = src.startsWith('gmail:') ? src.replace('gmail:', '') : src
        const opt = document.createElement('label')
        opt.style.cssText = 'display:flex;align-items:center;gap:10px;font-size:14px;color:var(--clr-text-2);cursor:pointer;user-select:none'
        opt.innerHTML = `<input type="checkbox" class="ex-src-cb" data-src="${escHtml(src)}"
          style="width:16px;height:16px;accent-color:var(--clr-accent);cursor:pointer;flex-shrink:0" />
          ${escHtml(label)}`
        list.appendChild(opt)
      })
    }).catch(() => {})

    document.getElementById('btn-preview').onclick = async () => {
      const btn = document.getElementById('btn-preview')
      btn.disabled = true
      btn.innerHTML = '<span class="spinner"></span> Loading…'

      try {
        const checked = [...document.querySelectorAll('.ex-src-cb:checked')]
        const wantScanned = checked.some(el => el.dataset.src === 'scanned')
        const emailSources = checked.filter(el => el.dataset.src !== 'scanned').map(el => el.dataset.src)

        const filters = {
          from:     document.getElementById('ex-from').value,
          to:       document.getElementById('ex-to').value,
          category: document.getElementById('ex-cat').value,
          ...(wantScanned ? { scanned: '1' } : {}),
          ...(emailSources.length > 0 ? { sources: emailSources.join(',') } : {}),
        }
        const data = await api.exportReceipts(filters)
        exportData = data.receipts

        const total = data.receipts.reduce((s, r) => s + (r.total ?? 0), 0)
        document.getElementById('exp-count').textContent = data.count
        document.getElementById('exp-total').textContent = fmt.currency(total)
        document.getElementById('export-preview').style.display = 'block'
        document.getElementById('export-actions').style.display = data.count > 0 ? 'flex' : 'none'
      } catch (err) {
        toast.error(err.message)
      } finally {
        btn.disabled = false
        btn.textContent = 'Preview'
      }
    }

    document.getElementById('btn-download').onclick = async () => {
      if (!exportData || exportData.length === 0) return

      const btn = document.getElementById('btn-download')
      btn.disabled = true
      btn.innerHTML = '<span class="spinner"></span> Generating…'

      try {
        await downloadExcel(exportData)
        toast.success('Excel file downloaded')
      } catch (err) {
        toast.error('Failed to generate Excel: ' + err.message)
      } finally {
        btn.disabled = false
        btn.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download Excel (.xlsx)
        `
      }
    }

    document.getElementById('btn-download-images').onclick = async () => {
      if (!exportData || exportData.length === 0) return

      const btn = document.getElementById('btn-download-images')
      const excelBtn = document.getElementById('btn-download')
      btn.disabled = true
      excelBtn.disabled = true

      try {
        await downloadImagesZip(exportData, (done, total) => {
          btn.innerHTML = `<span class="spinner"></span> Downloading ${done}/${total}…`
        })
        toast.success('Images downloaded')
      } catch (err) {
        toast.error('Failed to download images: ' + err.message)
      } finally {
        btn.disabled = false
        excelBtn.disabled = false
        btn.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          Download Images (.zip)
        `
      }
    }
  },

  // ── Settings ──────────────────────────────────────────────────────────────────

  settings() {
    this.main.innerHTML = /* html */`
      <div class="settings-view">
        <div class="page-header">
          <h1 class="page-title">Settings</h1>
        </div>

        <div class="settings-section">
          <div class="section-title">App</div>
          <div class="card" id="install-card">
            <div class="settings-row">
              <div class="settings-row__info">
                <div class="settings-row__title">Install as App</div>
                <div class="settings-row__desc">Add Receipt Vault to your home screen for a native-like experience.</div>
              </div>
              <button class="btn btn--secondary btn--sm" id="btn-install">Add to Home Screen</button>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <div class="section-title">Security</div>
          <div class="card" style="margin-bottom:12px">
            <div style="margin-bottom:16px;font-size:13px;color:var(--clr-text-3)">
              Your passphrase is stored in the Worker as an environment secret. To change it, update the <code>AUTH_SECRET</code> secret via the Cloudflare dashboard or Wrangler CLI.
            </div>
            <code style="font-family:var(--font-mono);font-size:12px;background:var(--clr-elevated);padding:8px 12px;border-radius:4px;display:block;color:var(--clr-accent)">
              wrangler secret put AUTH_SECRET
            </code>
          </div>
          <div class="settings-row">
            <div class="settings-row__info">
              <div class="settings-row__title">Sign Out</div>
              <div class="settings-row__desc">Removes your session token from this device.</div>
            </div>
            <button class="btn btn--secondary btn--sm" id="btn-signout">Sign Out</button>
          </div>
        </div>

        <div class="settings-section">
          <div class="section-title">About</div>
          <div class="card">
            <div style="display:flex;flex-direction:column;gap:10px;font-size:13px">
              <div style="display:flex;justify-content:space-between">
                <span style="color:var(--clr-text-3)">Application</span>
                <span style="font-family:var(--font-brand);color:var(--clr-accent);letter-spacing:0.08em">VAULT</span>
              </div>
              <div style="display:flex;justify-content:space-between">
                <span style="color:var(--clr-text-3)">Version</span>
                <span style="font-family:var(--font-mono)">1.0.0</span>
              </div>
              <div style="display:flex;justify-content:space-between">
                <span style="color:var(--clr-text-3)">Storage</span>
                <span>Cloudflare R2 + D1</span>
              </div>
              <div style="display:flex;justify-content:space-between">
                <span style="color:var(--clr-text-3)">Source</span>
                <a href="https://github.com" style="color:var(--clr-accent)" target="_blank" rel="noopener">Open Source</a>
              </div>
            </div>
          </div>
        </div>
      </div>
    `

    document.getElementById('btn-signout').onclick = () => auth.logout()

    const installCard = document.getElementById('install-card')
    if (pwa.isInstalled()) {
      installCard.innerHTML = `
        <div class="settings-row">
          <div class="settings-row__info">
            <div class="settings-row__title">Running as App</div>
            <div class="settings-row__desc" style="color:var(--clr-success)">&#x2714; Receipt Vault is installed on your home screen.</div>
          </div>
        </div>
      `
    } else {
      document.getElementById('btn-install').onclick = () => pwa.showInstallModal()
    }
  },
}

// ── Shared HTML builders ───────────────────────────────────────────────────────

function receiptItemHtml(r) {
  const badgeClass = CATEGORY_BADGE[r.category] ?? 'muted'
  const icon = categoryIcon(r.category)
  return /* html */`
    <a href="#/receipt/${r.id}" class="receipt-item">
      <div class="receipt-item__icon">${icon}</div>
      <div class="receipt-item__body">
        <div class="receipt-item__vendor">${escHtml(r.vendor)}</div>
        <div class="receipt-item__meta">
          <span class="badge badge--${badgeClass}">${r.category}</span>
          ${r.payment_method !== 'unknown' ? `<span>${fmt.capitalize(r.payment_method)}</span>` : ''}
        </div>
      </div>
      <div>
        <div class="receipt-item__total amount">${fmt.currency(r.total)}</div>
        <div class="receipt-item__date">${fmt.date(r.date)}</div>
      </div>
    </a>
  `
}

function categoryIcon(category) {
  const icons = {
    'Food & Ingredients':   '🥩',
    'Alcohol & Beverages':  '🍷',
    'Kitchen Equipment':    '🔪',
    'Cleaning & Supplies':  '🧹',
    'Packaging & Takeout':  '📦',
    'Utilities':            '💡',
    'Rent':                 '🏠',
    'Insurance':            '🛡',
    'Marketing':            '📣',
    'Maintenance & Repair': '🔧',
    'Licensing & Permits':  '📋',
    'Delivery & Transport': '🚚',
    'Other':                '📄',
  }
  return icons[category] ?? '📄'
}

// ── Excel export (SheetJS) ─────────────────────────────────────────────────────

async function downloadExcel(receipts) {
  // Lazy-load SheetJS from local bundle (bundled at /xlsx.full.min.js)
  if (!window.XLSX) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = '/xlsx.full.min.js'
      script.onload = resolve
      script.onerror = () => reject(new Error('Failed to load SheetJS'))
      document.head.appendChild(script)
    })
  }

  const headers = [
    'Date', 'Vendor', 'Category', 'Subtotal', 'HST', 'Total',
    'Payment', 'Invoice #', 'Notes', 'Image Name',
  ]

  const rows = receipts.map((r, index) => {
    const fileType = r.file_type || ''
    const ext =
      fileType.includes('pdf') ? 'pdf' :
      fileType.includes('png') ? 'png' :
      fileType.includes('webp') ? 'webp' :
      fileType.includes('gif') ? 'gif' :
      'jpg'

    // Stable, easy-to-reference image name starting from 0.
    const imageName = `${String(index).padStart(4, '0')}.${ext}`

    return [
      r.date,
      r.vendor,
      r.category,
      r.subtotal ?? '',
      r.hst ?? '',
      r.total,
      r.payment_method,
      r.invoice_number ?? '',
      r.notes ?? '',
      imageName,
    ]
  })

  const ws = window.XLSX.utils.aoa_to_sheet([headers, ...rows])

  // Column widths (no "View Receipt" column anymore)
  ws['!cols'] = [
    { wch: 12 }, { wch: 28 }, { wch: 24 }, { wch: 10 },
    { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 14 },
    { wch: 32 }, { wch: 24 },
  ]

  const wb = window.XLSX.utils.book_new()
  window.XLSX.utils.book_append_sheet(wb, ws, 'Receipts')

  const now = new Date()
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  window.XLSX.writeFile(wb, `receipts-${dateStr}.xlsx`)
}

// ── Image ZIP export ───────────────────────────────────────────────────────────

async function downloadImagesZip(receipts, onProgress) {
  if (!window.fflate) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = '/fflate.umd.js'
      script.onload = resolve
      script.onerror = () => reject(new Error('Failed to load zip library'))
      document.head.appendChild(script)
    })
  }

  const files = {}
  const token = auth.getToken()

  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]
    onProgress(i + 1, receipts.length)

    const res = await fetch(`${API_BASE}/api/receipts/${r.id}/image`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) continue

    const ext = (r.file_type || '').includes('pdf')  ? 'pdf'
              : (r.file_type || '').includes('png')  ? 'png'
              : (r.file_type || '').includes('webp') ? 'webp'
              : 'jpg'
    const vendorSafe = (r.vendor || 'unknown').replace(/[^a-z0-9]/gi, '_').slice(0, 25)
    const filename = `${r.date}_${vendorSafe}_${r.id.slice(0, 8)}.${ext}`
    files[filename] = new Uint8Array(await res.arrayBuffer())
  }

  // level: 0 = store without re-compressing (images are already compressed)
  const zip = window.fflate.zipSync(files, { level: 0 })
  const blob = new Blob([zip], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const now = new Date()
  a.href = url
  a.download = `receipt-images-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}.zip`
  a.click()
  URL.revokeObjectURL(url)
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function parseFloatOrNull(str) {
  const n = parseFloat(str)
  return isNaN(n) ? null : n
}

function splitMboxMessages(raw) {
  const normalized = String(raw ?? '').replace(/\r\n/g, '\n')
  if (!normalized.trim()) return []

  const chunks = normalized.split(/\n(?=From [^\n]*\n)/g)
  const out = []

  for (const chunk of chunks) {
    if (!chunk.trim()) continue
    // Remove mbox envelope line, keep RFC822 content
    const message = chunk.replace(/^From [^\n]*\n/, '')
    if (message.trim()) out.push(message)
  }
  return out
}

async function stableMessageId(raw, sourceFile, idx) {
  const text = `${sourceFile}|${idx}|${String(raw).slice(0, 2048)}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  const hex = Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return `<vault-import-${hex.slice(0, 32)}>`
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Service Worker registration ─────────────────────────────────────────────────

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('/sw.js')
      .catch(err => console.warn('[SW] Registration failed:', err))
  }
}

// ── PWA install prompt ─────────────────────────────────────────────────────────

const pwa = (() => {
  let deferredPrompt = null
  let bannerEl = null

  const isInstalled = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true

  function isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent)
  }

  function dismissBanner() {
    if (bannerEl) {
      bannerEl.remove()
      bannerEl = null
    }
    sessionStorage.setItem('pwa-banner-dismissed', '1')
  }

  function showInstallModal() {
    dismissBanner()
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = /* html */`
      <div class="modal">
        <div class="modal__title">Add to Home Screen</div>
        ${isIos() ? `
          <div class="install-steps">
            <div class="install-step">
              <div class="install-step__num">1</div>
              <div class="install-step__text">
                Tap the <strong>Share</strong> button
                <span class="install-step__icon">&#x1F4E4;</span>
                in Safari's toolbar (bottom of screen).
              </div>
            </div>
            <div class="install-step">
              <div class="install-step__num">2</div>
              <div class="install-step__text">
                Scroll down and tap <strong>"Add to Home Screen"</strong>.
              </div>
            </div>
            <div class="install-step">
              <div class="install-step__num">3</div>
              <div class="install-step__text">
                Tap <strong>"Add"</strong> in the top-right corner.
              </div>
            </div>
          </div>
          <p style="font-size:12px;color:var(--clr-text-3);margin-bottom:var(--sp-4)">
            Receipt Vault must be opened in <strong style="color:var(--clr-text-2)">Safari</strong> for this to work.
          </p>
        ` : `
          <div class="install-steps">
            <div class="install-step">
              <div class="install-step__num">1</div>
              <div class="install-step__text">
                Tap the <strong>menu</strong>
                <span class="install-step__icon">&#x22EE;</span>
                in Chrome or use the banner that appears.
              </div>
            </div>
            <div class="install-step">
              <div class="install-step__num">2</div>
              <div class="install-step__text">
                Select <strong>"Add to Home screen"</strong> or
                <strong>"Install app"</strong>.
              </div>
            </div>
            <div class="install-step">
              <div class="install-step__num">3</div>
              <div class="install-step__text">
                Confirm by tapping <strong>"Install"</strong>.
              </div>
            </div>
          </div>
        `}
        <div style="display:flex;gap:8px">
          ${deferredPrompt ? `<button class="btn btn--primary" id="modal-install-btn" style="flex:1">Install Now</button>` : ''}
          <button class="btn btn--secondary" id="modal-close-btn" style="flex:1">Got It</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.remove()
    })
    document.getElementById('modal-close-btn').onclick = () => overlay.remove()
    const installBtn = document.getElementById('modal-install-btn')
    if (installBtn) {
      installBtn.onclick = async () => {
        overlay.remove()
        deferredPrompt.prompt()
        const { outcome } = await deferredPrompt.userChoice
        if (outcome === 'accepted') deferredPrompt = null
      }
    }
  }

  function showBanner() {
    if (isInstalled()) return
    if (sessionStorage.getItem('pwa-banner-dismissed')) return
    if (bannerEl) return

    bannerEl = document.createElement('div')
    bannerEl.className = 'install-banner'
    bannerEl.innerHTML = /* html */`
      <div class="install-banner__icon">&#x1F4CB;</div>
      <div class="install-banner__body">
        <div class="install-banner__title">Install Receipt Vault</div>
        <div class="install-banner__desc">Add to your home screen for quick access</div>
      </div>
      <div class="install-banner__actions">
        <button class="btn btn--primary btn--sm" id="banner-install-btn">Install</button>
        <button class="btn btn--ghost btn--sm" id="banner-dismiss-btn">✕</button>
      </div>
    `
    document.body.appendChild(bannerEl)

    document.getElementById('banner-dismiss-btn').onclick = dismissBanner
    document.getElementById('banner-install-btn').onclick = () => {
      if (deferredPrompt) {
        dismissBanner()
        deferredPrompt.prompt()
        deferredPrompt.userChoice.then(({ outcome }) => {
          if (outcome === 'accepted') deferredPrompt = null
        })
      } else {
        showInstallModal()
      }
    }
  }

  // Capture the Android Chrome install event
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault()
    deferredPrompt = e
    // Show banner after a brief delay so it doesn't appear immediately on load
    setTimeout(showBanner, 3000)
  })

  // iOS: show the banner manually if not installed and on iOS
  if (isIos() && !isInstalled()) {
    setTimeout(showBanner, 3000)
  }

  return { showInstallModal, isInstalled }
})()

// ── Email import helpers ───────────────────────────────────────────────────────

/**
 * Extract the Delivered-To address from a raw email string.
 * Present in all Gmail/Google Takeout exports — identifies which account
 * the email was delivered to, used as the import source tag.
 */
function extractDeliveredTo(rawEmail) {
  const match = rawEmail.match(/^Delivered-To:\s*(.+)$/im)
  return match ? match[1].trim().toLowerCase() : null
}

/**
 * Extract plain text from an email parsed by PostalMime.
 * Priority: text/plain → strip HTML → empty string.
 */
function emailToText(parsed) {
  // Best case: clean plain-text part already exists
  if (parsed.text && parsed.text.trim().length > 30) {
    return parsed.text.trim().slice(0, 6000)
  }

  // Fall back: strip HTML in the browser using DOMParser
  if (parsed.html) {
    try {
      const doc = new DOMParser().parseFromString(parsed.html, 'text/html')
      // Remove style and script nodes entirely
      doc.querySelectorAll('style, script, head').forEach(el => el.remove())
      const text = (doc.body?.innerText || doc.body?.textContent || '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      if (text.length > 30) return text.slice(0, 6000)
    } catch {
      // DOMParser not available or failed — continue to empty fallback
    }
  }

  return ''
}

/**
 * If emailToText returns nothing (image-only email), try to find the first
 * inline image attachment to send to the vision pipeline.
 */
function emailToImage(parsed) {
  const att = (parsed.attachments || []).find(a => {
    const mime = (a.mimeType || '').toLowerCase()
    return mime.startsWith('image/') || mime === 'application/pdf'
  })
  if (!att) return null
  const data = typeof att.content === 'string' ? att.content : null
  if (!data) return null
  return { imageDataBase64: data, imageMimeType: att.mimeType }
}

// ── App init ───────────────────────────────────────────────────────────────────

registerServiceWorker()
router.init()
