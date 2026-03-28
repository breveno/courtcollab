// ============================================================
// CourtCollab — App Logic
// ============================================================

// --- Auth ---
function getAuthUsers() {
  try { return JSON.parse(localStorage.getItem('cc_users') || '[]'); } catch { return []; }
}
function saveAuthUsers(users) {
  localStorage.setItem('cc_users', JSON.stringify(users));
}
function getCurrentUser() {
  try { return JSON.parse(localStorage.getItem('cc_current_user') || 'null'); } catch { return null; }
}
function setCurrentUser(user) {
  localStorage.setItem('cc_current_user', JSON.stringify(user));
}
function clearCurrentUser() {
  localStorage.removeItem('cc_current_user');
}

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
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const password = document.getElementById('login-password').value;
  const users = getAuthUsers();
  const user = users.find(u => u.email === email && u.password === password);
  if (!user) { showAuthError('Incorrect email or password. Try again or create an account.'); return; }
  setCurrentUser(user);
  onAuthSuccess(user);
}

function handleSignup(e) {
  e.preventDefault();
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim().toLowerCase();
  const password = document.getElementById('signup-password').value;
  const role = document.querySelector('input[name="signup-role"]:checked').value;
  const users = getAuthUsers();
  if (users.find(u => u.email === email)) { showAuthError('An account with that email already exists. Sign in instead.'); return; }
  const user = { name, email, password, role, initials: name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2) };
  users.push(user);
  saveAuthUsers(users);
  setCurrentUser(user);
  onAuthSuccess(user);
}

function onAuthSuccess(user) {
  hideAuthGate();
  // Sync role to match account type
  switchRole(user.role);
  // Update nav user display
  document.getElementById('nav-user-initials').textContent = user.initials || user.name.slice(0,2).toUpperCase();
  document.getElementById('nav-user-name').textContent = user.name;
  navigate('landing');
}

function handleLogout() {
  clearCurrentUser();
  showAuthGate();
  showAuthTab('login');
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
}

// --- Mock Data ---
const CREATORS = [
  {
    id: 1, name: "Dink Dynasty", location: "Austin, TX", avatar: "DD",
    bio: "Former college tennis player turned pickleball content machine. Known for viral trick shot videos and beginner-friendly tutorials that make the sport accessible.",
    niche: "Tutorials & Tips", skillLevel: "Pro (5.0+)",
    skills: ["Short Form Video", "Editing", "Voice Overs", "UGC"],
    stats: { ig: 87000, tiktok: 215000, yt: 42000, engagement: 6.2, views: 95000, total: 344000 },
    demographics: { age: "25-34", gender: "Male Leaning (55-70%)", locations: "USA 72%, Canada 12%, UK 8%", interests: "Sports, Fitness, Outdoor Recreation" },
    rates: { ig: 1200, tiktok: 800, yt: 3500, ugc: 600, notes: "10% discount for 3+ post packages. Open to long-term ambassador deals." }
  },
  {
    id: 2, name: "PicklePro Sarah", location: "Naples, FL", avatar: "PS",
    bio: "PPA Tour pro sharing behind-the-scenes tournament life, advanced strategy breakdowns, and daily training routines. 4x gold medalist.",
    niche: "Pro Match Highlights", skillLevel: "Pro (5.0+)",
    skills: ["Long Form Video", "Live Streaming", "Voice Overs", "Photography"],
    stats: { ig: 156000, tiktok: 89000, yt: 78000, engagement: 5.8, views: 120000, total: 323000 },
    demographics: { age: "35-44", gender: "Even Split", locations: "USA 65%, Canada 15%, Australia 10%", interests: "Competitive Sports, Tennis, Fitness" },
    rates: { ig: 2500, tiktok: 1500, yt: 5000, ugc: 1200, notes: "Available for on-court brand demos. Tournament appearance fees negotiable." }
  },
  {
    id: 3, name: "The Kitchen King", location: "San Diego, CA", avatar: "KK",
    bio: "Making pickleball hilarious one video at a time. Comedy skits about rec play culture, the dreaded banger, and kitchen violations that go viral.",
    niche: "Comedy & Entertainment", skillLevel: "Intermediate (3.0-3.5)",
    skills: ["Short Form Video", "Editing", "Voice Overs", "UGC", "Podcast"],
    stats: { ig: 52000, tiktok: 430000, yt: 18000, engagement: 8.1, views: 250000, total: 500000 },
    demographics: { age: "25-34", gender: "Even Split", locations: "USA 80%, UK 8%, Canada 7%", interests: "Comedy, Sports, Lifestyle" },
    rates: { ig: 900, tiktok: 1800, yt: 2000, ugc: 500, notes: "Custom comedy scripts available. Brand integration into existing series formats." }
  },
  {
    id: 4, name: "Paddle Review Pro", location: "Denver, CO", avatar: "PR",
    bio: "The most trusted paddle and gear review channel in pickleball. Data-driven testing with spin rate analysis, power metrics, and real-game feel reviews.",
    niche: "Gear Reviews", skillLevel: "Advanced (4.0-4.5)",
    skills: ["Long Form Video", "Editing", "Voice Overs", "Photography"],
    stats: { ig: 34000, tiktok: 28000, yt: 125000, engagement: 4.5, views: 85000, total: 187000 },
    demographics: { age: "35-44", gender: "Mostly Male (70%+)", locations: "USA 68%, Canada 14%, Europe 12%", interests: "Gear, Technology, Sports Equipment" },
    rates: { ig: 800, tiktok: 600, yt: 4000, ugc: 1000, notes: "Dedicated review videos include spin/power testing data. Paddle companies: ask about the testing protocol package." }
  },
  {
    id: 5, name: "Court & Cocktails", location: "Scottsdale, AZ", avatar: "CC",
    bio: "Pickleball meets lifestyle. Content blending on-court action with travel, fashion, and the social side of the fastest growing sport in America.",
    niche: "Lifestyle & Fitness", skillLevel: "Intermediate (3.0-3.5)",
    skills: ["Short Form Video", "Photography", "UGC", "Editing"],
    stats: { ig: 112000, tiktok: 67000, yt: 8500, engagement: 5.4, views: 48000, total: 187500 },
    demographics: { age: "25-34", gender: "Mostly Female (70%+)", locations: "USA 75%, Mexico 8%, Canada 7%", interests: "Lifestyle, Fashion, Travel, Wellness" },
    rates: { ig: 1800, tiktok: 1000, yt: 2500, ugc: 700, notes: "Styled product photography available. Ideal for apparel, accessories, and lifestyle brands." }
  },
  {
    id: 6, name: "PickleNews Daily", location: "Chicago, IL", avatar: "PD",
    bio: "Your daily source for pickleball news, tournament updates, and hot takes. Breaking down the latest in the sport with sharp commentary.",
    niche: "News & Commentary", skillLevel: "Advanced (4.0-4.5)",
    skills: ["Short Form Video", "Long Form Video", "Podcast", "Voice Overs"],
    stats: { ig: 45000, tiktok: 92000, yt: 55000, engagement: 7.3, views: 110000, total: 192000 },
    demographics: { age: "35-44", gender: "Male Leaning (55-70%)", locations: "USA 70%, Canada 12%, UK 9%", interests: "Sports News, Competitive Play, Industry" },
    rates: { ig: 700, tiktok: 900, yt: 3000, ugc: 400, notes: "Sponsored segments in daily show available. Newsletter ad placements also offered." }
  },
  {
    id: 7, name: "Tiny Dinkers", location: "Portland, OR", avatar: "TD",
    bio: "Teaching kids and families to love pickleball! Fun, energetic content featuring junior players, family drills, and youth tournament coverage.",
    niche: "Tutorials & Tips", skillLevel: "Intermediate (3.0-3.5)",
    skills: ["Short Form Video", "Editing", "Photography", "Live Streaming"],
    stats: { ig: 28000, tiktok: 145000, yt: 22000, engagement: 9.2, views: 180000, total: 195000 },
    demographics: { age: "25-34", gender: "Female Leaning (55-70%)", locations: "USA 82%, Canada 10%, Australia 5%", interests: "Family, Youth Sports, Education, Parenting" },
    rates: { ig: 500, tiktok: 700, yt: 1800, ugc: 350, notes: "Perfect for family-friendly brands. No alcohol/gambling sponsors." }
  },
  {
    id: 8, name: "Smash Brothers PB", location: "Miami, FL", avatar: "SB",
    bio: "Two brothers dominating doubles and documenting the grind. Raw, unfiltered content from open play to tournament finals. High energy, no filter.",
    niche: "Pro Match Highlights", skillLevel: "Advanced (4.0-4.5)",
    skills: ["Short Form Video", "Live Streaming", "Voice Overs", "UGC"],
    stats: { ig: 73000, tiktok: 198000, yt: 35000, engagement: 6.8, views: 140000, total: 306000 },
    demographics: { age: "18-24", gender: "Mostly Male (70%+)", locations: "USA 76%, Latin America 12%, Canada 6%", interests: "Action Sports, Competition, Fitness, Gaming" },
    rates: { ig: 1000, tiktok: 1200, yt: 2800, ugc: 550, notes: "Available for on-location brand shoots in South Florida. Bilingual content (EN/ES) available." }
  },
  {
    id: 9, name: "Zen & the Art of Dinking", location: "Boulder, CO", avatar: "ZD",
    bio: "Mindful pickleball content focusing on the mental game, sports psychology, and finding flow on the court. Calm, thoughtful, deeply engaging.",
    niche: "Lifestyle & Fitness", skillLevel: "Advanced (4.0-4.5)",
    skills: ["Long Form Video", "Voice Overs", "Podcast", "Photography"],
    stats: { ig: 41000, tiktok: 32000, yt: 68000, engagement: 5.1, views: 42000, total: 141000 },
    demographics: { age: "45-54", gender: "Even Split", locations: "USA 60%, Canada 15%, UK 12%, Europe 8%", interests: "Wellness, Mindfulness, Sports Psychology, Yoga" },
    rates: { ig: 900, tiktok: 500, yt: 3200, ugc: 800, notes: "Ideal for wellness, health, and premium lifestyle brands. Podcast sponsorship slots available." }
  }
];

