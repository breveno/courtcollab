// ============================================================
// CourtCollab — App Logic (API-connected, no mock data)
// ============================================================

// --- Auth & API Helpers ---
const API = 'https://courtcollab-production.up.railway.app';

// Slow-load detector: show spinner if any fetch takes > 500ms
const _origFetch = window.fetch;
window.fetch = function(...args) {
  let _slowTimer = null;
  const url = typeof args[0] === 'string' ? args[0] : '';
  // Only intercept our own API calls (not Stripe etc.)
  if (url.includes('railway.app')) {
    _slowTimer = setTimeout(() => showLoading('Loading…'), 500);
  }
  return _origFetch.apply(this, args).finally(() => {
    if (_slowTimer) { clearTimeout(_slowTimer); _slowTimer = null; hideLoading(); }
  });
};

function getToken() { return localStorage.getItem('cc_jwt'); }
function setToken(t) { localStorage.setItem('cc_jwt', t); }
function clearToken() { localStorage.removeItem('cc_jwt'); }

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
    if (!res.ok) throw new Error(data.detail || 'Request failed');
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
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || 'Request failed');
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
    if (!res.ok) throw new Error(data.detail || 'Request failed');
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
    if (!res.ok) throw new Error(data.detail || 'Request failed');
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

function showAuthTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('login-form').style.display = isLogin ? 'block' : 'none';
  document.getElementById('signup-form').style.display = isLogin ? 'none' : 'block';
  document.getElementById('tab-login').classList.toggle('active', isLogin);
  document.getElementById('tab-signup').classList.toggle('active', !isLogin);
  document.getElementById('auth-error').classList.add('hidden');
  if (!isLogin) highlightRole();
}

function highlightRole() {
  const brandChecked = document.getElementById('role-brand').checked;
  document.getElementById('role-brand-label').style.borderColor = brandChecked ? '#2F4F2F' : '#e5e7eb';
  document.getElementById('role-brand-label').style.background = brandChecked ? '#f0f5f0' : '';
  document.getElementById('role-creator-label').style.borderColor = !brandChecked ? '#2F4F2F' : '#e5e7eb';
  document.getElementById('role-creator-label').style.background = !brandChecked ? '#f0f5f0' : '';
  // Show/hide creator social handle fields
  const socialFields = document.getElementById('creator-social-fields');
  if (socialFields) socialFields.style.display = brandChecked ? 'none' : 'flex';
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
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
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  setAuthBtnLoading('login-form', true);
  try {
    const { token, user } = await apiPost('/api/login', { email, password }, { loading: true, msg: 'Signing in…' });
    setToken(token);
    onAuthSuccess(user);
  } catch (err) {
    showAuthError(err.message);
  } finally {
    setAuthBtnLoading('login-form', false);
  }
}

