/**
 * dsh-video-background browser half.
 *
 * Surfaces:
 *  - A frame-wide media background behind the whole app: one layer (video
 *    or image — both supported) fills the window, a zoomed+blurred sibling
 *    pane fills the sidebar column (keeps the session-list text readable),
 *    and a dim layer (strength adjustable) keeps global contrast. Message
 *    bubbles keep their own opaque fills.
 *  - A `shell.overlay` entry anchored to the conversation area's top-left
 *    corner (the [data-conversation-scroll] scrollport, i.e. just below
 *    the session header). The popover carries: background toggle, dim
 *    slider, playback-speed slider (50%-200%, plus a direct numeric input
 *    clamped to the same bounds), a media list (built-in default +
 *    user-added files, switchable, deletable) and a "choose file" entry
 *    (the OS file picker, flp-plugin style). The anchor is measured live,
 *    so the button follows the sidebar's width and collapse state.
 *
 * Media storage:
 *  - The bundled asset (assets/background.mp4, base64-embedded via
 *    media.gen.js) is just one item among others: it is listed under its
 *    own filename and can be deleted like any picked file (the deletion is
 *    persisted with a flag; it never reappears).
 *  - Files the user picks are stored as Blobs in IndexedDB (browser
 *    storage owned by this plugin): deleting the ORIGINAL file never
 *    affects the plugin, and deleting a LIST entry removes its record,
 *    freeing the space. Picking a file also auto-activates it.
 *  - With no playable media at all the background stays OFF (native
 *    Harness surface shown) instead of faking a default — the toggle and
 *    sliders are disabled until a file is added.
 *
 * Implementation notes:
 *  - No host service, no RPC: pure DOM injection. The app's surface
 *    backgrounds are made transparent by overriding the alias tokens on
 *    document.body inline (setProperty with 'important' priority beats the
 *    theme presenter's non-important inline writes), and restored on
 *    disable/dispose.
 *  - The sidebar rect is measured from the layout frame; the button anchor
 *    from the conversation scrollport (live ResizeObserver, follows
 *    sidebar width/collapse).
 */

const React = require('react');
const media = require('./media.gen.js');
const { HAS_VIDEO, MEDIA_URL, MEDIA_NAME, MEDIA_SIZE } = media;

export const name = 'dsh-video-background';
export const inject = ['slots', 'locale'];

const NS = 'dsh-video-background';
const LS_ON = 'dsh-video-background:on';
const LS_DIM = 'dsh-video-background:dim';
const LS_SPEED = 'dsh-video-background:speed';
const LS_ACTIVE = 'dsh-video-background:active';
const LS_BUILTIN_GONE = 'dsh-video-background:builtin-gone';
const DEFAULT_DIM = 0.35;
const SPEED_MIN = 50; // percent
const SPEED_MAX = 200; // percent
const DEFAULT_SPEED = 100;
const MAX_FILE_BYTES = 128 * 1024 * 1024; // 128 MB picker guard
const MSG_TIME = 4000;

const zh = {
  title: '视频背景',
  on: '背景已开启',
  off: '背景已关闭',
  dim: '暗化强度',
  speed: '播放速度',
  mediaList: '媒体列表',
  chooseFile: '选择文件…',
  del: '删除',
  delConfirm: '删除「{{name}}」？将从插件存储中移除并释放空间。',
  errType: '不支持的格式（仅图片和常用视频格式）',
  errSize: '文件过大（上限 128 MB）',
  errStore: '保存到浏览器存储失败',
  stored: '文件保存在浏览器存储：删除原文件不影响使用；删除列表项即释放空间。',
  noMedia: '无媒体——显示默认 Harness 背景。可在下方添加图片/视频。',
  img: '图片',
  video: '视频',
};
const en = {
  title: 'Video background',
  on: 'Background on',
  off: 'Background off',
  dim: 'Dim strength',
  speed: 'Playback speed',
  mediaList: 'Media list',
  chooseFile: 'Choose file…',
  del: 'Remove',
  delConfirm: 'Delete "{{name}}"? It will be removed from plugin storage, freeing space.',
  errType: 'Unsupported format (images and common video formats only)',
  errSize: 'File too large (limit 128 MB)',
  errStore: 'Failed to store in browser storage',
  stored: 'Files live in browser storage: deleting the original never breaks the plugin; removing a list entry frees the space.',
  noMedia: 'No media — the default Harness background is shown. Add an image/video below.',
  img: 'Image',
  video: 'Video',
};

