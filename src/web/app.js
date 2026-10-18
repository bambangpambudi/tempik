const logoBtn = document.getElementById('logoBtn');
const currentInbox = document.getElementById('currentInbox');
const inboxTimer = document.getElementById('inboxTimer');
const copyBtn = document.getElementById('copyBtn');
const refreshBtn = document.getElementById('refreshBtn');
const pushBtn = document.getElementById('pushBtn');
const sidebar = document.getElementById('sidebar');
const drawerBackdrop = document.getElementById('drawerBackdrop');
const closeSidebarBtn = document.getElementById('closeSidebarBtn');
const inboxList = document.getElementById('inboxList');
const inboxCount = document.getElementById('inboxCount');
const localPartInput = document.getElementById('localPartInput');
const domainSelect = document.getElementById('domainSelect');
const ttlSelect = document.getElementById('ttlSelect');
const createCustomBtn = document.getElementById('createCustomBtn');
const createRandomBtn = document.getElementById('createRandomBtn');
const messageList = document.getElementById('messageList');
const messageDetail = document.getElementById('messageDetail');
const messageCount = document.getElementById('messageCount');
const deleteModal = document.getElementById('deleteModal');
const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
const deleteTargetAddress = document.getElementById('deleteTargetAddress');
const rateLimitModal = document.getElementById('rateLimitModal');
const closeRateLimitBtn = document.getElementById('closeRateLimitBtn');

let appConfig = { appName: 'Artex Mail', mailDomain: 'artexmail.web.id' };
const SESSION_KEY = 'artex_session_v2';
let sessionId = localStorage.getItem(SESSION_KEY) || '';

let allInboxes = [];
let currentAddress = '';
let currentMessages = [];
let selectedMessageIndex = 0;
let pendingDeleteAddress = '';
let pollingInterval = null;
let inboxTimerInterval = null;
const POLLING_DELAY = 3000;

/* ---------- Helpers ---------- */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function truncate(str, len) {
  if (!str) return '';
  const s = String(str).replace(/\s+/g, ' ').trim();
  return s.length > len ? s.slice(0, len) + '...' : s;
}

function parseDate(isoString) {
  if (!isoString) return null;
  let str = String(isoString).trim();
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(str)) str = str.replace(' ', 'T') + 'Z';
  return new Date(str);
}

function formatRelative(iso) {
  if (!iso) return '';
  const then = parseDate(iso)?.getTime() || 0;
  if (isNaN(then) || then === 0) return '';
  const diff = Math.floor((Date.now() - then) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
  return parseDate(iso).toLocaleDateString();
}

function linkify(text) {
  if (!text) return '';
  const pattern = /(?:(?:https?|ftp):\/\/[^\s<>"']+|\bwww\.[^\s<>"']+|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b)/gi;
  let html = '', last = 0, m;
  while ((m = pattern.exec(text)) !== null) {
    html += escapeHtml(text.slice(last, m.index));
    let url = m[0], trailing = '';
    while (url.length > 0 && /[.,;:!?)\]]$/.test(url)) { trailing = url.slice(-1) + trailing; url = url.slice(0, -1); }
    if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(url)) {
      html += '<a class="body-link" href="mailto:' + escapeHtml(url) + '">' + escapeHtml(url) + '</a>';
    } else {
      const href = /^www\./i.test(url) ? 'https://' + url : url;
      html += '<a class="body-link" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer nofollow">' + escapeHtml(url) + '</a>';
    }
    html += escapeHtml(trailing);
    last = m.index + m[0].length;
  }
  html += escapeHtml(text.slice(last));
  return html;
}

const ALLOWED_TAGS = new Set(['P','BR','A','STRONG','B','EM','I','U','S','STRIKE','DEL','UL','OL','LI','BLOCKQUOTE','H1','H2','H3','H4','H5','H6','SPAN','DIV','HR','CODE','PRE','TABLE','THEAD','TBODY','TR','TD','TH','CAPTION']);
const ALLOWED_ATTRS = new Set(['href','alt','title','width','height','align','colspan','rowspan','dir','lang']);