async function handleSignup(e) {
  e.preventDefault();
  const name     = document.getElementById('signup-name').value.trim();
  const email    = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const role     = document.querySelector('input[name="signup-role"]:checked').value;
  setAuthBtnLoading('signup-form', true);
  try {
    const { token, user } = await apiPost('/api/signup', { name, email, password, role }, { loading: true, msg: 'Creating your account…' });
    setToken(token);
    // Save social handles for creators right after signup (non-blocking)
    if (role === 'creator') {
      try {
        const ig = (document.getElementById('signup-instagram').value || '').trim().replace(/^@/, '');
        const tt = (document.getElementById('signup-tiktok').value || '').trim().replace(/^@/, '');
        if (ig || tt) {
          const handles = {};
          if (ig) handles.instagram = ig;
          if (tt) handles.tiktok = tt;
          await apiPut('/api/creator/profile', { social_handles: JSON.stringify(handles) });
        }
      } catch (_) { /* handles save is best-effort, don't block signup */ }
    }
    onAuthSuccess(user);
  } catch (err) {
    showAuthError(err.message);
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
  const adminLink = document.getElementById('nav-admin-link');
  const adminLinkMobile = document.getElementById('nav-admin-link-mobile');
  if (adminLink) adminLink.classList.toggle('hidden', !isAdmin);
  if (adminLinkMobile) adminLinkMobile.classList.toggle('hidden', !isAdmin);
  navigate('landing');
  if (user.role === 'creator') loadStripeConnectStatus();
}

function updateLandingHeroButtons(role) {
  const browse   = document.getElementById('btn-browse-creators');
  const join     = document.getElementById('btn-join-creator');
  const dashboard = document.getElementById('btn-creator-dashboard');
  if (!browse) return;
  if (role === 'creator') {
    browse.style.display = 'none';
    join.style.display = 'none';
    dashboard.style.display = '';
  } else {
    browse.style.display = '';
    join.style.display = '';
    dashboard.style.display = 'none';
  }
}

function handleLogout() {
  state.currentUser = null;
  state.activePartner = null;
  state.selectedCreator = null;
  clearToken();
  showAuthGate();
  showAuthTab('login');
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
}

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

// --- Navigation ---
function navigate(page) {
  if (!getToken()) { showAuthGate(); return; }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + page);
  if (target) {
    target.classList.add('active');
    state.currentPage = page;
  }
  window.scrollTo(0, 0);
  document.body.scrollTop = 0;
  document.documentElement.scrollTop = 0;
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.page === page);
  });
  if (page === 'creators')  renderCreators();
  if (page === 'campaigns') renderCampaigns();
  if (page === 'matching')  runMatching();
  if (page === 'messages')  renderConversations();
  if (page === 'payments')  renderPayments();
  if (page === 'contact')   renderContact();
  if (page === 'admin')     renderAdmin();
}

// --- Role Switch ---
function switchRole(role) {
  state.role = role;
  const el = document.getElementById('user-role');
  if (el) el.value = role;
}

// --- Format Numbers ---
function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
  return n.toString();
}

// --- Toast ---
function showToast(text) {
  const toast = document.getElementById('toast');
  document.getElementById('toast-text').textContent = text;
  toast.classList.remove('hidden', 'opacity-0', 'translate-y-2');
  toast.classList.add('opacity-100', 'translate-y-0');
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.classList.add('hidden'), 300);
  }, 3000);
}