// ---- persistence ----
function loadJSON(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}
function saveJSON(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

// ---- IndexedDB media store (files the user picked) ----
const DB_NAME = 'dsh-video-background';
const DB_STORE = 'media';

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

async function idbList() {
  try {
    const db = await idbOpen();
    try {
      const recs = await idbReq(db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAll());
      return recs.map((r) => ({ ...r, blob: undefined })); // meta only for listing
    } finally { db.close(); }
  } catch { return []; }
}
async function idbPut(record) {
  const db = await idbOpen();
  try {
    await idbReq(db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(record));
  } finally { db.close(); }
}
async function idbDelete(id) {
  const db = await idbOpen();
  try {
    await idbReq(db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).delete(id));
  } finally { db.close(); }
}
async function idbGet(id) {
  const db = await idbOpen();
  try {
    return await idbReq(db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(id));
  } catch { return undefined; } finally { db.close(); }
}

// ---- format mapping for picker validation ----
const EXT_MAP = {
  png: ['image/png', 'image'], jpg: ['image/jpeg', 'image'], jpeg: ['image/jpeg', 'image'],
  webp: ['image/webp', 'image'], gif: ['image/gif', 'image'], avif: ['image/avif', 'image'],
  bmp: ['image/bmp', 'image'], svg: ['image/svg+xml', 'image'],
  mp4: ['video/mp4', 'video'], webm: ['video/webm', 'video'], mov: ['video/quicktime', 'video'],
  m4v: ['video/x-m4v', 'video'], ogv: ['video/ogg', 'video'],
};
function kindOf(file) {
  const t = (file.type || '').toLowerCase();
  if (t.startsWith('image/')) return { mime: t, kind: 'image' };
  if (t.startsWith('video/')) return { mime: t, kind: 'video' };
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const hit = EXT_MAP[ext];
  if (hit) return { mime: hit[0], kind: hit[1] };
  return null;
}
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '--';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// ---- shared background store (engine <-> React bridge) ----
const bgListeners = new Set();
const bgState = {
  on: loadJSON(LS_ON, true),
  dim: Math.max(0, Math.min(1, loadJSON(LS_DIM, DEFAULT_DIM))),
  speed: (() => {
    const raw = Number(loadJSON(LS_SPEED, DEFAULT_SPEED));
    if (!Number.isFinite(raw)) return DEFAULT_SPEED;
    if (raw > 0 && raw < SPEED_MIN) return Math.round(raw * 100); // legacy factor 0.5–2 → percent
    return Math.max(SPEED_MIN, Math.min(SPEED_MAX, raw));
  })(),
  activeId: loadJSON(LS_ACTIVE, undefined),
  builtinGone: loadJSON(LS_BUILTIN_GONE, false),
};

function commitBg(patch) {
  if (patch.on !== undefined) { bgState.on = Boolean(patch.on); saveJSON(LS_ON, bgState.on); }
  if (patch.dim !== undefined) {
    bgState.dim = Math.max(0, Math.min(1, Number(patch.dim)));
    saveJSON(LS_DIM, bgState.dim);
  }
  if (patch.speed !== undefined) {
    bgState.speed = Math.max(SPEED_MIN, Math.min(SPEED_MAX, Number(patch.speed)));
    saveJSON(LS_SPEED, bgState.speed);
  }
  if (patch.activeId !== undefined) {
    bgState.activeId = patch.activeId || undefined;
    saveJSON(LS_ACTIVE, bgState.activeId ?? null);
  }
  if (patch.builtinGone !== undefined) {
    bgState.builtinGone = Boolean(patch.builtinGone);
    saveJSON(LS_BUILTIN_GONE, bgState.builtinGone);
  }
  const engine = getEngine();
  if (engine) engine.applyState(bgState);
  const snapshot = { ...bgState };
  for (const fn of [...bgListeners]) { try { fn(snapshot); } catch { /* ignore */ } }
}

function useBgState() {
  const [state, setState] = React.useState({ ...bgState });
  React.useEffect(() => {
    bgListeners.add(setState);
    setState({ ...bgState });
    return () => { bgListeners.delete(setState); };
  }, []);
  return state;
}

// ---- engine ----
/** Tokens the app uses for its surface fills; overridden while the background is on. */
const TOKENS = ['--dsw-alias-bg-base', '--dsw-specific-sidebar-fill'];

function applyTokens(on) {
  const s = document.body.style;
  for (const token of TOKENS) {
    if (on) s.setProperty(token, 'transparent', 'important');
    else s.removeProperty(token);
  }
}