const PORTFOLIOS = {
  1: [
    { brand: "Selkirk Sport", campaign: "Paddle Launch 2024", year: "2024", deliverable: "3x TikTok", result: "2.1M views", rating: 5, testimonial: "Incredible engagement, exceeded all KPIs. Best creator collab we've run." },
    { brand: "Franklin Sports", campaign: "Ball Drop", year: "2024", deliverable: "IG Reel + Story", result: "890K views", rating: 5, testimonial: "Great creative execution, very professional team to work with." },
    { brand: "Joola", campaign: "Ambassador Q1", year: "2023", deliverable: "YouTube Review", result: "145K views", rating: 4, testimonial: "Solid review content, strong audience trust and authenticity." }
  ],
  2: [
    { brand: "ONIX Sports", campaign: "Pro Series Launch", year: "2024", deliverable: "Live Stream + Recap", result: "320K reach", rating: 5, testimonial: "Sarah's tournament credibility drove incredible conversion for us." },
    { brand: "Paddletek", campaign: "Champion's Choice", year: "2024", deliverable: "YouTube Deep Dive", result: "210K views", rating: 5, testimonial: "Authentic, authoritative content that performed above all benchmarks." },
    { brand: "Engage Pickleball", campaign: "Elite Ambassador", year: "2023", deliverable: "3x IG Posts + Stories", result: "540K reach", rating: 4, testimonial: "Professional, timely delivery and outstanding audience alignment." }
  ],
  3: [
    { brand: "Gamma Sports", campaign: "Grip Tape Comedy Drop", year: "2024", deliverable: "TikTok Skit Series", result: "4.8M views", rating: 5, testimonial: "Went viral overnight. Funniest branded content we've ever produced." },
    { brand: "HEAD Pickleball", campaign: "Banger Nation", year: "2024", deliverable: "IG Reel + TikTok", result: "1.2M views", rating: 5, testimonial: "Insane organic reach. The Kitchen King's audience is fiercely loyal." },
    { brand: "Vulcan Sporting Goods", campaign: "Kitchen Chronicles", year: "2023", deliverable: "YouTube Comedy Special", result: "380K views", rating: 4, testimonial: "Creative, collaborative, and absolutely delivered on the brief." }
  ],
  4: [
    { brand: "CRBN Pickleball", campaign: "Carbon Review Series", year: "2024", deliverable: "Long-form YouTube Review", result: "198K views", rating: 5, testimonial: "The most thorough, data-backed review we've ever seen. Exceptional." },
    { brand: "Selkirk Sport", campaign: "Epic Flash Review", year: "2024", deliverable: "YouTube + IG Short", result: "275K views", rating: 5, testimonial: "His testing methodology is unmatched — drove massive pre-order sales." },
    { brand: "Fromuth Pickleball", campaign: "Gear Guide 2023", year: "2023", deliverable: "YouTube Comparison", result: "120K views", rating: 4, testimonial: "Balanced, credible, and clearly respected by the gear community." }
  ],
  5: [
    { brand: "Joola", campaign: "Lifestyle Spring Drop", year: "2024", deliverable: "5x Styled IG Photos", result: "620K reach", rating: 5, testimonial: "Court & Cocktails captured our brand aesthetic perfectly. Stunning content." },
    { brand: "Lululemon Pickleball", campaign: "Court to Brunch", year: "2024", deliverable: "IG Reel + Stories", result: "890K reach", rating: 5, testimonial: "Exactly the lifestyle angle we needed. Audience engagement was off the charts." },
    { brand: "Calia by Carrie", campaign: "Active Lifestyle Edit", year: "2023", deliverable: "UGC Photo Package", result: "310K reach", rating: 4, testimonial: "Beautiful UGC content we used across digital ads. Very professional." }
  ],
  6: [
    { brand: "PickleTV Network", campaign: "News Desk Sponsor", year: "2024", deliverable: "Weekly Show Segment x4", result: "1.1M views", rating: 5, testimonial: "PickleNews Daily is THE voice of the pickleball community. Fantastic ROI." },
    { brand: "Fromuth Pickleball", campaign: "Industry Insider", year: "2024", deliverable: "Podcast Sponsorship x6", result: "280K listens", rating: 4, testimonial: "Great host read ads, genuinely engaged listeners, strong conversion." },
    { brand: "USA Pickleball", campaign: "Rule Change Explainer", year: "2023", deliverable: "YouTube + TikTok Series", result: "760K views", rating: 5, testimonial: "Exceptional reach and credibility. Our membership sign-ups spiked." }
  ],
  7: [
    { brand: "Franklin Sports", campaign: "Youth Ball Launch", year: "2024", deliverable: "TikTok Family Series", result: "2.3M views", rating: 5, testimonial: "Tiny Dinkers speaks directly to our target family demographic. Phenomenal." },
    { brand: "Gamma Sports", campaign: "Kids Court Starter", year: "2024", deliverable: "IG Reels + Stories", result: "540K reach", rating: 5, testimonial: "Wholesome, authentic, and exactly on-brand for our family product line." },
    { brand: "USAPA", campaign: "Junior Nationals Coverage", year: "2023", deliverable: "Live Stream + Highlight Reel", result: "195K views", rating: 4, testimonial: "Gave our junior program amazing visibility. Kids loved it." }
  ],
  8: [
    { brand: "HEAD Pickleball", campaign: "Extreme Rally Campaign", year: "2024", deliverable: "TikTok + IG Reels x3", result: "3.2M views", rating: 5, testimonial: "Smash Brothers content is pure energy — our brand awareness skyrocketed." },
    { brand: "Vulcan Sporting Goods", campaign: "Doubles Domination", year: "2024", deliverable: "YouTube Series x2", result: "420K views", rating: 4, testimonial: "High-production value, authentic doubles strategy content. Loved it." },
    { brand: "ONIX Sports", campaign: "Miami Open Promo", year: "2023", deliverable: "Event Coverage + Social", result: "680K reach", rating: 5, testimonial: "Their South Florida presence was invaluable for our regional launch." }
  ],
  9: [
    { brand: "Engage Pickleball", campaign: "Mindful Game Series", year: "2024", deliverable: "YouTube x2 + Podcast", result: "310K views", rating: 5, testimonial: "Zen content perfectly aligned with our premium brand positioning." },
    { brand: "Paddletek", campaign: "Focus & Flow", year: "2024", deliverable: "Long-form YouTube + IG", result: "185K views", rating: 4, testimonial: "Thoughtful, high-quality content that resonated with our wellness audience." },
    { brand: "Headspace Sports", campaign: "Mental Game Partnership", year: "2023", deliverable: "Podcast Sponsorship x8", result: "390K listens", rating: 5, testimonial: "Perfect audience alignment with our sports mindfulness product. Exceptional." }
  ]
};

