// ============================================================
// CourtCollab — App Logic (API-connected, no mock data)
// ============================================================

// --- Auth & API Helpers ---
const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'https://courtcollab-production.up.railway.app'
  : '';
// --- Real-time messaging via polling ---
let _msgPollTimer  = null;
let _lastMsgId     = 0;
let _typingTimer   = null;
let _typingHideTimer = null;

function _connectWS() { _startMsgPolling(); }   // alias kept for onAuthSuccess
function _disconnectWS() { _stopMsgPolling(); }  // alias kept for handleLogout

function _startMsgPolling() {
  if (_msgPollTimer) return;
  _msgPollTimer = setInterval(_pollMessages, 2000);
}

function _stopMsgPolling() {
  if (_msgPollTimer) { clearInterval(_msgPollTimer); _msgPollTimer = null; }
  _lastMsgId = 0;
}

async function _pollMessages() {
  if (!state.activePartner || !getToken()) return;
  try {
    const msgs = await apiGet('/api/messages/' + state.activePartner);
    if (!msgs || !msgs.length) return;
    const latest = msgs[msgs.length - 1];
    if (_lastMsgId === 0) { _lastMsgId = latest.id; return; }   // first poll, just set baseline
    if (latest.id <= _lastMsgId) return;                         // nothing new
    // Append only the new messages
    const newMsgs = msgs.filter(m => m.id > _lastMsgId);
    _lastMsgId = latest.id;
    const myId = state.currentUser?.id;
    newMsgs.forEach(m => {
      if (m.sender_id !== myId) _appendIncomingMessage(m);
    });
    // Refresh the conversation list sidebar too
    renderConversations();
  } catch (_) {}

  // Also check typing indicator (cache-bust to prevent Netlify CDN caching)
  try {
    const t = await apiGet('/api/typing/' + state.activePartner + '?_=' + Date.now());
    if (t && t.is_typing) _showTypingIndicator();
    else _hideTypingIndicator();
  } catch (_) {}
}

function _appendIncomingMessage(msg) {
  const chatEl = document.getElementById('chat-messages');
  if (!chatEl) return;
  const placeholder = chatEl.querySelector('.text-center.text-gray-400');
  if (placeholder) placeholder.remove();
  _hideTypingIndicator();
  const div = document.createElement('div');
  div.className = 'flex justify-start mb-1';
  div.innerHTML = `<div class="max-w-sm"><div class="message-bubble-left px-4 py-3 text-sm">${escHtml(msg.body)}</div><div class="text-xs text-gray-400 mt-1">${_fmtMsgTime(msg.created_at)}</div></div>`;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function _showTypingIndicator() {
  let el = document.getElementById('typing-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'typing-indicator';
    el.className = 'flex justify-start mb-1 px-4';
    const chatEl = document.getElementById('chat-messages');
    if (chatEl) chatEl.appendChild(el);
  }
  el.innerHTML = `<div class="message-bubble-left px-4 py-2.5 flex items-center gap-1.5"><span class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay:0ms"></span><span class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay:150ms"></span><span class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay:300ms"></span></div>`;
  const chatEl = document.getElementById('chat-messages');
  if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
}

function _hideTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

function _sendTyping(value) {
  if (!state.activePartner) return;
  if (!value || value.length === 0) return;  // don't show bubble for empty input
  // Only POST once per 5s (debounce), backend expires after 2 min
  if (!_typingTimer) {
    apiPost('/api/typing/' + state.activePartner, {}).catch(() => {});
  }
  clearTimeout(_typingTimer);
  _typingTimer = setTimeout(() => { _typingTimer = null; }, 5000);
}

// Extract a human-readable message from a FastAPI error response
function _extractDetail(data) {
  if (!data || !data.detail) return 'Request failed';
  if (typeof data.detail === 'string') return data.detail;
  if (Array.isArray(data.detail)) {
    return data.detail.map(e => e.msg || JSON.stringify(e)).join(', ');
  }
  return JSON.stringify(data.detail);
}

// Slow-load detector: show spinner if any fetch takes > 500ms
const _origFetch = window.fetch;
window.fetch = function(...args) {
  let _slowTimer = null;
  const url = typeof args[0] === 'string' ? args[0] : '';
  // Only intercept our own API calls (not Stripe etc.)
  if (url.includes('railway.app') || url.startsWith('/api')) {
    _slowTimer = setTimeout(() => showLoading('Loading…'), 500);
  }
  return _origFetch.apply(this, args).catch(err => {
    if (err instanceof TypeError && (url.includes('railway.app') || url.startsWith('/api'))) {
      showToast('Connection failed. Please check your internet and try again.', 'error');
    }
    throw err;
  }).finally(() => {
    if (_slowTimer) { clearTimeout(_slowTimer); _slowTimer = null; hideLoading(); }
  });
};

function getToken() {
  return localStorage.getItem('cc_jwt') || sessionStorage.getItem('cc_jwt');
}
function setToken(t, remember = true) {
  if (remember) {
    localStorage.setItem('cc_jwt', t);
    sessionStorage.removeItem('cc_jwt');
  } else {
    sessionStorage.setItem('cc_jwt', t);
    localStorage.removeItem('cc_jwt');
  }
}
function clearToken() {
  localStorage.removeItem('cc_jwt');
  sessionStorage.removeItem('cc_jwt');
}

async function apiPost(path, body, opts = {}) {
  if (opts.loading) showLoading(opts.msg || 'Please wait…');
  try {
    const token = getToken();
    const res = await fetch(API + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': 'Bearer ' + token } : {})
      },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(_extractDetail(data));
    return data;
  } finally { if (opts.loading) hideLoading(); }
}

async function apiGet(path, opts = {}) {
  if (opts.loading) showLoading(opts.msg || 'Loading…');
  try {
    const token = getToken();
    const res = await fetch(API + path, {
      headers: token ? { 'Authorization': 'Bearer ' + token } : {}
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let data = {};
      try { data = JSON.parse(text); } catch (_) {}
      const msg = _extractDetail(data);
      throw new Error(msg === 'Request failed' ? `Request failed (${res.status})` : msg);
    }
    return res.json();
  } finally { if (opts.loading) hideLoading(); }
}

async function apiPut(path, body, opts = {}) {
  if (opts.loading) showLoading(opts.msg || 'Saving…');
  try {
    const token = getToken();
    const res = await fetch(API + path, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': 'Bearer ' + token } : {})
      },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(_extractDetail(data));
    return data;
  } finally { if (opts.loading) hideLoading(); }
}

async function apiPatch(path, body = {}, opts = {}) {
  if (opts.loading) showLoading(opts.msg || 'Updating…');
  try {
    const token = getToken();
    const res = await fetch(API + path, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': 'Bearer ' + token } : {})
      },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(_extractDetail(data));
    return data;
  } finally { if (opts.loading) hideLoading(); }
}

// --- Loading Overlay ---
let _loadingCount = 0;
let _loadingShownAt = 0;
const LOADING_MIN_MS = 3000; // show for at least one full animation cycle

function showLoading(msg = 'Loading…') {
  _loadingCount++;
  _loadingShownAt = Date.now();
  const el = document.getElementById('loading-overlay');
  const txt = document.getElementById('loading-message');
  if (el) el.classList.add('active');
  if (txt) txt.textContent = msg;
}
function hideLoading() {
  _loadingCount = Math.max(0, _loadingCount - 1);
  if (_loadingCount === 0) {
    const elapsed = Date.now() - _loadingShownAt;
    const remaining = Math.max(0, LOADING_MIN_MS - elapsed);
    setTimeout(() => {
      if (_loadingCount === 0) {
        const el = document.getElementById('loading-overlay');
        if (el) el.classList.remove('active');
      }
    }, remaining);
  }
}

// --- Auth Gate ---
function showAuthGate() {
  const gate = document.getElementById('auth-gate');
  if (gate) gate.classList.remove('hidden');
}
function hideAuthGate() {
  const gate = document.getElementById('auth-gate');
  if (gate) gate.classList.add('hidden');
}

function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isText = input.type === 'text';
  input.type = isText ? 'password' : 'text';
  // Swap eye icon to slashed version when visible
  const svg = btn.querySelector('svg');
  if (svg) {
    if (isText) {
      svg.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>';
    } else {
      svg.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/>';
    }
  }
}

function showForgotPassword() {
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('forgot-password-form').style.display = 'block';
  document.getElementById('forgot-success').style.display = 'none';
  document.getElementById('forgot-email').value = '';
  document.getElementById('auth-error').classList.add('hidden');
}

async function handleForgotPassword() {
  const email = document.getElementById('forgot-email').value.trim();
  if (!email) return;
  const btn = document.querySelector('#forgot-password-form .auth-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    await apiPost('/api/forgot-password', { email });
    document.getElementById('forgot-success').style.display = 'block';
    if (btn) { btn.disabled = true; btn.textContent = 'Email Sent'; }
  } catch (err) {
    // Show success anyway to avoid email enumeration
    document.getElementById('forgot-success').style.display = 'block';
    if (btn) { btn.disabled = true; btn.textContent = 'Email Sent'; }
  }
}

async function handleResetPassword() {
  const password = document.getElementById('reset-password').value;
  const token    = new URLSearchParams(window.location.search).get('reset_token');
  const errorEl  = document.getElementById('reset-error');
  const btn      = document.querySelector('#reset-password-form .auth-btn');
  errorEl.style.display = 'none';
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
  try {
    await apiPost('/api/reset-password', { token, password });
    history.replaceState({}, '', window.location.pathname);
    showAuthTab('login');
    showToast('✓ Password updated! Please sign in.');
  } catch (err) {
    errorEl.textContent = err.message || 'Reset failed. Please request a new link.';
    errorEl.style.display = 'block';
    if (btn) { btn.disabled = false; btn.textContent = 'Update Password'; }
  }
}

function showAuthTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('login-form').style.display = isLogin ? 'block' : 'none';
  document.getElementById('signup-form').style.display = isLogin ? 'none' : 'block';
  document.getElementById('forgot-password-form').style.display = 'none';
  document.getElementById('reset-password-form').style.display = 'none';
  document.getElementById('tab-login').classList.toggle('active', isLogin);
  document.getElementById('tab-signup').classList.toggle('active', !isLogin);
  document.getElementById('auth-error').classList.add('hidden');
  const heading = document.querySelector('.auth-right h2');
  const sub     = document.querySelector('.auth-right > div > p');
  if (heading) heading.textContent = isLogin ? 'Welcome back' : 'Create your account';
  if (sub)     sub.textContent     = isLogin ? 'Sign in to your CourtCollab account.' : 'Join the pickleball creator marketplace.';
  if (!isLogin) highlightRole();
}

function highlightRole() {
  const brandChecked = document.getElementById('role-brand').checked;
  document.getElementById('role-brand-label').style.borderColor = brandChecked ? '#2F4F2F' : '#e5e7eb';
  document.getElementById('role-brand-label').style.background = brandChecked ? '#f0f5f0' : '';
  document.getElementById('role-creator-label').style.borderColor = !brandChecked ? '#2F4F2F' : '#e5e7eb';
  document.getElementById('role-creator-label').style.background = !brandChecked ? '#f0f5f0' : '';
  // Show brand fields for brands, social handle fields for creators
  const brandFields = document.getElementById('brand-signup-fields');
  const socialFields = document.getElementById('creator-social-fields');
  if (brandFields) brandFields.style.display = brandChecked ? 'flex' : 'none';
  if (socialFields) socialFields.style.display = brandChecked ? 'none' : 'flex';
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function showFieldError(inputId, msg) {
  clearFieldError(inputId);
  const input = document.getElementById(inputId);
  if (!input) return;
  let container = input.parentNode;
  if (!container.querySelector('label')) container = container.parentNode;
  const err = document.createElement('p');
  err.className = 'field-error';
  err.dataset.field = inputId;
  err.style.cssText = 'color:#dc2626;font-size:0.78rem;margin-top:0.3rem;';
  err.textContent = msg;
  container.appendChild(err);
  input.style.borderColor = '#fca5a5';
}
function clearFieldError(inputId) {
  const input = document.getElementById(inputId);
  if (input) input.style.borderColor = '';
  document.querySelectorAll(`.field-error[data-field="${inputId}"]`).forEach(e => e.remove());
}
function clearAllFieldErrors() {
  document.querySelectorAll('.field-error').forEach(e => e.remove());
  document.querySelectorAll('.auth-input').forEach(i => { if (i.style.borderColor) i.style.borderColor = ''; });
}

function setAuthBtnLoading(formId, loading) {
  const btn = document.querySelector(`#${formId} button[type="submit"]`);
  if (btn) {
    btn.disabled = loading;
    btn.textContent = loading ? 'Please wait…' : (formId === 'login-form' ? 'Sign In' : 'Create Account');
  }
}

async function handleLogin(e) {
  e.preventDefault();
  clearAllFieldErrors();
  document.getElementById('auth-error').classList.add('hidden');
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const remember = document.getElementById('remember-me')?.checked ?? true;
  if (!email)    { showFieldError('login-email',    'Please enter your email.');    return; }
  if (!password) { showFieldError('login-password', 'Please enter your password.'); return; }
  setAuthBtnLoading('login-form', true);
  try {
    const { token, user } = await apiPost('/api/login', { email, password, remember }, { loading: true, msg: 'Signing in…' });
    setToken(token, remember);
    onAuthSuccess(user);
  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('password') || msg.includes('incorrect') || msg.includes('invalid credentials')) {
      showFieldError('login-password', 'Incorrect password. Please try again.');
    } else if (msg.includes('not found') || msg.includes('no user') || msg.includes('no account')) {
      showFieldError('login-email', 'No account found with this email.');
    } else {
      showAuthError(err.message || 'Sign in failed. Please try again.');
    }
  } finally {
    setAuthBtnLoading('login-form', false);
  }
}

async function handleSignup(e) {
  e.preventDefault();
  clearAllFieldErrors();
  document.getElementById('auth-error').classList.add('hidden');
  const name     = document.getElementById('signup-name').value.trim();
  const email    = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const role     = document.querySelector('input[name="signup-role"]:checked').value;

  if (password.length < 6) {
    showFieldError('signup-password', 'Password must be at least 6 characters.');
    return;
  }

  // Role-specific validation
  if (role === 'creator') {
    const ig = (document.getElementById('signup-instagram').value || '').trim();
    const tt = (document.getElementById('signup-tiktok').value || '').trim();
    if (!ig && !tt) {
      showAuthError('Please enter at least one social handle (Instagram or TikTok) so brands can find you.');
      return;
    }
  }
  if (role === 'brand') {
    const company = (document.getElementById('signup-company').value || '').trim();
    if (!company) {
      showAuthError('Please enter your company name.');
      return;
    }
  }

  setAuthBtnLoading('signup-form', true);
  try {
    const { token, user } = await apiPost('/api/signup', { name, email, password, role }, { loading: true, msg: 'Creating your account…' });
    setToken(token);
    // Save role-specific data right after signup (non-blocking)
    if (role === 'creator') {
      try {
        const ig = (document.getElementById('signup-instagram').value || '').trim().replace(/^@/, '');
        const tt = (document.getElementById('signup-tiktok').value || '').trim().replace(/^@/, '');
        const handles = {};
        if (ig) handles.instagram = ig;
        if (tt) handles.tiktok = tt;
        await apiPut('/api/creator/profile', { social_handles: handles });
      } catch (_) { /* best-effort */ }
    }
    if (role === 'brand') {
      try {
        const company = (document.getElementById('signup-company').value || '').trim();
        await apiPut('/api/brand/profile', { company_name: company });
      } catch (_) { /* best-effort */ }
    }
    onAuthSuccess(user);
    startOnboarding(user);   // shows wizard overlay for new users
  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('already') || msg.includes('registered') || (msg.includes('email') && msg.includes('exist'))) {
      showFieldError('signup-email', 'An account with this email already exists.');
    } else {
      showAuthError(err.message || 'Sign up failed. Please try again.');
    }
  } finally {
    setAuthBtnLoading('signup-form', false);
  }
}

// Platform admin emails — must match ADMIN_EMAILS on the backend
const ADMIN_EMAILS = ['benreveno@gmail.com', 'juliacono@gmail.com', 'ben@courtcollab.com', 'julia@courtcollab.com'];

function onAuthSuccess(user) {
  state.currentUser = user;
  hideAuthGate();
  switchRole(user.role);
  const initials = user.initials || user.name.slice(0, 2).toUpperCase();
  document.getElementById('nav-user-initials').textContent = initials;
  document.getElementById('nav-user-initials-mobile').textContent = initials;
  document.getElementById('nav-user-name').textContent = user.name;
  updateLandingHeroButtons(user.role);
  // Show admin nav link only for platform admins
  const isAdmin = ADMIN_EMAILS.includes(user.email);
  const badge = document.getElementById('nav-role-badge');
  if (badge) {
    if (isAdmin) {
      badge.classList.add('hidden');
    } else {
      badge.textContent = user.role === 'creator' ? '🎥 Creator' : '🏢 Brand';
      badge.classList.remove('hidden');
    }
  }
  const adminLink = document.getElementById('nav-admin-link');
  const adminLinkMobile = document.getElementById('nav-admin-link-mobile');
  if (adminLink) adminLink.classList.toggle('hidden', !isAdmin);
  if (adminLinkMobile) adminLinkMobile.classList.toggle('hidden', !isAdmin);
  // Show role toggle for admins (desktop nav + mobile hamburger)
  const roleToggle = document.getElementById('admin-role-toggle');
  const roleToggleMobile = document.getElementById('admin-role-toggle-mobile');
  if (roleToggle) {
    if (isAdmin) {
      roleToggle.classList.remove('hidden', 'md:hidden');
      roleToggle.classList.add('md:flex');
      adminUpdateToggleButtons('creator');
    } else {
      roleToggle.classList.add('hidden');
      roleToggle.classList.remove('md:flex');
    }
  }
  if (roleToggleMobile) {
    roleToggleMobile.classList.toggle('hidden', !isAdmin);
  }
  navigate(isAdmin ? 'admin' : 'landing');
  if (user.role === 'creator') loadStripeConnectStatus();
  startNotifPolling();
  _connectWS();
}

// --- Admin role view switcher ---
function adminSwitchView(role) {
  switchRole(role);
  adminUpdateToggleButtons(role);
  updateLandingHeroButtons(role);
  navigate('landing');
}

function adminUpdateToggleButtons(role) {
  const creatorBtn = document.getElementById('admin-toggle-creator');
  const brandBtn   = document.getElementById('admin-toggle-brand');
  if (!creatorBtn || !brandBtn) return;
  const activeClass   = 'bg-white text-gray-900 shadow-sm';
  const inactiveClass = 'text-gray-500 hover:text-gray-700';
  if (role === 'creator') {
    creatorBtn.className = creatorBtn.className.replace(inactiveClass, '').trim() + ' ' + activeClass;
    brandBtn.className   = brandBtn.className.replace(activeClass, '').trim() + ' ' + inactiveClass;
  } else {
    brandBtn.className   = brandBtn.className.replace(inactiveClass, '').trim() + ' ' + activeClass;
    creatorBtn.className = creatorBtn.className.replace(activeClass, '').trim() + ' ' + inactiveClass;
  }
  creatorBtn.className = creatorBtn.className.replace(/\s+/g, ' ').trim();
  brandBtn.className   = brandBtn.className.replace(/\s+/g, ' ').trim();
}

function updateLandingHeroButtons(role) {
  const browse          = document.getElementById('btn-browse-creators');
  const join            = document.getElementById('btn-join-creator');
  const creatorDash     = document.getElementById('btn-creator-dashboard');
  const brandDash       = document.getElementById('btn-brand-dashboard');
  if (!browse) return;
  if (role === 'creator') {
    browse.style.display = 'none';
    join.style.display = 'none';
    creatorDash.style.display = '';
    if (brandDash) brandDash.style.display = 'none';
  } else if (role === 'brand') {
    browse.style.display = 'none';
    join.style.display = 'none';
    creatorDash.style.display = 'none';
    if (brandDash) brandDash.style.display = '';
  } else {
    browse.style.display = '';
    join.style.display = '';
    creatorDash.style.display = 'none';
    if (brandDash) brandDash.style.display = 'none';
  }
}

function handleLogout() {
  stopNotifPolling();
  _disconnectWS();
  state.currentUser = null;
  state.activePartner = null;
  state.selectedCreator = null;
  clearToken();
  showAuthGate();
  showAuthTab('login');
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
}

// --- Notification dots ---
let _notifPollTimer = null;

async function refreshNotifDots() {
  if (!getToken()) return;
  try {
    const [notifData, convos] = await Promise.all([
      apiGet('/api/notifications', { silent: true }),
      apiGet('/api/conversations', { silent: true }).catch(() => [])
    ]);

    // Unread messages
    const unreadMessages = convos.some(c => c.unread_count > 0);
    // Unread payment notifications
    const unreadPayments = notifData.some(n => !n.read_at &&
      (n.type === 'payment_received' || n.type === 'payment_released'));

    const hasAny = unreadMessages || unreadPayments;

    const dot        = document.getElementById('nav-activity-dot');
    const msgDot     = document.getElementById('nav-messages-dot');
    const payDot     = document.getElementById('nav-payments-dot');
    if (dot)    dot.classList.toggle('hidden', !hasAny);
    if (msgDot) msgDot.classList.toggle('hidden', !unreadMessages);
    if (payDot) payDot.classList.toggle('hidden', !unreadPayments);
  } catch { /* silent fail */ }
}