function fallbackSanitize(html) {
  const temp = document.createElement('div');
  temp.innerHTML = html;
  function clean(node) {
    if (node.nodeType === 1) {
      const tag = node.tagName;
      if (['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','FORM','INPUT','BUTTON'].includes(tag)) { node.remove(); return; }
      if (!ALLOWED_TAGS.has(tag)) {
        const parent = node.parentNode;
        if (parent) { while (node.firstChild) parent.insertBefore(node.firstChild, node); parent.removeChild(node); }
        return;
      }
      Array.from(node.attributes).forEach((attr) => {
        if (!ALLOWED_ATTRS.has(attr.name.toLowerCase())) node.removeAttribute(attr.name);
      });
      if (tag === 'A') {
        const href = node.getAttribute('href') || '';
        if (/^javascript:/i.test(href) || /^data:/i.test(href)) node.setAttribute('href', '#');
      }
      Array.from(node.childNodes).forEach(clean);
    }
  }
  Array.from(temp.childNodes).forEach(clean);
  return temp.innerHTML;
}

function sanitizeHtml(html) {
  if (typeof DOMPurify !== 'undefined' && DOMPurify.sanitize) {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: Array.from(ALLOWED_TAGS).map((t) => t.toLowerCase()),
      ALLOWED_ATTR: Array.from(ALLOWED_ATTRS),
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|ftp|tel):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
      FORBID_TAGS: ['style','script','iframe','object','embed','form','input','button','img'],
      FORBID_ATTR: ['style','onerror','onload','onclick','onmouseover','srcset']
    });
  }
  return fallbackSanitize(html);
}