const CAMPAIGNS = [
  {
    id: 1, title: "Summer Slam Paddle Launch", brand: "VoltDrive Paddles", status: "active",
    description: "Launching our new carbon fiber paddle line this summer. Looking for creators to showcase the paddle in action — trick shots, gameplay, and unboxing content. We want authentic, high-energy content that highlights the power and spin capabilities.",
    budget: "$2,500 - $5,000", content: "Short Form Video (Reels/TikTok)", audience: "Competitive Players",
    deadline: "2026-05-15", skills: ["Short Form Video", "Editing", "UGC"],
    postedDate: "2026-03-20"
  },
  {
    id: 2, title: "Pickleball Apparel — Spring Collection", brand: "CourtCulture", status: "active",
    description: "We're dropping our Spring 2026 performance apparel line and need lifestyle-focused creators to model and feature the collection. Think on-court action shots mixed with casual lifestyle content. Must look great on camera.",
    budget: "$1,000 - $2,500", content: "Multi-format Package", audience: "All Levels",
    deadline: "2026-04-30", skills: ["Photography", "Short Form Video", "UGC"],
    postedDate: "2026-03-22"
  },
  {
    id: 3, title: "Beginner's Guide Sponsorship", brand: "PlayPickle Academy", status: "active",
    description: "Seeking tutorial creators to produce a sponsored 'Start Playing Today' beginner series. 3-5 videos covering rules, basic shots, and where to play. Must be approachable and beginner-friendly in tone.",
    budget: "$5,000 - $10,000", content: "Long Form Video (YouTube)", audience: "Beginners",
    deadline: "2026-06-01", skills: ["Long Form Video", "Voice Overs", "Editing"],
    postedDate: "2026-03-18"
  },
  {
    id: 4, title: "Tournament Live Coverage", brand: "PickleTV Network", status: "active",
    description: "Looking for creators to provide live commentary and social coverage at upcoming PPA and MLP events. Need someone comfortable on camera with deep knowledge of the pro scene.",
    budget: "$5,000 - $10,000", content: "Live Stream", audience: "Competitive Players",
    deadline: "2026-04-20", skills: ["Live Streaming", "Voice Overs"],
    postedDate: "2026-03-25"
  },
  {
    id: 5, title: "Court Shoe Review Campaign", brand: "SwiftStep Athletics", status: "active",
    description: "We want honest, data-driven reviews of our new court shoe designed specifically for pickleball. Looking for gear reviewers who test with real metrics — lateral movement, grip, durability over time.",
    budget: "$2,500 - $5,000", content: "Long Form Video (YouTube)", audience: "All Levels",
    deadline: "2026-05-30", skills: ["Long Form Video", "Editing", "Voice Overs", "Photography"],
    postedDate: "2026-03-24"
  }
];