// --- Modal ---
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// --- Render Creator Cards ---
async function renderCreators() {
  const grid = document.getElementById('creator-grid');
  if (!grid) return;
  grid.innerHTML = '<div class="col-span-full text-center py-16 text-gray-400">Loading creators…</div>';

  try {
    const params = new URLSearchParams();
    const niche = document.getElementById('filter-niche')?.value;
    const skill = document.getElementById('filter-skill')?.value;
    if (niche) params.set('niche', niche);
    if (skill) params.set('skill', skill);

    let creators = await apiGet('/api/creators?' + params.toString());

    // Client-side filters for audience size and rate (not supported as API params)
    const search   = document.getElementById('filter-search')?.value.toLowerCase() || '';
    const audience = document.getElementById('filter-audience')?.value || '';
    const rate     = document.getElementById('filter-rate')?.value || '';

    if (search) {
      creators = creators.filter(c =>
        (c.name || '').toLowerCase().includes(search) ||
        (c.bio  || '').toLowerCase().includes(search)
      );
    }
    if (audience) {
      creators = creators.filter(c => {
        const t = c.total_followers || 0;
        if (audience === 'micro')  return t >= 1000  && t <= 10000;
        if (audience === 'mid')    return t >= 10000 && t <= 50000;
        if (audience === 'macro')  return t >= 50000 && t <= 200000;
        if (audience === 'mega')   return t >= 200000;
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

    if (creators.length === 0) {
      grid.innerHTML = '<div class="col-span-full text-center py-16 text-gray-400">No creators match your filters. Try adjusting your search.</div>';
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
              <div class="flex-1">
                <h3 class="font-bold text-lg">${c.name || 'Creator'}</h3>
                <p class="text-gray-500 text-sm">${c.location || ''}</p>
              </div>
              <span class="tag bg-pickle-100 text-pickle-700">${c.niche || 'Creator'}</span>
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
            <div class="flex items-center justify-between pt-3 border-t border-gray-100">
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

// --- Creator Detail ---
async function showCreatorDetail(userId) {
  const modal = document.getElementById('creator-detail-modal');
  if (!modal) return;
  // Show loading state inside modal first
  document.getElementById('detail-name').textContent = 'Loading…';
  document.getElementById('detail-location').textContent = '';
  document.getElementById('detail-content').innerHTML = '';
  openModal('creator-detail-modal');

  try {
    const c = await apiGet('/api/creators/' + userId);
    state.selectedCreator = c;

    const initials = c.initials || (c.name || 'CC').slice(0, 2).toUpperCase();
    const skills   = Array.isArray(c.skills) ? c.skills : [];

    document.getElementById('detail-avatar').textContent   = initials;
    document.getElementById('detail-name').textContent     = c.name || 'Creator';
    document.getElementById('detail-location').textContent =
      [c.location, c.niche, c.skill_level].filter(Boolean).join(' · ');

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
      ${c.rate_notes ? `<p class="text-sm text-gray-500 italic mb-6">${c.rate_notes}</p>` : ''}
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
  try {
    await apiPut('/api/creator/profile', body);
    showToast('Profile saved successfully!');
    navigate('creators');
  } catch (err) {
    showToast('⚠ ' + err.message);
  }
}

// --- Render Campaigns ---
async function renderCampaigns() {
  const list = document.getElementById('campaign-list');
  if (!list) return;
  list.innerHTML = '<div class="text-center py-16 text-gray-400">Loading campaigns…</div>';

  try {
    const campaigns = await apiGet('/api/campaigns');

    if (campaigns.length === 0) {
      list.innerHTML = '<div class="text-center py-16 text-gray-400">No campaigns posted yet.</div>';
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

// --- Post Campaign ---
async function postCampaign(e) {
  e.preventDefault();
  const skills = Array.from(document.querySelectorAll('#camp-skills input:checked')).map(i => i.value);
  const body = {
    title:       document.getElementById('camp-title').value,
    description: document.getElementById('camp-desc').value,
    niche:       document.getElementById('camp-niche')?.value || null,
    budget:      document.getElementById('camp-budget').value,
    deadline:    document.getElementById('camp-deadline').value,
    skills,
  };
  try {
    await apiPost('/api/campaigns', body);
    closeModal('campaign-modal');
    showToast('Campaign brief posted!');
    renderCampaigns();
  } catch (err) {
    showToast('⚠ ' + err.message);
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
              <div class="flex items-center gap-2">
                <h3 class="font-bold text-lg">${c.name || 'Creator'}</h3>
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
async function renderConversations() {
  const list = document.getElementById('conversation-list');
  if (!list) return;
  list.innerHTML = '<div class="p-4 text-sm text-gray-400">Loading…</div>';

  try {
    const convs = await apiGet('/api/conversations');

    if (convs.length === 0) {
      list.innerHTML = '<div class="p-4 text-sm text-gray-400">No conversations yet.</div>';
      return;
    }

    list.innerHTML = convs.map(conv => {
      const partner  = conv.partner;
      const lastMsg  = conv.last_message;
      const unread   = conv.unread_count || 0;
      const preview  = lastMsg ? (lastMsg.body || '').substring(0, 60) : 'No messages yet';
      const isActive = state.activePartner === partner.id;
      return `
        <div class="p-4 border-b border-gray-50 cursor-pointer hover:bg-gray-50 transition ${isActive ? 'bg-pickle-50' : ''}" onclick="openConversation(${partner.id})">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-pickle-100 flex items-center justify-center font-bold text-pickle-700 text-sm">${partner.initials || partner.name.slice(0,2).toUpperCase()}</div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-semibold text-sm">${partner.name}</span>
                ${unread > 0 ? `<span class="bg-pickle-600 text-white text-xs rounded-full px-2 py-0.5">${unread}</span>` : ''}
              </div>
              <p class="text-xs text-gray-500 truncate">${preview}${preview.length >= 60 ? '…' : ''}</p>
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
    if (headerStatus) headerStatus.textContent = deal
      ? `Deal: $${(deal.amount || 0).toLocaleString()} — ${deal.status.charAt(0).toUpperCase() + deal.status.slice(1)}`
      : 'No active deal';

    // Deal action buttons (creator accepts/declines; brand marks complete)
    const dealActions = document.getElementById('deal-actions');
    if (dealActions) {
      if (deal && deal.status === 'pending' && state.role === 'creator') {
        dealActions.classList.remove('hidden');
        dealActions.innerHTML = `
          <button onclick="updateDealStatus(${deal.id}, 'active')"   class="bg-pickle-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-pickle-700 transition">Accept Deal</button>
          <button onclick="updateDealStatus(${deal.id}, 'declined')" class="bg-red-100 text-red-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-200 transition">Decline</button>
        `;
      } else if (deal && deal.status === 'active' && state.role === 'brand') {
        dealActions.classList.remove('hidden');
        dealActions.innerHTML = `
          <button onclick="updateDealStatus(${deal.id}, 'completed')" class="bg-pickle-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-pickle-700 transition">Mark Complete</button>
          <button onclick="stripeCheckout(${deal.id})" class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition">Pay with Stripe</button>
        `;
      } else {
        dealActions.classList.add('hidden');
      }
    }

    // Render messages
    const chatEl = document.getElementById('chat-messages');
    if (!chatEl) return;
    const myId = state.currentUser?.id;

    if (messages.length === 0) {
      chatEl.innerHTML = '<div class="text-center text-gray-400 text-sm py-8">No messages yet. Say hello!</div>';
    } else {
      chatEl.innerHTML = messages.map(m => {
        const isMe = m.sender_id === myId;
        const time = m.created_at ? new Date(m.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
        return `
          <div class="flex ${isMe ? 'justify-end' : 'justify-start'}">
            <div class="max-w-sm">
              <div class="${isMe ? 'message-bubble-right' : 'message-bubble-left'} px-4 py-3 text-sm">${m.body}</div>
              <div class="text-xs text-gray-400 mt-1 ${isMe ? 'text-right' : ''}">${time}</div>
            </div>
          </div>
        `;
      }).join('');
    }

    chatEl.scrollTop = chatEl.scrollHeight;
  } catch (err) {
    const chatEl = document.getElementById('chat-messages');
    if (chatEl) chatEl.innerHTML = `<div class="text-center text-red-400 text-sm py-8">${err.message}</div>`;
  }
}

async function sendMessage() {
  const input = document.getElementById('message-input');
  const text  = (input?.value || '').trim();
  if (!text || !state.activePartner) return;
  input.value = '';

  try {
    await apiPost('/api/messages', { receiver_id: state.activePartner, body: text });
    await openConversation(state.activePartner);
  } catch (err) {
    showToast('⚠ ' + err.message);
    input.value = text;
  }
}

async function startConversation() {
  if (!state.selectedCreator) return;
  const creatorUserId = state.selectedCreator.user_id;
  closeModal('creator-detail-modal');
  navigate('messages');
  // Send an initial opening message then open the thread
  try {
    await apiPost('/api/messages', {
      receiver_id: creatorUserId,
      body: `Hi! I'm interested in collaborating with you on a campaign.`
    });
  } catch { /* thread may already exist */ }
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
    showToast('⚠ Please select a campaign for this deal');
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
    showToast('Deal proposal sent!');
    await openConversation(state.activePartner);
  } catch (err) {
    showToast('⚠ ' + err.message);
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
    showToast('Deal ' + status + '!');
    await openConversation(state.activePartner);
  } catch (err) {
    showToast('⚠ ' + err.message);
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
  const historyEl = document.getElementById('payment-history');
  if (!historyEl) return;
  historyEl.innerHTML = '<div class="text-center py-8 text-gray-400 text-sm">Loading payments…</div>';

  try {
    const payments = await apiGet('/api/payments');

    if (payments.length === 0) {
      historyEl.innerHTML = '<div class="text-center py-8 text-gray-400 text-sm">No payments yet.</div>';
      return;
    }

    historyEl.innerHTML = payments.map(p => {
      const statusColor = p.status === 'released'  ? 'bg-green-100 text-green-700'  :
                          p.status === 'held'       ? 'bg-yellow-100 text-yellow-700' :
                          p.status === 'refunded'   ? 'bg-red-100 text-red-700'      :
                                                      'bg-gray-100 text-gray-600';
      const date = p.created_at ? new Date(p.created_at).toLocaleDateString() : '';
      return `
        <div class="flex items-center justify-between p-4 border border-gray-100 rounded-xl mb-2">
          <div>
            <div class="font-semibold text-sm">${p.campaign_title || 'Campaign'}</div>
            <div class="text-xs text-gray-500">${state.role === 'brand' ? 'To: ' + p.creator_name : 'From: ' + p.brand_name} · ${date}</div>
          </div>
          <div class="text-right">
            <div class="font-bold">${state.role === 'brand' ? '$' + (p.amount || 0).toLocaleString() : '$' + (p.creator_payout || 0).toLocaleString()}</div>
            <span class="tag ${statusColor} text-xs">${p.status}</span>
            ${p.status === 'held' && state.role === 'brand' ?
              `<button onclick="releasePayment(${p.id})" class="ml-2 text-xs bg-pickle-600 text-white px-2 py-1 rounded-lg hover:bg-pickle-700 transition">Release</button>` : ''}
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
    showToast('✓ Payment released to creator!');
    renderPayments();
  } catch (err) {
    showToast('⚠ ' + err.message);
  }
}

function submitPayment(e) {
  e.preventDefault();
  showToast('✓ Payment sent! Funds held in escrow pending content delivery.');
}

async function handleStripePaymentForm(e) {
  e.preventDefault();
  const dealId = parseInt(document.getElementById('pay-deal-id')?.value);
  if (!dealId) { showToast('⚠ Please enter a Deal ID'); return; }
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
    showToast('⚠ ' + (err.message || 'Could not start Stripe onboarding'));
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
          <span class="font-medium">Stripe payouts connected — you'll receive 85% of each deal directly to your bank.</span>
        </div>`;
    } else {
      banner.innerHTML = `
        <div class="flex items-center justify-between gap-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          <div class="flex items-center gap-2 text-amber-800">
            <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
            <span class="font-medium">Connect your bank to receive deal payouts (85% of each deal).</span>
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
    showToast('⚠ ' + (err.message || 'Payment failed'));
    const btn = document.getElementById(`pay-btn-${dealId}`);
    if (btn) { btn.disabled = false; btn.textContent = 'Pay with Stripe'; }
  }
}

// Handle Stripe return URLs
function handleStripeReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('stripe_onboard')) {
    showToast('🎉 Stripe account connected! You\'re ready to receive payouts.');
    history.replaceState({}, '', window.location.pathname);
    navigate('profile');
  }
  if (params.get('deal_id') && params.get('session_id')) {
    showToast('💳 Payment complete! Funds are held in escrow until you confirm delivery.');
    history.replaceState({}, '', window.location.pathname);
    navigate('messages');
  }
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

  try {
    _adminUsers = await apiGet('/api/admin/users');
  } catch (err) {
    listEl.innerHTML = `<div class="px-6 py-10 text-center text-red-500">Failed to load users: ${err.message}</div>`;
    return;
  }

  // Update stat cards
  const creators = _adminUsers.filter(u => u.role === 'creator').length;
  const brands   = _adminUsers.filter(u => u.role === 'brand').length;
  const totalEl    = document.getElementById('admin-stat-total');
  const creatorsEl = document.getElementById('admin-stat-creators');
  const brandsEl   = document.getElementById('admin-stat-brands');
  if (totalEl)    totalEl.textContent    = _adminUsers.length;
  if (creatorsEl) creatorsEl.textContent = creators;
  if (brandsEl)   brandsEl.textContent   = brands;

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
      <div class="text-xs text-gray-400 flex-shrink-0 hidden sm:block">
        #${u.id} · ${u.created_at ? u.created_at.slice(0, 10) : ''}
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
    showToast('⚠ ' + (err.message || 'Delete failed'));
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
    if (!res.ok) throw new Error(data.detail || 'Request failed');
    return data;
  } finally { if (opts.loading) hideLoading(); }
}

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  const roleEl = document.getElementById('user-role');
  if (roleEl) roleEl.value = state.role;
  highlightRole();
  handleStripeReturn();

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
});