function findFrame() {
  const scope = (document.getElementById('root') || document.body);
  const els = scope.querySelectorAll('*');
  for (const el of els) {
    if (el.clientWidth === 0 || el.clientHeight === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display !== 'grid' || cs.position !== 'relative' || cs.overflow !== 'hidden') continue;
    if (cs.gridTemplateRows === 'none' || cs.gridTemplateRows === '') continue;
    const tracks = cs.gridTemplateColumns.split(/\s+/).map(parseFloat).filter((n) => Number.isFinite(n));
    if (tracks.length >= 2) return el;
  }
  return null;
}

/**
 * Resolve the active media source. The bundled asset is treated like any
 * other listed item: once "deleted" (builtinGone) it is never used again.
 * Returns { kind: 'video'|'image'|'none', url?, revoke? } — revoke true for
 * object URLs the engine owns (freed on swap/dispose; the bundled
 * MEDIA_URL is part of the bundle and must NOT be revoked).
 */
async function resolveSource(activeId, builtinGone) {
  if (activeId === 'builtin' && !builtinGone) {
    return HAS_VIDEO ? { kind: 'video', url: MEDIA_URL, revoke: false } : { kind: 'none' };
  }
  if (activeId) {
    const rec = await idbGet(activeId);
    if (rec && rec.blob) {
      return { kind: rec.kind, url: URL.createObjectURL(rec.blob), revoke: true };
    }
  }
  // auto: bundled (if not deleted) first, then the first user file, then none
  if (HAS_VIDEO && !builtinGone) return { kind: 'video', url: MEDIA_URL, revoke: false };
  const list = await idbList();
  if (list.length > 0) {
    const rec = await idbGet(list[0].id);
    if (rec && rec.blob) {
      return { kind: rec.kind, url: URL.createObjectURL(rec.blob), revoke: true };
    }
  }
  return { kind: 'none' };
}