const CONVERSATIONS = [
  {
    id: 1,
    participants: { brand: "VoltDrive Paddles", creator: "Dink Dynasty" },
    creatorId: 1,
    avatar: "DD",
    deal: { status: "proposed", amount: 3500, deliverables: "2x Instagram Reels + 1x TikTok + Unboxing video", timeline: "3 weeks" },
    messages: [
      { from: "brand", text: "Hey! Love your trick shot content. We're launching a new carbon fiber paddle and think you'd be perfect to showcase it.", time: "Mar 20, 2:30 PM" },
      { from: "creator", text: "Thanks! I've actually been eyeing your brand. What are you thinking for the campaign?", time: "Mar 20, 3:15 PM" },
      { from: "brand", text: "We'd love 2 Instagram Reels, a TikTok, and an unboxing video. Budget is $3,500 for the package. Interested?", time: "Mar 20, 4:00 PM" },
      { from: "creator", text: "That's in the right ballpark. I usually do $1,200 per Reel and $800 for TikTok. Can we do $3,800 and I'll throw in 3 story posts?", time: "Mar 20, 5:20 PM" },
      { from: "system", text: "Deal proposed: $3,500 for 2x Reels + 1x TikTok + Unboxing — awaiting response", time: "Mar 20, 5:30 PM" }
    ]
  },
  {
    id: 2,
    participants: { brand: "CourtCulture", creator: "Court & Cocktails" },
    creatorId: 5,
    avatar: "CC",
    deal: { status: "accepted", amount: 2200, deliverables: "5x styled photos + 2x Reels + 4x Story posts", timeline: "2 weeks" },
    messages: [
      { from: "brand", text: "Hi! Your aesthetic is exactly what we're looking for our Spring collection launch. Would love to collaborate!", time: "Mar 22, 10:00 AM" },
      { from: "creator", text: "Oh I love CourtCulture! I actually own a few pieces already. What did you have in mind?", time: "Mar 22, 10:45 AM" },
      { from: "brand", text: "We'd send you the full Spring line — 5 styled photos for our website + 2 Reels + stories. How does $2,200 sound?", time: "Mar 22, 11:30 AM" },
      { from: "creator", text: "That works for me! I can also do a try-on style Reel if you want — those perform really well with my audience.", time: "Mar 22, 12:15 PM" },
      { from: "system", text: "Deal accepted: $2,200 — Campaign in progress", time: "Mar 22, 12:30 PM" }
    ]
  },
  {
    id: 3,
    participants: { brand: "SwiftStep Athletics", creator: "Paddle Review Pro" },
    creatorId: 4,
    avatar: "PR",
    deal: null,
    messages: [
      { from: "brand", text: "We've been following your reviews — your testing methodology is best-in-class. We'd love to send you our new court shoe for review.", time: "Mar 24, 9:00 AM" },
      { from: "creator", text: "Appreciate that! I'd be interested. I do want to note — I give honest reviews. If there are issues, I'll mention them (constructively of course).", time: "Mar 24, 10:30 AM" },
      { from: "brand", text: "That's exactly what we want. Our shoes are built for pickleball-specific movement and we're confident they'll test well. What are your rates for a dedicated review?", time: "Mar 24, 11:00 AM" }
    ]
  }
];

// --- State ---
let state = {
  role: 'brand',
  currentPage: 'landing',
  selectedCreator: null,
  activeConversation: null,
  creators: [...CREATORS],
  campaigns: [...CAMPAIGNS],
  conversations: [...CONVERSATIONS]
};

// Load saved state
try {
  const saved = localStorage.getItem('pickleconnect');
  if (saved) {
    const parsed = JSON.parse(saved);
    state = { ...state, ...parsed };
  }
} catch(e) {}

function saveState() {
  localStorage.setItem('pickleconnect', JSON.stringify({
    role: state.role,
    creators: state.creators,
    campaigns: state.campaigns,
    conversations: state.conversations
  }));
}

// --- Navigation ---
function navigate(page) {
  if (!getCurrentUser()) { showAuthGate(); return; }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + page);
  if (target) {
    target.classList.add('active');
    state.currentPage = page;
  }
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.page === page);
  });
  // Render page content
  if (page === 'creators') renderCreators();
  if (page === 'campaigns') renderCampaigns();
  if (page === 'matching') runMatching();
  if (page === 'messages') renderConversations();
  if (page === 'payments') renderPayments();
  if (page === 'contact') renderContact();
}

// --- Role Switch ---
function switchRole(role) {
  state.role = role;
  document.getElementById('user-role').value = role;
  saveState();
}

