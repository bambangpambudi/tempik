const logoBtn = document.getElementById('logoBtn');
const currentInbox = document.getElementById('currentInbox');
const copyBtn = document.getElementById('copyBtn');
const refreshBtn = document.getElementById('refreshBtn');
const sidebar = document.getElementById('sidebar');
const drawerBackdrop = document.getElementById('drawerBackdrop');
const closeSidebarBtn = document.getElementById('closeSidebarBtn');
const inboxList = document.getElementById('inboxList');
const inboxCount = document.getElementById('inboxCount');
const localPartInput = document.getElementById('localPartInput');
const domainSelect = document.getElementById('domainSelect');
const createCustomBtn = document.getElementById('createCustomBtn');
const createRandomBtn = document.getElementById('createRandomBtn');
const messageList = document.getElementById('messageList');
const messageDetail = document.getElementById('messageDetail');
const messageCount = document.getElementById('messageCount');
const deleteModal = document.getElementById('deleteModal');
const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
const deleteTargetAddress = document.getElementById('deleteTargetAddress');

let appConfig = { appName: 'Artex Mail', mailDomain: 'artexmail.web.id' };
const SESSION_KEY = 'artex_session_v2';
let sessionId = localStorage.getItem(SESSION_KEY) || '';

let allInboxes = [];
let currentAddress = '';
let currentMessages = [];
let selectedMessageIndex = 0;
let pendingDeleteAddress = '';

// ⭐ Polling
let pollingInterval = null;
const POLLING_DELAY = 3000; // 3 detik (lebih responsif)

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
  if (audio) {
    audio.currentTime = 0;
    audio.play().catch(e => console.warn('[audio] Autoplay diblokir:', e));
  }
}

async function fetchJson(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (sessionId) headers['x-session-id'] = sessionId;
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/* ---------- URL ROUTING ---------- */
function getAddressFromURL() {
  const decodedPath = decodeURIComponent(location.pathname);
  if (decodedPath.startsWith('/email=')) return decodedPath.slice(7).trim();
  
  const decodedSearch = decodeURIComponent(location.search);
  const params = new URLSearchParams(decodedSearch);
  if (params.get('email')) return params.get('email').trim();
  
  const decodedUrl = decodeURIComponent(location.href);
  const match = decodedUrl.match(/(?:\/|\?|&|#)email=([^&?#\/]+)/i);
  if (match) return match[1].trim();
  
  return null;
}

function buildInboxURL(address) {
  if (!address) return '/';
  const localPart = address.split('@')[0];
  return '/email=' + encodeURIComponent(localPart);
}

function updateURL(address, replace = false) {
  const desired = buildInboxURL(address);
  if (location.pathname === desired) return;
  const state = { address };
  if (replace) history.replaceState(state, '', desired);
  else history.pushState(state, '', desired);
}

/* ---------- Data Fetch & Polling ---------- */
async function fetchInboxes() {
  try {
    allInboxes = await fetchJson('/api/inboxes');
  } catch (e) {
    allInboxes = [];
  }
  inboxCount.textContent = allInboxes.length;
}

async function loadMessages({ isBackground = false } = {}) {
  if (!currentAddress) {
    currentMessages = [];
    renderMailView();
    return;
  }
  currentInbox.textContent = currentAddress;
  
  try {
    const fetched = await fetchJson('/api/inboxes/' + encodeURIComponent(currentAddress) + '/messages');
    
    // ⭐ Deteksi Email Baru
    if (isBackground && fetched.length > currentMessages.length) {
      console.log('[polling] 🔔 Email baru terdeteksi! (' + currentMessages.length + ' → ' + fetched.length + ')');
      playNotification();
    }
    
    currentMessages = fetched;
  } catch (e) {
    console.warn('[polling] Fetch error:', e.message);
    if (!isBackground) showToast('Failed to load messages', 'fa-solid fa-triangle-exclamation');
  }
  
  if (!isBackground) {
    selectedMessageIndex = currentMessages.length > 0 ? 0 : -1;
  } else if (selectedMessageIndex >= currentMessages.length) {
    selectedMessageIndex = currentMessages.length > 0 ? 0 : -1;
  }

  renderMailView();
}

function startPolling() {
  if (pollingInterval) {
    console.log('[polling] Already running, skip');
    return;
  }
  console.log('[polling] ✅ Started (every ' + (POLLING_DELAY / 1000) + 's)');
  
  // Tampilkan indikator polling aktif
  const dot = document.querySelector('.status-indicator');
  if (dot) dot.style.animation = 'pulse 2s infinite';
  
  pollingInterval = setInterval(() => {
    if (currentAddress) {
      console.log('[polling] Checking... ' + new Date().toLocaleTimeString());
      loadMessages({ isBackground: true });
    }
  }, POLLING_DELAY);
}

function stopPolling() {
  if (pollingInterval) {
    console.log('[polling] ⏸ Stopped');
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  const dot = document.querySelector('.status-indicator');
  if (dot) dot.style.animation = 'none';
}

// ⭐ Page Visibility
document.addEventListener('visibilitychange', () => {
  console.log('[visibility] hidden=' + document.hidden);
  if (document.hidden) {
    stopPolling();
  } else {
    if (currentAddress) loadMessages({ isBackground: true });
    startPolling();
  }
});

async function selectInbox(address, { push = true } = {}) {
  currentAddress = address || '';
  renderInboxList();
  updateURL(currentAddress, !push);
  await loadMessages({ isBackground: false });
  startPolling();
}

/* ---------- Render: Inbox List ---------- */
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
      await selectInbox(addr, { push: true });
      closeSidebar();
    });
  });

  inboxList.querySelectorAll('.inbox-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDeleteModal(btn.dataset.delete);
    });
  });
}