class BackgroundEngine {
  constructor() {
    this.built = false;
    this.root = null;
    this.styleEl = null;
    this.videos = [];
    this.observer = null;
    this.retryTimer = null;
    this.resizeHandler = null;
    this.frame = null;
    this.scroll = null;
    this.baseEl = null;
    this.sideEl = null;
    this.sideTintEl = null;
    this.dimEl = null;
    this.usedUrls = new Set();
    this.activeKey = undefined;
    this.kind = 'none';
    this.visible = false;
    this.reloadSeq = 0;
    this.reduced = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  start() {
    if (this.built) return;
    if (!document.body) { setTimeout(() => this.start(), 60); return; }
    this.built = true;
    this.build();
    this.applyState(bgState);
  }

  makeVideo(cls) {
    const v = document.createElement('video');
    v.className = cls;
    v.muted = true;
    v.defaultMuted = true;
    v.loop = true;
    v.autoplay = true;
    v.preload = 'auto';
    v.disablePictureInPicture = true;
    v.draggable = false;
    v.setAttribute('playsinline', '');
    v.setAttribute('muted', '');
    this.videos.push(v);
    return v;
  }

  createEl(tag, cls) {
    const el = document.createElement(tag);
    el.className = cls;
    return el;
  }

  build() {
    const root = document.createElement('div');
    root.className = 'dshvb-root';
    root.style.display = 'none';
    document.body.appendChild(root);
    this.root = root;

    const style = document.createElement('style');
    style.id = 'dshvb-bg-css';
    style.textContent = BG_CSS;
    document.head.appendChild(style);
    this.styleEl = style;

    this.watchLayout();
  }

  /** Build base+side layers for the given source; 'none' clears everything (background stays off). */
  setMedia(src) {
    const oldBase = this.baseEl;
    const oldSide = this.sideEl;
    const oldTint = this.sideTintEl;
    const oldDim = this.dimEl;

    if (src.kind === 'video' || src.kind === 'image') {
      const base = src.kind === 'video' ? this.makeVideo('dshvb-base') : this.createEl('img', 'dshvb-base');
      const side = src.kind === 'video' ? this.makeVideo('dshvb-side-video') : this.createEl('img', 'dshvb-side-video');
      base.src = src.url;
      base.draggable = false;
      side.src = src.url;
      side.draggable = false;

      const sideTint = this.createEl('div', 'dshvb-side-tint');
      const dim = this.createEl('div', 'dshvb-dim');
      const sideWrap = this.createEl('div', 'dshvb-side');
      sideWrap.appendChild(side);
      sideWrap.appendChild(sideTint);

      if (oldBase) oldBase.remove();
      if (oldSide) oldSide.remove();
      if (oldTint) oldTint.remove();
      if (oldDim) oldDim.remove();
      // drop removed elements from the video registry so switches don't leak
      this.videos = this.videos.filter((v) => v !== oldBase && v !== oldSide);
      // object URLs the engine owns are gone with the old layers — free them
      // (the bundled MEDIA_URL is part of the bundle and never enters this set)
      for (const u of this.usedUrls) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
      this.usedUrls.clear();
      if (src.revoke && src.url) this.usedUrls.add(src.url);

      this.root.appendChild(base);
      this.root.appendChild(sideWrap);
      this.root.appendChild(dim);
      this.baseEl = base;
      this.sideEl = side;
      this.sideTintEl = sideTint;
      this.dimEl = dim;
      this.kind = src.kind;
    } else {
      // none: no playable media — remove every layer, the background stays off
      if (oldBase) oldBase.remove();
      if (oldSide) oldSide.remove();
      if (oldTint) oldTint.remove();
      if (oldDim) oldDim.remove();
      this.videos = this.videos.filter((v) => v !== oldBase && v !== oldSide);
      for (const u of this.usedUrls) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
      this.usedUrls.clear();
      this.baseEl = null;
      this.sideEl = null;
      this.sideTintEl = null;
      this.dimEl = null;
      this.kind = 'none';
    }
    this.applyState(bgState);
  }

  /** Async: resolve active source and swap media layers (old layer kept until new one is ready). */
  async reloadMedia(state, force) {
    const key = (state.activeId ?? 'auto') + (state.builtinGone ? ':gone' : '');
    if (!force && key === this.activeKey && this.kind !== 'none') return;
    this.activeKey = key;
    const seq = ++this.reloadSeq;
    let src;
    try {
      src = await resolveSource(state.activeId, state.builtinGone);
    } catch {
      src = { kind: 'none' };
    }
    if (seq !== this.reloadSeq || !this.built) { // superseded or disposed
      if (src.revoke) URL.revokeObjectURL(src.url);
      return;
    }
    this.setMedia(src);
  }

  applyPlayback() {
    for (const v of this.videos) {
      v.playbackRate = Math.max(SPEED_MIN, Math.min(SPEED_MAX, bgState.speed)) / 100;
      if (this.visible) { const p = v.play(); if (p && typeof p.catch === 'function') p.catch(() => { /* ignore */ }); }
      else v.pause();
    }
  }

  watchLayout() {
    let tries = 0;
    const attempt = () => {
      const frame = findFrame();
      const scroll = document.querySelector('[data-conversation-scroll]');
      if (!frame || !scroll) {
        tries += 1;
        if (tries > 600 && this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
        return;
      }
      if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
      this.frame = frame;
      this.scroll = scroll;
      this.measure();
      this.observer = new ResizeObserver(() => this.measure());
      this.observer.observe(frame);
      this.observer.observe(scroll);
      this.resizeHandler = () => this.measure();
      window.addEventListener('resize', this.resizeHandler);
    };
    this.retryTimer = setInterval(attempt, 150);
    attempt();
  }

  measure() {
    const rootStyle = document.documentElement.style;
    // 1) sidebar blur-pane width (first resolved grid track of the frame)
    let w = 288;
    const frame = this.frame;
    if (frame) {
      const cs = getComputedStyle(frame);
      const tracks = cs.gridTemplateColumns.split(/\s+/).map(parseFloat).filter((n) => Number.isFinite(n));
      let sw = tracks.length ? tracks[0] : 0;
      if (!(sw > 0)) {
        const first = frame.firstElementChild;
        if (first) sw = first.getBoundingClientRect().width;
      }
      if (!(sw > 0)) sw = 288;
      if (sw > window.innerWidth * 0.7) sw = 288; // collapsed/oversized sanity
      w = sw;
    }
    rootStyle.setProperty('--dshvb-sidebar-w', `${Math.round(w)}px`);
    // 2) button anchor: top-left of the conversation scrollport (below the
    //    session header); follows sidebar width/collapse automatically.
    const scroll = this.scroll;
    if (scroll) {
      const r = scroll.getBoundingClientRect();
      rootStyle.setProperty('--dshvb-ctrl-x', `${Math.round(r.left + 12)}px`);
      rootStyle.setProperty('--dshvb-ctrl-y', `${Math.round(r.top + 12)}px`);
    } else {
      rootStyle.setProperty('--dshvb-ctrl-x', `${Math.round(w + 12)}px`);
      rootStyle.setProperty('--dshvb-ctrl-y', '12px');
    }
  }

  applyState(state) {
    if (!this.root) return;
    const mediaOk = this.kind === 'video' || this.kind === 'image';
    const show = Boolean(state.on) && mediaOk;
    this.visible = show;
    this.root.style.display = show ? '' : 'none';
    this.root.style.setProperty('--dshvb-dim', String(state.dim));
    applyTokens(show);
    this.applyPlayback();
    const key = (state.activeId ?? 'auto') + (state.builtinGone ? ':gone' : '');
    if (this.activeKey !== key) {
      this.reloadMedia(state, true);
    }
  }

  dispose() {
    if (!this.built) return;
    this.built = false;
    this.reloadSeq += 1;
    if (this.styleEl) this.styleEl.remove();
    if (this.root) this.root.remove();
    if (this.observer) this.observer.disconnect();
    if (this.retryTimer) clearInterval(this.retryTimer);
    if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
    document.documentElement.style.removeProperty('--dshvb-sidebar-w');
    document.documentElement.style.removeProperty('--dshvb-ctrl-x');
    document.documentElement.style.removeProperty('--dshvb-ctrl-y');
    for (const u of this.usedUrls) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
    this.usedUrls.clear();
    applyTokens(false);
    this.root = null;
    this.styleEl = null;
    this.videos = [];
    this.frame = null;
    this.scroll = null;
    this.baseEl = null;
    this.sideEl = null;
    this.sideTintEl = null;
    this.dimEl = null;
  }
}

let engine = null;
function getEngine() {
  if (!engine) engine = new BackgroundEngine();
  return engine;
}

// ---- engine + ui css ----
const BG_CSS = `
.dshvb-root{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;background:#101216}
.dshvb-root video,.dshvb-root img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transition:opacity .3s ease}
.dshvb-side{position:absolute;left:0;top:0;bottom:0;width:var(--dshvb-sidebar-w,288px);overflow:hidden}
.dshvb-side-video{filter:blur(18px) saturate(1.2) brightness(1.02);transform:scale(1.15);transform-origin:50% 50%}
.dshvb-side-tint{position:absolute;inset:0;background:rgba(10,12,18,.28)}
.dshvb-dim{position:absolute;inset:0;background:rgba(5,7,11,var(--dshvb-dim,.35))}
`;

const UI_CSS = `
.dshvbg-fab{position:absolute;left:var(--dshvb-ctrl-x,296px);top:var(--dshvb-ctrl-y,64px);z-index:10;pointer-events:auto;display:inline-flex;flex:0 0 auto}
.dshvbg-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:26px;padding:0;border:1px solid var(--dsw-alias-line-secondary,rgba(255,255,255,.18));border-radius:8px;
  background:color-mix(in srgb,var(--dsw-alias-bg-module-platform,#1c1c1e) 78%,transparent);
  color:var(--dsw-alias-label-secondary,#c7c7cc);cursor:pointer;
  box-shadow:0 2px 10px rgba(0,0,0,.28);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.dshvbg-btn:hover{background:color-mix(in srgb,var(--dsw-alias-bg-module-platform,#1c1c1e) 100%,transparent);color:var(--dsw-alias-label-primary,#fff)}
.dshvbg-btn[data-off="1"]{opacity:.55}
.dshvbg-pop{position:absolute;top:calc(100% + 10px);left:0;right:auto;width:min(320px,calc(100vw - 16px));z-index:20;box-sizing:border-box;
  max-height:min(460px,calc(100vh - 96px));overflow:auto;
  background:rgba(24,26,32,.97);
  background:color-mix(in srgb,var(--dsw-alias-bg-module-platform,#1c1c1e) 97%,transparent);
  border:1px solid var(--dsw-alias-line-secondary,rgba(255,255,255,.16));border-radius:12px;padding:12px 14px;
  box-shadow:0 12px 40px rgba(0,0,0,.45);
  opacity:0;visibility:hidden;pointer-events:none;transform:translateY(-6px) scale(.98);transform-origin:top left;
  transition:opacity .14s ease,transform .18s cubic-bezier(.2,.9,.3,1.15),visibility 0s linear .18s}
.dshvbg-hover .dshvbg-pop{opacity:1;visibility:visible;pointer-events:auto;transform:translateY(0) scale(1);
  transition:opacity .14s ease,transform .18s cubic-bezier(.2,.9,.3,1.15),visibility 0s}
.dshvbg-pop-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#fff);margin-bottom:8px}
.dshvbg-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.8));margin-bottom:10px}
.dshvbg-row>span:first-child{flex:0 0 auto;min-width:56px}
.dshvbg-toggle{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.8));cursor:pointer;margin-bottom:10px}
.dshvbg-toggle input{accent-color:#0a84ff}
.dshvbg-toggle[data-disabled="1"]{opacity:.45;pointer-events:none}
.dshvbg-slider{flex:1;min-width:0;accent-color:#0a84ff}
.dshvbg-val{flex:0 0 auto;min-width:34px;text-align:right;font-variant-numeric:tabular-nums}
.dshvbg-num{flex:0 0 auto;width:58px;min-height:22px;padding:1px 6px;box-sizing:border-box;border-radius:6px;
  border:1px solid var(--dsw-alias-line-secondary,rgba(255,255,255,.16));
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));
  color:var(--dsw-alias-label-primary,#fff);font-size:12px;text-align:right;font-variant-numeric:tabular-nums}
.dshvbg-unit{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.55));font-size:12px;margin-left:-4px}
.dshvbg-row[data-disabled="1"]{opacity:.45;pointer-events:none}
.dshvbg-media{display:flex;flex-direction:column;gap:3px;max-height:150px;overflow:auto;margin:2px 0 10px}
.dshvbg-mrow{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:7px;cursor:pointer;border:1px solid transparent}
.dshvbg-mrow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.dshvbg-mrow[data-active="1"]{background:color-mix(in srgb,var(--dsw-alias-state-info,#0a84ff) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-info,#0a84ff) 40%,transparent)}
.dshvbg-mname{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary,#fff);font-size:12px;font-weight:500}
.dshvbg-mmeta{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.55));font-size:11px}
.dshvbg-mdel{flex:0 0 auto;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.55));cursor:pointer;border-radius:6px;padding:2px 5px;font-size:11px}
.dshvbg-mdel:hover{color:#ff6b61;background:rgba(255,59,48,.12)}
.dshvbg-pick{display:inline-flex;align-items:center;gap:6px;border:1px dashed var(--dsw-alias-line-secondary,rgba(255,255,255,.25));border-radius:8px;
  background:transparent;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.85));cursor:pointer;padding:6px 10px;font-size:12px}
.dshvbg-pick:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.dshvbg-err{color:#ff6b61;font-size:11px;margin-top:6px;line-height:1.4}
.dshvbg-hint{margin-top:10px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.55))}
`;

function installUiCss() {
  if (document.getElementById('dshvbg-ui-css')) return () => {};
  const style = document.createElement('style');
  style.id = 'dshvbg-ui-css';
  style.textContent = UI_CSS;
  document.head.appendChild(style);
  return () => { style.remove(); };
}

// ---- error boundary: a render error must never silently remove the item ----
class SafeBg extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    console.error('[dsh-video-background] render error:', error, info);
  }
  render() {
    if (this.state.error !== null) {
      return React.createElement('div', { className: 'dshvbg-fab' },
        React.createElement('div', { className: 'dshvbg-btn dshvbg-err', title: `bg error: ${String(this.state.error.message ?? this.state.error).slice(0, 80)}` }, '!'));
    }
    return this.props.children;
  }
}