function renderBody(raw) {
  if (!raw) return '';
  if (!/<[a-zA-Z][\s\S]*?>/.test(raw)) return linkify(raw);
  const clean = sanitizeHtml(raw);
  const temp = document.createElement('div');
  temp.innerHTML = clean;
  temp.querySelectorAll('a').forEach((a) => {
    let href = a.getAttribute('href') || '';
    if (/^www\./i.test(href)) href = 'https://' + href;
    else if (/^\/\//.test(href)) href = 'https:' + href;
    else if (!/^(https?|mailto|ftp|tel):/i.test(href) && !/^#/.test(href)) href = '#';
    a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer nofollow');
    a.classList.add('body-link');
  });
  const walker = document.createTreeWalker(temp, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) {
    if (n.parentElement && n.parentElement.tagName !== 'A') nodes.push(n);
  }
  nodes.forEach((tn) => {
    if (!/https?:\/\/|www\.|@/i.test(tn.nodeValue)) return;
    const span = document.createElement('span');
    span.innerHTML = linkify(tn.nodeValue);
    if (tn.parentNode) tn.parentNode.replaceChild(span, tn);
  });
  return temp.innerHTML;
}

function showToast(text, icon = 'fa-solid fa-circle-check') {
  const tc = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = '<i class="' + icon + '"></i><span>' + escapeHtml(text) + '</span>';
  tc.appendChild(el);
  setTimeout(() => { el.classList.add('fadeout'); setTimeout(() => el.remove(), 200); }, 2400);
}

function playNotification() {
  const audio = document.getElementById('notificationSound');
  if (audio) { audio.currentTime = 0; audio.play().catch(e => console.warn('Autoplay diblokir:', e)); }
}

async function fetchJson(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (sessionId) headers['x-session-id'] = sessionId;
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch(e) {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* ---------- Ticking Countdown Timer ---------- */
function startInboxTimer() {
  if (inboxTimerInterval) clearInterval(inboxTimerInterval);
  if (!inboxTimer) return;

  if (!currentAddress) { inboxTimer.classList.add('hidden'); return; }

  const inbox = allInboxes.find(x => x.address === currentAddress);
  if (!inbox || !inbox.expires_at) { inboxTimer.classList.add('hidden'); return; }

  inboxTimer.classList.remove('hidden');
  const expiresAt = parseDate(inbox.expires_at).getTime();

  inboxTimerInterval = setInterval(() => {
    const remaining = expiresAt - Date.now();

    if (remaining <= 0) {
      clearInterval(inboxTimerInterval);
      inboxTimer.classList.add('hidden');
      showToast('💥 Inbox self-destructed (expired).', 'fa-solid fa-burst');
      currentAddress = '';
      currentMessages = [];
      fetchInboxes().then(() => { renderInboxList(); renderMailView(); });
      return;
    }

    const totalSecs = Math.floor(remaining / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    inboxTimer.textContent = `⏳ ${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

    if (remaining < 5 * 60 * 1000) inboxTimer.classList.add('warning');
    else inboxTimer.classList.remove('warning');
  }, 1000);
}

/* ---------- PWA & Push ---------- */
async function registerSWAndPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    if (Notification.permission === 'granted') {
      pushBtn.style.display = 'none';
      subscribePush(reg);
    } else if (Notification.permission !== 'denied') {
      pushBtn.style.display = 'flex';
    }
    pushBtn.addEventListener('click', async () => {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        pushBtn.style.display = 'none';
        await subscribePush(reg);
        showToast('Push notifications enabled!', 'fa-solid fa-bell');
      } else {
        showToast('Permission denied', 'fa-solid fa-bell-slash');
      }
    });
  } catch (e) { console.warn('SW registration failed:', e); }
}

async function subscribePush(reg) {
  try {
    const existing = await reg.pushManager.getSubscription();
    let sub = existing;
    if (!sub) {
      const vapidPublicKey = 'BOcc_Qm52Ql3X3QdZ5lnaLXUIVYRYAULvNmvvMiS13shx8Yr8Z43mj1fcfUq1OWNYMpZu8nG2cjdqWOV_ve6XSU';
      const convertedVapidKey = urlBase64ToUint8Array(vapidPublicKey);
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: convertedVapidKey });
    }
    await fetchJson('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub }) });
  } catch (e) { console.error('Subscribe push failed:', e); }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

/* ---------- Data Fetch & Polling ---------- */
async function fetchInboxes() {
  try { allInboxes = await fetchJson('/api/inboxes'); } catch (e) { allInboxes = []; }
  inboxCount.textContent = allInboxes.length;
}

async function loadMessages({ isBackground = false } = {}) {
  if (!currentAddress) { currentMessages = []; renderMailView(); return; }
  currentInbox.textContent = currentAddress;
  try {
    const fetched = await fetchJson('/api/inboxes/' + encodeURIComponent(currentAddress) + '/messages');
    if (isBackground && fetched.length > currentMessages.length) playNotification();
    currentMessages = fetched;
  } catch (e) {
    if (!isBackground) showToast('Failed to load messages', 'fa-solid fa-triangle-exclamation');
  }
  if (!isBackground) selectedMessageIndex = currentMessages.length > 0 ? 0 : -1;
  else if (selectedMessageIndex >= currentMessages.length) selectedMessageIndex = currentMessages.length > 0 ? 0 : -1;
  renderMailView();
}

function startPolling() {
  if (pollingInterval) return;
  const dot = document.querySelector('.status-indicator');
  if (dot) dot.style.animation = 'pulse 2s infinite';

  pollingInterval = setInterval(async () => {
    if (!currentAddress) return;
    const currentList = await fetchJson('/api/inboxes').catch(() => []);
    if (!currentList.some(x => x.address === currentAddress)) {
      currentAddress = '';
      renderInboxList();
      renderMailView();
      if (inboxTimer) inboxTimer.classList.add('hidden');
      if (inboxTimerInterval) clearInterval(inboxTimerInterval);
      showToast('Inbox expired.', 'fa-solid fa-clock');
      return;
    }
    allInboxes = currentList;
    inboxCount.textContent = allInboxes.length;
    renderInboxList();
    loadMessages({ isBackground: true });
  }, POLLING_DELAY);
}

function stopPolling() {
  if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
  const dot = document.querySelector('.status-indicator');
  if (dot) dot.style.animation = 'none';
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else { if (currentAddress) loadMessages({ isBackground: true }); startPolling(); }
});

async function selectInbox(address) {
  currentAddress = address || '';
  renderInboxList();
  await loadMessages({ isBackground: false });
  startPolling();
  startInboxTimer();
}

/* ---------- Rendering: Inbox List ---------- */
function renderInboxList() {
  if (!allInboxes.length) {
    inboxList.innerHTML = '<div class="empty-inbox-list"><i class="fa-regular fa-folder-open"></i><span>No inboxes yet</span></div>';
    return;
  }
  inboxList.innerHTML = allInboxes.map((inbox) => {
    const active = inbox.address === currentAddress ? 'active' : '';
    return '<div class="inbox-item ' + active + '" data-address="' + escapeHtml(inbox.address) + '">' +
              '<button type="button" class="inbox-main" data-select="' + escapeHtml(inbox.address) + '">' +
                '<div class="inbox-icon"><i class="fa-solid fa-envelope"></i></div>' +
                '<span class="inbox-text">' + escapeHtml(inbox.address) + '</span>' +
              '</button>' +
              '<button type="button" class="inbox-delete" data-delete="' + escapeHtml(inbox.address) + '" title="Delete inbox">' +
                '<i class="fa-regular fa-trash-can"></i>' +
              '</button>' +
            '</div>';
  }).join('');

  inboxList.querySelectorAll('.inbox-main').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const addr = btn.dataset.select;
      if (addr === currentAddress) { closeSidebar(); return; }
      await selectInbox(addr);
      closeSidebar();
    });
  });

  inboxList.querySelectorAll('.inbox-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openDeleteModal(btn.dataset.delete); });
  });
}

/* ---------- Rendering: Mail View ---------- */
function renderMailView() {
  messageCount.textContent = currentMessages.length;
  if (!currentAddress) {
    messageList.innerHTML = '';
    messageDetail.innerHTML = '<div class="empty-view"><div class="empty-icon"><i class="fa-regular fa-paper-plane"></i></div><h3>No Inbox Selected</h3><p>Click the <strong>Artex Mail</strong> logo at the top-left to open the inbox manager and select an inbox.</p></div>';
    return;
  }
  if (!currentMessages.length) {
    messageList.innerHTML = '';
    messageDetail.innerHTML = '<div class="empty-view"><div class="empty-icon"><i class="fa-regular fa-envelope-open"></i></div><h3>Inbox is empty</h3><p>Emails sent to <strong>' + escapeHtml(currentAddress) + '</strong> will appear here.</p></div>';
    return;
  }
  renderMessageList();
  renderMessageDetail();
}

function renderMessageList() {
  messageList.innerHTML = currentMessages.map((msg, i) => {
    const sender = msg.from_address || '?';
    const shortName = sender.split('@')[0];
    const active = i === selectedMessageIndex ? 'active' : '';
    const avatarUrl = `https://api.dicebear.com/7.x/bottts-neutral/svg?seed=${encodeURIComponent(sender)}&backgroundColor=06b6d4,8b5cf6,6366f1,a855f7`;

    return '<button type="button" class="msg-item ' + active + '" data-index="' + i + '">' +
      '<div class="msg-avatar"><img src="' + avatarUrl + '" alt="avatar" loading="lazy" /></div>' +
      '<div class="msg-content">' +
        '<div class="msg-top">' +
          '<span class="msg-sender">' + escapeHtml(shortName) + '</span>' +
          '<span class="msg-time">' + formatRelative(msg.received_at) + '</span>' +
        '</div>' +
        '<div class="msg-subject">' + escapeHtml(msg.subject || '(no subject)') + '</div>' +
        '<div class="msg-preview">' + escapeHtml(truncate(msg.body, 100)) + '</div>' +
      '</div>' +
    '</button>';
  }).join('');

  messageList.querySelectorAll('.msg-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index, 10);
      if (idx === selectedMessageIndex) return;
      selectedMessageIndex = idx;
      renderMessageList();
      renderMessageDetail();
      if (window.innerWidth <= 1024) messageDetail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function renderMessageDetail() {
  const msg = currentMessages[selectedMessageIndex];
  if (!msg) { messageDetail.innerHTML = ''; return; }
  const dateStr = msg.received_at ? parseDate(msg.received_at)?.toLocaleString() : '';
  const isHtml = /<[a-zA-Z][\s\S]*?>/.test(msg.body || '');
  const bodyClass = isHtml ? 'detail-body is-html' : 'detail-body';
  messageDetail.innerHTML =
    '<div class="detail-header">' +
      '<h1 class="detail-subject">' + escapeHtml(msg.subject || '(no subject)') + '</h1>' +
      '<div class="detail-meta">' +
        '<div class="meta-item"><span>From</span><strong>' + escapeHtml(msg.from_address) + '</strong></div>' +
        '<div class="meta-item"><span>To</span><strong>' + escapeHtml(currentAddress) + '</strong></div>' +
        '<div class="meta-item"><span>Date</span><strong>' + escapeHtml(dateStr) + '</strong></div>' +
      '</div>' +
    '</div>' +
    '<div class="' + bodyClass + '">' + renderBody(msg.body || '') + '</div>';
}

/* ---------- Sidebar Drawer ---------- */
function openSidebar() { sidebar.classList.add('open'); drawerBackdrop.classList.add('show'); document.body.classList.add('drawer-open'); setTimeout(() => localPartInput.focus(), 300); }
function closeSidebar() { sidebar.classList.remove('open'); drawerBackdrop.classList.remove('show'); document.body.classList.remove('drawer-open'); }
logoBtn.addEventListener('click', (e) => { e.stopPropagation(); if (sidebar.classList.contains('open')) closeSidebar(); else openSidebar(); });
closeSidebarBtn.addEventListener('click', closeSidebar);
drawerBackdrop.addEventListener('click', closeSidebar);

/* ---------- Config ---------- */
async function loadConfig() {
  try {
    appConfig = await fetchJson('/api/config', { headers: {} });
    document.title = appConfig.appName || 'Artex Mail';
    document.getElementById('appTitle').textContent = appConfig.appName || 'Artex Mail';
  } catch(e) {}
  const domains = appConfig.mailDomains || [appConfig.mailDomain || 'artexmail.web.id'];
  domainSelect.innerHTML = '';
  domains.forEach((d) => { const opt = document.createElement('option'); opt.value = d; opt.textContent = '@' + d; domainSelect.appendChild(opt); });
  if (domains.length <= 1) domainSelect.style.display = 'none';
}

async function ensureSession() {
  const payload = await fetchJson('/api/session');
  sessionId = payload.sessionId;
  localStorage.setItem(SESSION_KEY, sessionId);
}

/* ---------- Header Actions ---------- */
copyBtn.addEventListener('click', async () => {
  if (!currentAddress) { showToast('No inbox selected', 'fa-solid fa-circle-exclamation'); return; }
  try { await navigator.clipboard.writeText(currentAddress); showToast('Address copied to clipboard', 'fa-regular fa-copy'); }
  catch (e) { showToast('Copy failed', 'fa-solid fa-triangle-exclamation'); }
});
refreshBtn.addEventListener('click', () => loadMessages({ isBackground: false }));

/* ---------- Create Inbox ---------- */
async function createInbox(localPart) {
  try {
    const ttlMinutes = Number(ttlSelect?.value) || 30;
    const inbox = await fetchJson('/api/inboxes', { method: 'POST', body: JSON.stringify({ localPart, domain: domainSelect.value, ttlMinutes }) });
    localPartInput.value = '';
    await fetchInboxes();
    await selectInbox(inbox.address);
    showToast('Inbox created successfully', 'fa-solid fa-check');
    closeSidebar();
  } catch (err) {
    if (err.status === 429 || (err.message && err.message.includes('Rate limit'))) {
      if (rateLimitModal) rateLimitModal.classList.remove('hidden');
    } else {
      showToast(err.message || 'Failed to create inbox', 'fa-solid fa-triangle-exclamation');
    }
  }
}
createCustomBtn.addEventListener('click', () => createInbox(localPartInput.value.trim()));
createRandomBtn.addEventListener('click', () => createInbox(''));
localPartInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); createInbox(localPartInput.value.trim()); } });

/* ---------- Delete Modal ---------- */
function openDeleteModal(address) { pendingDeleteAddress = address; deleteTargetAddress.textContent = address; deleteModal.classList.remove('hidden'); }
cancelDeleteBtn.addEventListener('click', () => { deleteModal.classList.add('hidden'); pendingDeleteAddress = ''; });
deleteModal.addEventListener('click', (e) => { if (e.target === deleteModal) { deleteModal.classList.add('hidden'); pendingDeleteAddress = ''; } });
confirmDeleteBtn.addEventListener('click', async () => {
  if (!pendingDeleteAddress) return;
  deleteModal.classList.add('hidden');
  const target = pendingDeleteAddress;
  confirmDeleteBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';
  confirmDeleteBtn.disabled = true;
  try {
    await fetchJson('/api/inboxes/' + encodeURIComponent(target), { method: 'DELETE' });
    showToast('Inbox deleted', 'fa-regular fa-trash-can');
    pendingDeleteAddress = '';
    await fetchInboxes();
    if (target === currentAddress) { currentAddress = ''; currentMessages = []; renderMailView(); if (inboxTimer) inboxTimer.classList.add('hidden'); if (inboxTimerInterval) clearInterval(inboxTimerInterval); }
    renderInboxList();
  } catch (e) { showToast('Failed to delete inbox', 'fa-solid fa-triangle-exclamation'); }
  finally { confirmDeleteBtn.innerHTML = 'Delete'; confirmDeleteBtn.disabled = false; }
});

/* ---------- Rate Limit Modal ---------- */
if (closeRateLimitBtn) {
  closeRateLimitBtn.addEventListener('click', () => rateLimitModal.classList.add('hidden'));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!deleteModal.classList.contains('hidden')) { deleteModal.classList.add('hidden'); pendingDeleteAddress = ''; }
    else if (rateLimitModal && !rateLimitModal.classList.contains('hidden')) { rateLimitModal.classList.add('hidden'); }
    else if (sidebar.classList.contains('open')) closeSidebar();
  }
});