function startNotifPolling() {
  refreshNotifDots();
  _notifPollTimer = setInterval(refreshNotifDots, 30000);
}
function stopNotifPolling() {
  if (_notifPollTimer) { clearInterval(_notifPollTimer); _notifPollTimer = null; }
}

// --- Nav dropdowns ---
function toggleNavDropdown(id) {
  const el = document.getElementById(id);
  const isOpen = el.classList.contains('open');
  closeNavDropdowns();
  if (!isOpen) el.classList.add('open');
}
function closeNavDropdowns() {
  document.querySelectorAll('.nav-dropdown-group.open').forEach(el => el.classList.remove('open'));
}
// Close dropdowns when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('.nav-dropdown-group')) closeNavDropdowns();
});

// --- Mobile menu ---
function toggleMobileMenu() {
  const menu = document.getElementById('mobile-menu-dropdown');
  menu.classList.toggle('open');
}
function closeMobileMenu() {
  const menu = document.getElementById('mobile-menu-dropdown');
  menu.classList.remove('open');
}

// --- State ---
let state = {
  role: 'brand',
  currentPage: 'landing',
  selectedCreator: null,
  activePartner: null,   // partner user_id for messaging
  currentUser: null,
};

// Saved creators state (brands only)
let _savedCreatorIds = new Set();
let _creatorsTab     = 'all';
let _detailCreatorId = null;  // creator user_id currently open in detail modal

// --- Navigation ---
function navigateDashboard() {
  navigate(state.role === 'brand' ? 'brand-portal' : 'creator-dashboard', 'nav-dashboard-btn');
}

function navigateToProfile() {
  if (state.role === 'creator') navigate('creator-profile');
  else navigate('brand-portal');
}

function navigate(page, activeNavId = null) {
  if (!getToken()) { showAuthGate(); return; }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + page);
  if (target) {
    target.classList.add('active');
    state.currentPage = page;
  } else {
    const notFound = document.getElementById('page-404');
    if (notFound) notFound.classList.add('active');
    return;
  }
  window.scrollTo(0, 0);
  document.body.scrollTop = 0;
  document.documentElement.scrollTop = 0;
  document.querySelectorAll('.nav-link').forEach(link => {
    if (activeNavId) {
      // Only light up the explicitly clicked button (and its mobile twin)
      const mobileId = activeNavId + '-mobile';
      link.classList.toggle('active', link.id === activeNavId || link.id === mobileId);
    } else {
      link.classList.toggle('active', link.dataset.page === page);
    }
  });
  if (page === 'brand-portal') renderBrandPortal();
  if (page === 'creators')  { loadSavedCreatorIds().then(() => renderCreators()); }
  if (page === 'campaigns') renderCampaigns();
  if (page === 'matching')  runMatching();
  if (page === 'messages')  { renderConversations(); document.getElementById('nav-messages-dot')?.classList.add('hidden'); }
  if (page === 'payments')  { renderPayments(); document.getElementById('nav-payments-dot')?.classList.add('hidden'); }
  // Hide the activity dot if both sub-dots are now hidden
  const msgDot = document.getElementById('nav-messages-dot');
  const payDot = document.getElementById('nav-payments-dot');
  if (msgDot?.classList.contains('hidden') && payDot?.classList.contains('hidden')) {
    document.getElementById('nav-activity-dot')?.classList.add('hidden');
  }
  if (page === 'contact')          renderContact();
  if (page === 'admin')            renderAdmin();
  if (page === 'creator-profile')    { populateCreatorForm(); renderCreatorDealHistory(); }
  else { const el = document.getElementById('creator-profile-completion'); if (el) el.innerHTML = ''; }
  if (page === 'creator-dashboard')  renderCreatorDashboard();
}

// --- Role Switch ---
function switchRole(role) {
  state.role = role;
  const el = document.getElementById('user-role');
  if (el) el.value = role;
  document.querySelectorAll('.brand-only').forEach(e => { e.style.display = role === 'brand' ? '' : 'none'; });
  document.querySelectorAll('.creator-only').forEach(e => { e.style.display = role === 'creator' ? '' : 'none'; });
  // Update dashboard nav button data-page so active highlight works per role
  const dashPage = role === 'brand' ? 'brand-portal' : 'creator-dashboard';
  ['nav-dashboard-btn', 'nav-dashboard-btn-mobile'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.dataset.page = dashPage;
  });
}

// --- Format Numbers ---
function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
  return n.toString();
}

// --- Render Star Rating ---
function renderStars(score) {
  if (!score && score !== 0) return '<span class="text-gray-300 text-sm">No rating</span>';
  const full  = Math.round(score);
  const empty = 5 - full;
  return (
    '<span class="text-yellow-400 leading-none">' + '★'.repeat(Math.max(0, full))  + '</span>' +
    '<span class="text-gray-200 leading-none">'  + '★'.repeat(Math.max(0, empty)) + '</span>'
  );
}

// --- Toast ---
function showToast(text, type = 'default') {
  const toast = document.getElementById('toast');
  const displayText = type === 'error' ? 'Uh oh! ' + text.replace(/^[⚠\s]+/, '') : text;
  document.getElementById('toast-text').textContent = displayText;
  if (type === 'success') toast.style.background = '#16a34a';
  else if (type === 'error') toast.style.background = '#264226';
  else toast.style.background = '';
  toast.classList.remove('hidden', 'opacity-0', 'translate-y-2');
  toast.classList.add('opacity-100', 'translate-y-0');
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => { toast.classList.add('hidden'); toast.style.background = ''; }, 300);
  }, 3500);
}

// --- Modal ---
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  if (id === 'creator-detail-modal') {
    document.getElementById('admin-detail-meta')?.classList.add('hidden');
  }
  if (id === 'campaign-modal') {
    const input = document.getElementById('camp-attachments');
    const list  = document.getElementById('camp-attachment-list');
    if (input) input.value = '';
    if (list)  list.innerHTML = '';
    const coverInput = document.getElementById('camp-cover');
    if (coverInput) coverInput.value = '';
    const coverPreview = document.getElementById('camp-cover-preview');
    if (coverPreview) coverPreview.innerHTML = `<svg class="w-6 h-6 text-white opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>`;
  }
}

// --- Render Creator Cards ---
// --- Time helper ---
function timeSince(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return 'recently';
  const secs = Math.floor((Date.now() - d) / 1000);
  if (secs < 60)    return 'just now';
  if (secs < 3600)  return Math.floor(secs/60) + ' min ago';
  if (secs < 86400) return Math.floor(secs/3600) + ' hr ago';
  return Math.floor(secs/86400) + ' day' + (Math.floor(secs/86400)>1?'s':'') + ' ago';
}