// --- Format Numbers ---
function fmtNum(n) {
  if (n >= 1000000) return (n/1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n/1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
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
function renderCreators() {
  const grid = document.getElementById('creator-grid');
  const search = document.getElementById('filter-search').value.toLowerCase();
  const niche = document.getElementById('filter-niche').value;
  const skill = document.getElementById('filter-skill').value;
  const audience = document.getElementById('filter-audience').value;
  const rate = document.getElementById('filter-rate').value;

  let filtered = state.creators.filter(c => {
    if (search && !c.name.toLowerCase().includes(search) && !c.bio.toLowerCase().includes(search)) return false;
    if (niche && c.niche !== niche) return false;
    if (skill && !c.skills.includes(skill)) return false;
    if (audience) {
      const t = c.stats.total;
      if (audience === 'micro' && (t < 1000 || t > 10000)) return false;
      if (audience === 'mid' && (t < 10000 || t > 50000)) return false;
      if (audience === 'macro' && (t < 50000 || t > 200000)) return false;
      if (audience === 'mega' && t < 200000) return false;
    }
    if (rate) {
      const r = Math.min(c.rates.ig, c.rates.tiktok);
      if (rate === 'budget' && r >= 500) return false;
      if (rate === 'mid' && (r < 500 || r > 2000)) return false;
      if (rate === 'premium' && (r < 2000 || r > 5000)) return false;
      if (rate === 'elite' && r < 5000) return false;
    }
    return true;
  });

  grid.innerHTML = filtered.map(c => `
    <div class="bg-white rounded-2xl border border-gray-200 overflow-hidden card-hover cursor-pointer" onclick="showCreatorDetail(${c.id})">
      <div class="p-6">
        <div class="flex items-center gap-4 mb-4">
          <div class="w-14 h-14 rounded-2xl bg-pickle-100 flex items-center justify-center text-xl font-bold text-pickle-700">${c.avatar}</div>
          <div class="flex-1">
            <h3 class="font-bold text-lg">${c.name}</h3>
            <p class="text-gray-500 text-sm">${c.location}</p>
          </div>
          <span class="tag bg-pickle-100 text-pickle-700">${c.niche}</span>
        </div>
        <p class="text-gray-600 text-sm mb-4 line-clamp-2">${c.bio}</p>
        <div class="grid grid-cols-3 gap-3 mb-4">
          <div class="text-center p-2 bg-gray-50 rounded-lg">
            <div class="font-bold text-pickle-700">${fmtNum(c.stats.total)}</div>
            <div class="text-xs text-gray-500">Followers</div>
          </div>
          <div class="text-center p-2 bg-gray-50 rounded-lg">
            <div class="font-bold text-pickle-700">${c.stats.engagement}%</div>
            <div class="text-xs text-gray-500">Engagement</div>
          </div>
          <div class="text-center p-2 bg-gray-50 rounded-lg">
            <div class="font-bold text-pickle-700">${fmtNum(c.stats.views)}</div>
            <div class="text-xs text-gray-500">Avg Views</div>
          </div>
        </div>
        <div class="flex flex-wrap gap-1 mb-4">
          ${c.skills.map(s => `<span class="tag bg-gray-100 text-gray-600">${s}</span>`).join('')}
        </div>
        <div class="flex items-center justify-between pt-3 border-t border-gray-100">
          <span class="text-sm text-gray-500">From <span class="font-semibold text-gray-900">$${Math.min(c.rates.ig, c.rates.tiktok, c.rates.ugc)}</span>/post</span>
          <span class="text-sm font-medium text-pickle-600 hover:text-pickle-700">View Profile →</span>
        </div>
      </div>
    </div>
  `).join('');

  if (filtered.length === 0) {
    grid.innerHTML = '<div class="col-span-full text-center py-16 text-gray-400">No creators match your filters. Try adjusting your search.</div>';
  }
}

function filterCreators() { renderCreators(); }

// --- Creator Detail ---
function showCreatorDetail(id) {
  const c = state.creators.find(cr => cr.id === id);
  if (!c) return;
  state.selectedCreator = c;
  document.getElementById('detail-avatar').textContent = c.avatar;
  document.getElementById('detail-name').textContent = c.name;
  document.getElementById('detail-location').textContent = c.location + ' · ' + c.niche + ' · ' + c.skillLevel;

  document.getElementById('detail-content').innerHTML = `
    <p class="text-gray-600 mb-6">${c.bio}</p>

    <h3 class="font-bold mb-3">Creator Skills</h3>
    <div class="flex flex-wrap gap-1 mb-6">
      ${c.skills.map(s => `<span class="tag bg-pickle-100 text-pickle-700">${s}</span>`).join('')}
    </div>

    <h3 class="font-bold mb-3">Audience Stats</h3>
    <div class="grid grid-cols-3 gap-3 mb-6">
      <div class="text-center p-3 bg-gray-50 rounded-xl">
        <div class="text-xs text-gray-500 mb-1">Instagram</div>
        <div class="font-bold text-lg">${fmtNum(c.stats.ig)}</div>
      </div>
      <div class="text-center p-3 bg-gray-50 rounded-xl">
        <div class="text-xs text-gray-500 mb-1">TikTok</div>
        <div class="font-bold text-lg">${fmtNum(c.stats.tiktok)}</div>
      </div>
      <div class="text-center p-3 bg-gray-50 rounded-xl">
        <div class="text-xs text-gray-500 mb-1">YouTube</div>
        <div class="font-bold text-lg">${fmtNum(c.stats.yt)}</div>
      </div>
      <div class="text-center p-3 bg-gray-50 rounded-xl">
        <div class="text-xs text-gray-500 mb-1">Engagement</div>
        <div class="font-bold text-lg">${c.stats.engagement}%</div>
      </div>
      <div class="text-center p-3 bg-gray-50 rounded-xl">
        <div class="text-xs text-gray-500 mb-1">Avg Views</div>
        <div class="font-bold text-lg">${fmtNum(c.stats.views)}</div>
      </div>
      <div class="text-center p-3 bg-gray-50 rounded-xl">
        <div class="text-xs text-gray-500 mb-1">Total</div>
        <div class="font-bold text-lg">${fmtNum(c.stats.total)}</div>
      </div>
    </div>

    <h3 class="font-bold mb-3">Demographics</h3>
    <div class="grid grid-cols-2 gap-3 mb-6">
      <div class="p-3 bg-gray-50 rounded-xl">
        <div class="text-xs text-gray-500 mb-1">Primary Age</div>
        <div class="font-semibold">${c.demographics.age}</div>
      </div>
      <div class="p-3 bg-gray-50 rounded-xl">
        <div class="text-xs text-gray-500 mb-1">Gender Split</div>
        <div class="font-semibold">${c.demographics.gender}</div>
      </div>
      <div class="p-3 bg-gray-50 rounded-xl col-span-2">
        <div class="text-xs text-gray-500 mb-1">Top Locations</div>
        <div class="font-semibold">${c.demographics.locations}</div>
      </div>
      <div class="p-3 bg-gray-50 rounded-xl col-span-2">
        <div class="text-xs text-gray-500 mb-1">Audience Interests</div>
        <div class="font-semibold">${c.demographics.interests}</div>
      </div>
    </div>

    <h3 class="font-bold mb-3">Rates</h3>
    <div class="grid grid-cols-2 gap-3 mb-3">
      <div class="p-3 bg-pickle-50 rounded-xl">
        <div class="text-xs text-gray-500 mb-1">Instagram Post/Reel</div>
        <div class="font-bold text-pickle-700">$${c.rates.ig.toLocaleString()}</div>
      </div>
      <div class="p-3 bg-pickle-50 rounded-xl">
        <div class="text-xs text-gray-500 mb-1">TikTok</div>
        <div class="font-bold text-pickle-700">$${c.rates.tiktok.toLocaleString()}</div>
      </div>
      <div class="p-3 bg-pickle-50 rounded-xl">
        <div class="text-xs text-gray-500 mb-1">YouTube Video</div>
        <div class="font-bold text-pickle-700">$${c.rates.yt.toLocaleString()}</div>
      </div>
      <div class="p-3 bg-pickle-50 rounded-xl">
        <div class="text-xs text-gray-500 mb-1">UGC (per piece)</div>
        <div class="font-bold text-pickle-700">$${c.rates.ugc.toLocaleString()}</div>
      </div>
    </div>
    ${c.rates.notes ? `<p class="text-sm text-gray-500 italic">${c.rates.notes}</p>` : ''}

    <h3 class="font-bold mb-3 mt-6">Past Collabs & Portfolio</h3>
    ${(() => {
      const collabs = PORTFOLIOS[c.id];
      if (!collabs || collabs.length === 0) return '<p class="text-sm text-gray-400 italic">No past collabs listed yet.</p>';
      return `<div class="grid grid-cols-2 gap-3">
        ${collabs.map(col => {
          const stars = '★'.repeat(col.rating) + '☆'.repeat(5 - col.rating);
          return `
          <div class="p-3 bg-gray-50 rounded-xl border border-gray-100">
            <div class="flex items-center justify-between mb-1">
              <span class="font-semibold text-sm">${col.brand}</span>
              <span class="tag bg-pickle-100 text-pickle-700 text-xs">${col.year}</span>
            </div>
            <p class="text-xs text-gray-500 mb-1">${col.campaign}</p>
            <p class="text-xs font-medium text-gray-700 mb-1">${col.deliverable} · <span class="text-pickle-600">${col.result}</span></p>
            <div class="text-yellow-400 text-xs mb-1">${stars}</div>
            <p class="text-xs text-gray-500 italic">"${col.testimonial}"</p>
          </div>`;
        }).join('')}
      </div>`;
    })()}
  `;
  openModal('creator-detail-modal');
}

// --- Save Creator Profile ---
function saveCreatorProfile(e) {
  e.preventDefault();
  const skills = Array.from(document.querySelectorAll('#cp-skills input:checked')).map(i => i.value);
  const newCreator = {
    id: state.creators.length + 1,
    name: document.getElementById('cp-name').value,
    location: document.getElementById('cp-location').value,
    avatar: document.getElementById('cp-name').value.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase(),
    bio: document.getElementById('cp-bio').value,
    niche: document.getElementById('cp-niche').value,
    skillLevel: document.getElementById('cp-skill-level').value,
    skills: skills,
    stats: {
      ig: parseInt(document.getElementById('cp-ig').value) || 0,
      tiktok: parseInt(document.getElementById('cp-tiktok').value) || 0,
      yt: parseInt(document.getElementById('cp-yt').value) || 0,
      engagement: parseFloat(document.getElementById('cp-engagement').value) || 0,
      views: parseInt(document.getElementById('cp-views').value) || 0,
      total: parseInt(document.getElementById('cp-total').value) || 0
    },
    demographics: {
      age: document.getElementById('cp-age').value,
      gender: document.getElementById('cp-gender').value,
      locations: document.getElementById('cp-locations').value,
      interests: document.getElementById('cp-interests').value
    },
    rates: {
      ig: parseInt(document.getElementById('cp-rate-ig').value) || 0,
      tiktok: parseInt(document.getElementById('cp-rate-tiktok').value) || 0,
      yt: parseInt(document.getElementById('cp-rate-yt').value) || 0,
      ugc: parseInt(document.getElementById('cp-rate-ugc').value) || 0,
      notes: document.getElementById('cp-rate-notes').value
    }
  };
  state.creators.push(newCreator);
  saveState();
  showToast('Profile saved successfully!');
  navigate('creators');
}

// --- Render Campaigns ---
function renderCampaigns() {
  const list = document.getElementById('campaign-list');
  list.innerHTML = state.campaigns.map(c => `
    <div class="bg-white rounded-2xl border border-gray-200 p-6 card-hover">
      <div class="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-4">
        <div>
          <div class="flex items-center gap-3 mb-2">
            <h2 class="text-xl font-bold">${c.title}</h2>
            <span class="tag ${c.status === 'active' ? 'bg-pickle-100 text-pickle-700' : 'bg-gray-100 text-gray-600'}">${c.status === 'active' ? 'Active' : 'Closed'}</span>
          </div>
          <p class="text-brand-600 font-medium">${c.brand}</p>
        </div>
        <div class="flex items-center gap-4 text-sm text-gray-500">
          <span>Budget: <strong class="text-gray-900">${c.budget}</strong></span>
          <span>Deadline: <strong class="text-gray-900">${c.deadline}</strong></span>
        </div>
      </div>
      <p class="text-gray-600 mb-4">${c.description}</p>
      <div class="flex flex-wrap items-center gap-2 mb-4">
        <span class="tag bg-brand-100 text-brand-700">${c.content}</span>
        <span class="tag bg-purple-100 text-purple-700">${c.audience}</span>
        ${c.skills.map(s => `<span class="tag bg-gray-100 text-gray-600">${s}</span>`).join('')}
      </div>
      <div class="flex items-center justify-between pt-4 border-t border-gray-100">
        <span class="text-sm text-gray-400">Posted ${c.postedDate}</span>
        <button onclick="applyCampaign(${c.id})" class="bg-pickle-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-pickle-700 transition">${state.role === 'creator' ? 'Apply Now' : 'View Applicants'}</button>
      </div>
    </div>
  `).join('');
}

function applyCampaign(id) {
  if (state.role === 'creator') {
    showToast('Application sent! The brand will be in touch.');
  } else {
    showToast('Applicant view coming soon.');
  }
}

// --- Post Campaign ---
function postCampaign(e) {
  e.preventDefault();
  const skills = Array.from(document.querySelectorAll('#camp-skills input:checked')).map(i => i.value);
  const campaign = {
    id: state.campaigns.length + 1,
    title: document.getElementById('camp-title').value,
    brand: document.getElementById('camp-brand').value,
    status: 'active',
    description: document.getElementById('camp-desc').value,
    budget: document.getElementById('camp-budget').value,
    content: document.getElementById('camp-content').value,
    audience: document.getElementById('camp-audience').value,
    deadline: document.getElementById('camp-deadline').value,
    skills: skills,
    postedDate: new Date().toISOString().split('T')[0]
  };
  state.campaigns.unshift(campaign);
  saveState();
  closeModal('campaign-modal');
  showToast('Campaign brief posted!');
  renderCampaigns();
}

// --- Discovery / Matching ---
function runMatching() {
  const type = document.getElementById('match-type')?.value;
  const age = document.getElementById('match-age')?.value;
  const minFollowers = parseInt(document.getElementById('match-followers')?.value) || 0;
  const maxBudget = parseInt(document.getElementById('match-budget')?.value) || Infinity;

  let results = state.creators.map(c => {
    let score = 50; // base score
    let reasons = [];

    // Skill match
    if (type && c.skills.includes(type)) {
      score += 20;
      reasons.push(`Specializes in ${type}`);
    } else if (type) {
      score -= 10;
    }

    // Age match
    if (age && c.demographics.age === age) {
      score += 15;
      reasons.push(`Audience is ${age} age range`);
    }

    // Follower threshold
    if (c.stats.total >= minFollowers) {
      score += 10;
    } else if (minFollowers > 0) {
      score -= 20;
    }

    // Budget match
    const minRate = Math.min(c.rates.ig, c.rates.tiktok, c.rates.ugc);
    if (minRate <= maxBudget) {
      score += 10;
      reasons.push(`Rates start at $${minRate}`);
    } else if (maxBudget < Infinity) {
      score -= 15;
    }

    // Engagement bonus
    if (c.stats.engagement >= 6) {
      score += 10;
      reasons.push(`High engagement (${c.stats.engagement}%)`);
    }

    // Audience size bonus
    if (c.stats.total >= 200000) {
      score += 5;
      reasons.push(`Large audience (${fmtNum(c.stats.total)})`);
    }

    score = Math.max(0, Math.min(100, score));
    if (reasons.length === 0) reasons.push('General pickleball creator');

    return { ...c, matchScore: score, matchReasons: reasons };
  });

  // Filter out low scores if filters are active
  if (type || age || minFollowers || maxBudget < Infinity) {
    results = results.filter(r => r.matchScore >= 40);
  }

  results.sort((a, b) => b.matchScore - a.matchScore);

  const container = document.getElementById('match-results');
  container.innerHTML = results.map((c, i) => `
    <div class="bg-white rounded-2xl border border-gray-200 p-5 card-hover cursor-pointer" onclick="showCreatorDetail(${c.id})">
      <div class="flex items-center gap-5">
        <div class="relative">
          <div class="w-14 h-14 rounded-2xl bg-pickle-100 flex items-center justify-center text-xl font-bold text-pickle-700">${c.avatar}</div>
          <div class="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-white border-2 ${c.matchScore >= 80 ? 'border-pickle-400' : c.matchScore >= 60 ? 'border-yellow-400' : 'border-gray-300'} flex items-center justify-center text-xs font-bold ${c.matchScore >= 80 ? 'text-pickle-600' : c.matchScore >= 60 ? 'text-yellow-600' : 'text-gray-500'}">${c.matchScore}</div>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <h3 class="font-bold text-lg">${c.name}</h3>
            <span class="tag bg-pickle-100 text-pickle-700">${c.niche}</span>
          </div>
          <div class="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-500 mt-1">
            <span>${fmtNum(c.stats.total)} followers</span>
            <span>${c.stats.engagement}% engagement</span>
            <span>From $${Math.min(c.rates.ig, c.rates.tiktok, c.rates.ugc)}/post</span>
          </div>
        </div>
        <div class="hidden md:block text-right">
          <div class="text-sm font-medium ${c.matchScore >= 80 ? 'text-pickle-600' : c.matchScore >= 60 ? 'text-yellow-600' : 'text-gray-500'}">${c.matchScore >= 80 ? 'Strong Match' : c.matchScore >= 60 ? 'Good Match' : 'Potential Match'}</div>
          <div class="text-xs text-gray-400 mt-1 max-w-xs">${c.matchReasons.slice(0, 2).join(' · ')}</div>
        </div>
      </div>
      <div class="mt-3 ml-[76px]">
        <div class="stat-bar w-full max-w-xs">
          <div class="stat-bar-fill" style="width: ${c.matchScore}%; background: ${c.matchScore >= 80 ? 'linear-gradient(90deg, #4f8a4f, #2F4F2F)' : c.matchScore >= 60 ? 'linear-gradient(90deg, #eab308, #ca8a04)' : '#9ca3af'}"></div>
        </div>
      </div>
    </div>
  `).join('');

  if (results.length === 0) {
    container.innerHTML = '<div class="text-center py-16 text-gray-400">No matches found. Try broadening your criteria.</div>';
  }
}

// --- Messages ---
function renderConversations() {
  const list = document.getElementById('conversation-list');
  list.innerHTML = state.conversations.map(c => {
    const otherName = state.role === 'brand' ? c.participants.creator : c.participants.brand;
    const lastMsg = c.messages[c.messages.length - 1];
    const dealBadge = c.deal ?
      (c.deal.status === 'accepted' ? '<span class="tag bg-pickle-100 text-pickle-700">Deal Active</span>' :
       c.deal.status === 'proposed' ? '<span class="tag bg-yellow-100 text-yellow-700">Pending</span>' :
       '<span class="tag bg-red-100 text-red-700">Declined</span>') : '';
    return `
      <div class="p-4 border-b border-gray-50 cursor-pointer hover:bg-gray-50 transition ${state.activeConversation === c.id ? 'bg-pickle-50' : ''}" onclick="openConversation(${c.id})">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-full bg-pickle-100 flex items-center justify-center font-bold text-pickle-700 text-sm">${c.avatar}</div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-semibold text-sm">${otherName}</span>
              ${dealBadge}
            </div>
            <p class="text-xs text-gray-500 truncate">${lastMsg.text.substring(0, 60)}...</p>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function openConversation(id) {
  state.activeConversation = id;
  const conv = state.conversations.find(c => c.id === id);
  if (!conv) return;

  const otherName = state.role === 'brand' ? conv.participants.creator : conv.participants.brand;
  document.getElementById('chat-avatar').textContent = conv.avatar;
  document.getElementById('chat-name').textContent = otherName;
  document.getElementById('chat-status').textContent = conv.deal ?
    `Deal: $${conv.deal.amount.toLocaleString()} — ${conv.deal.status.charAt(0).toUpperCase() + conv.deal.status.slice(1)}` : 'No active deal';

  const dealActions = document.getElementById('deal-actions');
  if (conv.deal && conv.deal.status === 'proposed') {
    dealActions.classList.remove('hidden');
  } else {
    dealActions.classList.add('hidden');
  }

  const chatEl = document.getElementById('chat-messages');
  chatEl.innerHTML = conv.messages.map(m => {
    if (m.from === 'system') {
      return `<div class="text-center"><span class="inline-block bg-yellow-50 text-yellow-700 px-4 py-2 rounded-full text-xs font-medium">${m.text}</span><div class="text-xs text-gray-400 mt-1">${m.time}</div></div>`;
    }
    const isMe = (state.role === m.from);
    return `
      <div class="flex ${isMe ? 'justify-end' : 'justify-start'}">
        <div class="max-w-sm">
          <div class="${isMe ? 'message-bubble-right' : 'message-bubble-left'} px-4 py-3 text-sm">${m.text}</div>
          <div class="text-xs text-gray-400 mt-1 ${isMe ? 'text-right' : ''}">${m.time}</div>
        </div>
      </div>
    `;
  }).join('');

  chatEl.scrollTop = chatEl.scrollHeight;
  renderConversations();
}

function sendMessage() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text || !state.activeConversation) return;

  const conv = state.conversations.find(c => c.id === state.activeConversation);
  if (!conv) return;

  conv.messages.push({
    from: state.role,
    text: text,
    time: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  });

  input.value = '';
  saveState();
  openConversation(state.activeConversation);
}

function startConversation() {
  if (!state.selectedCreator) return;
  const c = state.selectedCreator;

  // Check if conversation already exists
  const existing = state.conversations.find(conv => conv.creatorId === c.id);
  if (existing) {
    closeModal('creator-detail-modal');
    navigate('messages');
    setTimeout(() => openConversation(existing.id), 100);
    return;
  }

  const newConv = {
    id: state.conversations.length + 1,
    participants: { brand: "Your Brand", creator: c.name },
    creatorId: c.id,
    avatar: c.avatar,
    deal: null,
    messages: []
  };
  state.conversations.push(newConv);
  saveState();
  closeModal('creator-detail-modal');
  navigate('messages');
  setTimeout(() => openConversation(newConv.id), 100);
}

// --- Deal Flow ---
function proposeDeal(e) {
  e.preventDefault();
  if (!state.activeConversation) return;
  const conv = state.conversations.find(c => c.id === state.activeConversation);
  if (!conv) return;

  const deal = {
    status: 'proposed',
    amount: parseInt(document.getElementById('deal-amount').value),
    deliverables: document.getElementById('deal-deliverables').value,
    timeline: document.getElementById('deal-timeline').value
  };
  conv.deal = deal;
  conv.messages.push({
    from: 'system',
    text: `Deal proposed: $${deal.amount.toLocaleString()} for ${deal.deliverables} — ${deal.timeline} timeline`,
    time: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  });

  saveState();
  closeModal('deal-modal');
  openConversation(state.activeConversation);
  showToast('Deal proposal sent!');
}

function updateDealStatus(status) {
  if (!state.activeConversation) return;
  const conv = state.conversations.find(c => c.id === state.activeConversation);
  if (!conv || !conv.deal) return;

  conv.deal.status = status;
  conv.messages.push({
    from: 'system',
    text: `Deal ${status}: $${conv.deal.amount.toLocaleString()} — ${conv.deal.deliverables}`,
    time: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  });

  saveState();
  openConversation(state.activeConversation);
  showToast(`Deal ${status}!`);
}

// --- Payments ---
function renderPayments() {
  const currentRole = state.role;
  document.querySelectorAll('.brand-only').forEach(el => {
    el.style.display = currentRole === 'brand' ? 'block' : 'none';
  });
  document.querySelectorAll('.creator-only').forEach(el => {
    el.style.display = currentRole === 'creator' ? 'block' : 'none';
  });

  // Attach live calculation listener to deal amount field
  const dealAmountInput = document.getElementById('deal-amount-pay');
  if (dealAmountInput) {
    // Remove old listeners by cloning
    const newInput = dealAmountInput.cloneNode(true);
    dealAmountInput.parentNode.replaceChild(newInput, dealAmountInput);
    newInput.addEventListener('input', function() {
      const raw = parseFloat(this.value) || 0;
      const fee = raw * 0.15;
      const payout = raw * 0.85;
      const feeEl = document.getElementById('platform-fee-display');
      const payoutEl = document.getElementById('creator-payout-display');
      if (feeEl) feeEl.value = '$' + fee.toFixed(2);
      if (payoutEl) payoutEl.value = '$' + payout.toFixed(2);
    });
  }
}

function submitPayment(e) {
  e.preventDefault();
  showToast('✓ Payment sent! Funds held in escrow pending content delivery.');
}

// --- Contact ---
function renderContact() {
  const form = document.getElementById('contact-form');
  if (!form) return;
  // Clone to remove stale listeners
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

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('user-role').value = state.role;
  highlightRole();
  const user = getCurrentUser();
  if (user) {
    onAuthSuccess(user);
  } else {
    showAuthGate();
  }
});