/* ---------- Boot ---------- */
async function boot() {
  try {
    await loadConfig();
    await ensureSession();
    await fetchInboxes();
    await registerSWAndPush();
    currentAddress = '';
    renderInboxList();
    renderMailView();
    startPolling();
  } catch (err) {
    console.error(err);
    messageDetail.innerHTML = '<div class="empty-view"><div class="empty-icon" style="color:#f43f5e"><i class="fa-solid fa-triangle-exclamation"></i></div><h3>Connection Error</h3><p>' + escapeHtml(err.message) + '</p></div>';
  }
}

/* ---------- CAPTCHA GATE ---------- */
window.onTurnstileSuccess = async function(token) {
  try {
    const res = await fetch('/api/captcha/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    if (res.ok) {
      sessionStorage.setItem('captcha_passed', 'true');
      const gate = document.getElementById('captchaGate');
      gate.style.opacity = '0';
      setTimeout(() => { gate.classList.add('hidden'); gate.style.opacity = '1'; boot(); }, 300);
    } else {
      showToast('Captcha failed. Please try again.', 'fa-solid fa-triangle-exclamation');
      if (window.turnstile) window.turnstile.reset();
    }
  } catch (e) {
    showToast('Connection error', 'fa-solid fa-triangle-exclamation');
    if (window.turnstile) window.turnstile.reset();
  }
};