/* ---------- Render: Mail View ---------- */
function renderMailView() {
  messageCount.textContent = currentMessages.length;
  if (!currentAddress) {
    messageList.innerHTML = '';
    messageDetail.innerHTML = '<div class="empty-view">' +
      '<div class="empty-icon"><i class="fa-regular fa-paper-plane"></i></div>' +
      '<h3>No Inbox Selected</h3>' +
      '<p>Click the <strong>Artex Mail</strong> logo at the top-left to open the inbox manager.</p>' +
    '</div>';
    return;
  }
  if (!currentMessages.length) {
    messageList.innerHTML = '';
    messageDetail.innerHTML = '<div class="empty-view">' +
      '<div class="empty-icon"><i class="fa-regular fa-envelope-open"></i></div>' +
      '<h3>Inbox is empty</h3>' +
      '<p>Emails sent to <strong>' + escapeHtml(currentAddress) + '</strong> will appear here.</p>' +
    '</div>';
    return;
  }
  renderMessageList();
  renderMessageDetail();
}

function renderMessageList() {
  messageList.innerHTML = currentMessages.map((msg, i) => {
    const sender = msg.from_address || '?';
    const initial = sender.trim().charAt(0).toUpperCase();
    const shortName = sender.split('@')[0];
    const active = i === selectedMessageIndex ? 'active' : '';
    return '<button type="button" class="msg-item ' + active + '" data-index="' + i + '">' +
      '<div class="msg-avatar">' + escapeHtml(initial) + '</div>' +
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
      if (window.innerWidth <= 1024) {
        messageDetail.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
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
function openSidebar() {
  sidebar.classList.add('open');
  drawerBackdrop.classList.add('show');
  document.body.classList.add('drawer-open');
  setTimeout(() => localPartInput.focus(), 300);
}
function closeSidebar() {
  sidebar.classList.remove('open');
  drawerBackdrop.classList.remove('show');
  document.body.classList.remove('drawer-open');
}
logoBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (sidebar.classList.contains('open')) closeSidebar();
  else openSidebar();
});
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
  domains.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = '@' + d;
    domainSelect.appendChild(opt);
  });
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
  try {
    await navigator.clipboard.writeText(currentAddress);
    showToast('Address copied to clipboard', 'fa-regular fa-copy');
  } catch (e) {
    showToast('Copy failed', 'fa-solid fa-triangle-exclamation');
  }
});