function IconBg({ off }) {
  return React.createElement('svg',
    { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', 'aria-hidden': 'true', style: off ? { opacity: 0.55 } : undefined },
    React.createElement('rect', { x: 1.5, y: 3, width: 13, height: 10, rx: 2, stroke: 'currentColor', strokeWidth: 1.2 }),
    React.createElement('path', { d: 'M6.5 6v4l3.5-2z', fill: 'currentColor' }),
  );
}

/** Effective active id for highlighting: explicit choice when valid, else bundled (if not deleted), else first user file, else null (no media). */
function effectiveActive(list, activeId, builtinGone) {
  const hasBuiltin = HAS_VIDEO && !builtinGone;
  if (activeId === 'builtin') return hasBuiltin ? 'builtin' : (list[0]?.id ?? null);
  if (activeId) return list.some((r) => r.id === activeId) ? activeId : (hasBuiltin ? 'builtin' : (list[0]?.id ?? null));
  return hasBuiltin ? 'builtin' : (list[0]?.id ?? null);
}

// ---- the conversation-area corner control ----
function BgControl(props) {
  const t = props.t;
  const s = (k) => (typeof t === 'function' ? t(k) : zh[k]);
  const { on, dim, speed, activeId, builtinGone } = useBgState();
  const [hover, setHover] = React.useState(false);
  const [list, setList] = React.useState([]);
  const [error, setError] = React.useState(null);
  const [speedDraft, setSpeedDraft] = React.useState(null); // null = follow global
  const popoverRef = React.useRef(null);
  const fileRef = React.useRef(null);
  const hoverTimer = React.useRef(null);
  const errorTimer = React.useRef(null);

  const refreshList = React.useCallback(async () => {
    setList(await idbList());
  }, []);
  React.useEffect(() => { refreshList(); }, [refreshList]);
  React.useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (errorTimer.current) clearTimeout(errorTimer.current);
  }, []);

  const active = effectiveActive(list, activeId, builtinGone);
  const hasMedia = (HAS_VIDEO && !builtinGone) || list.length > 0;
  const isVideo = active === 'builtin' ? HAS_VIDEO : (list.find((r) => r.id === active)?.kind === 'video');
  const effectiveOn = on && hasMedia;

  const keepHover = () => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    setHover(true);
  };
  const hideSoon = (e) => {
    if (e && e.relatedTarget instanceof Node && popoverRef.current?.contains(e.relatedTarget)) return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHover(false), 250);
  };
  // Click toggles the popover too, but never when the click lands on an
  // interactive child (toggles, sliders, rows, buttons).
  const onWrapClick = (e) => {
    if (e.target instanceof Element && e.target.closest('button, input, label')) return;
    setHover((h) => !h);
  };

  const showError = (msg) => {
    setError(msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), MSG_TIME);
  };

  const toggle = () => commitBg({ on: !on });
  const onDimChange = (e) => commitBg({ dim: Number(e.target.value) / 100 });
  const onSpeedChange = (e) => { setSpeedDraft(null); commitBg({ speed: Number(e.target.value) }); };
  // Direct numeric input: keep the draft as typed while focused; commit clamped
  // values live, then re-sync to the canonical format on blur.
  const onSpeedInput = (e) => {
    const raw = e.target.value;
    setSpeedDraft(raw);
    const n = Number(raw);
    if (Number.isFinite(n)) commitBg({ speed: Math.max(SPEED_MIN, Math.min(SPEED_MAX, n)) });
  };
  const onSpeedBlur = () => {
    const n = Number(speedDraft);
    if (Number.isFinite(n)) commitBg({ speed: Math.max(SPEED_MIN, Math.min(SPEED_MAX, n)) });
    setSpeedDraft(null);
  };

  const onPick = React.useCallback(async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    const info = kindOf(file);
    if (!info) { showError(s('errType')); return; }
    if (file.size > MAX_FILE_BYTES) { showError(s('errSize')); return; }
    try {
      const record = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.name}`,
        name: file.name,
        mime: info.mime,
        kind: info.kind,
        size: file.size,
        addedAt: Date.now(),
        blob: file,
      };
      await idbPut(record);
      await refreshList();
      commitBg({ activeId: record.id });
    } catch {
      showError(s('errStore'));
    }
  }, [refreshList, s]);

  const onDeleteBuiltin = React.useCallback(() => {
    if (!window.confirm(s('delConfirm').replace('{{name}}', MEDIA_NAME ?? 'background.mp4'))) return;
    commitBg({ builtinGone: true, activeId: undefined });
  }, [s]);

  const onDelete = React.useCallback(async (rec) => {
    if (!window.confirm(s('delConfirm').replace('{{name}}', rec.name))) return;
    try {
      await idbDelete(rec.id);
      await refreshList();
      if (activeId === rec.id) commitBg({ activeId: undefined });
    } catch {
      showError(s('errStore'));
    }
  }, [refreshList, activeId, s]);

  const onActivate = (id) => commitBg({ activeId: id });

  const speedVal = Math.round(speed);
  const speedStr = speedDraft !== null ? speedDraft : String(speedVal);

  return React.createElement('div',
    { className: 'dshvbg-fab' + (hover ? ' dshvbg-hover' : ''), onMouseEnter: keepHover, onMouseLeave: hideSoon, onClick: onWrapClick },
    React.createElement('button', {
      className: 'dshvbg-btn', type: 'button', 'data-off': effectiveOn ? '0' : '1',
      title: s(effectiveOn ? 'on' : 'off'), 'aria-label': s(effectiveOn ? 'on' : 'off'),
      'aria-pressed': effectiveOn ? 'true' : 'false',
      onClick: toggle,
    }, React.createElement(IconBg, { off: !effectiveOn })),
    React.createElement('div', { className: 'dshvbg-pop', ref: popoverRef, onMouseEnter: keepHover, onMouseLeave: hideSoon },
      React.createElement('div', { className: 'dshvbg-pop-title' }, s('title')),
      React.createElement('label', { className: 'dshvbg-toggle', 'data-disabled': hasMedia ? '0' : '1' },
        React.createElement('input', { type: 'checkbox', checked: effectiveOn, onChange: toggle, disabled: !hasMedia }),
        React.createElement('span', null, effectiveOn ? s('on') : s('off'))),
      React.createElement('div', { className: 'dshvbg-row', 'data-disabled': hasMedia ? '0' : '1' },
        React.createElement('span', null, s('dim')),
        React.createElement('input', {
          className: 'dshvbg-slider', type: 'range', min: 0, max: 80, step: 5,
          value: Math.round(dim * 100), onChange: onDimChange, disabled: !hasMedia,
          'aria-label': s('dim'),
        }),
        React.createElement('span', { className: 'dshvbg-val' }, `${Math.round(dim * 100)}%`)),
      React.createElement('div', { className: 'dshvbg-row', 'data-disabled': !hasMedia || !isVideo ? '1' : '0' },
        React.createElement('span', null, s('speed')),
        React.createElement('input', {
          className: 'dshvbg-slider', type: 'range', min: SPEED_MIN, max: SPEED_MAX, step: 5,
          value: speedVal, onChange: onSpeedChange, disabled: !hasMedia || !isVideo,
          'aria-label': s('speed'),
        }),
        React.createElement('input', {
          className: 'dshvbg-num', type: 'number', min: SPEED_MIN, max: SPEED_MAX, step: 5,
          value: speedStr, onChange: onSpeedInput, onBlur: onSpeedBlur, disabled: !hasMedia || !isVideo,
          onFocus: (e) => e.target.select(),
          'aria-label': s('speed'),
        }),
        React.createElement('span', { className: 'dshvbg-unit' }, '%')),
      React.createElement('div', { className: 'dshvbg-pop-title' }, s('mediaList')),
      React.createElement('div', { className: 'dshvbg-media' },
        HAS_VIDEO && !builtinGone && React.createElement('div', {
          className: 'dshvbg-mrow', 'data-active': active === 'builtin' ? '1' : '0',
          onClick: () => onActivate('builtin'), title: MEDIA_NAME ?? 'background.mp4',
        },
          React.createElement('span', { className: 'dshvbg-mname' }, MEDIA_NAME ?? 'background.mp4'),
          React.createElement('span', { className: 'dshvbg-mmeta' }, `${s('video')} · ${fmtBytes(MEDIA_SIZE)}`),
          React.createElement('button', {
            className: 'dshvbg-mdel', type: 'button', title: s('del'), 'aria-label': s('del'),
            onClick: (e) => { e.stopPropagation(); onDeleteBuiltin(); },
          }, '×')),
        list.map((rec) => React.createElement('div', {
          className: 'dshvbg-mrow', key: rec.id,
          'data-active': active === rec.id ? '1' : '0',
          onClick: () => onActivate(rec.id), title: rec.name,
        },
          React.createElement('span', { className: 'dshvbg-mname' }, rec.name),
          React.createElement('span', { className: 'dshvbg-mmeta' }, `${rec.kind === 'image' ? s('img') : s('video')} · ${fmtBytes(rec.size)}`),
          React.createElement('button', {
            className: 'dshvbg-mdel', type: 'button', title: s('del'), 'aria-label': s('del'),
            onClick: (e) => { e.stopPropagation(); onDelete(rec); },
          }, '×'))),
        !hasMedia && React.createElement('div', { className: 'dshvbg-hint' }, s('noMedia')),
      ),
      React.createElement('button', { className: 'dshvbg-pick', type: 'button', onClick: () => fileRef.current?.click() },
        React.createElement('svg', { viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', 'aria-hidden': 'true' },
          React.createElement('path', { d: 'M8 3v7M4.5 7.5 8 11l3.5-3.5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
          React.createElement('path', { d: 'M2.5 12.5h11', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' })),
        s('chooseFile')),
      React.createElement('input', {
        ref: fileRef, type: 'file', style: { display: 'none' },
        accept: '.png,.jpg,.jpeg,.webp,.gif,.avif,.bmp,.svg,.mp4,.webm,.mov,.m4v,.ogv,image/*,video/*',
        onChange: onPick,
      }),
      error && React.createElement('div', { className: 'dshvbg-err' }, error),
      hasMedia && React.createElement('div', { className: 'dshvbg-hint' }, s('stored')),
    ),
  );
}

// ---- apply ----
async function apply(ctx) {
  const removeUiCss = installUiCss();
  const disposeLocale = ctx.locale.register(NS, { zh, en });
  getEngine().start(); // defers internally until document.body exists
  const feature = ctx.inject(['slots'], (scope) => {
    scope.slots.inject('shell.overlay', () => scope.slots.register({
      name: 'shell.overlay',
      id: 'dsh-video-background',
      order: 50,
      locale: NS,
    }, (props) => React.createElement(SafeBg, null, React.createElement(BgControl, props))));
    return () => {};
  });
  return async () => {
    await feature.dispose();
    disposeLocale();
    removeUiCss();
    getEngine().dispose();
  };
}

export default { apply, inject };