function checkCaptcha() {
  if (sessionStorage.getItem('captcha_passed') === 'true') {
    document.getElementById('captchaGate').classList.add('hidden');
    boot();
  } else {
    document.getElementById('captchaGate').classList.remove('hidden');
  }
}

checkCaptcha();

/* =========== iOS ZOOM LOCK =========== */
document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
document.addEventListener('gesturechange', function (e) { e.preventDefault(); });
document.addEventListener('gestureend', function (e) { e.preventDefault(); });
let lastTouchEnd = 0;
document.addEventListener('touchend', function (event) {
  const now = (new Date()).getTime();
  if (now - lastTouchEnd <= 300) event.preventDefault();
  lastTouchEnd = now;
}, false);

/* ---------- CUSTOM DROPDOWN LOGIC ---------- */
document.addEventListener('DOMContentLoaded', () => {
  const trigger = document.getElementById('ttlTrigger');
  const optionsContainer = document.getElementById('ttlOptions');
  const selectedLabel = document.getElementById('ttlSelectedLabel');
  const hiddenSelect = document.getElementById('ttlSelect');

  if (trigger && optionsContainer) {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      optionsContainer.classList.toggle('hidden');
      trigger.classList.toggle('open');
    });

    optionsContainer.querySelectorAll('.custom-select-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.val;
        const label = opt.textContent;

        // Update UI
        selectedLabel.textContent = label;
        trigger.classList.remove('open');
        optionsContainer.classList.add('hidden');

        // Update active class
        optionsContainer.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');

        // Update hidden select (agar createInbox membaca value yg benar)
        if (hiddenSelect) hiddenSelect.value = val;
      });
    });

    // Tutup dropdown jika klik di luar area
    document.addEventListener('click', (e) => {
      if (!optionsContainer.contains(e.target) && !trigger.contains(e.target)) {
        optionsContainer.classList.add('hidden');
        trigger.classList.remove('open');
      }
    });
  }
});