refreshBtn.addEventListener('click', () => loadMessages({ isBackground: false }));

/* ---------- Create Inbox ---------- */
async function createInbox(localPart) {
  try {
    const inbox = await fetchJson('/api/inboxes', {
      method: 'POST',
      body: JSON.stringify({ localPart, domain: domainSelect.value })
    });
    localPartInput.value = '';
    await fetchInboxes();
    await selectInbox(inbox.address, { push: true });
    showToast('Inbox created successfully', 'fa-solid fa-check');
    closeSidebar();
  } catch (err) {
    showToast(err.message || 'Failed to create inbox', 'fa-solid fa-triangle-exclamation');
  }
}

createCustomBtn.addEventListener('click', () => createInbox(localPartInput.value.trim()));
createRandomBtn.addEventListener('click', () => createInbox(''));
localPartInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    createInbox(localPartInput.value.trim());
  }
});

/* ---------- Delete Modal ---------- */
function openDeleteModal(address) {
  pendingDeleteAddress = address;
  deleteTargetAddress.textContent = address;
  deleteModal.classList.remove('hidden');
}

cancelDeleteBtn.addEventListener('click', () => {
  deleteModal.classList.add('hidden');
  pendingDeleteAddress = '';
});

deleteModal.addEventListener('click', (e) => {
  if (e.target === deleteModal) {
    deleteModal.classList.add('hidden');
    pendingDeleteAddress = '';
  }
});

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
    const wasCurrent = target === currentAddress;
    const nextAddr = wasCurrent ? (allInboxes[0]?.address || '') : currentAddress;
    await selectInbox(nextAddr, { push: !wasCurrent });
  } catch (e) {
    showToast('Failed to delete inbox', 'fa-solid fa-triangle-exclamation');
  } finally {
    confirmDeleteBtn.innerHTML = 'Delete';
    confirmDeleteBtn.disabled = false;
  }
});

/* ---------- Keyboard ---------- */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!deleteModal.classList.contains('hidden')) {
      deleteModal.classList.add('hidden');
      pendingDeleteAddress = '';
    } else if (sidebar.classList.contains('open')) {
      closeSidebar();
    }
  }
});

/* ---------- Boot ---------- */
async function boot() {
  try {
    await loadConfig();
    await ensureSession();
    await fetchInboxes();

    const urlAddr = getAddressFromURL();

    if (urlAddr) {
      const localPart = urlAddr.includes('@') ? urlAddr.split('@')[0] : urlAddr;
      const domain = appConfig.mailDomain || 'artexmail.web.id';
      const targetAddress = localPart + '@' + domain;

      try {
        await fetchJson('/api/inboxes', {
          method: 'POST',
          body: JSON.stringify({ localPart, domain })
        });
      } catch (err) {
        console.warn('Adopt skipped or failed:', err);
      }
      
      await fetchInboxes();
      await selectInbox(targetAddress, { push: false });
    } else {
      if (!allInboxes.length) {
        currentAddress = '';
        renderInboxList();
        renderMailView();
      } else {
        await selectInbox(allInboxes[0].address, { push: false });
      }
    }

    // ⭐ Paksa mulai polling (tanpa syarat document.hidden)
    startPolling();
    console.log('[boot] App ready, polling active');

  } catch (err) {
    console.error(err);
    messageDetail.innerHTML = '<div class="empty-view"><div class="empty-icon" style="color:#f43f5e"><i class="fa-solid fa-triangle-exclamation"></i></div><h3>Connection Error</h3><p>' + escapeHtml(err.message) + '</p></div>';
  }
}

boot();