// Always format dates in UTC so timezone offsets never shift the displayed day
function fmtDateUTC(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr.slice(0, 10);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// --- Brand Fit Score ---
function calcBrandFitScore(creator) {
  let score = 0;
  // Followers (0-25 pts)
  const f = creator.total_followers || 0;
  if      (f >= 500000) score += 25;
  else if (f >= 100000) score += 20;
  else if (f >= 50000)  score += 15;
  else if (f >= 10000)  score += 10;
  else if (f >= 1000)   score += 5;
  // Engagement rate (0-25 pts)
  const eng = parseFloat(creator.engagement_rate) || 0;
  if      (eng >= 8)   score += 25;
  else if (eng >= 5)   score += 20;
  else if (eng >= 3)   score += 15;
  else if (eng >= 1.5) score += 10;
  else if (eng > 0)    score += 5;
  // Avg views (0-20 pts)
  const v = creator.avg_views || 0;
  if      (v >= 100000) score += 20;
  else if (v >= 50000)  score += 16;
  else if (v >= 10000)  score += 12;
  else if (v >= 5000)   score += 8;
  else if (v > 0)       score += 4;
  // Skills (0-15 pts)
  const skills = Array.isArray(creator.skills) ? creator.skills : [];
  score += Math.min(skills.length * 3, 15);
  // Profile completeness (0-15 pts)
  if (creator.bio)      score += 5;
  if (creator.location) score += 3;
  if (creator.niche)    score += 4;
  if (creator.rate_ig || creator.rate_tiktok || creator.rate_ugc) score += 3;
  return Math.min(score, 100);
}

function fitScoreMeta(score) {
  if (score >= 80) return { color: '#22c55e', bg: 'bg-green-50',  text: 'text-green-700',  label: 'Great match' };
  if (score >= 60) return { color: '#eab308', bg: 'bg-yellow-50', text: 'text-yellow-700', label: 'Good match' };
  if (score >= 40) return { color: '#f97316', bg: 'bg-orange-50', text: 'text-orange-700', label: 'Fair match' };
  return               { color: '#9ca3af', bg: 'bg-gray-50',   text: 'text-gray-500',   label: 'Low match' };
}

function fitScoreBadgeHtml(creator) {
  if (state.role !== 'brand') return '';
  const score = calcBrandFitScore(creator);
  const m = fitScoreMeta(score);
  const r = 20, circ = 2 * Math.PI * r;
  const dash = ((score / 100) * circ).toFixed(1);
  return `
    <div class="${m.bg} rounded-xl px-3 py-2.5 flex items-center gap-3 mt-3 border border-white">
      <div class="relative w-11 h-11 shrink-0">
        <svg class="w-11 h-11 -rotate-90" viewBox="0 0 48 48">
          <circle cx="24" cy="24" r="${r}" fill="none" stroke="#e5e7eb" stroke-width="4"/>
          <circle cx="24" cy="24" r="${r}" fill="none" stroke="${m.color}" stroke-width="4"
            stroke-dasharray="${dash} ${circ.toFixed(1)}" stroke-linecap="round"/>
        </svg>
        <div class="absolute inset-0 flex items-center justify-center">
          <span class="text-[10px] font-bold ${m.text}">${score}%</span>
        </div>
      </div>
      <div>
        <div class="text-xs font-bold ${m.text}">Brand Fit Score</div>
        <div class="text-xs ${m.text} opacity-80">${m.label}</div>
        <div class="text-[10px] text-gray-400 mt-0.5">Only visible to you</div>
      </div>
    </div>
  `;
}

// --- Brand Portal ---
let _brandPortalAllCampaigns = [];

async function renderBrandPortal() {
  const greeting = document.getElementById('brand-portal-greeting');
  if (greeting && state.currentUser) {
    const name = state.currentUser.company_name || state.currentUser.name || 'Brand';
    greeting.textContent = 'Welcome back, ' + name.split(' ')[0];
  }
  const grid    = document.getElementById('brand-portal-campaign-grid');
  const statsEl = document.getElementById('brand-portal-stats');
  if (!grid) return;

  try {
    // Fetch campaigns + brand profile (with ratings) in parallel
    const [campaigns, brandProfile] = await Promise.all([
      apiGet('/api/campaigns'),
      apiGet('/api/brand/profile').catch(() => null),
    ]);
    _brandPortalAllCampaigns = campaigns;

    // Stats row — 4 tiles (change grid to 4-col)
    if (statsEl) {
      statsEl.className = 'grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8';
      const active = campaigns.filter(c => (c.status || 'open') === 'open').length;
      const avgRating   = brandProfile?.avg_rating;
      const ratingCount = brandProfile?.rating_count || 0;
      statsEl.innerHTML = `
        <div class="bg-white rounded-2xl border border-gray-100 p-5">
          <div class="text-3xl font-bold text-gray-900">${campaigns.length}</div>
          <div class="text-sm text-gray-500 mt-1">Total Campaigns</div>
        </div>
        <div class="bg-white rounded-2xl border border-gray-100 p-5">
          <div class="text-3xl font-bold text-pickle-700">${active}</div>
          <div class="text-sm text-gray-500 mt-1">Active Campaigns</div>
        </div>
        <div class="bg-white rounded-2xl border border-gray-100 p-5">
          <div class="text-3xl font-bold text-brand-700">${campaigns.length - active}</div>
          <div class="text-sm text-gray-500 mt-1">Closed Campaigns</div>
        </div>
        <div class="bg-white rounded-2xl border border-gray-100 p-5">
          ${avgRating
            ? `<div class="text-2xl font-bold text-yellow-500 leading-none mb-1">${renderStars(avgRating)}</div>
               <div class="text-sm font-semibold text-gray-800">${avgRating} / 5</div>
               <div class="text-xs text-gray-400 mt-0.5">${ratingCount} creator rating${ratingCount !== 1 ? 's' : ''}</div>`
            : `<div class="text-2xl text-gray-200 leading-none mb-1">★★★★★</div>
               <div class="text-sm text-gray-400">No ratings yet</div>
               <div class="text-xs text-gray-300 mt-0.5">Complete deals to earn reviews</div>`}
        </div>
      `;
    }

    // Profile completion bar (top of portal)
    renderBrandCompletion(brandProfile);
    // Ratings from creators card (below the campaign grid, populated after grid renders)
    renderBrandPortalGrid(campaigns);
    renderBrandRatingsCard(brandProfile);
  } catch (err) {
    grid.innerHTML = `<div class="col-span-full text-center py-8 text-red-400">${err.message}</div>`;
  }
}

function renderBrandRatingsCard(brandProfile) {
  // Find or create the ratings card container (below the campaign grid)
  let card = document.getElementById('brand-portal-ratings-card');
  if (!card) {
    const grid = document.getElementById('brand-portal-campaign-grid');
    if (!grid) return;
    card = document.createElement('div');
    card.id = 'brand-portal-ratings-card';
    card.className = 'mt-8';
    grid.parentNode.insertBefore(card, grid.nextSibling);
  }

  const ratings = brandProfile?.recent_ratings || [];
  if (!ratings.length) { card.innerHTML = ''; return; }

  card.innerHTML = `
    <div class="bg-white rounded-2xl border border-gray-100 p-6">
      <h2 class="font-bold text-lg mb-1">Creator Reviews</h2>
      <p class="text-sm text-gray-500 mb-4">What creators say about working with you</p>
      <div class="divide-y divide-gray-50">
        ${ratings.map(r => `
          <div class="py-3 flex items-start justify-between gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <span class="font-medium text-sm">${escHtml(r.creator_name || 'Creator')}</span>
                <span class="text-xs text-gray-400">on "${escHtml(r.campaign_title || '')}"</span>
              </div>
              ${r.comment ? `<p class="text-sm text-gray-600 italic">"${escHtml(r.comment)}"</p>` : ''}
            </div>
            <div class="flex-shrink-0 text-right">
              <div>${renderStars(r.score)}</div>
              <div class="text-xs text-gray-400 mt-0.5">${fmtDateUTC(r.created_at)}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// --- Creator Dashboard ---
async function renderCreatorDashboard() {
  const statsEl = document.getElementById('creator-dash-stats');
  const dealsEl = document.getElementById('creator-dash-deals');
  const greetEl = document.getElementById('creator-dash-greeting');
  if (!statsEl || !dealsEl) return;

  if (greetEl && state.currentUser) {
    const first = (state.currentUser.name || 'Creator').split(' ')[0];
    greetEl.textContent = `Welcome back, ${first}`;
  }

  try {
    const [payments, deals] = await Promise.all([
      apiGet('/api/payments'),
      apiGet('/api/deals')
    ]);

    // Compute stats
    const totalEarned  = payments.filter(p => p.status === 'released').reduce((s, p) => s + (p.creator_payout || 0), 0);
    const pending      = payments.filter(p => p.status === 'held').reduce((s, p) => s + (p.creator_payout || 0), 0);
    const activeDeals  = deals.filter(d => d.status === 'active').length;

    statsEl.innerHTML = `
      <div class="bg-white rounded-2xl border border-gray-100 p-5">
        <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Total Earned</p>
        <p class="text-2xl font-bold text-gray-900">$${totalEarned.toLocaleString()}</p>
        <p class="text-xs text-gray-400 mt-1">After platform fee</p>
      </div>
      <div class="bg-white rounded-2xl border border-gray-100 p-5">
        <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">In Escrow</p>
        <p class="text-2xl font-bold text-yellow-600">$${pending.toLocaleString()}</p>
        <p class="text-xs text-gray-400 mt-1">Pending brand release</p>
      </div>
      <div class="bg-white rounded-2xl border border-gray-100 p-5">
        <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Active Deals</p>
        <p class="text-2xl font-bold text-pickle-600">${activeDeals}</p>
        <p class="text-xs text-gray-400 mt-1">Currently in progress</p>
      </div>
    `;

    if (deals.length === 0) {
      dealsEl.innerHTML = `
        <div class="flex flex-col items-center py-14 text-center text-gray-400">
          <svg class="w-10 h-10 mb-3 text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          <p class="font-medium text-gray-500 mb-1">No deals yet</p>
          <p class="text-sm">Browse campaigns and apply to start earning.</p>
          <button onclick="navigate('campaigns')" class="mt-4 bg-pickle-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-pickle-700 transition">Browse Campaigns</button>
        </div>`;
      return;
    }

    dealsEl.innerHTML = deals.map(d => {
      const payment    = payments.find(p => p.deal_id === d.id);
      const payout     = payment ? payment.creator_payout : Math.round((d.amount || 0) * 0.85);
      const payStatus  = payment ? payment.status : null;
      const statusColor = { pending:'bg-yellow-100 text-yellow-700', active:'bg-blue-100 text-blue-700', completed:'bg-green-100 text-green-700', declined:'bg-red-100 text-red-700' }[d.status] || 'bg-gray-100 text-gray-600';
      return `
        <div class="px-6 py-4 hover:bg-gray-50 transition cursor-pointer" onclick="openConversation(${d.id})">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <p class="font-semibold text-gray-900 truncate">${escHtml(d.campaign_title || d.title || 'Deal #' + d.id)}</p>
                <span class="tag ${statusColor} text-xs">${d.status.charAt(0).toUpperCase() + d.status.slice(1)}</span>
              </div>
              <p class="text-sm text-gray-500 mt-0.5">${escHtml(d.brand_name || 'Brand')} · ${fmtDateUTC(d.created_at)}</p>
              <div class="mt-2">${dealStepperMiniHtml(d)}</div>
            </div>
            <div class="text-right shrink-0">
              <p class="font-bold text-gray-900">$${payout.toLocaleString()}</p>
              <p class="text-xs mt-0.5 ${payStatus === 'released' ? 'text-green-600' : payStatus === 'held' ? 'text-yellow-600' : 'text-gray-400'}">
                ${payStatus === 'released' ? '✓ Paid' : payStatus === 'held' ? 'In escrow' : 'Awaiting payment'}
              </p>
            </div>
          </div>
        </div>`;
    }).join('');

  } catch (err) {
    statsEl.innerHTML = '';
    dealsEl.innerHTML = `<p class="p-6 text-red-500 text-sm">Could not load dashboard data.</p>`;
  }
}

function renderBrandPortalGrid(campaigns) {
  const grid = document.getElementById('brand-portal-campaign-grid');
  if (!grid) return;
  if (campaigns.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full flex flex-col items-center py-12 text-center">
        <div class="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mb-4">
          <svg class="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"/></svg>
        </div>
        <p class="text-gray-500 mb-4 text-sm">No campaigns yet</p>
        <button onclick="openModal('campaign-modal')" class="bg-pickle-700 text-white px-5 py-2.5 rounded-xl font-medium hover:bg-pickle-800 text-sm">Post Your First Campaign</button>
      </div>
    `;
    return;
  }
  grid.innerHTML = campaigns.map(c => {
    const isActive = (c.status || 'open') === 'open';
    const cover = c.cover_image || localStorage.getItem('camp_cover_' + c.id) || null;
    const initials = (c.title || 'C').slice(0, 2).toUpperCase();
    return `
      <div class="group rounded-2xl overflow-hidden border border-gray-100 cursor-pointer card-hover bg-white" onclick="navigate('campaigns')">
        <div class="relative" style="aspect-ratio:4/3">
          ${cover
            ? `<img src="${cover}" class="w-full h-full object-cover" alt="${c.title}">`
            : `<div class="w-full h-full bg-gradient-to-br from-pickle-400 to-brand-500 flex items-center justify-center">
                 <span class="text-white text-2xl font-bold opacity-60">${initials}</span>
               </div>`
          }
          <span class="absolute top-2 right-2 text-xs font-medium px-2 py-0.5 rounded-full ${isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}">${isActive ? 'Active' : 'Closed'}</span>
          <div class="absolute bottom-2 left-2 w-7 h-7 bg-white/90 backdrop-blur rounded-lg flex items-center justify-center shadow-sm">
            <svg class="w-3.5 h-3.5 text-brand-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"/></svg>
          </div>
        </div>
        <div class="p-3">
          <h3 class="font-semibold text-sm text-gray-900 truncate">${c.title}</h3>
          <p class="text-xs text-gray-400 mt-0.5">Last Modified: ${timeSince(c.created_at)}</p>
        </div>
      </div>
    `;
  }).join('');
}

function filterBrandPortal(filter, btn) {
  document.querySelectorAll('.portal-pill').forEach(p => {
    p.className = p.className.replace('bg-gray-900 text-white', 'bg-gray-100 text-gray-600');
  });
  if (btn) { btn.className = btn.className.replace('bg-gray-100 text-gray-600', 'bg-gray-900 text-white'); }
  let list = _brandPortalAllCampaigns;
  if (filter === 'active') list = list.filter(c => (c.status || 'open') === 'open');
  if (filter === 'closed') list = list.filter(c => c.status === 'closed');
  renderBrandPortalGrid(list);
}

// --- Cover photo preview ---
function previewCampCover(input) {
  if (!input.files[0]) return;
  const reader = new FileReader();
  reader.onload = e => {
    const preview = document.getElementById('camp-cover-preview');
    preview.innerHTML = `<img src="${e.target.result}" class="w-full h-full object-cover">`;
  };
  reader.readAsDataURL(input.files[0]);
}

function creatorSkeletonHtml() {
  return Array(6).fill(0).map(() => `
    <div class="bg-white rounded-2xl border border-gray-200 p-6">
      <div class="flex items-start gap-4 mb-4">
        <div class="skeleton w-14 h-14 rounded-full flex-shrink-0"></div>
        <div class="flex-1 min-w-0 pt-1">
          <div class="skeleton h-4 w-32 mb-2"></div>
          <div class="skeleton h-3 w-20"></div>
        </div>
      </div>
      <div class="skeleton h-3 w-full mb-2"></div>
      <div class="skeleton h-3 w-4/5 mb-4"></div>
      <div class="flex gap-2">
        <div class="skeleton h-6 w-16 rounded-full"></div>
        <div class="skeleton h-6 w-20 rounded-full"></div>
      </div>
    </div>`).join('');
}

// --- Deal Status Stepper ---
const _DEAL_STEPS = ['Proposed', 'Accepted', 'In Progress', 'Complete'];

function _dealCurrentStep(status) {
  if (status === 'pending')   return 0;
  if (status === 'active')    return 2;
  if (status === 'completed') return 3;
  return -1; // declined or unknown
}

// Full horizontal stepper — used in the chat header area
function dealStepperHtml(deal) {
  if (!deal) return '';
  const step = _dealCurrentStep(deal.status);

  if (step === -1) {
    return `<div class="flex items-center gap-2 text-sm text-red-500 py-0.5">
      <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
      </svg>
      <span class="font-medium">Deal Declined</span>
    </div>`;
  }

  const checkSvg = `<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>`;

  let html = `<div class="flex items-start w-full min-w-0">`;
  _DEAL_STEPS.forEach((label, i) => {
    const done    = i < step;
    const current = i === step;

    const circleCls = done
      ? 'bg-pickle-600 text-white border-2 border-pickle-600'
      : current
        ? 'bg-white text-pickle-700 border-2 border-pickle-600 ring-4 ring-pickle-100'
        : 'bg-white text-gray-300 border-2 border-gray-200';
    const labelCls = done    ? 'text-pickle-600 font-medium'
                   : current ? 'text-pickle-700 font-semibold'
                   :           'text-gray-400';

    html += `
      <div class="flex flex-col items-center flex-shrink-0" style="min-width:3rem">
        <div class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all ${circleCls}">
          ${done ? checkSvg : `<span>${i + 1}</span>`}
        </div>
        <span class="text-[11px] mt-1 text-center whitespace-nowrap ${labelCls}">${label}</span>
      </div>`;

    if (i < _DEAL_STEPS.length - 1) {
      const connCls = i < step ? 'bg-pickle-500' : 'bg-gray-200';
      html += `<div class="flex-1 h-0.5 ${connCls} mt-3.5 mx-0.5 min-w-0 transition-all"></div>`;
    }
  });
  html += `</div>`;

  // Amount pill + step label
  const amountStr = deal.amount ? `$${deal.amount.toLocaleString()} · ` : '';
  const stepLabel = _DEAL_STEPS[step] || '';
  html += `<div class="flex items-center justify-between mt-2">
    <span class="text-xs text-gray-400">${amountStr}Step ${step + 1} of ${_DEAL_STEPS.length}</span>
    <span class="text-xs font-semibold text-pickle-600">${stepLabel}</span>
  </div>`;

  return html;
}

// Compact mini stepper — 4 dots + labels for use in list rows
function dealStepperMiniHtml(status) {
  const step = _dealCurrentStep(status);
  if (step === -1) return `<span class="tag bg-red-100 text-red-600">Declined</span>`;

  const dots = _DEAL_STEPS.map((label, i) => {
    const cls = i < step  ? 'bg-pickle-600'
              : i === step ? 'bg-pickle-600 ring-2 ring-pickle-200'
              :              'bg-gray-200';
    return `<div class="w-2 h-2 rounded-full flex-shrink-0 ${cls}" title="${label}"></div>`;
  });

  const connectors = _DEAL_STEPS.slice(0, -1).map((_, i) =>
    `<div class="flex-1 h-0.5 max-w-[12px] ${i < step ? 'bg-pickle-500' : 'bg-gray-200'}"></div>`
  );

  // Interleave dots and connectors
  let inner = '';
  dots.forEach((d, i) => {
    inner += d;
    if (i < connectors.length) inner += connectors[i];
  });

  const label = _DEAL_STEPS[step] || '';
  const labelColor = status === 'completed' ? 'text-green-600' : status === 'active' ? 'text-yellow-700' : 'text-blue-600';
  return `<div class="flex items-center gap-0.5">${inner}</div><span class="text-xs font-medium ${labelColor} ml-1.5">${label}</span>`;
}

// --- Saved Creators ---
async function loadSavedCreatorIds() {
  if (!state.user || state.user.role !== 'brand') return;
  try {
    const ids = await apiGet('/api/saved-creators/ids');
    _savedCreatorIds = new Set(ids);
    _updateSavedCountBadge();
  } catch (_) {}
}

function _updateSavedCountBadge() {
  const badge = document.getElementById('saved-count-badge');
  if (!badge) return;
  const n = _savedCreatorIds.size;
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
}

async function toggleSaveCreator(creatorId) {
  if (!creatorId || !state.user || state.user.role !== 'brand') return;
  try {
    const { saved } = await apiPost(`/api/saved-creators/${creatorId}`, {});
    if (saved) _savedCreatorIds.add(creatorId);
    else        _savedCreatorIds.delete(creatorId);
    _updateSavedCountBadge();
    // Update every bookmark button for this creator currently in the DOM
    document.querySelectorAll(`[data-save-id="${creatorId}"]`).forEach(btn => {
      _applyBookmarkState(btn, saved);
    });
    // Update detail modal save button if open for this creator
    if (_detailCreatorId === creatorId) _syncDetailSaveBtn(saved);
    // If in saved tab and just un-saved, re-render to remove the card
    if (_creatorsTab === 'saved' && !saved) renderCreators();
  } catch (err) {
    showToast(err.message || 'Something went wrong', 'error');
  }
}

function _applyBookmarkState(btn, saved) {
  if (saved) {
    btn.classList.add('text-pickle-700', 'bg-pickle-50', 'border-pickle-300');
    btn.classList.remove('text-gray-400', 'border-gray-200', 'hover:text-pickle-600', 'hover:border-pickle-300');
  } else {
    btn.classList.remove('text-pickle-700', 'bg-pickle-50', 'border-pickle-300');
    btn.classList.add('text-gray-400', 'border-gray-200', 'hover:text-pickle-600', 'hover:border-pickle-300');
  }
  const path = btn.querySelector('path');
  if (path) path.setAttribute('fill', saved ? 'currentColor' : 'none');
  btn.title = saved ? 'Saved' : 'Save creator';
}

function bookmarkBtnHtml(creatorId) {
  if (!state.user || state.user.role !== 'brand') return '';
  const saved     = _savedCreatorIds.has(creatorId);
  const colorCls  = saved
    ? 'text-pickle-700 bg-pickle-50 border-pickle-300'
    : 'text-gray-400 border-gray-200 hover:text-pickle-600 hover:border-pickle-300';
  const fillAttr  = saved ? 'currentColor' : 'none';
  return `<button
    data-save-id="${creatorId}"
    onclick="event.stopPropagation();toggleSaveCreator(${creatorId})"
    title="${saved ? 'Saved' : 'Save creator'}"
    class="w-8 h-8 rounded-lg border flex items-center justify-center transition flex-shrink-0 ${colorCls}">
    <svg class="w-4 h-4 pointer-events-none" fill="${fillAttr}" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/>
    </svg>
  </button>`;
}

function _syncDetailSaveBtn(saved) {
  const btn   = document.getElementById('detail-save-btn');
  const icon  = document.getElementById('detail-save-icon');
  const label = document.getElementById('detail-save-label');
  if (!btn) return;
  if (saved) {
    btn.classList.add('bg-pickle-50', 'border-pickle-300', 'text-pickle-700');
    btn.classList.remove('border-gray-300', 'text-gray-600');
    if (icon)  icon.setAttribute('fill', 'currentColor');
    if (label) label.textContent = 'Saved';
  } else {
    btn.classList.remove('bg-pickle-50', 'border-pickle-300', 'text-pickle-700');
    btn.classList.add('border-gray-300', 'text-gray-600');
    if (icon)  icon.setAttribute('fill', 'none');
    if (label) label.textContent = 'Save';
  }
}

function switchCreatorsTab(tab) {
  _creatorsTab = tab;
  const allBtn   = document.getElementById('tab-all-creators');
  const savedBtn = document.getElementById('tab-saved-creators');
  const activeCls   = 'bg-pickle-600 text-white border-transparent';
  const inactiveCls = 'border border-gray-300 text-gray-600 bg-white hover:bg-gray-50';
  if (allBtn)   allBtn.className   = `px-4 py-1.5 rounded-full text-sm font-medium transition ${tab === 'all'   ? activeCls : inactiveCls}`;
  if (savedBtn) savedBtn.className = `px-4 py-1.5 rounded-full text-sm font-medium transition flex items-center gap-1.5 ${tab === 'saved' ? activeCls : inactiveCls}`;
  renderCreators();
}

// --- Verified Badge ---
function _updateVerifiedBadgeUI(handles) {
  // Show/hide the verified badge on the creator's own profile form
  const badge = document.getElementById('cp-verified-badge');
  if (!badge) return;
  const isVerified = Object.values(handles || {}).some(v => v && String(v).trim().length > 0);
  if (isVerified) {
    badge.classList.remove('hidden');
    badge.classList.add('inline-flex');
  } else {
    badge.classList.add('hidden');
    badge.classList.remove('inline-flex');
  }
}

function verifiedBadgeHtml(creator, size = 'sm') {
  const handles = (typeof creator.social_handles === 'object' && creator.social_handles !== null)
    ? creator.social_handles : {};
  const isVerified = Object.values(handles).some(v => v && String(v).trim().length > 0);
  if (!isVerified) return '';
  const sizeCls = size === 'lg'
    ? 'w-5 h-5 text-xs px-2 py-0.5'
    : 'w-4 h-4 text-[11px] px-1.5 py-0.5';
  return `<span class="inline-flex items-center gap-1 bg-pickle-100 text-pickle-700 font-semibold rounded-full leading-none ${sizeCls}" title="Verified creator — connected social account">
    <svg class="${size === 'lg' ? 'w-3.5 h-3.5' : 'w-3 h-3'}" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd"/></svg>
    Verified
  </span>`;
}

async function renderCreators() {
  const grid = document.getElementById('creator-grid');
  if (!grid) return;
  grid.innerHTML = creatorSkeletonHtml();

  try {
    const params = new URLSearchParams();
    const niche = document.getElementById('filter-niche')?.value;
    const skill = document.getElementById('filter-skill')?.value;
    if (niche) params.set('niche', niche);
    if (skill) params.set('skill', skill);

    let creators = await apiGet('/api/creators?' + params.toString());

    // Client-side filters
    const search     = document.getElementById('filter-search')?.value.toLowerCase().trim() || '';
    const platform   = document.getElementById('filter-platform')?.value || '';
    const audience   = document.getElementById('filter-audience')?.value || '';
    const engagement = document.getElementById('filter-engagement')?.value || '';
    const rate       = document.getElementById('filter-rate')?.value || '';

    if (search) {
      creators = creators.filter(c =>
        (c.name     || '').toLowerCase().includes(search) ||
        (c.bio      || '').toLowerCase().includes(search) ||
        (c.location || '').toLowerCase().includes(search)
      );
    }
    if (platform) {
      creators = creators.filter(c => {
        const handles  = (typeof c.social_handles === 'object' && c.social_handles) ? c.social_handles : {};
        if (platform === 'instagram') return (c.followers_ig || 0) > 0 || !!(handles.instagram);
        if (platform === 'tiktok')    return (c.followers_tt || 0) > 0 || !!(handles.tiktok);
        if (platform === 'youtube')   return (c.followers_yt || 0) > 0 || !!(handles.youtube);
        return true;
      });
    }
    if (audience) {
      creators = creators.filter(c => {
        const t = c.total_followers || 0;
        if (audience === 'nano')   return t < 1000;
        if (audience === 'micro')  return t >= 1000  && t < 10000;
        if (audience === 'mid')    return t >= 10000 && t < 50000;
        if (audience === 'macro')  return t >= 50000 && t < 200000;
        if (audience === 'mega')   return t >= 200000;
        return true;
      });
    }
    if (engagement) {
      creators = creators.filter(c => {
        const e = c.engagement_rate || 0;
        if (engagement === 'low')    return e > 0  && e < 2;
        if (engagement === 'medium') return e >= 2 && e < 5;
        if (engagement === 'high')   return e >= 5 && e < 10;
        if (engagement === 'viral')  return e >= 10;
        return true;
      });
    }
    if (rate) {
      creators = creators.filter(c => {
        const r = Math.min(c.rate_ig || 9999, c.rate_tiktok || 9999, c.rate_ugc || 9999);
        if (rate === 'budget')  return r < 500;
        if (rate === 'mid')     return r >= 500  && r <= 2000;
        if (rate === 'premium') return r >= 2000 && r <= 5000;
        if (rate === 'elite')   return r >= 5000;
        return true;
      });
    }

    // Saved tab: fetch from API when in saved view, otherwise filter in memory
    if (_creatorsTab === 'saved') {
      creators = creators.filter(c => _savedCreatorIds.has(c.user_id));
    }

    // Show/hide clear button and results count
    const anyFilter = search || platform || audience || engagement || rate || niche || skill || _creatorsTab === 'saved';
    const clearBtn  = document.getElementById('filter-clear-btn');
    const resultsBar = document.getElementById('creator-results-bar');
    const resultsCount = document.getElementById('creator-results-count');
    if (clearBtn) clearBtn.classList.toggle('hidden', !anyFilter);
    if (resultsBar) resultsBar.classList.toggle('hidden', !anyFilter);
    if (resultsCount && anyFilter) {
      resultsCount.textContent = `${creators.length} creator${creators.length !== 1 ? 's' : ''} found`;
    }

    if (creators.length === 0) {
      const emptySaved = _creatorsTab === 'saved';
      grid.innerHTML = `
        <div class="col-span-full flex flex-col items-center py-16 text-center">
          <div class="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mb-4">
            ${emptySaved
              ? `<svg class="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>`
              : `<svg class="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`}
          </div>
          <p class="font-semibold text-gray-700 mb-1">${emptySaved ? 'No saved creators yet' : 'No creators found'}</p>
          <p class="text-gray-400 text-sm">${emptySaved ? 'Bookmark creators to save them here for quick access.' : 'Try adjusting your filters to see more results.'}</p>
          ${emptySaved ? `<button onclick="switchCreatorsTab('all')" class="mt-4 text-sm text-pickle-600 hover:underline font-medium">Browse all creators →</button>` : ''}
        </div>`;
      return;
    }

    grid.innerHTML = creators.map(c => {
      const initials   = c.initials || (c.name || 'CC').slice(0, 2).toUpperCase();
      const minRate    = Math.min(c.rate_ig || 0, c.rate_tiktok || 0, c.rate_ugc || 0) || '—';
      const skills     = Array.isArray(c.skills) ? c.skills : [];
      return `
        <div class="bg-white rounded-2xl border border-gray-200 overflow-hidden card-hover cursor-pointer" onclick="showCreatorDetail(${c.user_id})">
          <div class="p-6">
            <div class="flex items-center gap-4 mb-4">
              <div class="w-14 h-14 rounded-2xl bg-pickle-100 flex items-center justify-center text-xl font-bold text-pickle-700">${initials}</div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <h3 class="font-bold text-lg">${c.name || 'Creator'}</h3>
                  ${verifiedBadgeHtml(c)}
                </div>
                <p class="text-gray-500 text-sm">${c.location || ''}</p>
              </div>
              <div class="flex items-center gap-2 flex-shrink-0">
                <span class="tag bg-pickle-100 text-pickle-700">${c.niche || 'Creator'}</span>
                ${bookmarkBtnHtml(c.user_id)}
              </div>
            </div>
            <p class="text-gray-600 text-sm mb-4 line-clamp-2">${c.bio || ''}</p>
            <div class="grid grid-cols-3 gap-3 mb-4">
              <div class="text-center p-2 bg-gray-50 rounded-lg">
                <div class="font-bold text-pickle-700">${fmtNum(c.total_followers)}</div>
                <div class="text-xs text-gray-500">Followers</div>
              </div>
              <div class="text-center p-2 bg-gray-50 rounded-lg">
                <div class="font-bold text-pickle-700">${c.engagement_rate || 0}%</div>
                <div class="text-xs text-gray-500">Engagement</div>
              </div>
              <div class="text-center p-2 bg-gray-50 rounded-lg">
                <div class="font-bold text-pickle-700">${fmtNum(c.avg_views)}</div>
                <div class="text-xs text-gray-500">Avg Views</div>
              </div>
            </div>
            <div class="flex flex-wrap gap-1 mb-4">
              ${skills.map(s => `<span class="tag bg-gray-100 text-gray-600">${s}</span>`).join('')}
            </div>
            ${fitScoreBadgeHtml(c)}
            <div class="flex items-center justify-between pt-3 border-t border-gray-100 mt-3">
              <span class="text-sm text-gray-500">From <span class="font-semibold text-gray-900">${minRate !== '—' ? '$' + minRate : '—'}</span>/post</span>
              <span class="text-sm font-medium text-pickle-600 hover:text-pickle-700">View Profile →</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    grid.innerHTML = `<div class="col-span-full text-center py-16 text-red-400">${err.message}</div>`;
  }
}

function filterCreators() { renderCreators(); }

function clearCreatorFilters() {
  ['filter-search','filter-niche','filter-platform','filter-audience','filter-engagement','filter-rate']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  renderCreators();
}

// --- Creator Detail ---
// --- Admin: view any user's profile ---
async function adminViewUser(userId) {
  const u = _adminUsers.find(u => u.id === userId);
  if (!u) return;

  // Populate admin meta strip
  const metaEl   = document.getElementById('admin-detail-meta');
  const emailEl  = document.getElementById('admin-detail-email');
  const joinedEl = document.getElementById('admin-detail-joined');
  const idEl     = document.getElementById('admin-detail-id');
  if (metaEl)   metaEl.classList.remove('hidden');
  if (emailEl)  emailEl.textContent  = u.email;
  if (joinedEl) joinedEl.textContent = fmtDateUTC(u.created_at);
  if (idEl)     idEl.textContent     = u.id;

  const msgBtn = document.getElementById('detail-message-btn');

  if (u.role === 'creator') {
    if (msgBtn) { msgBtn.textContent = 'Message Creator'; msgBtn.classList.remove('hidden'); }

    // Set up modal with loading state
    const avatarEl = document.getElementById('detail-avatar');
    if (avatarEl) {
      avatarEl.textContent = (u.name || 'C').slice(0,2).toUpperCase();
      avatarEl.className = 'w-16 h-16 rounded-2xl bg-pickle-100 flex items-center justify-center text-2xl font-bold text-pickle-700';
    }
    document.getElementById('detail-name').textContent     = u.name || 'Creator';
    document.getElementById('detail-location').textContent = u.niche || '';
    document.getElementById('detail-content').innerHTML    = '<div class="text-center py-6 text-gray-400">Loading profile…</div>';
    openModal('creator-detail-modal');

    // Inject admin meta right away
    if (metaEl)   metaEl.classList.remove('hidden');
    if (emailEl)  emailEl.textContent  = u.email;
    if (joinedEl) joinedEl.textContent = fmtDateUTC(u.created_at);
    if (idEl)     idEl.textContent     = u.id;

    try {
      const c = await apiGet('/api/creators/' + userId);
      state.selectedCreator = c;
      const skills = Array.isArray(c.skills) ? c.skills : [];
      document.getElementById('detail-avatar').textContent = c.initials || (c.name||'CC').slice(0,2).toUpperCase();
      document.getElementById('detail-name').innerHTML =
        escHtml(c.name || u.name) + ' ' + verifiedBadgeHtml(c, 'lg');
      document.getElementById('detail-location').textContent = [c.location, c.niche, c.skill_level].filter(Boolean).join(' · ');
      document.getElementById('detail-content').innerHTML = `
        <p class="text-gray-600 mb-6">${c.bio || '<span class="text-gray-400 italic">No bio added yet.</span>'}</p>
        <h3 class="font-bold mb-3">Creator Skills</h3>
        <div class="flex flex-wrap gap-1 mb-6">${skills.length ? skills.map(s=>`<span class="tag bg-pickle-100 text-pickle-700">${s}</span>`).join('') : '<span class="text-gray-400 text-sm">No skills listed</span>'}</div>
        <h3 class="font-bold mb-3">Audience Stats</h3>
        <div class="grid grid-cols-3 gap-3 mb-6">
          <div class="text-center p-3 bg-gray-50 rounded-xl"><div class="text-xs text-gray-500 mb-1">Instagram</div><div class="font-bold text-lg">${fmtNum(c.followers_ig)}</div></div>
          <div class="text-center p-3 bg-gray-50 rounded-xl"><div class="text-xs text-gray-500 mb-1">TikTok</div><div class="font-bold text-lg">${fmtNum(c.followers_tt)}</div></div>
          <div class="text-center p-3 bg-gray-50 rounded-xl"><div class="text-xs text-gray-500 mb-1">YouTube</div><div class="font-bold text-lg">${fmtNum(c.followers_yt)}</div></div>
          <div class="text-center p-3 bg-gray-50 rounded-xl"><div class="text-xs text-gray-500 mb-1">Engagement</div><div class="font-bold text-lg">${c.engagement_rate||0}%</div></div>
          <div class="text-center p-3 bg-gray-50 rounded-xl"><div class="text-xs text-gray-500 mb-1">Avg Views</div><div class="font-bold text-lg">${fmtNum(c.avg_views)}</div></div>
          <div class="text-center p-3 bg-gray-50 rounded-xl"><div class="text-xs text-gray-500 mb-1">Total</div><div class="font-bold text-lg">${fmtNum(c.total_followers)}</div></div>
        </div>
        <h3 class="font-bold mb-3">Demographics</h3>
        <div class="grid grid-cols-2 gap-3 mb-6">
          <div class="p-3 bg-gray-50 rounded-xl"><div class="text-xs text-gray-500 mb-1">Primary Age</div><div class="font-semibold">${c.demo_age||'—'}</div></div>
          <div class="p-3 bg-gray-50 rounded-xl"><div class="text-xs text-gray-500 mb-1">Gender Split</div><div class="font-semibold">${c.demo_gender||'—'}</div></div>
          <div class="p-3 bg-gray-50 rounded-xl col-span-2"><div class="text-xs text-gray-500 mb-1">Top Locations</div><div class="font-semibold">${c.demo_locations||'—'}</div></div>
          <div class="p-3 bg-gray-50 rounded-xl col-span-2"><div class="text-xs text-gray-500 mb-1">Audience Interests</div><div class="font-semibold">${c.demo_interests||'—'}</div></div>
        </div>
        <h3 class="font-bold mb-3">Rates</h3>
        <div class="grid grid-cols-2 gap-3 mb-3">
          <div class="p-3 bg-pickle-50 rounded-xl"><div class="text-xs text-gray-500 mb-1">Instagram Post/Reel</div><div class="font-bold text-pickle-700">${c.rate_ig?'$'+c.rate_ig.toLocaleString():'—'}</div></div>
          <div class="p-3 bg-pickle-50 rounded-xl"><div class="text-xs text-gray-500 mb-1">TikTok</div><div class="font-bold text-pickle-700">${c.rate_tiktok?'$'+c.rate_tiktok.toLocaleString():'—'}</div></div>
          <div class="p-3 bg-pickle-50 rounded-xl"><div class="text-xs text-gray-500 mb-1">YouTube Video</div><div class="font-bold text-pickle-700">${c.rate_yt?'$'+c.rate_yt.toLocaleString():'—'}</div></div>
          <div class="p-3 bg-pickle-50 rounded-xl"><div class="text-xs text-gray-500 mb-1">UGC (per piece)</div><div class="font-bold text-pickle-700">${c.rate_ugc?'$'+c.rate_ugc.toLocaleString():'—'}</div></div>
        </div>
        ${c.rate_notes?`<p class="text-sm text-gray-500 italic mb-6">${c.rate_notes}</p>`:''}
      `;
    } catch (err) {
      // Profile not filled out yet — show what we know from the admin user record
      document.getElementById('detail-content').innerHTML = `
        <div class="bg-yellow-50 border border-yellow-200 rounded-xl px-4 py-3 mb-4 text-sm text-yellow-700">
          ⚠ This creator hasn't completed their profile yet.
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="p-3 bg-gray-50 rounded-xl col-span-2"><div class="text-xs text-gray-500 mb-1">Niche</div><div class="font-semibold">${escHtml(u.niche||'—')}</div></div>
          ${u.followers_ig ? `<div class="p-3 bg-gray-50 rounded-xl"><div class="text-xs text-gray-500 mb-1">Instagram</div><div class="font-bold">${fmtNum(u.followers_ig)}</div></div>` : ''}
          ${u.followers_tt ? `<div class="p-3 bg-gray-50 rounded-xl"><div class="text-xs text-gray-500 mb-1">TikTok</div><div class="font-bold">${fmtNum(u.followers_tt)}</div></div>` : ''}
        </div>
      `;
    }
  } else {
    // Brand profile view
    if (msgBtn) { msgBtn.textContent = 'Message Brand'; msgBtn.classList.remove('hidden'); }
    const modal = document.getElementById('creator-detail-modal');
    if (!modal) return;
    const initials = (u.name || 'B').slice(0, 2).toUpperCase();
    const avatarEl = document.getElementById('detail-avatar');
    if (avatarEl) {
      avatarEl.textContent = initials;
      avatarEl.className = 'w-16 h-16 rounded-2xl bg-brand-100 flex items-center justify-center text-2xl font-bold text-brand-700';
    }
    document.getElementById('detail-name').textContent     = u.name || 'Brand';
    document.getElementById('detail-location').textContent = u.company_name || '';
    document.getElementById('detail-content').innerHTML = `
      <div class="grid grid-cols-2 gap-3 mb-6">
        <div class="p-3 bg-gray-50 rounded-xl col-span-2">
          <div class="text-xs text-gray-500 mb-1">Company Name</div>
          <div class="font-semibold">${escHtml(u.company_name || '—')}</div>
        </div>
        <div class="p-3 bg-gray-50 rounded-xl">
          <div class="text-xs text-gray-500 mb-1">Industry / Niche</div>
          <div class="font-semibold">${escHtml(u.niche || '—')}</div>
        </div>
        <div class="p-3 bg-gray-50 rounded-xl">
          <div class="text-xs text-gray-500 mb-1">Website</div>
          <div class="font-semibold">${u.website ? `<a href="${escHtml(u.website)}" target="_blank" class="text-pickle-600 hover:underline">${escHtml(u.website)}</a>` : '—'}</div>
        </div>
        <div class="p-3 bg-gray-50 rounded-xl col-span-2">
          <div class="text-xs text-gray-500 mb-1">Bio / About</div>
          <div class="font-semibold">${escHtml(u.bio || '—')}</div>
        </div>
      </div>
    `;
    state.selectedCreator = u;
    openModal('creator-detail-modal');
  }
}

async function showCreatorDetail(userId) {
  const modal = document.getElementById('creator-detail-modal');
  if (!modal) return;
  _detailCreatorId = userId;
  // Show loading state inside modal first
  document.getElementById('detail-name').textContent = 'Loading…';
  document.getElementById('detail-location').textContent = '';
  document.getElementById('detail-content').innerHTML = '';
  // Hide save button during load
  const saveBtnEl = document.getElementById('detail-save-btn');
  if (saveBtnEl) saveBtnEl.classList.add('hidden');
  openModal('creator-detail-modal');

  try {
    const c = await apiGet('/api/creators/' + userId);
    state.selectedCreator = c;

    const initials = c.initials || (c.name || 'CC').slice(0, 2).toUpperCase();
    const skills   = Array.isArray(c.skills) ? c.skills : [];

    document.getElementById('detail-avatar').textContent = initials;
    document.getElementById('detail-name').innerHTML =
      escHtml(c.name || 'Creator') + ' ' + verifiedBadgeHtml(c, 'lg');
    document.getElementById('detail-location').textContent =
      [c.location, c.niche, c.skill_level].filter(Boolean).join(' · ');

    // Show save button for brands
    if (saveBtnEl && state.user?.role === 'brand') {
      saveBtnEl.classList.remove('hidden');
      saveBtnEl.classList.add('inline-flex');
      _syncDetailSaveBtn(_savedCreatorIds.has(c.user_id));
    }

    document.getElementById('detail-content').innerHTML = `
      <p class="text-gray-600 mb-6">${c.bio || ''}</p>

      <h3 class="font-bold mb-3">Creator Skills</h3>
      <div class="flex flex-wrap gap-1 mb-6">
        ${skills.map(s => `<span class="tag bg-pickle-100 text-pickle-700">${s}</span>`).join('')}
      </div>

      <h3 class="font-bold mb-3">Audience Stats</h3>
      <div class="grid grid-cols-3 gap-3 mb-6">
        <div class="text-center p-3 bg-gray-50 rounded-xl">
          <div class="text-xs text-gray-500 mb-1">Instagram</div>
          <div class="font-bold text-lg">${fmtNum(c.followers_ig)}</div>
        </div>
        <div class="text-center p-3 bg-gray-50 rounded-xl">
          <div class="text-xs text-gray-500 mb-1">TikTok</div>
          <div class="font-bold text-lg">${fmtNum(c.followers_tt)}</div>
        </div>
        <div class="text-center p-3 bg-gray-50 rounded-xl">
          <div class="text-xs text-gray-500 mb-1">YouTube</div>
          <div class="font-bold text-lg">${fmtNum(c.followers_yt)}</div>
        </div>
        <div class="text-center p-3 bg-gray-50 rounded-xl">
          <div class="text-xs text-gray-500 mb-1">Engagement</div>
          <div class="font-bold text-lg">${c.engagement_rate || 0}%</div>
        </div>
        <div class="text-center p-3 bg-gray-50 rounded-xl">
          <div class="text-xs text-gray-500 mb-1">Avg Views</div>
          <div class="font-bold text-lg">${fmtNum(c.avg_views)}</div>
        </div>
        <div class="text-center p-3 bg-gray-50 rounded-xl">
          <div class="text-xs text-gray-500 mb-1">Total</div>
          <div class="font-bold text-lg">${fmtNum(c.total_followers)}</div>
        </div>
      </div>

      <h3 class="font-bold mb-3">Demographics</h3>
      <div class="grid grid-cols-2 gap-3 mb-6">
        <div class="p-3 bg-gray-50 rounded-xl">
          <div class="text-xs text-gray-500 mb-1">Primary Age</div>
          <div class="font-semibold">${c.demo_age || '—'}</div>
        </div>
        <div class="p-3 bg-gray-50 rounded-xl">
          <div class="text-xs text-gray-500 mb-1">Gender Split</div>
          <div class="font-semibold">${c.demo_gender || '—'}</div>
        </div>
        <div class="p-3 bg-gray-50 rounded-xl col-span-2">
          <div class="text-xs text-gray-500 mb-1">Top Locations</div>
          <div class="font-semibold">${c.demo_locations || '—'}</div>
        </div>
        <div class="p-3 bg-gray-50 rounded-xl col-span-2">
          <div class="text-xs text-gray-500 mb-1">Audience Interests</div>
          <div class="font-semibold">${c.demo_interests || '—'}</div>
        </div>
      </div>

      <h3 class="font-bold mb-3">Rates</h3>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div class="p-3 bg-pickle-50 rounded-xl">
          <div class="text-xs text-gray-500 mb-1">Instagram Post/Reel</div>
          <div class="font-bold text-pickle-700">${c.rate_ig ? '$' + c.rate_ig.toLocaleString() : '—'}</div>
        </div>
        <div class="p-3 bg-pickle-50 rounded-xl">
          <div class="text-xs text-gray-500 mb-1">TikTok</div>
          <div class="font-bold text-pickle-700">${c.rate_tiktok ? '$' + c.rate_tiktok.toLocaleString() : '—'}</div>
        </div>
        <div class="p-3 bg-pickle-50 rounded-xl">
          <div class="text-xs text-gray-500 mb-1">YouTube Video</div>
          <div class="font-bold text-pickle-700">${c.rate_yt ? '$' + c.rate_yt.toLocaleString() : '—'}</div>
        </div>
        <div class="p-3 bg-pickle-50 rounded-xl">
          <div class="text-xs text-gray-500 mb-1">UGC (per piece)</div>
          <div class="font-bold text-pickle-700">${c.rate_ugc ? '$' + c.rate_ugc.toLocaleString() : '—'}</div>
        </div>
      </div>
      ${c.rate_notes ? `<p class="text-sm text-gray-500 italic mb-4">${c.rate_notes}</p>` : ''}

      <h3 class="font-bold mb-3">Track Record</h3>
      <div class="grid grid-cols-2 gap-3 mb-4">
        <div class="p-3 bg-gray-50 rounded-xl text-center">
          <div class="text-xs text-gray-500 mb-1">Deals Completed</div>
          <div class="font-bold text-2xl text-pickle-700">${c.deals_completed || 0}</div>
        </div>
        <div class="p-3 bg-gray-50 rounded-xl text-center">
          <div class="text-xs text-gray-500 mb-1">Avg Rating</div>
          <div class="font-bold text-lg mt-0.5">
            ${c.avg_rating
              ? renderStars(c.avg_rating) + `<span class="text-sm font-normal text-gray-500 ml-1">${c.avg_rating} (${c.rating_count})</span>`
              : '<span class="text-sm text-gray-400 font-normal">No ratings yet</span>'}
          </div>
        </div>
      </div>

      ${(c.deal_history && c.deal_history.length) ? `
        <h3 class="font-bold mb-3">Past Brand Partners</h3>
        <div class="border border-gray-100 rounded-xl overflow-hidden mb-2">
          ${c.deal_history.map(h => `
            <div class="flex items-center justify-between px-4 py-3 border-b border-gray-50 last:border-0 hover:bg-gray-50 transition">
              <div class="min-w-0 mr-3">
                <div class="font-medium text-sm truncate">${escHtml(h.brand_name || 'Brand')}</div>
                <div class="text-xs text-gray-500 truncate">${escHtml(h.campaign_title || '')}</div>
              </div>
              <div class="text-right flex-shrink-0">
                <div class="font-semibold text-pickle-700 text-sm">$${(h.amount || 0).toLocaleString()}</div>
                ${h.brand_rating ? `<div class="text-xs mt-0.5">${renderStars(h.brand_rating)}</div>` : '<div class="text-xs text-gray-300">—</div>'}
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}
    `;
  } catch (err) {
    document.getElementById('detail-content').innerHTML =
      `<p class="text-red-500">${err.message}</p>`;
  }
}

// --- Save Creator Profile ---
async function saveCreatorProfile(e) {
  e.preventDefault();
  const skills = Array.from(document.querySelectorAll('#cp-skills input:checked')).map(i => i.value);
  const body = {
    name:            document.getElementById('cp-name').value,
    location:        document.getElementById('cp-location').value,
    bio:             document.getElementById('cp-bio').value,
    niche:           document.getElementById('cp-niche').value,
    skill_level:     document.getElementById('cp-skill-level').value,
    skills,
    followers_ig:    parseInt(document.getElementById('cp-ig').value)         || 0,
    followers_tt:    parseInt(document.getElementById('cp-tiktok').value)     || 0,
    followers_yt:    parseInt(document.getElementById('cp-yt').value)         || 0,
    engagement_rate: parseFloat(document.getElementById('cp-engagement').value) || 0,
    avg_views:       parseInt(document.getElementById('cp-views').value)      || 0,
    demo_age:        document.getElementById('cp-age').value,
    demo_gender:     document.getElementById('cp-gender').value,
    demo_locations:  document.getElementById('cp-locations').value,
    demo_interests:  document.getElementById('cp-interests').value,
    rate_ig:         parseInt(document.getElementById('cp-rate-ig').value)    || 0,
    rate_tiktok:     parseInt(document.getElementById('cp-rate-tiktok').value) || 0,
    rate_yt:         parseInt(document.getElementById('cp-rate-yt').value)    || 0,
    rate_ugc:        parseInt(document.getElementById('cp-rate-ugc').value)   || 0,
    rate_notes:      document.getElementById('cp-rate-notes').value,
  };
  // Social handles — build dict, skip blanks
  const _ig = (document.getElementById('cp-handle-ig')?.value || '').trim().replace(/^@/, '');
  const _tt = (document.getElementById('cp-handle-tt')?.value || '').trim().replace(/^@/, '');
  const _yt = (document.getElementById('cp-handle-yt')?.value || '').trim().replace(/^@/, '');
  const handles = {};
  if (_ig) handles.instagram = _ig;
  if (_tt) handles.tiktok    = _tt;
  if (_yt) handles.youtube   = _yt;
  body.social_handles = handles;
  try {
    const saved = await apiPut('/api/creator/profile', body);
    // Attach parsed handles back for the completion bar
    saved.social_handles = handles;
    showToast('Profile saved!', 'success');
    _updateVerifiedBadgeUI(handles);
    renderCreatorCompletion(saved);
    setTimeout(() => navigate('creator-dashboard', 'nav-dashboard-btn'), 1000);
  } catch (err) {
    showToast(err.message || 'Something went wrong', 'error');
  }
}

// --- Render Campaigns ---
function campaignSkeletonHtml() {
  return Array(4).fill(0).map(() => `
    <div class="bg-white rounded-2xl border border-gray-200 p-6">
      <div class="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-4">
        <div class="flex-1">
          <div class="flex items-center gap-3 mb-2">
            <div class="skeleton h-5 w-48"></div>
            <div class="skeleton h-5 w-16 rounded-full"></div>
          </div>
          <div class="skeleton h-4 w-28"></div>
        </div>
        <div class="flex gap-4">
          <div class="skeleton h-4 w-20"></div>
          <div class="skeleton h-4 w-24"></div>
        </div>
      </div>
      <div class="skeleton h-3 w-full mb-2"></div>
      <div class="skeleton h-3 w-3/4 mb-4"></div>
      <div class="flex gap-2">
        <div class="skeleton h-6 w-16 rounded-full"></div>
        <div class="skeleton h-6 w-20 rounded-full"></div>
        <div class="skeleton h-6 w-14 rounded-full"></div>
      </div>
    </div>`).join('');
}

async function renderCampaigns() {
  const list = document.getElementById('campaign-list');
  if (!list) return;

  // Render post button only for brands
  const postBtnWrap = document.getElementById('post-campaign-btn-wrap');
  if (postBtnWrap) {
    postBtnWrap.innerHTML = state.role === 'brand'
      ? `<button onclick="openModal('campaign-modal')" id="post-campaign-btn" class="bg-brand-600 text-white px-5 py-2.5 rounded-xl font-medium hover:bg-brand-700 transition whitespace-nowrap">+ Post Campaign Brief</button>`
      : '';
  }

  list.innerHTML = campaignSkeletonHtml();

  try {
    const campaigns = await apiGet('/api/campaigns');

    if (campaigns.length === 0) {
      list.innerHTML = state.role === 'brand'
        ? `<div class="flex flex-col items-center py-16 text-center">
             <div class="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center mb-4">
               <svg class="w-8 h-8 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"/></svg>
             </div>
             <p class="font-semibold text-gray-700 mb-1">No campaigns yet</p>
             <p class="text-gray-400 text-sm mb-5">Post your first campaign brief to start getting matched with creators.</p>
             <button onclick="openModal('campaign-modal')" class="bg-brand-600 text-white px-5 py-2.5 rounded-xl font-medium hover:bg-brand-700 transition text-sm">Post Your First Campaign</button>
           </div>`
        : `<div class="flex flex-col items-center py-16 text-center">
             <div class="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mb-4">
               <svg class="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"/></svg>
             </div>
             <p class="font-semibold text-gray-700 mb-1">No campaigns posted yet</p>
             <p class="text-gray-400 text-sm">Brand campaigns will appear here. Check back soon!</p>
           </div>`;
      return;
    }

    list.innerHTML = campaigns.map(c => {
      const skills     = Array.isArray(c.skills) ? c.skills : [];
      const brandLabel = c.company_name || c.brand_name || 'Brand';
      const budget     = c.budget || (c.budget_min && c.budget_max ? `$${c.budget_min.toLocaleString()} – $${c.budget_max.toLocaleString()}` : '—');
      const postedDate = c.created_at ? c.created_at.split('T')[0] : '';
      const isActive   = (c.status || 'open') === 'open';
      return `
        <div class="bg-white rounded-2xl border border-gray-200 p-6 card-hover">
          <div class="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-4">
            <div>
              <div class="flex items-center gap-3 mb-2">
                <h2 class="text-xl font-bold">${c.title}</h2>
                <span class="tag ${isActive ? 'bg-pickle-100 text-pickle-700' : 'bg-gray-100 text-gray-600'}">${isActive ? 'Active' : 'Closed'}</span>
              </div>
              <p class="text-brand-600 font-medium">${brandLabel}</p>
            </div>
            <div class="flex items-center gap-4 text-sm text-gray-500">
              <span>Budget: <strong class="text-gray-900">${budget}</strong></span>
              ${c.deadline ? `<span>Deadline: <strong class="text-gray-900">${c.deadline}</strong></span>` : ''}
            </div>
          </div>
          <p class="text-gray-600 mb-4">${c.description || ''}</p>
          <div class="flex flex-wrap items-center gap-2 mb-4">
            ${c.niche ? `<span class="tag bg-brand-100 text-brand-700">${c.niche}</span>` : ''}
            ${skills.map(s => `<span class="tag bg-gray-100 text-gray-600">${s}</span>`).join('')}
          </div>
          <div class="flex items-center justify-between pt-4 border-t border-gray-100">
            <span class="text-sm text-gray-400">${postedDate ? 'Posted ' + postedDate : ''}</span>
            <button onclick="applyCampaign(${c.id})" class="bg-pickle-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-pickle-700 transition">
              ${state.role === 'creator' ? 'Apply Now' : 'View Applicants'}
            </button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="text-center py-16 text-red-400">${err.message}</div>`;
  }
}

function applyCampaign(id) {
  if (state.role === 'creator') {
    showToast('Application sent! The brand will be in touch.');
  } else {
    showToast('Applicant view coming soon.');
  }
}

// --- Campaign Attachments Preview ---
function renderCampAttachments() {
  const input = document.getElementById('camp-attachments');
  const list  = document.getElementById('camp-attachment-list');
  if (!input || !list) return;
  list.innerHTML = Array.from(input.files).map((f, i) => `
    <li class="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm">
      <div class="flex items-center gap-2 min-w-0">
        <svg class="w-4 h-4 text-brand-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/></svg>
        <span class="truncate text-gray-700">${f.name}</span>
        <span class="text-gray-400 shrink-0">${(f.size / 1024 / 1024).toFixed(1)} MB</span>
      </div>
      <button type="button" onclick="removeCampAttachment(${i})" class="text-gray-400 hover:text-red-500 ml-2 shrink-0">&times;</button>
    </li>
  `).join('');
}

function removeCampAttachment(index) {
  const input = document.getElementById('camp-attachments');
  const dt = new DataTransfer();
  Array.from(input.files).forEach((f, i) => { if (i !== index) dt.items.add(f); });
  input.files = dt.files;
  renderCampAttachments();
}

// --- Post Campaign ---
async function postCampaign(e) {
  e.preventDefault();
  const skills = Array.from(document.querySelectorAll('#camp-skills input:checked')).map(i => i.value);
  const coverInput = document.getElementById('camp-cover');
  const body = {
    title:       document.getElementById('camp-title').value,
    description: document.getElementById('camp-desc').value,
    niche:       document.getElementById('camp-niche')?.value || null,
    budget:      document.getElementById('camp-budget').value,
    deadline:    document.getElementById('camp-deadline').value,
    skills,
  };
  // Disable submit button and show saving state
  const submitBtn = document.querySelector('#campaign-modal button[type="submit"], #campaign-modal button[onclick*="postCampaign"]');
  const origBtnText = submitBtn?.textContent || 'Post Campaign';
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving…'; }

  // Read cover image as base64 if provided
  const coverFile = coverInput?.files[0];
  const saveCover = (campaignId, dataUrl) => {
    if (dataUrl && campaignId) localStorage.setItem('camp_cover_' + campaignId, dataUrl);
  };
  try {
    if (coverFile) {
      await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = ev => { body.cover_image = ev.target.result; resolve(); };
        reader.readAsDataURL(coverFile);
      });
    }
    const result = await apiPost('/api/campaigns', body);
    if (coverFile && body.cover_image) saveCover(result?.id || result?.campaign?.id, body.cover_image);
    closeModal('campaign-modal');
    showToast('Campaign brief posted!');
    renderCampaigns();
    if (state.currentPage === 'brand-portal') renderBrandPortal();
  } catch (err) {
    showToast(err.message || 'Something went wrong', 'error');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = origBtnText; }
  }
}

// --- Discovery / Matching ---
async function runMatching() {
  const container = document.getElementById('match-results');
  if (!container) return;
  container.innerHTML = '<div class="text-center py-16 text-gray-400">Finding matches…</div>';

  try {
    const params = new URLSearchParams();
    const niche       = document.getElementById('match-type')?.value;
    const age         = document.getElementById('match-age')?.value;
    const minFollowers = document.getElementById('match-followers')?.value;
    const maxBudget   = document.getElementById('match-budget')?.value;

    if (niche)        params.set('niche', niche);
    if (age)          params.set('age', age);
    if (minFollowers) params.set('min_followers', minFollowers);
    if (maxBudget)    params.set('max_budget', maxBudget);

    const results = await apiGet('/api/discover?' + params.toString());

    if (results.length === 0) {
      container.innerHTML = '<div class="text-center py-16 text-gray-400">No matches found. Try broadening your criteria.</div>';
      return;
    }

    container.innerHTML = results.map(c => {
      const initials   = c.initials || (c.name || 'CC').slice(0, 2).toUpperCase();
      const score      = c.match_score || 50;
      const reasons    = Array.isArray(c.match_reasons) ? c.match_reasons : [];
      const colorClass = score >= 80 ? 'border-pickle-400' : score >= 60 ? 'border-yellow-400' : 'border-gray-300';
      const textClass  = score >= 80 ? 'text-pickle-600' : score >= 60 ? 'text-yellow-600' : 'text-gray-500';
      const label      = score >= 80 ? 'Strong Match' : score >= 60 ? 'Good Match' : 'Potential Match';
      const barColor   = score >= 80 ? 'linear-gradient(90deg, #4f8a4f, #2F4F2F)' : score >= 60 ? 'linear-gradient(90deg, #eab308, #ca8a04)' : '#9ca3af';
      const minRate    = Math.min(c.rate_ig || 9999, c.rate_tiktok || 9999, c.rate_ugc || 9999);
      return `
        <div class="bg-white rounded-2xl border border-gray-200 p-5 card-hover cursor-pointer" onclick="showCreatorDetail(${c.user_id})">
          <div class="flex items-center gap-5">
            <div class="relative">
              <div class="w-14 h-14 rounded-2xl bg-pickle-100 flex items-center justify-center text-xl font-bold text-pickle-700">${initials}</div>
              <div class="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-white border-2 ${colorClass} flex items-center justify-center text-xs font-bold ${textClass}">${score}</div>
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <h3 class="font-bold text-lg">${c.name || 'Creator'}</h3>
                ${verifiedBadgeHtml(c)}
                <span class="tag bg-pickle-100 text-pickle-700">${c.niche || ''}</span>
              </div>
              <div class="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-500 mt-1">
                <span>${fmtNum(c.total_followers)} followers</span>
                <span>${c.engagement_rate || 0}% engagement</span>
                ${minRate < 9999 ? `<span>From $${minRate}/post</span>` : ''}
              </div>
            </div>
            <div class="hidden md:block text-right">
              <div class="text-sm font-medium ${textClass}">${label}</div>
              <div class="text-xs text-gray-400 mt-1 max-w-xs">${reasons.slice(0, 2).join(' · ')}</div>
            </div>
          </div>
          <div class="mt-3 ml-[76px]">
            <div class="stat-bar w-full max-w-xs">
              <div class="stat-bar-fill" style="width: ${score}%; background: ${barColor}"></div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = `<div class="text-center py-16 text-red-400">${err.message}</div>`;
  }
}

// --- Messages ---

// Format a timestamp for display in message threads / conversation list
function _fmtMsgTime(ts) {
  if (!ts || ts === 'null' || ts === 'undefined') return '';
  try {
    // Normalise: replace space separator with T, strip fractional seconds, ensure Z suffix
    const normalised = ts.trim()
      .replace(' ', 'T')
      .replace(/\.\d+/, '')          // strip microseconds
      .replace(/Z?$/, 'Z');          // ensure UTC marker
    const d = new Date(normalised);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const diffMs  = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    const sameDay = d.toDateString() === now.toDateString();
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();
    if (diffMin < 1)         return 'Just now';
    if (sameDay)             return d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });
    if (isYesterday)         return 'Yesterday ' + d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });
    if (diffMs < 7*86400000) return d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

// Double-checkmark SVG (seen indicator)
const _SEEN_ICON = `<svg class="w-3.5 h-3.5 inline-block" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75l6 6 9-13.5" opacity="0.5"/></svg>`;
const _SENT_ICON = `<svg class="w-3.5 h-3.5 inline-block opacity-40" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>`;

async function renderConversations() {
  const list = document.getElementById('conversation-list');
  if (!list) return;
  list.innerHTML = '<div class="p-4 text-sm text-gray-400">Loading…</div>';

  try {
    const convs = await apiGet('/api/conversations');

    if (convs.length === 0) {
      const cta = state.role === 'brand'
        ? `<p class="text-xs text-gray-400 mt-1">Browse creators to find the right match for your campaign.</p>
           <button onclick="navigate('creators');closeMobileMenu()" class="mt-3 text-xs bg-pickle-600 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-pickle-700 transition">Browse Creators</button>`
        : `<p class="text-xs text-gray-400 mt-1">Apply to campaigns to start a conversation with brands.</p>
           <button onclick="navigate('campaigns');closeMobileMenu()" class="mt-3 text-xs bg-pickle-600 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-pickle-700 transition">Browse Campaigns</button>`;
      list.innerHTML = `
        <div class="p-6 text-center flex flex-col items-center">
          <div class="w-10 h-10 bg-gray-100 rounded-xl flex items-center justify-center mb-3">
            <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/></svg>
          </div>
          <p class="text-sm font-semibold text-gray-600">No conversations yet</p>
          ${cta}
        </div>`;
      return;
    }

    const myId = state.currentUser?.id;
    list.innerHTML = convs.map(conv => {
      const partner   = conv.partner;
      const lastMsg   = conv.last_message;
      const unread    = conv.unread_count || 0;
      const rawPreview = lastMsg ? (lastMsg.body || '') : '';
      const preview   = rawPreview.substring(0, 55) + (rawPreview.length > 55 ? '…' : '');
      const isActive  = state.activePartner === partner.id;
      const iMine     = lastMsg && lastMsg.sender_id === myId;
      const wasSeen   = iMine && lastMsg.read_at;
      const msgTime   = lastMsg ? _fmtMsgTime(lastMsg.created_at) : '';
      const seenIcon  = iMine
        ? (wasSeen
            ? `<span class="text-pickle-500 flex-shrink-0">${_SEEN_ICON}</span>`
            : `<span class="text-gray-400 flex-shrink-0">${_SENT_ICON}</span>`)
        : '';
      return `
        <div class="p-4 border-b border-gray-50 cursor-pointer hover:bg-gray-50 transition ${isActive ? 'bg-pickle-50' : ''}" onclick="openConversation(${partner.id})">
          <div class="flex items-center gap-3">
            <div class="relative flex-shrink-0">
              <div class="w-10 h-10 rounded-full bg-pickle-100 flex items-center justify-center font-bold text-pickle-700 text-sm">${partner.initials || partner.name.slice(0,2).toUpperCase()}</div>
              ${unread > 0 ? `<span class="absolute -top-1 -right-1 w-4 h-4 bg-pickle-600 text-white text-[10px] font-bold rounded-full flex items-center justify-center">${unread > 9 ? '9+' : unread}</span>` : ''}
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between gap-1 mb-0.5">
                <span class="font-semibold text-sm truncate ${unread > 0 ? 'text-gray-900' : 'text-gray-700'}">${escHtml(partner.name)}</span>
                <span class="text-[11px] text-gray-400 whitespace-nowrap flex-shrink-0">${msgTime}</span>
              </div>
              <div class="flex items-center gap-1">
                ${seenIcon}
                <p class="text-xs truncate ${unread > 0 ? 'text-gray-700 font-medium' : 'text-gray-500'}">${escHtml(preview) || '<span class="italic text-gray-400">No messages yet</span>'}</p>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="p-4 text-sm text-red-400">${err.message}</div>`;
  }
}

async function openConversation(partnerId) {
  state.activePartner = partnerId;
  _lastMsgId = 0;   // reset so poller sets new baseline for this thread
  renderConversations();

  try {
    // Fetch messages and partner info in parallel
    const [messages, allDeals] = await Promise.all([
      apiGet('/api/messages/' + partnerId),
      apiGet('/api/deals').catch(() => [])
    ]);

    // Find the active deal with this partner
    const deal = allDeals.find(d =>
      d.brand_id === partnerId || d.creator_id === partnerId
    ) || null;

    // Update header
    const partnerName    = messages[0]?.sender_name || messages[0]?.sender_initials || 'Conversation';
    const headerName     = document.getElementById('chat-name');
    const headerStatus   = document.getElementById('chat-status');
    if (headerName)   headerName.textContent   = partnerName;
    const dealStatusText = deal
      ? `Deal: $${(deal.amount || 0).toLocaleString()} — ${deal.status.charAt(0).toUpperCase() + deal.status.slice(1)}`
      : 'No active deal';
    if (headerStatus) headerStatus.textContent = dealStatusText;

    // Deal status stepper
    const stepperEl = document.getElementById('deal-stepper');
    if (stepperEl) {
      if (deal) {
        stepperEl.innerHTML = dealStepperHtml(deal);
        stepperEl.classList.remove('hidden');
      } else {
        stepperEl.classList.add('hidden');
        stepperEl.innerHTML = '';
      }
    }

    // If creator, fetch brand's avg rating and show alongside deal status
    if (state.role === 'creator' && headerStatus) {
      apiGet('/api/brands/' + partnerId).then(b => {
        if (b && b.avg_rating) {
          headerStatus.innerHTML =
            `${escHtml(dealStatusText)} &nbsp;·&nbsp; ${renderStars(b.avg_rating)} ` +
            `<span class="text-gray-400">${b.avg_rating} brand rating</span>`;
        }
      }).catch(() => {});
    }

    // Deal action buttons (creator accepts/declines; brand marks complete; both sign contract)
    const dealActions = document.getElementById('deal-actions');
    if (dealActions) {
      if (deal && deal.status === 'pending' && state.role === 'creator') {
        dealActions.classList.remove('hidden');
        dealActions.innerHTML = `
          <button onclick="updateDealStatus(${deal.id}, 'active')"   class="bg-pickle-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-pickle-700 transition">Accept Deal</button>
          <button onclick="updateDealStatus(${deal.id}, 'declined')" class="bg-red-100 text-red-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-200 transition">Decline</button>
        `;
      } else if (deal && deal.status === 'active') {
        dealActions.classList.remove('hidden');
        // Check contract signing status for the badge
        apiGet(`/api/deals/${deal.id}/contract`).then(c => {
          const badge = c.is_fully_signed ? '✅' : c.i_have_signed ? '⏳' : '✍️';
          const btn = document.querySelector(`[data-contract-btn="${deal.id}"]`);
          if (btn) btn.innerHTML = `${badge} ${c.is_fully_signed ? 'Contract Signed' : c.i_have_signed ? 'Awaiting Co-Sign' : 'Sign Contract'}`;
        }).catch(() => {});
        dealActions.innerHTML = state.role === 'brand'
          ? `<button onclick="updateDealStatus(${deal.id}, 'completed')" class="bg-pickle-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-pickle-700 transition">Mark Complete</button>
             <button onclick="stripeCheckout(${deal.id})" class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition">Pay with Stripe</button>
             <button data-contract-btn="${deal.id}" onclick="openContractModal(${deal.id})" class="border border-pickle-300 text-pickle-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-pickle-50 transition">📄 View Contract</button>
             <button onclick="openDisputeModal(${deal.id})" class="border border-red-300 text-red-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-50 transition" title="File a dispute">🚩</button>`
          : `<button data-contract-btn="${deal.id}" onclick="openContractModal(${deal.id})" class="border border-pickle-300 text-pickle-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-pickle-50 transition">📄 View Contract</button>
             <button onclick="openDisputeModal(${deal.id})" class="border border-red-300 text-red-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-50 transition" title="File a dispute">🚩</button>`;
      } else if (deal && deal.status === 'completed') {
        dealActions.classList.remove('hidden');
        const partnerLabel   = state.role === 'brand' ? 'Creator' : 'Brand';
        const ratingSubtitle = state.role === 'brand'
          ? 'Did the creator deliver quality content on time?'
          : 'Did the brand communicate clearly and pay on time?';
        dealActions.innerHTML = deal.my_rating
          ? `<span class="inline-flex items-center gap-2 text-sm text-gray-600 bg-gray-50 border border-gray-200 px-4 py-2 rounded-lg">
               ${renderStars(deal.my_rating)}
               <span>You rated this ${partnerLabel.toLowerCase()} <strong>${deal.my_rating}/5</strong></span>
             </span>`
          : `<button onclick="openRatingModal(${deal.id}, '${ratingSubtitle}')"
               class="bg-yellow-50 border border-yellow-300 text-yellow-800 px-4 py-2 rounded-lg text-sm font-semibold hover:bg-yellow-100 transition flex items-center gap-2">
               ⭐ Rate this ${partnerLabel}
             </button>`;
      } else {
        dealActions.classList.add('hidden');
      }
    }

    // Show/hide dispute banner
    const disputeBanner = document.getElementById('dispute-banner');
    const disputeBannerText = document.getElementById('dispute-banner-text');
    const disputeBannerBtn  = document.getElementById('dispute-banner-btn');
    if (disputeBanner) {
      if (deal && (deal.status === 'active' || deal.status === 'completed')) {
        apiGet(`/api/deals/${deal.id}/dispute`).then(dispute => {
          if (dispute) {
            const statusLabel = dispute.status.charAt(0).toUpperCase() + dispute.status.slice(1);
            const colours = { open: 'bg-red-50 border-red-200', resolved: 'bg-green-50 border-green-200', closed: 'bg-gray-50 border-gray-200' };
            const textColours = { open: 'text-red-700', resolved: 'text-green-700', closed: 'text-gray-600' };
            disputeBanner.className = `px-4 py-2.5 border-b flex items-center justify-between gap-3 ${colours[dispute.status] || colours.open}`;
            if (disputeBannerText) {
              disputeBannerText.className = `font-medium text-sm ${textColours[dispute.status] || textColours.open}`;
              disputeBannerText.textContent = `🚩 Dispute ${statusLabel} — filed ${dispute.created_at ? dispute.created_at.slice(0,10) : ''}`;
            }
            if (disputeBannerBtn) {
              disputeBannerBtn.onclick = () => openDisputeDetailModal(deal.id);
            }
            disputeBanner.classList.remove('hidden');
          } else {
            disputeBanner.classList.add('hidden');
          }
        }).catch(() => disputeBanner.classList.add('hidden'));
      } else {
        disputeBanner.classList.add('hidden');
      }
    }

    // Render messages
    const chatEl = document.getElementById('chat-messages');
    if (!chatEl) return;
    const myId = state.currentUser?.id;

    if (messages.length === 0) {
      chatEl.innerHTML = '<div class="text-center text-gray-400 text-sm py-8">No messages yet. Say hello!</div>';
    } else {
      // Find the id of the last message I sent that the other person has read
      const lastReadSentId = [...messages]
        .filter(m => m.sender_id === myId && m.read_at)
        .pop()?.id ?? null;

      chatEl.innerHTML = messages.map(m => {
        const isMe     = m.sender_id === myId;
        const time     = _fmtMsgTime(m.created_at);
        const showSeen = isMe && m.id === lastReadSentId;
        const seenTime = showSeen ? _fmtMsgTime(m.read_at) : '';
        return `
          <div class="flex ${isMe ? 'justify-end' : 'justify-start'} mb-1">
            <div class="max-w-sm">
              <div class="${isMe ? 'message-bubble-right' : 'message-bubble-left'} px-4 py-3 text-sm">${escHtml(m.body)}</div>
              <div class="text-xs text-gray-400 mt-1 ${isMe ? 'text-right' : ''}">
                ${time}
                ${showSeen
                  ? `<span class="ml-1.5 inline-flex items-center gap-0.5 text-pickle-500 font-medium">${_SEEN_ICON} Seen${seenTime ? ' · ' + seenTime : ''}</span>`
                  : (isMe ? `<span class="ml-1 text-gray-300">${_SENT_ICON}</span>` : '')}
              </div>
            </div>
          </div>
        `;
      }).join('');
    }

    chatEl.scrollTop = chatEl.scrollHeight;
  } catch (err) {
    showToast(err.message || 'Could not load conversation', 'error');
  }
}

async function sendMessage() {
  const input = document.getElementById('message-input');
  const text  = (input?.value || '').trim();
  if (!text) return;
  if (!state.activePartner) { showToast('Select a conversation first', 'error'); return; }
  input.value = '';
  clearTimeout(_typingTimer); _typingTimer = null;
  _hideTypingIndicator();

  try {
    await apiPost('/api/messages', { receiver_id: state.activePartner, body: text });
    await openConversation(state.activePartner);
  } catch (err) {
    showToast(err.message || 'Something went wrong', 'error');
    input.value = text;
  }
}

async function startConversation() {
  if (!state.selectedCreator) return;
  const creatorUserId = state.selectedCreator.user_id;
  closeModal('creator-detail-modal');
  navigate('messages');
  setTimeout(() => openConversation(creatorUserId), 200);
}

// --- Deal Flow ---
async function proposeDeal(e) {
  e.preventDefault();
  if (!state.activePartner) return;

  const amount       = parseInt(document.getElementById('deal-amount').value);
  const deliverables = document.getElementById('deal-deliverables').value;
  const timeline     = document.getElementById('deal-timeline').value;
  const campaignEl   = document.getElementById('deal-campaign-id');
  const campaignId   = campaignEl ? parseInt(campaignEl.value) : null;

  if (!campaignId) {
    showToast('Please select a campaign for this deal', 'error');
    return;
  }

  try {
    await apiPost('/api/deals', {
      campaign_id: campaignId,
      creator_id:  state.activePartner,
      amount,
      terms: `${deliverables} — ${timeline}`
    });
    // Also send a system-style message
    await apiPost('/api/messages', {
      receiver_id: state.activePartner,
      body: `📋 Deal proposed: $${amount.toLocaleString()} for ${deliverables} — ${timeline} timeline`
    });
    closeModal('deal-modal');
    showToast('Deal proposal sent!', 'success');
    await openConversation(state.activePartner);
  } catch (err) {
    showToast(err.message || 'Something went wrong', 'error');
  }
}

// Populate campaign dropdown when deal modal opens
async function openDealModal() {
  openModal('deal-modal');
  const sel = document.getElementById('deal-campaign-id');
  if (!sel) return;
  sel.innerHTML = '<option value="">Loading campaigns…</option>';
  try {
    const campaigns = await apiGet('/api/campaigns?mine=true');
    if (campaigns.length === 0) {
      sel.innerHTML = '<option value="">No campaigns — post one first</option>';
    } else {
      sel.innerHTML = campaigns.map(c => `<option value="${c.id}">${c.title}</option>`).join('');
    }
  } catch {
    sel.innerHTML = '<option value="">Could not load campaigns</option>';
  }
}

async function updateDealStatus(dealId, status) {
  try {
    await apiPatch('/api/deals/' + dealId + '/status', { status });
    showToast('Deal ' + status + '!', 'success');
    await openConversation(state.activePartner);
    if (status === 'active') {
      // Creator accepted — give the backend a moment to write the contract, then open it
      setTimeout(() => openContractModal(dealId), 600);
    }
    if (status === 'completed') {
      openRatingModal(dealId, 'How was your experience working with this creator?');
    }
  } catch (err) {
    showToast(err.message || 'Something went wrong', 'error');
  }
}

// --- Creator Deal History (creator's own profile page) ---
// ---------------------------------------------------------------------------
// Profile Completion
// ---------------------------------------------------------------------------

const _CREATOR_COMPLETION_FIELDS = [
  {
    key: 'bio', label: 'Write a bio', icon: '✍️', pct: 15,
    tip: 'Brands read your bio first — make it count.',
    check: p => (p.bio || '').trim().length > 10,
    focusId: 'cp-bio',
  },
  {
    key: 'niche', label: 'Choose a content niche', icon: '🎯', pct: 15,
    tip: 'Niche is the #1 filter brands use to find creators.',
    check: p => !!(p.niche || '').trim(),
    focusId: 'cp-niche',
  },
  {
    key: 'followers', label: 'Add follower counts', icon: '📈', pct: 15,
    tip: 'Brands filter by audience size — add at least one platform.',
    check: p => (p.followers_ig || 0) + (p.followers_tt || 0) + (p.followers_yt || 0) > 0,
    focusId: 'cp-ig',
  },
  {
    key: 'rates', label: 'Set your rates', icon: '💰', pct: 15,
    tip: 'Creators with listed rates close deals faster.',
    check: p => (p.rate_ig || 0) + (p.rate_tiktok || 0) + (p.rate_yt || 0) + (p.rate_ugc || 0) > 0,
    focusId: 'cp-rate-ig',
  },
  {
    key: 'name', label: 'Add a display name', icon: '👤', pct: 10,
    tip: 'Your creator name shown to brands.',
    check: p => !!(p.name || '').trim(),
    focusId: 'cp-name',
  },
  {
    key: 'skills', label: 'Select creator skills', icon: '🛠️', pct: 10,
    tip: 'Skills power the AI matching engine.',
    check: p => Array.isArray(p.skills) ? p.skills.length > 0 : !!(p.skills),
    focusId: 'cp-skills',
    scroll: true,
  },
  {
    key: 'skill_level', label: 'Set your skill level', icon: '🎯', pct: 5,
    tip: 'Pickleball skill level helps brands target the right audience.',
    check: p => !!(p.skill_level || '').trim(),
    focusId: 'cp-skill-level',
  },
  {
    key: 'location', label: 'Add your location', icon: '📍', pct: 5,
    tip: 'Local brands love working with creators in their market.',
    check: p => !!(p.location || '').trim(),
    focusId: 'cp-location',
  },
  {
    key: 'engagement', label: 'Enter engagement rate', icon: '⚡', pct: 5,
    tip: 'High engagement can outweigh follower count for many brands.',
    check: p => (p.engagement_rate || 0) > 0,
    focusId: 'cp-engagement',
  },
  {
    key: 'demo', label: 'Add audience demographics', icon: '👥', pct: 5,
    tip: 'Demographics help brands confirm audience fit.',
    check: p => !!(p.demo_age || p.demo_gender || p.demo_locations),
    focusId: 'cp-age',
  },
];

const _BRAND_COMPLETION_FIELDS = [
  {
    key: 'budget', label: 'Set campaign budget', icon: '💰', pct: 25,
    tip: 'Creators use your budget to decide if it\'s worth applying.',
    check: p => (p.budget_min || 0) > 0 || (p.budget_max || 0) > 0,
  },
  {
    key: 'company_name', label: 'Add company name', icon: '🏢', pct: 20,
    tip: 'Your company name appears on every campaign brief.',
    check: p => !!(p.company_name || '').trim(),
  },
  {
    key: 'industry', label: 'Select your industry', icon: '🎯', pct: 20,
    tip: 'Creators browse by industry to find relevant partners.',
    check: p => !!(p.industry || '').trim(),
  },
  {
    key: 'description', label: 'Write a brand description', icon: '✍️', pct: 20,
    tip: 'A strong description attracts higher-quality creators.',
    check: p => (p.description || '').trim().length > 10,
  },
  {
    key: 'website', label: 'Add your website', icon: '🌐', pct: 15,
    tip: 'Creators research your brand before applying.',
    check: p => !!(p.website || '').trim(),
  },
];

function _calcCompletion(profile, fields) {
  return fields.reduce((sum, f) => sum + (f.check(profile) ? f.pct : 0), 0);
}

function _completionBarHtml(pct, missingFields, role) {
  // Color scheme
  const isComplete = pct >= 100;
  let barColor, bgColor, textColor, borderColor;
  if (isComplete)    { barColor = '#16a34a'; bgColor = 'bg-green-50';  textColor = 'text-green-800';  borderColor = 'border-green-200'; }
  else if (pct >= 75){ barColor = '#2F4F2F'; bgColor = 'bg-pickle-50'; textColor = 'text-pickle-800'; borderColor = 'border-pickle-200'; }
  else if (pct >= 40){ barColor = '#d97706'; bgColor = 'bg-amber-50';  textColor = 'text-amber-800';  borderColor = 'border-amber-200'; }
  else               { barColor = '#dc2626'; bgColor = 'bg-red-50';    textColor = 'text-red-800';    borderColor = 'border-red-200'; }

  const topItems = missingFields.slice(0, 3);

  const actionHtml = isComplete
    ? `<p class="text-sm font-medium ${textColor} mt-2">You're fully set up — brands can discover and contact you. 🎉</p>`
    : `<div class="mt-3 flex flex-wrap gap-2">
         ${topItems.map(f => `
           <button onclick="${role === 'creator' ? `_creatorCompletionFocus('${f.focusId}',${!!f.scroll})` : `openBrandProfileModal('${f.key}')`}"
             class="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full bg-white border ${borderColor} ${textColor} hover:shadow-sm transition">
             <span>${f.icon}</span>
             <span>${f.label}</span>
             <span class="opacity-60">+${f.pct}%</span>
           </button>
         `).join('')}
       </div>`;

  return `
    <div class="${bgColor} border ${borderColor} rounded-2xl p-5">
      <div class="flex items-center justify-between mb-3">
        <div>
          <span class="text-sm font-semibold ${textColor}">${isComplete ? '✅ Profile Complete' : 'Profile Strength'}</span>
          ${!isComplete ? `<span class="text-xs ${textColor} opacity-70 ml-2">${missingFields.length} field${missingFields.length !== 1 ? 's' : ''} missing</span>` : ''}
        </div>
        <span class="text-2xl font-black ${textColor}">${pct}%</span>
      </div>
      <div class="h-2.5 bg-white/60 rounded-full overflow-hidden border ${borderColor}">
        <div class="h-full rounded-full transition-all duration-700 ease-out" style="width:${pct}%;background:${barColor};"></div>
      </div>
      ${actionHtml}
    </div>
  `;
}

function _creatorCompletionFocus(id, scroll) {
  const el = document.getElementById(id);
  if (!el) return;
  if (scroll) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => { try { el.focus(); } catch (_) {} }, 350);
  }
}

function renderCreatorCompletion(profile) {
  const el = document.getElementById('creator-profile-completion');
  if (!el) return;
  const missing = _CREATOR_COMPLETION_FIELDS.filter(f => !f.check(profile));
  const pct     = _calcCompletion(profile, _CREATOR_COMPLETION_FIELDS);
  el.innerHTML  = _completionBarHtml(pct, missing, 'creator');
}

// Build a profile-like object from the live form values (no API call needed)
function _buildProfileFromForm() {
  const skills = Array.from(document.querySelectorAll('#cp-skills input:checked')).map(i => i.value);
  return {
    name:            (document.getElementById('cp-name')?.value        || '').trim(),
    bio:             (document.getElementById('cp-bio')?.value         || '').trim(),
    location:        (document.getElementById('cp-location')?.value    || '').trim(),
    skill_level:     (document.getElementById('cp-skill-level')?.value || '').trim(),
    skills,
    followers_ig:    parseInt(document.getElementById('cp-ig')?.value)         || 0,
    followers_tt:    parseInt(document.getElementById('cp-tiktok')?.value)     || 0,
    followers_yt:    parseInt(document.getElementById('cp-yt')?.value)         || 0,
    engagement_rate: parseFloat(document.getElementById('cp-engagement')?.value) || 0,
    rate_ig:         parseInt(document.getElementById('cp-rate-ig')?.value)    || 0,
    rate_tiktok:     parseInt(document.getElementById('cp-rate-tiktok')?.value) || 0,
    rate_yt:         parseInt(document.getElementById('cp-rate-yt')?.value)    || 0,
    rate_ugc:        parseInt(document.getElementById('cp-rate-ugc')?.value)   || 0,
    demo_age:        (document.getElementById('cp-age')?.value         || '').trim(),
    demo_gender:     (document.getElementById('cp-gender')?.value      || '').trim(),
    demo_locations:  (document.getElementById('cp-locations')?.value   || '').trim(),
  };
}

// Auto-sum follower fields into Total Followers
function _updateTotalFollowers() {
  const ig  = parseInt(document.getElementById('cp-ig')?.value)     || 0;
  const tt  = parseInt(document.getElementById('cp-tiktok')?.value) || 0;
  const yt  = parseInt(document.getElementById('cp-yt')?.value)     || 0;
  const el  = document.getElementById('cp-total');
  if (el) el.value = (ig + tt + yt) > 0 ? (ig + tt + yt) : '';
}

// Attach live-update listeners to all profile form fields (called once after form renders)
function _attachProfileFormListeners() {
  const fieldIds = [
    'cp-name','cp-bio','cp-location','cp-skill-level','cp-niche',
    'cp-ig','cp-tiktok','cp-yt','cp-engagement','cp-views',
    'cp-rate-ig','cp-rate-tiktok','cp-rate-yt','cp-rate-ugc','cp-rate-notes',
    'cp-age','cp-gender','cp-locations','cp-interests',
    'cp-handle-ig','cp-handle-tt','cp-handle-yt',
  ];
  const handler = () => renderCreatorCompletion(_buildProfileFromForm());
  fieldIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', handler);
    if (el && el.tagName === 'SELECT') el.addEventListener('change', handler);
  });
  // Auto-calculate total followers when any platform count changes
  ['cp-ig', 'cp-tiktok', 'cp-yt'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', _updateTotalFollowers);
  });
  // Skills checkboxes
  document.querySelectorAll('#cp-skills input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', handler);
  });
}

function renderBrandCompletion(profile) {
  const el = document.getElementById('brand-profile-completion');
  if (!el) return;
  if (!profile) { el.innerHTML = ''; return; }
  const missing = _BRAND_COMPLETION_FIELDS.filter(f => !f.check(profile));
  const pct     = _calcCompletion(profile, _BRAND_COMPLETION_FIELDS);
  el.innerHTML  = _completionBarHtml(pct, missing, 'brand');
}

// --- Pre-populate creator profile form from API ---
async function populateCreatorForm() {
  try {
    const p = await apiGet('/api/creator/profile');
    const setVal  = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
    const setNum  = (id, v) => { const el = document.getElementById(id); if (el) el.value = v > 0 ? v : ''; };
    const setSel  = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };

    setVal('cp-name',       p.name);
    setVal('cp-location',   p.location);
    setVal('cp-bio',        p.bio);
    setSel('cp-niche',      p.niche);
    setSel('cp-skill-level', p.skill_level);
    setNum('cp-ig',         p.followers_ig);
    setNum('cp-tiktok',     p.followers_tt);
    setNum('cp-yt',         p.followers_yt);
    setNum('cp-engagement', p.engagement_rate);
    setNum('cp-views',      p.avg_views);
    setSel('cp-age',        p.demo_age);
    setSel('cp-gender',     p.demo_gender);
    setVal('cp-locations',  p.demo_locations);
    setVal('cp-interests',  p.demo_interests);
    setNum('cp-rate-ig',    p.rate_ig);
    setNum('cp-rate-tiktok', p.rate_tiktok);
    setNum('cp-rate-yt',    p.rate_yt);
    setNum('cp-rate-ugc',   p.rate_ugc);
    setVal('cp-rate-notes', p.rate_notes);

    // Tick skill checkboxes
    const skills = Array.isArray(p.skills) ? p.skills : [];
    document.querySelectorAll('#cp-skills input[type="checkbox"]').forEach(cb => {
      cb.checked = skills.includes(cb.value);
    });

    // Social handles
    const handles = (typeof p.social_handles === 'object' && p.social_handles !== null) ? p.social_handles : {};
    const igHandle = document.getElementById('cp-handle-ig');
    const ttHandle = document.getElementById('cp-handle-tt');
    const ytHandle = document.getElementById('cp-handle-yt');
    if (igHandle) igHandle.value = handles.instagram || '';
    if (ttHandle) ttHandle.value = handles.tiktok    || '';
    if (ytHandle) ytHandle.value = handles.youtube   || '';
    _updateVerifiedBadgeUI(handles);

    renderCreatorCompletion(p);
    _updateTotalFollowers();
    _attachProfileFormListeners();
  } catch (err) {
    // Profile doesn't exist yet (new user) — show empty completion bar
    renderCreatorCompletion({});
    _attachProfileFormListeners();
  }
}

// --- Brand profile edit modal ---
async function openBrandProfileModal(highlightKey) {
  try {
    const p = await apiGet('/api/brand/profile').catch(() => ({}));
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
    const setSel = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
    const setNum = (id, v) => { const el = document.getElementById(id); if (el) el.value = v > 0 ? v : ''; };

    setVal('bp-company',     p.company_name);
    setSel('bp-industry',    p.industry);
    setVal('bp-website',     p.website);
    setNum('bp-budget-min',  p.budget_min);
    setNum('bp-budget-max',  p.budget_max);
    setVal('bp-description', p.description);
  } catch (_) {}

  openModal('bp-edit-modal');

  // Highlight the relevant field after modal opens
  if (highlightKey) {
    const fieldMap = {
      company_name: 'bp-company', industry: 'bp-industry',
      website: 'bp-website', budget: 'bp-budget-min', description: 'bp-description',
    };
    const targetId = fieldMap[highlightKey];
    if (targetId) {
      setTimeout(() => {
        const el = document.getElementById(targetId);
        if (el) { el.focus(); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      }, 150);
    }
  }
}

async function saveBrandProfileModal() {
  const body = {
    company_name: document.getElementById('bp-company')?.value.trim() || '',
    industry:     document.getElementById('bp-industry')?.value || '',
    website:      document.getElementById('bp-website')?.value.trim() || '',
    budget_min:   parseInt(document.getElementById('bp-budget-min')?.value || '0') || 0,
    budget_max:   parseInt(document.getElementById('bp-budget-max')?.value || '0') || 0,
    description:  document.getElementById('bp-description')?.value.trim() || '',
  };
  try {
    await apiPut('/api/brand/profile', body);
    closeModal('bp-edit-modal');
    showToast('Brand profile saved!', 'success');
    renderBrandPortal(); // re-renders completion bar + stats
  } catch (err) {
    showToast(err.message || 'Could not save profile', 'error');
  }
}

async function renderCreatorDealHistory() {
  const el = document.getElementById('creator-deal-history');
  if (!el || state.role !== 'creator') return;
  el.innerHTML = '';

  try {
    const deals = await apiGet('/api/deals');
    const active = deals.filter(d => d.status !== 'declined');
    if (!active.length) return;

    const completed = active.filter(d => d.status === 'completed').length;
    el.innerHTML = `
      <div class="bg-white rounded-2xl border border-gray-200 p-6 mt-6">
        <h2 class="font-bold text-lg mb-1">My Deals</h2>
        <p class="text-sm text-gray-500 mb-4">
          ${active.length} deal${active.length !== 1 ? 's' : ''} · ${completed} completed
        </p>
        <div class="divide-y divide-gray-100">
          ${active.map(d => `
            <div class="py-3">
              <div class="flex items-center justify-between mb-2">
                <div class="min-w-0 mr-3">
                  <div class="font-medium text-sm">${escHtml(d.brand_name || 'Brand')}</div>
                  <div class="text-xs text-gray-500 truncate">${escHtml(d.campaign_title || '')}</div>
                </div>
                <span class="font-semibold text-pickle-700 text-sm flex-shrink-0">$${(d.amount || 0).toLocaleString()}</span>
              </div>
              <div class="flex items-center gap-1">
                ${dealStepperMiniHtml(d.status)}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  } catch {
    el.innerHTML = '';
  }
}

// --- Payments ---
async function renderPayments() {
  // Show/hide role sections
  document.querySelectorAll('.brand-only').forEach(el => {
    el.style.display = state.role === 'brand' ? 'block' : 'none';
  });
  document.querySelectorAll('.creator-only').forEach(el => {
    el.style.display = state.role === 'creator' ? 'block' : 'none';
  });

  // Fee calculator listener
  const dealAmountInput = document.getElementById('deal-amount-pay');
  if (dealAmountInput) {
    const newInput = dealAmountInput.cloneNode(true);
    dealAmountInput.parentNode.replaceChild(newInput, dealAmountInput);
    newInput.addEventListener('input', function () {
      const raw    = parseFloat(this.value) || 0;
      const fee    = raw * 0.15;
      const payout = raw * 0.85;
      const feeEl    = document.getElementById('platform-fee-display');
      const payoutEl = document.getElementById('creator-payout-display');
      if (feeEl)    feeEl.value    = '$' + fee.toFixed(2);
      if (payoutEl) payoutEl.value = '$' + payout.toFixed(2);
    });
  }

  // Fetch and render real payment history
  const historyEl = document.getElementById(state.role === 'brand' ? 'payment-history-brand' : 'payment-history-creator');
  if (!historyEl) return;
  historyEl.innerHTML = '<div class="text-center py-8 text-gray-400 text-sm">Loading payments…</div>';

  try {
    const payments = await apiGet('/api/payments');

    if (payments.length === 0) {
      historyEl.innerHTML = state.role === 'brand'
        ? `<div class="py-10 text-center flex flex-col items-center gap-2">
             <svg class="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"/></svg>
             <p class="text-sm font-medium text-gray-500">No payments yet</p>
             <p class="text-xs text-gray-400">Payments will appear here once you've funded a deal with a creator.</p>
           </div>`
        : `<div class="py-10 text-center flex flex-col items-center gap-2">
             <svg class="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"/></svg>
             <p class="text-sm font-medium text-gray-500">No payments yet</p>
             <p class="text-xs text-gray-400">Your earnings from brand deals will appear here.</p>
           </div>`;
      return;
    }

    historyEl.innerHTML = payments.map(p => {
      const payStatusColor = p.status === 'released'  ? 'bg-green-100 text-green-700'  :
                             p.status === 'held'       ? 'bg-yellow-100 text-yellow-700' :
                             p.status === 'refunded'   ? 'bg-red-100 text-red-700'      :
                                                         'bg-gray-100 text-gray-600';
      const date = p.created_at ? new Date(p.created_at).toLocaleDateString() : '';
      // Map payment status to deal status for the mini stepper
      const dealStatusForStep = p.deal_status || (p.status === 'released' ? 'completed' : 'active');
      return `
        <div class="p-4 border border-gray-100 rounded-xl mb-2">
          <div class="flex items-center justify-between mb-2.5">
            <div class="min-w-0 mr-3">
              <div class="font-semibold text-sm">${escHtml(p.campaign_title || 'Campaign')}</div>
              <div class="text-xs text-gray-500">${escHtml(state.role === 'brand' ? 'To: ' + (p.creator_name||'') : 'From: ' + (p.brand_name||''))} · ${date}</div>
            </div>
            <div class="text-right flex-shrink-0">
              <div class="font-bold">${state.role === 'brand' ? '$' + (p.amount || 0).toLocaleString() : '$' + (p.creator_payout || 0).toLocaleString()}</div>
              <span class="tag ${payStatusColor} text-xs">${p.status}</span>
              ${p.status === 'held' && state.role === 'brand' ?
                `<button onclick="releasePayment(${p.id})" class="ml-1 text-xs bg-pickle-600 text-white px-2 py-1 rounded-lg hover:bg-pickle-700 transition">Release</button>` : ''}
            </div>
          </div>
          <div class="flex items-center gap-1 pt-2 border-t border-gray-50">
            ${dealStepperMiniHtml(dealStatusForStep)}
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    historyEl.innerHTML = `<div class="text-center py-8 text-red-400 text-sm">${err.message}</div>`;
  }
}

async function releasePayment(paymentId) {
  try {
    await apiPatch('/api/payments/' + paymentId + '/release');
    showToast('✓ Payment released to creator!', 'success');
    renderPayments();
  } catch (err) {
    showToast(err.message || 'Something went wrong', 'error');
  }
}

function submitPayment(e) {
  e.preventDefault();
  showToast('✓ Payment sent! Funds held in escrow pending content delivery.');
}

async function handleStripePaymentForm(e) {
  e.preventDefault();
  const dealId = parseInt(document.getElementById('pay-deal-id')?.value);
  if (!dealId) { showToast('Please enter a Deal ID', 'error'); return; }
  await stripeCheckout(dealId);
}

// --- Stripe Connect Helpers ---
async function stripeConnectOnboard() {
  try {
    const btn = document.getElementById('stripe-connect-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
    const data = await apiPost('/api/stripe/connect/onboard', {});
    window.location.href = data.url;
  } catch (err) {
    showToast(err.message || 'Could not start Stripe onboarding', 'error');
    const btn = document.getElementById('stripe-connect-btn');
    if (btn) { btn.disabled = false; btn.textContent = 'Connect Stripe Payouts'; }
  }
}

async function loadStripeConnectStatus() {
  const banner = document.getElementById('stripe-connect-banner');
  if (!banner) return;
  try {
    const status = await apiGet('/api/stripe/connect/status');
    if (status.onboarded) {
      banner.innerHTML = `
        <div class="flex items-center gap-2 text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-3">
          <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          <span class="font-medium">Stripe payouts connected — you'll receive your earnings directly to your bank.</span>
        </div>`;
    } else {
      banner.innerHTML = `
        <div class="flex items-center justify-between gap-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          <div class="flex items-center gap-2 text-amber-800">
            <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
            <span class="font-medium">Connect your bank to receive your deal payouts.</span>
          </div>
          <button id="stripe-connect-btn" onclick="stripeConnectOnboard()"
            class="shrink-0 bg-[#2F4F2F] text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-[#1f3a1f] transition">
            Connect Stripe Payouts
          </button>
        </div>`;
    }
  } catch {
    banner.innerHTML = '';
  }
}

async function stripeCheckout(dealId) {
  try {
    const btn = document.getElementById(`pay-btn-${dealId}`);
    if (btn) { btn.disabled = true; btn.textContent = 'Redirecting to payment…'; }
    const data = await apiPost(`/api/stripe/checkout/${dealId}`, {});
    window.location.href = data.checkout_url;
  } catch (err) {
    showToast(err.message || 'Payment failed', 'error');
    const btn = document.getElementById(`pay-btn-${dealId}`);
    if (btn) { btn.disabled = false; btn.textContent = 'Pay with Stripe'; }
  }
}

// Handle Stripe return URLs
function handleStripeReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('stripe_onboard')) {
    showToast('🎉 Stripe account connected! You\'re ready to receive payouts.', 'success');
    history.replaceState({}, '', window.location.pathname);
    navigate('profile');
  }
  if (params.get('deal_id') && params.get('session_id')) {
    showToast('💳 Payment complete! Funds are held in escrow until you confirm delivery.');
    history.replaceState({}, '', window.location.pathname);
    navigate('messages');
  }
}

// --- Deal Ratings ---
let _ratingDealId = null;
let _ratingScore  = 0;

function openRatingModal(dealId, subtitleText) {
  _ratingDealId = dealId;
  _ratingScore  = 0;
  const comment = document.getElementById('rating-comment');
  if (comment) comment.value = '';
  const sub = document.getElementById('rating-modal-subtitle');
  if (sub && subtitleText) sub.textContent = subtitleText;
  document.querySelectorAll('.star-btn').forEach(b => {
    b.classList.remove('text-yellow-400');
    b.classList.add('text-gray-200');
  });
  openModal('rating-modal');
}

async function submitRating() {
  if (!_ratingScore) { showToast('Please select a star rating first'); return; }
  try {
    await apiPost('/api/deals/' + _ratingDealId + '/rate', {
      score:   _ratingScore,
      comment: (document.getElementById('rating-comment')?.value || '').trim() || null,
    });
    closeModal('rating-modal');
    showToast('Rating submitted — thanks!', 'success');
    // Refresh deal panel so the "Rate" button swaps to the submitted stars
    if (state.activePartner) openConversation(state.activePartner);
    // Refresh brand portal if brand is on that page
    if (state.currentPage === 'brand-portal') renderBrandPortal();
  } catch (err) {
    showToast(err.message || 'Could not submit rating', 'error');
  }
}

// --- Contracts ---
let _contractDealId = null;

async function openContractModal(dealId) {
  _contractDealId = dealId;
  // Reset modal state
  document.getElementById('contract-body').textContent        = 'Loading contract…';
  document.getElementById('contract-deal-label').textContent  = `Deal #${dealId}`;
  document.getElementById('contract-agree-check').checked     = false;
  document.getElementById('contract-brand-sig-icon').textContent    = '⬜';
  document.getElementById('contract-creator-sig-icon').textContent  = '⬜';
  document.getElementById('contract-brand-sig-label').textContent   = 'Not signed';
  document.getElementById('contract-creator-sig-label').textContent = 'Not signed';
  document.getElementById('contract-sign-area').classList.remove('hidden');
  document.getElementById('contract-signed-banner').classList.add('hidden');
  openModal('contract-modal');

  try {
    const c = await apiGet(`/api/deals/${dealId}/contract`);
    document.getElementById('contract-body').textContent = c.content || '(No contract content)';

    // Brand signing status
    if (c.is_brand_signed) {
      document.getElementById('contract-brand-sig-icon').textContent  = '✅';
      document.getElementById('contract-brand-sig-label').textContent =
        'Signed ' + fmtDateUTC(c.brand_signed_at);
    }
    // Creator signing status
    if (c.is_creator_signed) {
      document.getElementById('contract-creator-sig-icon').textContent  = '✅';
      document.getElementById('contract-creator-sig-label').textContent =
        'Signed ' + fmtDateUTC(c.creator_signed_at);
    }

    // If current user has already signed, swap to the "already signed" view
    if (c.i_have_signed) {
      document.getElementById('contract-sign-area').classList.add('hidden');
      document.getElementById('contract-signed-banner').classList.remove('hidden');
      document.getElementById('contract-signed-msg').textContent = 'You have signed this agreement';
      document.getElementById('contract-cosign-msg').textContent = c.is_fully_signed
        ? '✅ Both parties have signed — agreement is complete.'
        : '⏳ Waiting for the other party to sign.';
    }
  } catch (err) {
    document.getElementById('contract-body').textContent = 'Could not load contract: ' + err.message;
  }
}

async function signContract() {
  if (!document.getElementById('contract-agree-check').checked) {
    showToast('Please check the box to confirm you have read and agree to the terms.');
    return;
  }
  try {
    const c = await apiPost(`/api/deals/${_contractDealId}/contract/sign`, {});
    // Update signing status icons
    if (c.is_brand_signed) {
      document.getElementById('contract-brand-sig-icon').textContent  = '✅';
      document.getElementById('contract-brand-sig-label').textContent =
        'Signed ' + fmtDateUTC(c.brand_signed_at);
    }
    if (c.is_creator_signed) {
      document.getElementById('contract-creator-sig-icon').textContent  = '✅';
      document.getElementById('contract-creator-sig-label').textContent =
        'Signed ' + fmtDateUTC(c.creator_signed_at);
    }
    // Swap to signed state
    document.getElementById('contract-sign-area').classList.add('hidden');
    document.getElementById('contract-signed-banner').classList.remove('hidden');
    document.getElementById('contract-signed-msg').textContent = 'You have signed this agreement';
    document.getElementById('contract-cosign-msg').textContent = c.is_fully_signed
      ? '✅ Both parties have signed — agreement is complete.'
      : '⏳ Waiting for the other party to sign.';
    showToast('Agreement signed successfully!', 'success');
    // Refresh deal panel so "View Contract" button updates
    if (state.activePartner) openConversation(state.activePartner);
  } catch (err) {
    showToast(err.message || 'Could not sign contract', 'error');
  }
}

// --- Dispute Resolution ---
let _disputeDealId = null;
let _disputeId     = null;

function openDisputeModal(dealId) {
  _disputeDealId = dealId;
  const ta = document.getElementById('dispute-reason');
  if (ta) ta.value = '';
  document.getElementById('dispute-modal').classList.remove('hidden');
}

async function submitDispute() {
  const reason = (document.getElementById('dispute-reason')?.value || '').trim();
  if (reason.length < 10) {
    showToast('Please describe the issue in at least 10 characters.', 'error');
    return;
  }
  try {
    await apiPost(`/api/deals/${_disputeDealId}/dispute`, { reason });
    closeModal('dispute-modal');
    showToast('Dispute filed. Our team will review and contact both parties.', 'success');
    if (state.activePartner) openConversation(state.activePartner);
  } catch (err) {
    showToast(err.message || 'Could not file dispute', 'error');
  }
}

async function openDisputeDetailModal(dealId) {
  _disputeDealId = dealId;
  const modal = document.getElementById('dispute-detail-modal');
  if (!modal) return;

  // Reset
  document.getElementById('dispute-reason-text').textContent    = '';
  document.getElementById('dispute-meta').textContent           = '';
  document.getElementById('dispute-comments-list').innerHTML    = '<p class="text-sm text-gray-400 text-center py-4">Loading…</p>';
  document.getElementById('dispute-resolution-section').classList.add('hidden');
  document.getElementById('dispute-admin-controls').classList.add('hidden');
  document.getElementById('dispute-comment-area').classList.remove('hidden');
  modal.classList.remove('hidden');

  try {
    const dispute = await apiGet(`/api/deals/${dealId}/dispute`);
    if (!dispute) {
      document.getElementById('dispute-reason-text').textContent = 'No dispute found.';
      return;
    }

    _disputeId = dispute.id;

    // Status badge
    const badge = document.getElementById('dispute-status-badge');
    if (badge) {
      const colours = { open: 'bg-red-100 text-red-700', resolved: 'bg-green-100 text-green-700', closed: 'bg-gray-100 text-gray-600' };
      badge.className = `inline-block mt-0.5 text-xs font-semibold px-2.5 py-0.5 rounded-full ${colours[dispute.status] || colours.open}`;
      badge.textContent = dispute.status.charAt(0).toUpperCase() + dispute.status.slice(1);
    }

    // Meta + reason
    const filed = dispute.created_at ? new Date(dispute.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    document.getElementById('dispute-meta').textContent =
      `Filed by ${escHtml(dispute.filed_by_name)} (${dispute.filed_by_role}) · ${filed}`;
    document.getElementById('dispute-reason-text').textContent = dispute.reason;

    // Resolution
    if (dispute.resolution) {
      document.getElementById('dispute-resolution-section').classList.remove('hidden');
      document.getElementById('dispute-resolution-text').textContent = dispute.resolution;
    }

    // Comments
    const commentsEl = document.getElementById('dispute-comments-list');
    if (!dispute.comments || dispute.comments.length === 0) {
      commentsEl.innerHTML = '<p class="text-sm text-gray-400 text-center py-4">No messages yet.</p>';
    } else {
      commentsEl.innerHTML = dispute.comments.map(c => {
        const isMe = c.author_id === state.currentUser?.id;
        const time = c.created_at ? new Date(c.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
        const adminBadge = c.is_admin ? '<span class="ml-1 text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-semibold">Admin</span>' : '';
        return `
          <div class="flex ${isMe ? 'justify-end' : 'justify-start'}">
            <div class="max-w-xs">
              <div class="text-xs text-gray-500 mb-0.5 ${isMe ? 'text-right' : ''}">
                ${escHtml(c.author_name)}${adminBadge}
              </div>
              <div class="${isMe ? 'bg-pickle-600 text-white' : 'bg-gray-100 text-gray-800'} px-3 py-2 rounded-xl text-sm">
                ${escHtml(c.body)}
              </div>
              <div class="text-xs text-gray-400 mt-0.5 ${isMe ? 'text-right' : ''}">${time}</div>
            </div>
          </div>
        `;
      }).join('');
    }

    // Closed → hide comment box
    if (dispute.status === 'closed') {
      document.getElementById('dispute-comment-area').classList.add('hidden');
    }

    // Admin controls
    const isAdmin = ADMIN_EMAILS.includes(state.currentUser?.email);
    if (isAdmin && dispute.status !== 'closed') {
      document.getElementById('dispute-admin-controls').classList.remove('hidden');
      const resolutionInput = document.getElementById('dispute-admin-resolution');
      if (resolutionInput) resolutionInput.value = dispute.resolution || '';
    }
  } catch (err) {
    document.getElementById('dispute-reason-text').textContent = 'Failed to load dispute.';
    showToast(err.message || 'Could not load dispute', 'error');
  }
}

async function submitDisputeComment() {
  const body = (document.getElementById('dispute-comment-input')?.value || '').trim();
  if (!body) { showToast('Please enter a message.'); return; }
  try {
    await apiPost(`/api/disputes/${_disputeId}/comment`, { body });
    document.getElementById('dispute-comment-input').value = '';
    await openDisputeDetailModal(_disputeDealId);
  } catch (err) {
    showToast(err.message || 'Could not send message', 'error');
  }
}

async function resolveDispute(newStatus) {
  const resolution = (document.getElementById('dispute-admin-resolution')?.value || '').trim() || null;
  try {
    await apiPatch(`/api/disputes/${_disputeId}`, { status: newStatus, resolution });
    showToast(newStatus === 'resolved' ? '✅ Dispute marked resolved!' : '🔒 Dispute closed.', 'success');
    await openDisputeDetailModal(_disputeDealId);
    renderAdmin();
  } catch (err) {
    showToast(err.message || 'Could not update dispute', 'error');
  }
}

// ---------------------------------------------------------------------------
// Onboarding Wizard
// ---------------------------------------------------------------------------

const _ONBOARD_NICHES     = ['Tutorials & Tips','Pro Match Highlights','Gear Reviews','Comedy & Entertainment','Lifestyle & Fitness','News & Commentary'];
const _ONBOARD_SKILLS_LVL = ['Beginner (2.0-2.5)','Intermediate (3.0-3.5)','Advanced (4.0-4.5)','Pro (5.0+)'];
const _ONBOARD_SKILLS     = ['Short Form Video','Long Form Video','Editing','UGC','Photography','Live Streaming','Voice Overs','Podcast'];
const _ONBOARD_INDUSTRIES = ['Paddles & Equipment','Apparel','Footwear','Training & Coaching','Sports Nutrition','Accessories','Technology','Other'];

let _onboardUser         = null;
let _onboardStep         = 1;
let _onboardTotalSteps   = 3;
let _onboardNiche        = '';
let _onboardSkillLvl     = '';
let _onboardSkills       = [];
let _onboardIndustry     = '';

function _onboardPills(containerId, items, type, multi = false) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = items.map(item => {
    const fn = multi ? `onboardToggleSkill(this,'${item.replace(/'/g,"\\'")}')` : `onboardSelectPill(this,'${type}','${item.replace(/'/g,"\\'")}')`;
    return `<button type="button" onclick="${fn}"
      class="onboard-pill text-sm px-3 py-1.5 rounded-full border border-gray-300 text-gray-700 hover:border-pickle-500 hover:bg-pickle-50 transition-all">${item}</button>`;
  }).join('');
}

function startOnboarding(user) {
  // Only show for brand-new users; skip admins and returning users
  if (!user || ADMIN_EMAILS.includes(user.email)) return;
  if (localStorage.getItem(`onboarded_${user.id}`)) return;

  _onboardUser       = user;
  _onboardStep       = 1;
  _onboardNiche      = '';
  _onboardSkillLvl   = '';
  _onboardSkills     = [];
  _onboardIndustry   = '';

  const isCreator      = user.role === 'creator';
  _onboardTotalSteps   = isCreator ? 3 : 2;
  const firstName      = user.name.split(' ')[0];

  // ── Welcome step ──
  const emojiEl = document.getElementById('onboard-emoji');
  const titleEl = document.getElementById('onboard-title');
  const subEl   = document.getElementById('onboard-sub');
  const ctaEl   = document.getElementById('onboard-cta-btn');
  const bullEl  = document.getElementById('onboard-bullets');

  if (emojiEl) emojiEl.innerHTML = '<img src="logo.svg" alt="CourtCollab" class="w-16 h-16 mx-auto">';
  if (titleEl) titleEl.textContent = `Welcome, ${firstName}!`;
  if (subEl)   subEl.textContent   = isCreator
    ? "Let's get your creator profile ready — it only takes 2 minutes."
    : "Let's get your brand set up so you can start finding creators.";
  if (ctaEl)   ctaEl.textContent   = isCreator ? "Let's set it up →" : "Let's get started →";

  if (bullEl) {
    bullEl.innerHTML = isCreator
      ? `<div class="flex items-start gap-3"><span class="text-pickle-500 font-bold text-base mt-0.5">✓</span><div><strong class="text-gray-800 text-sm">Your profile is your media kit.</strong><p class="text-xs text-gray-500 mt-0.5">Brands discover you by niche, skill level, and audience size.</p></div></div>
         <div class="flex items-start gap-3"><span class="text-pickle-500 font-bold text-base mt-0.5">✓</span><div><strong class="text-gray-800 text-sm">Every deal builds your track record.</strong><p class="text-xs text-gray-500 mt-0.5">Completed campaigns and reviews appear on your public profile.</p></div></div>
         <div class="flex items-start gap-3"><span class="text-pickle-500 font-bold text-base mt-0.5">✓</span><div><strong class="text-gray-800 text-sm">Contracts, payments & protection built in.</strong><p class="text-xs text-gray-500 mt-0.5">Auto-generated contracts, escrow payments, and dispute support.</p></div></div>`
      : `<div class="flex items-start gap-3"><span class="text-pickle-500 font-bold text-base mt-0.5">✓</span><div><strong class="text-gray-800 text-sm">Browse verified pickleball creators.</strong><p class="text-xs text-gray-500 mt-0.5">Filter by niche, audience size, skill level, and rates.</p></div></div>
         <div class="flex items-start gap-3"><span class="text-pickle-500 font-bold text-base mt-0.5">✓</span><div><strong class="text-gray-800 text-sm">Post campaigns and get matched instantly.</strong><p class="text-xs text-gray-500 mt-0.5">Our AI scores creators against your brief and budget.</p></div></div>
         <div class="flex items-start gap-3"><span class="text-pickle-500 font-bold text-base mt-0.5">✓</span><div><strong class="text-gray-800 text-sm">Deals, contracts & payments in one place.</strong><p class="text-xs text-gray-500 mt-0.5">No more back-and-forth emails or chasing invoices.</p></div></div>`;
  }

  // ── Step 2 setup ──
  const s2Title  = document.getElementById('onboard-s2-title');
  const s2Sub    = document.getElementById('onboard-s2-sub');
  const s2Next   = document.getElementById('onboard-s2-next');
  const creatorF = document.getElementById('onboard-creator-fields');
  const brandF   = document.getElementById('onboard-brand-fields');

  if (isCreator) {
    if (s2Title) s2Title.textContent = 'What do you create?';
    if (s2Sub)   s2Sub.textContent   = 'Help brands understand your content and find you faster.';
    if (s2Next)  s2Next.textContent  = 'Next →';
    if (creatorF) creatorF.classList.remove('hidden');
    if (brandF)   brandF.classList.add('hidden');
    _onboardPills('onboard-niche-pills',  _ONBOARD_NICHES,     'niche');
    _onboardPills('onboard-skill-pills',  _ONBOARD_SKILLS_LVL, 'skill');
    _onboardPills('onboard-skills-pills', _ONBOARD_SKILLS,     'skills', true);
  } else {
    if (s2Title) s2Title.textContent = 'Tell us about your brand';
    if (s2Sub)   s2Sub.textContent   = 'Creators will see this when reviewing your campaign briefs.';
    if (s2Next)  s2Next.textContent  = 'Finish & go to dashboard';
    if (brandF)   brandF.classList.remove('hidden');
    if (creatorF) creatorF.classList.add('hidden');
    _onboardPills('onboard-industry-pills', _ONBOARD_INDUSTRIES, 'industry');
  }

  // ── Dot visibility ──
  const dot3 = document.getElementById('onboard-dot-3');
  if (dot3) dot3.style.display = isCreator ? '' : 'none';

  _onboardGoToStep(1);

  const overlay = document.getElementById('onboarding-overlay');
  if (overlay) {
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
  }
  document.body.style.overflow = 'hidden';
  document.documentElement.style.overflow = 'hidden';
}

function _onboardGoToStep(n) {
  _onboardStep = n;

  // Show correct step panel with animation
  for (let i = 1; i <= 3; i++) {
    const el = document.getElementById(`onboard-step-${i}`);
    if (!el) continue;
    if (i === n) {
      el.classList.remove('hidden');
      el.classList.add('onboard-step-visible');
    } else {
      el.classList.add('hidden');
      el.classList.remove('onboard-step-visible');
    }
  }

  // Progress bar
  const pct = Math.round((n / _onboardTotalSteps) * 100);
  const bar = document.getElementById('onboard-progress');
  if (bar) bar.style.width = pct + '%';

  // Step dots
  for (let i = 1; i <= 3; i++) {
    const dot = document.getElementById(`onboard-dot-${i}`);
    if (!dot) continue;
    if (i <= n) {
      dot.style.background = '#2F4F2F';
    } else {
      dot.style.background = '#e5e7eb';
    }
  }
}

function onboardSelectPill(btn, type, value) {
  // Single-select — reset siblings in same container
  btn.parentElement.querySelectorAll('.onboard-pill').forEach(p => p.classList.remove('onboard-pill-active'));
  btn.classList.add('onboard-pill-active');
  if (type === 'niche')    _onboardNiche    = value;
  if (type === 'skill')    _onboardSkillLvl = value;
  if (type === 'industry') _onboardIndustry = value;
}

function onboardToggleSkill(btn, skill) {
  const idx = _onboardSkills.indexOf(skill);
  if (idx >= 0) {
    _onboardSkills.splice(idx, 1);
    btn.classList.remove('onboard-pill-active');
  } else {
    _onboardSkills.push(skill);
    btn.classList.add('onboard-pill-active');
  }
}

async function onboardNext() {
  const isCreator = _onboardUser?.role === 'creator';

  if (_onboardStep === 1) {
    _onboardGoToStep(2);
    return;
  }

  if (_onboardStep === 2) {
    if (isCreator) {
      // Save step 2 — best-effort, non-blocking
      _onboardSaveCreatorStep2();
      _onboardGoToStep(3);
    } else {
      // Brand: step 2 is final
      await _onboardSaveBrand();
      _onboardClose(true);
    }
  }
}

function onboardBack() {
  if (_onboardStep > 1) _onboardGoToStep(_onboardStep - 1);
}

async function onboardFinish() {
  // Save step 3 (creator audience & rates)
  try {
    const ig  = parseInt(document.getElementById('onboard-ig')?.value  || '0') || 0;
    const tt  = parseInt(document.getElementById('onboard-tt')?.value  || '0') || 0;
    const yt  = parseInt(document.getElementById('onboard-yt')?.value  || '0') || 0;
    const eng = parseFloat(document.getElementById('onboard-engagement')?.value || '0') || 0;
    const rIg  = parseInt(document.getElementById('onboard-rate-ig')?.value  || '0') || 0;
    const rTt  = parseInt(document.getElementById('onboard-rate-tt')?.value  || '0') || 0;
    const rYt  = parseInt(document.getElementById('onboard-rate-yt')?.value  || '0') || 0;
    const rUgc = parseInt(document.getElementById('onboard-rate-ugc')?.value  || '0') || 0;
    const payload = {};
    if (ig)   payload.followers_ig    = ig;
    if (tt)   payload.followers_tt    = tt;
    if (yt)   payload.followers_yt    = yt;
    if (eng)  payload.engagement_rate = eng;
    if (rIg)  payload.rate_ig         = rIg;
    if (rTt)  payload.rate_tiktok     = rTt;
    if (rYt)  payload.rate_yt         = rYt;
    if (rUgc) payload.rate_ugc        = rUgc;
    if (Object.keys(payload).length) await apiPut('/api/creator/profile', payload);
  } catch (_) { /* best-effort */ }
  _onboardClose(true);
}

function onboardSkip() {
  _onboardClose(false);
}

function _onboardClose(saved = false) {
  if (_onboardUser) localStorage.setItem(`onboarded_${_onboardUser.id}`, '1');
  const overlay = document.getElementById('onboarding-overlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
  document.documentElement.style.overflow = '';
  _onboardUser = null;
  if (saved) showToast('Profile saved! Welcome to CourtCollab', 'success');
}

function _onboardSaveCreatorStep2() {
  try {
    const location = document.getElementById('onboard-location')?.value.trim() || '';
    const bio      = document.getElementById('onboard-bio')?.value.trim() || '';
    const payload  = {};
    if (_onboardNiche)             payload.niche       = _onboardNiche;
    if (_onboardSkillLvl)          payload.skill_level = _onboardSkillLvl;
    if (_onboardSkills.length)     payload.skills      = _onboardSkills;
    if (location)                  payload.location    = location;
    if (bio)                       payload.bio         = bio;
    if (Object.keys(payload).length) apiPut('/api/creator/profile', payload).catch(() => {});
  } catch (_) { /* best-effort */ }
}

async function _onboardSaveBrand() {
  try {
    const website    = document.getElementById('onboard-website')?.value.trim() || '';
    const budgetMin  = parseInt(document.getElementById('onboard-budget-min')?.value || '0') || 0;
    const budgetMax  = parseInt(document.getElementById('onboard-budget-max')?.value || '0') || 0;
    const desc       = document.getElementById('onboard-brand-desc')?.value.trim() || '';
    const payload = {};
    if (_onboardIndustry) payload.industry    = _onboardIndustry;
    if (website)          payload.website     = website;
    if (budgetMin)        payload.budget_min  = budgetMin;
    if (budgetMax)        payload.budget_max  = budgetMax;
    if (desc)             payload.description = desc;
    if (Object.keys(payload).length) await apiPut('/api/brand/profile', payload);
  } catch (_) { /* best-effort */ }
}

// --- Contact ---
function renderContact() {
  const form = document.getElementById('contact-form');
  if (!form) return;
  const newForm = form.cloneNode(true);
  form.parentNode.replaceChild(newForm, form);
  newForm.addEventListener('submit', submitContact);
}

function submitContact(e) {
  e.preventDefault();
  const banner = document.getElementById('contact-success');
  if (banner) {
    banner.classList.remove('hidden');
    banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  e.target.reset();
}

// --- Admin Dashboard ---
let _adminUsers = [];

async function renderAdmin() {
  const listEl = document.getElementById('admin-user-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="px-6 py-12 text-center text-gray-400">Loading users…</div>';

  // Fetch all data in parallel
  const [usersResult, paymentsResult, dealsResult, messagesResult, disputesResult] = await Promise.allSettled([
    apiGet('/api/admin/users'),
    apiGet('/api/payments'),
    apiGet('/api/deals'),
    apiGet('/api/messages'),
    apiGet('/api/admin/disputes'),
  ]);

  // ── Users ──
  if (usersResult.status === 'rejected') {
    listEl.innerHTML = `<div class="px-6 py-10 text-center text-red-500">Failed to load users: ${usersResult.reason?.message}</div>`;
    return;
  }
  _adminUsers = usersResult.value;

  const creators = _adminUsers.filter(u => u.role === 'creator').length;
  const brands   = _adminUsers.filter(u => u.role === 'brand').length;
  const totalEl    = document.getElementById('admin-stat-total');
  const creatorsEl = document.getElementById('admin-stat-creators');
  const brandsEl   = document.getElementById('admin-stat-brands');
  if (totalEl)    totalEl.textContent    = _adminUsers.length;
  if (creatorsEl) creatorsEl.textContent = creators;
  if (brandsEl)   brandsEl.textContent   = brands;

  // ── Revenue & Payments ──
  const payments = paymentsResult.status === 'fulfilled' ? (paymentsResult.value || []) : [];
  const completedPayments = payments.filter(p => p.status === 'completed' || p.status === 'released' || p.status === 'held');
  const failedPayments    = payments.filter(p => p.status === 'failed' || p.status === 'refunded');
  const totalRevenue = completedPayments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const platformFees = totalRevenue * 0.15;

  const revenueEl = document.getElementById('admin-stat-revenue');
  const feesEl    = document.getElementById('admin-stat-fees');
  if (revenueEl) revenueEl.textContent = '$' + totalRevenue.toLocaleString('en-US', {minimumFractionDigits: 0, maximumFractionDigits: 0});
  if (feesEl)    feesEl.textContent    = '$' + platformFees.toLocaleString('en-US', {minimumFractionDigits: 0, maximumFractionDigits: 0});

  // Failed payments panel
  const failedEl    = document.getElementById('admin-failed-payments');
  const failedCount = document.getElementById('admin-failed-count');
  if (failedCount) failedCount.textContent = failedPayments.length ? `${failedPayments.length} issue${failedPayments.length > 1 ? 's' : ''}` : 'None';
  if (failedEl) {
    if (!failedPayments.length) {
      failedEl.innerHTML = '<div class="px-6 py-8 text-center text-gray-400 text-sm flex flex-col items-center gap-2"><span class="text-2xl">✅</span>No failed payments</div>';
    } else {
      failedEl.innerHTML = failedPayments.map(p => `
        <div class="flex items-center gap-3 px-6 py-3">
          <div class="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
            <svg class="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-gray-900 truncate">${escHtml(p.creator_name || p.brand_name || 'Unknown')}</p>
            <p class="text-xs text-gray-400">${p.created_at ? p.created_at.slice(0,10) : ''} · ${escHtml(p.status)}</p>
          </div>
          <span class="text-sm font-bold text-red-500">$${(parseFloat(p.amount)||0).toLocaleString()}</span>
        </div>
      `).join('');
    }
  }

  // ── Deals ──
  const deals = dealsResult.status === 'fulfilled' ? (dealsResult.value || []) : [];
  const activeDeals    = deals.filter(d => d.status === 'active' || d.status === 'pending').length;
  const completedDeals = deals.filter(d => d.status === 'completed').length;
  const dealsActiveEl = document.getElementById('admin-stat-deals-active');
  const dealsDoneEl   = document.getElementById('admin-stat-deals-done');
  if (dealsActiveEl) dealsActiveEl.textContent = activeDeals;
  if (dealsDoneEl)   dealsDoneEl.textContent   = `${completedDeals} completed`;

  // ── Messages ──
  const messages = messagesResult.status === 'fulfilled' ? (messagesResult.value || []) : [];
  const msgCount = Array.isArray(messages) ? messages.length : 0;
  const msgEl = document.getElementById('admin-stat-messages');
  if (msgEl) msgEl.textContent = msgCount.toLocaleString();

  // ── Disputes ──
  const disputesEl    = document.getElementById('admin-disputes-list');
  const disputeCount  = document.getElementById('admin-disputes-count');
  const disputes      = disputesResult.status === 'fulfilled' ? (disputesResult.value || []) : [];
  const openDisputes  = disputes.filter(d => d.status === 'open');
  if (disputeCount) {
    disputeCount.textContent = openDisputes.length ? `${openDisputes.length} open` : 'None';
    disputeCount.className = `text-xs font-semibold px-2 py-0.5 rounded-full ${openDisputes.length ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'}`;
  }
  if (disputesEl) {
    if (!disputes.length) {
      disputesEl.innerHTML = '<div class="px-6 py-8 text-center text-gray-400 text-sm flex flex-col items-center gap-2"><span class="text-2xl">✅</span>No disputes filed</div>';
    } else {
      disputesEl.innerHTML = disputes.map(d => {
        const statusColour = { open: 'bg-red-100 text-red-700', resolved: 'bg-green-100 text-green-700', closed: 'bg-gray-100 text-gray-600' };
        const sc = statusColour[d.status] || statusColour.open;
        const date = d.created_at ? d.created_at.slice(0, 10) : '';
        const reasonSnippet = (d.reason || '').slice(0, 120) + ((d.reason || '').length > 120 ? '…' : '');
        return `
          <div class="flex items-start gap-4 px-6 py-4 hover:bg-gray-50 transition">
            <div class="w-9 h-9 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0 text-base">🚩</div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap mb-0.5">
                <span class="font-semibold text-gray-900 text-sm">Deal #${d.deal_id}</span>
                <span class="text-xs ${sc} px-2 py-0.5 rounded-full font-semibold">${d.status}</span>
                <span class="text-xs text-gray-400">${escHtml(d.campaign_title || '')}</span>
              </div>
              <p class="text-xs text-gray-500 mb-1">
                Filed by <strong>${escHtml(d.filed_by_name)}</strong> (${d.filed_by_role}) ·
                ${escHtml(d.brand_name)} ↔ ${escHtml(d.creator_name)} · ${date}
                ${d.comment_count > 0 ? `· <span class="text-pickle-600">${d.comment_count} message${d.comment_count > 1 ? 's' : ''}</span>` : ''}
              </p>
              <p class="text-xs text-gray-600 line-clamp-2">${escHtml(reasonSnippet)}</p>
            </div>
            <button onclick="openDisputeDetailModal(${d.deal_id})"
              class="text-xs bg-pickle-600 text-white px-3 py-1.5 rounded-lg hover:bg-pickle-700 transition font-medium whitespace-nowrap flex-shrink-0">
              ${d.status === 'open' ? 'Review' : 'View'}
            </button>
          </div>
        `;
      }).join('');
    }
  }

  // ── Recent Signups ──
  const signupsEl = document.getElementById('admin-recent-signups');
  if (signupsEl) {
    const recent = [..._adminUsers]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 10);
    if (!recent.length) {
      signupsEl.innerHTML = '<div class="px-6 py-8 text-center text-gray-400 text-sm">No users yet</div>';
    } else {
      signupsEl.innerHTML = recent.map(u => {
        const roleColor = u.role === 'creator' ? 'bg-pickle-100 text-pickle-700' : 'bg-brand-100 text-brand-700';
        return `
          <div class="flex items-center gap-3 px-6 py-3">
            <div class="w-8 h-8 rounded-full ${roleColor} flex items-center justify-center flex-shrink-0 text-xs font-bold">
              ${(u.name || '?').slice(0,2).toUpperCase()}
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-gray-900 truncate">${escHtml(u.name)}</p>
              <p class="text-xs text-gray-400 truncate">${escHtml(u.email)}</p>
            </div>
            <div class="text-right flex-shrink-0">
              <span class="text-xs font-medium px-2 py-0.5 rounded-full ${roleColor}">${u.role}</span>
              <p class="text-xs text-gray-400 mt-0.5">${u.created_at ? timeSince(u.created_at) : ''}</p>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  if (!_adminUsers.length) {
    listEl.innerHTML = '<div class="px-6 py-12 text-center text-gray-400">No users found.</div>';
    return;
  }

  listEl.innerHTML = _adminUsers.map(u => {
    const isAdmin  = ADMIN_EMAILS.includes(u.email);
    const roleColor = u.role === 'creator' ? 'bg-pickle-100 text-pickle-700' : 'bg-brand-100 text-brand-700';
    const followers = u.role === 'creator'
      ? [u.followers_ig, u.followers_tt, u.followers_yt].filter(Boolean)
      : [];
    const followerStr = followers.length ? `· ${fmtNum(Math.max(...followers))} followers` : '';
    const subtext = u.role === 'brand'
      ? (u.company_name || 'No company name') + (u.niche ? ` · ${u.niche}` : '')
      : (u.niche || 'No niche set') + followerStr;

    return `
    <div class="flex items-center gap-4 px-6 py-4 hover:bg-gray-50 transition" id="admin-row-${u.id}">
      <input type="checkbox" class="admin-user-check w-4 h-4 rounded border-gray-300 text-red-500 cursor-pointer flex-shrink-0"
        value="${u.id}" onchange="adminUpdateSelection()" ${isAdmin ? 'disabled title="Cannot delete admin"' : ''}>
      <div class="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 font-bold text-sm
        ${u.role === 'creator' ? 'bg-pickle-100 text-pickle-700' : 'bg-brand-100 text-brand-700'}">
        ${(u.name || '?').slice(0, 2).toUpperCase()}
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-semibold text-gray-900 truncate">${escHtml(u.name)}</span>
          <span class="tag ${roleColor} text-xs">${u.role}</span>
          ${isAdmin ? '<span class="tag bg-red-100 text-red-700 text-xs">admin</span>' : ''}
        </div>
        <p class="text-xs text-gray-400 truncate">${escHtml(u.email)} · ${escHtml(subtext)}</p>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <div class="text-xs text-gray-400 hidden sm:block whitespace-nowrap">
          #${u.id} · ${fmtDateUTC(u.created_at)}
        </div>
        <button onclick="adminViewUser(${u.id})"
          class="text-xs font-medium text-pickle-600 hover:text-pickle-800 border border-pickle-200 hover:border-pickle-400 bg-pickle-50 hover:bg-pickle-100 px-3 py-1.5 rounded-lg transition whitespace-nowrap">
          View Profile
        </button>
      </div>
    </div>`;
  }).join('');

  adminUpdateSelection();
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function adminToggleAll(checked) {
  document.querySelectorAll('.admin-user-check:not([disabled])').forEach(cb => {
    cb.checked = checked;
  });
  adminUpdateSelection();
}

function adminUpdateSelection() {
  const checked = [...document.querySelectorAll('.admin-user-check:checked')];
  const count   = checked.length;
  const deleteBtn  = document.getElementById('admin-delete-btn');
  const countEl    = document.getElementById('admin-selected-count');
  const statSelEl  = document.getElementById('admin-stat-selected');
  if (deleteBtn)  deleteBtn.classList.toggle('hidden', count === 0);
  if (countEl)    countEl.textContent   = count;
  if (statSelEl)  statSelEl.textContent = count;
}

async function deleteSelectedUsers() {
  const checked = [...document.querySelectorAll('.admin-user-check:checked')];
  const ids     = checked.map(cb => parseInt(cb.value));
  if (!ids.length) return;

  const names = ids.map(id => {
    const u = _adminUsers.find(u => u.id === id);
    return u ? u.name : `#${id}`;
  });

  const ok = confirm(
    `Permanently delete ${ids.length} user${ids.length > 1 ? 's' : ''}?\n\n` +
    names.join(', ') +
    '\n\nThis cannot be undone. All their profiles, deals, and messages will be removed.'
  );
  if (!ok) return;

  try {
    const result = await apiDelete('/api/admin/users', { ids });
    showToast(`✓ Deleted ${result.deleted} user${result.deleted !== 1 ? 's' : ''}`);
    renderAdmin();
  } catch (err) {
    showToast(err.message || 'Delete failed', 'error');
  }
}

async function adminDeleteOne(userId) {
  const u = _adminUsers.find(u => u.id === userId);
  if (!u) return;
  if (ADMIN_EMAILS.includes(u.email)) {
    showToast('Admin accounts cannot be deleted.', 'error');
    return;
  }
  const ok = confirm(`Permanently delete ${u.name}?\n\nThis cannot be undone. Their profile, deals, and messages will be removed.`);
  if (!ok) return;
  try {
    const result = await apiDelete('/api/admin/users', { ids: [userId] });
    showToast(`✓ ${u.name} has been deleted.`);
    renderAdmin();
  } catch (err) {
    showToast(err.message || 'Delete failed', 'error');
  }
}

async function apiDelete(path, body, opts = {}) {
  if (opts.loading) showLoading(opts.msg || 'Deleting…');
  try {
    const token = getToken();
    const res = await fetch(API + path, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': 'Bearer ' + token } : {})
      },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(_extractDetail(data));
    return data;
  } finally { if (opts.loading) hideLoading(); }
}

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  const roleEl = document.getElementById('user-role');
  if (roleEl) roleEl.value = state.role;
  highlightRole();
  handleStripeReturn();

  // Handle password reset link (?reset_token=...)
  const resetToken = new URLSearchParams(window.location.search).get('reset_token');
  if (resetToken) {
    showAuthGate();
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('signup-form').style.display = 'none';
    document.getElementById('reset-password-form').style.display = 'block';
    return;
  }

  // Wire star picker for rating modal
  document.querySelectorAll('.star-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _ratingScore = parseInt(btn.dataset.val);
      document.querySelectorAll('.star-btn').forEach(b => {
        const v = parseInt(b.dataset.val);
        b.classList.toggle('text-yellow-400', v <= _ratingScore);
        b.classList.toggle('text-gray-200',   v >  _ratingScore);
      });
    });
    btn.addEventListener('mouseenter', () => {
      const hv = parseInt(btn.dataset.val);
      document.querySelectorAll('.star-btn').forEach(b => {
        const v = parseInt(b.dataset.val);
        b.classList.toggle('text-yellow-400', v <= hv);
        b.classList.toggle('text-gray-200',   v >  hv);
      });
    });
    btn.addEventListener('mouseleave', () => {
      document.querySelectorAll('.star-btn').forEach(b => {
        const v = parseInt(b.dataset.val);
        b.classList.toggle('text-yellow-400', v <= _ratingScore);
        b.classList.toggle('text-gray-200',   v >  _ratingScore);
      });
    });
  });

  // Dismiss splash after auth resolves
  const dismissSplash = () => {
    const splash = document.getElementById('app-splash');
    if (!splash) return;
    splash.classList.add('fade-out');
    setTimeout(() => splash.remove(), 420);
  };

  if (getToken()) {
    try {
      const user = await apiGet('/api/me', { silent: true });
      onAuthSuccess(user);
    } catch {
      clearToken();
      showAuthGate();
    }
  } else {
    showAuthGate();
  }
  dismissSplash();
});
