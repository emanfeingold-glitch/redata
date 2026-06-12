/* ============================================================================
   REDATA — User System (auth + quota metering)
   ----------------------------------------------------------------------------
   HYBRID SCAFFOLD: This module is the single abstraction layer the rest of the
   app talks to (window.RedataUser). Today it is backed entirely by the browser
   (localStorage) so it works with zero infrastructure. When you are ready for
   real, server-enforced accounts + quotas (and Stripe), you only need to swap
   the `Backend` implementation near the top — every public method already
   returns a Promise, so the app code above it does not change.

   WHAT IS METERED
   ---------------
   The unit is a "property score" = one property. Per property, all API-backed
   actions (Fetch Comps, LoopNet Parse, AI Market Intel) are bundled into ONE
   credit. Clicking Reset starts a brand-new property, so the next API action
   consumes a fresh credit. The Market-Intel "Refresh" button is a PAID-ONLY
   action (it fires an extra API call) and is gated separately.

   TIERS
   -----
     guest : 5 property scores total (until an account is created)
     free  : 10 property scores per rolling 4 hours
     paid  : up to PAID_HOURLY_LIMIT scores per rolling 1 hour  (+ Refresh)

   NOTE ON SECURITY: localStorage limits are client-side and therefore
   bypassable (clearing storage resets them). That is acceptable for this
   scaffold; the real enforcement belongs in the server `Backend` swap.
   ========================================================================== */
(function () {
  "use strict";

  // ---- Tier configuration -------------------------------------------------
  // Edit these freely. PAID_HOURLY_LIMIT lives in the 50–100 range you wanted.
  const PAID_HOURLY_LIMIT = 100;
  const HOUR = 60 * 60 * 1000;

  // Pro price is display-only here; the billing authority will be the Stripe price (STRIPE_PRICE_ID).
  const PRO_PRICE_DISPLAY = "$15";
  const PRO_PRICE_PERIOD = "/mo";

  const TIERS = {
    guest: { id: "guest", label: "Guest", limit: 5,                windowMs: null,     paidFeatures: false },
    free:  { id: "free",  label: "Free",  limit: 10,               windowMs: 4 * HOUR, paidFeatures: false },
    paid:  { id: "paid",  label: "Pro",   limit: PAID_HOURLY_LIMIT, windowMs: HOUR,     paidFeatures: true,
             priceDisplay: PRO_PRICE_DISPLAY + PRO_PRICE_PERIOD },
  };

  // ==========================================================================
  //  BACKEND SEAM
  //  Enforcement now lives server-side (Vercel Postgres). This client talks to
  //  it through ServerBackend; auth, quota, and the score token are all issued
  //  and verified by /api/*. The old localStorage LocalBackend is in git history.
  // ==========================================================================
  // Thin fetch wrapper around the server API.
  const ServerBackend = {
    async api(path, opts = {}) {
      const res = await fetch(path, {
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
        ...opts,
      });
      let data = null;
      try { data = await res.json(); } catch { /* no body */ }
      return { res, data, ok: res.ok, statusCode: res.status };
    },
  };

  const Backend = ServerBackend;

  // ---- Runtime state ------------------------------------------------------
  const listeners = new Set();
  const GUEST_FALLBACK = {
    tier: "guest", label: "Guest", email: null, used: 0,
    limit: TIERS.guest.limit, remaining: TIERS.guest.limit,
    windowMs: null, resetsAt: null, paidFeatures: false, signedIn: false,
  };
  const state = {
    currentPropertyId: null,
    creditedPropertyId: null,       // which property already spent a credit this session
    scoreToken: null,               // proof-of-credit for the current property (sent to data routes)
    status: { ...GUEST_FALLBACK },  // last-known quota status (drives the UI)
  };

  function notify() {
    for (const cb of listeners) { try { cb(); } catch { /* ignore */ } }
  }

  // ---- Quota status (server is the source of truth) -----------------------
  // Returns the same shape the UI already consumes. Falls back to a guest view
  // if the backend is unreachable (e.g. static preview without the API).
  async function getQuotaStatus() {
    try {
      const { ok, data } = await Backend.api("/api/auth/me");
      if (ok && data && data.status) { state.status = data.status; return state.status; }
    } catch { /* offline / backend unreachable */ }
    return state.status || { ...GUEST_FALLBACK };
  }

  // ==========================================================================
  //  PUBLIC API
  // ==========================================================================
  const RedataUser = {
    TIERS,

    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },

    openPlans() { return renderPlans(); },
    openAccount() { return openAccountModal(); },

    getQuotaStatus,
    async getCurrentUser() {
      const s = await getQuotaStatus();
      return s.signedIn ? { email: s.email, tier: s.tier } : null;
    },
    async hasPaidFeatures() {
      const s = (state.status && state.status.signedIn) ? state.status : await getQuotaStatus();
      return !!s.paidFeatures;
    },

    // --- property lifecycle ---
    startNewProperty() {
      state.currentPropertyId = "p_" + Math.random().toString(36).slice(2);
      state.creditedPropertyId = null;
    },
    isCurrentPropertyCredited() {
      return state.currentPropertyId && state.currentPropertyId === state.creditedPropertyId;
    },

    /* Gate an API-backed action. Consumes one property credit server-side
       (idempotent per property), stores the returned score token, and maps the
       server's limits to the right modal. `action` is one of
       'attom' | 'parse-listing' | 'market-intel'. Returns { allowed }. */
    async requireCredit(action) {
      try {
        const { ok, statusCode, data } = await Backend.api("/api/credit/consume", {
          method: "POST",
          body: JSON.stringify({ propertyId: state.currentPropertyId, action: action || "" }),
        });
        if (ok && data && data.scoreToken) {
          state.scoreToken = data.scoreToken;
          state.creditedPropertyId = state.currentPropertyId;
          if (data.status) state.status = data.status;
          notify();
          return { allowed: true };
        }
        const status = (data && data.status) || state.status || (await getQuotaStatus());
        state.status = status; notify();
        if (statusCode === 402) { openUpgradeModal(status, "paid-feature"); return { allowed: false }; }
        if (statusCode === 429) { openUpgradeModal(status, "quota"); return { allowed: false }; }
        // 401 / 403 / 500 / network — fail closed and surface the limit prompt.
        openUpgradeModal(status, "quota");
        return { allowed: false };
      } catch {
        return { allowed: false };
      }
    },

    /* Gate the paid-only Market-Intel refresh. Instant client check for UX;
       the server re-checks on the consume call as the real backstop. */
    async requirePaidFeature() {
      const s = await getQuotaStatus();
      if (s.paidFeatures) return true;
      openUpgradeModal(s, "paid-feature");
      return false;
    },

    getScoreToken() { return state.scoreToken; },
    getPropertyId() { return state.currentPropertyId; },

    // --- auth (server-backed) ---
    async signUp(email, password) {
      const { ok, data } = await Backend.api("/api/auth/signup", {
        method: "POST", body: JSON.stringify({ email, password }),
      });
      if (!ok) throw new Error((data && data.error) || "Sign up failed.");
      await getQuotaStatus(); notify();
      return data.user;
    },
    async signIn(email, password) {
      const { ok, data } = await Backend.api("/api/auth/login", {
        method: "POST", body: JSON.stringify({ email, password }),
      });
      if (!ok) throw new Error((data && data.error) || "Sign in failed.");
      await getQuotaStatus(); notify();
      return data.user;
    },
    async signOut() {
      await Backend.api("/api/auth/logout", { method: "POST", body: "{}" });
      state.scoreToken = null;
      await getQuotaStatus(); notify();
    },

    /* Start a Stripe Checkout subscription. The Plans popup is the only caller.
       Returns a status object instead of throwing for expected outcomes:
       'needs_account' | 'not_configured' | 'redirecting' | 'error'. */
    async upgradeToPaid() {
      const { ok, statusCode, data } = await Backend.api("/api/stripe/create-checkout-session", {
        method: "POST", body: "{}",
      });
      if (statusCode === 401) return { status: "needs_account" };
      if (ok && data && data.configured === false) return { status: "not_configured" };
      if (ok && data && data.url) { window.location.href = data.url; return { status: "redirecting" }; }
      return { status: "error", message: (data && data.error) || "Upgrade failed." };
    },
  };

  window.RedataUser = RedataUser;

  // ==========================================================================
  //  UI  (header widget + account/upgrade modal). Self-contained so the host
  //  page only needs the public API above.
  // ==========================================================================
  function injectStyles() {
    const css = `
      .rdu-account { display:flex; align-items:center; gap:10px; }
      .rdu-quota-pill {
        display:inline-flex; align-items:center; gap:7px; min-height:42px;
        padding:0 14px; border-radius:999px; cursor:pointer;
        border:1px solid var(--line); background:#fff; color:var(--ink);
        font-weight:800; font-size:0.82rem; white-space:nowrap;
        transition:border-color .18s ease, box-shadow .18s ease;
      }
      .rdu-quota-pill:hover { border-color:var(--brand); box-shadow:0 4px 16px rgba(26,107,80,.12); }
      .rdu-quota-dot { width:8px; height:8px; border-radius:50%; background:var(--brand); flex:0 0 auto; }
      .rdu-quota-dot.warn { background:var(--accent); }
      .rdu-quota-dot.empty { background:#b4322c; }
      .rdu-tier-tag {
        padding:2px 7px; border-radius:999px; font-size:0.68rem; letter-spacing:.04em;
        text-transform:uppercase; background:#e7f1ed; color:var(--brand-dark);
      }
      .rdu-tier-tag.paid { background:linear-gradient(135deg,var(--accent),#a85f10); color:#fff; }
      .site-header.scrolled .rdu-quota-pill { background:rgba(255,255,255,.08); color:#e8f2ee; border-color:rgba(232,242,238,.35); }

      .rdu-overlay {
        position:fixed; inset:0; z-index:200; display:flex; align-items:center; justify-content:center;
        padding:20px; background:rgba(10,25,20,.55); backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px);
      }
      .rdu-overlay[hidden] { display:none; }
      .rdu-modal {
        width:100%; max-width:440px; background:var(--panel); border-radius:12px;
        box-shadow:var(--shadow-deep); overflow:hidden; display:flex; flex-direction:column;
        border-top:3px solid var(--brand); animation:rduFade .25s ease;
      }
      @keyframes rduFade { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }
      .rdu-modal-head { display:flex; align-items:center; justify-content:space-between; padding:20px 24px 12px; }
      .rdu-modal-head h3 { margin:0; font-size:1.15rem; }
      .rdu-x { background:none; border:none; cursor:pointer; font-size:1.1rem; color:var(--muted); padding:4px 8px; border-radius:6px; }
      .rdu-x:hover { background:var(--paper); color:var(--ink); }
      .rdu-modal-body { padding:4px 24px 22px; }
      .rdu-sub { margin:0 0 16px; color:var(--muted); font-size:0.9rem; line-height:1.55; }
      .rdu-tabs { display:flex; gap:8px; margin-bottom:16px; }
      .rdu-tab {
        flex:1; padding:9px 0; border:1px solid var(--line); background:#fff; border-radius:8px;
        cursor:pointer; font-weight:800; font-size:0.82rem; color:var(--muted); text-transform:uppercase; letter-spacing:.04em;
      }
      .rdu-tab.active { border-color:var(--brand); color:var(--brand-dark); background:#f0f7f4; }
      .rdu-field { display:grid; gap:6px; margin-bottom:12px; }
      .rdu-field label { font-size:0.74rem; font-weight:800; text-transform:uppercase; color:var(--muted); }
      .rdu-field input { width:100%; min-height:44px; padding:0 12px; border:1px solid var(--line); border-radius:8px; background:#fbfcfa; }
      .rdu-field input:focus { border-color:var(--brand); box-shadow:0 0 0 3px rgba(31,111,85,.12); outline:none; }
      .rdu-msg { margin:2px 0 12px; font-size:0.82rem; min-height:1.1em; line-height:1.4; }
      .rdu-msg.error { color:#9f342f; }
      .rdu-msg.ok { color:var(--brand-dark); }
      .rdu-actions { display:grid; gap:10px; margin-top:6px; }
      .rdu-btn { width:100%; min-height:46px; border-radius:8px; border:1px solid transparent; cursor:pointer; font-weight:800; }
      .rdu-btn-primary { color:#fff; background:var(--brand); }
      .rdu-btn-primary:hover { background:var(--brand-dark); }
      .rdu-btn-ghost { background:#fff; border-color:var(--line); color:var(--ink); }
      .rdu-btn-ghost:hover { border-color:var(--brand); color:var(--brand-dark); }
      .rdu-pro-card {
        margin:6px 0 14px; padding:14px 16px; border-radius:10px;
        background:linear-gradient(135deg,#0e4a36,#1b3a52); color:#eaf3ef;
      }
      .rdu-pro-card strong { display:block; font-size:1rem; margin-bottom:4px; }
      .rdu-pro-card span { font-size:0.84rem; color:#cfe1da; line-height:1.5; }
      .rdu-foot-note { margin:12px 0 0; font-size:0.74rem; color:var(--muted); line-height:1.5; text-align:center; }
      .rdu-account-meta { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:14px;
        padding:12px 14px; border:1px solid var(--line); border-radius:8px; background:var(--paper); }
      .rdu-account-meta .em { font-weight:800; font-size:0.9rem; word-break:break-all; }
      .rdu-account-meta .mt { font-size:0.76rem; color:var(--muted); }
      .rdu-plans-btn {
        display:inline-flex; align-items:center; justify-content:center;
        min-height:42px; padding:0 18px; border-radius:8px; cursor:pointer;
        border:1px solid var(--line); background:#fff; color:var(--ink);
        font-weight:700; white-space:nowrap;
        transition:border-color .18s ease, color .18s ease;
      }
      .rdu-plans-btn:hover { border-color:var(--brand); color:var(--brand-dark); }
      .site-header.scrolled .rdu-plans-btn { background:rgba(255,255,255,.08); color:#e8f2ee; border-color:rgba(232,242,238,.35); }

      .rdu-modal.rdu-modal--wide { max-width:840px; }
      .rdu-plans-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin-top:6px; }
      .rdu-plan-card {
        position:relative; display:flex; flex-direction:column; gap:8px;
        padding:18px 16px 16px; border:1px solid var(--line); border-radius:12px; background:#fff;
      }
      .rdu-plan-card.featured { border-color:var(--brand); box-shadow:0 10px 30px rgba(26,107,80,.12); }
      .rdu-plan-card.current { background:var(--paper); }
      .rdu-plan-badge {
        position:absolute; top:-10px; left:16px; padding:2px 9px; border-radius:999px;
        font-size:0.64rem; font-weight:800; letter-spacing:.05em; text-transform:uppercase;
        color:#fff; background:linear-gradient(135deg,var(--brand),var(--steel));
      }
      .rdu-plan-name { font-size:0.74rem; font-weight:800; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
      .rdu-plan-price { font-size:1.7rem; font-weight:800; line-height:1; color:var(--ink); }
      .rdu-plan-quota { font-size:0.86rem; font-weight:700; color:var(--brand-dark); }
      .rdu-plan-quota span { display:block; font-size:0.74rem; font-weight:600; color:var(--muted); text-transform:none; }
      .rdu-plan-feats { list-style:none; margin:4px 0 0; padding:0; display:grid; gap:6px; flex:1; }
      .rdu-plan-feats li { position:relative; padding-left:18px; font-size:0.82rem; color:var(--ink); line-height:1.35; }
      .rdu-plan-feats li::before { content:"✓"; position:absolute; left:0; color:var(--brand); font-weight:800; }
      .rdu-plan-cta { margin-top:10px; }
      .rdu-plan-cta .rdu-btn { min-height:42px; }
      .rdu-plan-cta .rdu-btn[disabled] { opacity:.6; cursor:default; }

      @media (max-width:760px) {
        .rdu-modal.rdu-modal--wide { max-width:440px; }
        .rdu-plans-grid { grid-template-columns:1fr; }
        .rdu-plan-card.featured { order:-1; }
      }
      @media (max-width:640px) { .rdu-quota-pill .rdu-quota-text-long { display:none; } }
    `;
    const tag = document.createElement("style");
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  function fmtReset(resetsAt) {
    if (!resetsAt) return "";
    const mins = Math.max(0, Math.round((resetsAt - Date.now()) / 60000));
    if (mins < 60) return `resets in ~${mins} min`;
    return `resets in ~${Math.round(mins / 60)} hr`;
  }

  let els = {};
  function buildWidget() {
    const host = document.querySelector(".header-actions");
    if (!host) return;
    const wrap = document.createElement("div");
    wrap.className = "rdu-account";
    wrap.innerHTML = `
      <button type="button" class="rdu-plans-btn" id="rduPlansBtn">Plans</button>
      <button type="button" class="rdu-quota-pill" id="rduQuotaPill" title="View your plan & usage">
        <span class="rdu-quota-dot" id="rduQuotaDot"></span>
        <span id="rduQuotaText">…</span>
      </button>
      <button type="button" class="btn btn-secondary" id="rduAuthBtn">Sign in</button>`;
    host.appendChild(wrap);
    els.pill = wrap.querySelector("#rduQuotaPill");
    els.dot = wrap.querySelector("#rduQuotaDot");
    els.text = wrap.querySelector("#rduQuotaText");
    els.authBtn = wrap.querySelector("#rduAuthBtn");
    els.pill.addEventListener("click", () => openAccountModal());
    els.authBtn.addEventListener("click", () => openAccountModal());
    wrap.querySelector("#rduPlansBtn").addEventListener("click", () => renderPlans());
  }

  async function refreshWidget() {
    if (!els.text) return;
    const s = await getQuotaStatus();
    const tag = `<span class="rdu-tier-tag ${s.tier === "paid" ? "paid" : ""}">${s.label}</span>`;
    els.text.innerHTML = `${tag} <span class="rdu-quota-text-long">${s.remaining} of ${s.limit} left</span>`;
    els.dot.className = "rdu-quota-dot" + (s.remaining === 0 ? " empty" : s.remaining <= Math.max(1, Math.ceil(s.limit * 0.2)) ? " warn" : "");
    els.authBtn.textContent = s.signedIn ? "Account" : "Sign in";
    els.pill.title = s.windowMs
      ? `${s.label} plan — ${s.remaining}/${s.limit} property scores left` + (s.resetsAt ? ` (${fmtReset(s.resetsAt)})` : "")
      : `${s.label} — ${s.remaining}/${s.limit} property scores left`;
  }

  // ---- Modal --------------------------------------------------------------
  function buildModal() {
    const overlay = document.createElement("div");
    overlay.className = "rdu-overlay";
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="rdu-modal" role="dialog" aria-modal="true" aria-labelledby="rduModalTitle">
        <div class="rdu-modal-head">
          <h3 id="rduModalTitle">Your account</h3>
          <button type="button" class="rdu-x" id="rduModalX" aria-label="Close">✕</button>
        </div>
        <div class="rdu-modal-body" id="rduModalBody"></div>
      </div>`;
    document.body.appendChild(overlay);
    els.overlay = overlay;
    els.modal = overlay.querySelector(".rdu-modal");
    els.modalTitle = overlay.querySelector("#rduModalTitle");
    els.modalBody = overlay.querySelector("#rduModalBody");
    overlay.querySelector("#rduModalX").addEventListener("click", closeModal);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) closeModal(); });
  }

  function closeModal() { if (els.overlay) els.overlay.hidden = true; }

  function planSummaryHtml(s) {
    const win = s.windowMs ? (s.windowMs === HOUR ? "per hour" : `per ${Math.round(s.windowMs / HOUR)} hours`) : "total";
    return `<strong>${s.label} plan</strong><span>${s.limit} property scores ${win}. ${s.remaining} left${s.resetsAt ? " · " + fmtReset(s.resetsAt) : ""}.</span>`;
  }

  // mode: "account" | "quota" (blocked) | "paid-feature"
  async function renderModal(mode, blockedStatus) {
    const s = blockedStatus || (await getQuotaStatus());
    const body = els.modalBody;
    if (els.modal) els.modal.classList.remove("rdu-modal--wide");

    // --- Blocked: out of credits ---
    if (mode === "quota") {
      els.modalTitle.textContent = "You're out of property scores";
      if (s.tier === "guest") {
        body.innerHTML = `
          <p class="rdu-sub">You've used all <strong>${s.limit}</strong> guest property scores. Create a free account for
          <strong>10 scores every 4 hours</strong> — it's instant.</p>
          ${signUpFormHtml()}`;
        wireAuthForm("signup");
      } else if (s.tier === "free") {
        body.innerHTML = `
          <p class="rdu-sub">You've reached <strong>${s.limit} scores</strong> in 4 hours${s.resetsAt ? ` (${fmtReset(s.resetsAt)})` : ""}.
          Go Pro for up to <strong>${TIERS.paid.limit} scores per hour</strong> plus Market-Intel refresh.</p>
          ${proCtaHtml()}`;
        wireProCta();
      } else {
        body.innerHTML = `<p class="rdu-sub">You've hit your Pro limit of <strong>${s.limit} scores/hour</strong>${s.resetsAt ? ` — ${fmtReset(s.resetsAt)}` : ""}. Thanks for the heavy usage!</p>
          <div class="rdu-actions"><button class="rdu-btn rdu-btn-ghost" id="rduOk">Got it</button></div>`;
        body.querySelector("#rduOk").addEventListener("click", closeModal);
      }
      els.overlay.hidden = false;
      return;
    }

    // --- Blocked: paid-only feature (Refresh) ---
    if (mode === "paid-feature") {
      els.modalTitle.textContent = "Refresh is a Pro feature";
      if (!s.signedIn) {
        body.innerHTML = `
          <p class="rdu-sub">Refreshing market intelligence fires an additional AI call, so it's reserved for <strong>Pro</strong>.
          Create a free account first, then upgrade anytime.</p>
          ${signUpFormHtml()}`;
        wireAuthForm("signup");
      } else {
        body.innerHTML = `
          <p class="rdu-sub">Refreshing market intelligence fires an additional AI call — available on <strong>Pro</strong>.</p>
          ${proCtaHtml()}`;
        wireProCta();
      }
      els.overlay.hidden = false;
      return;
    }

    // --- Account home ---
    els.modalTitle.textContent = s.signedIn ? "Your account" : "Sign in or create an account";
    if (s.signedIn) {
      body.innerHTML = `
        <div class="rdu-account-meta">
          <div><div class="em">${s.email}</div><div class="mt">Signed in</div></div>
          <span class="rdu-tier-tag ${s.tier === "paid" ? "paid" : ""}">${s.label}</span>
        </div>
        <div class="rdu-pro-card">${planSummaryHtml(s)}</div>
        ${s.tier !== "paid" ? proCtaHtml(true) : ""}
        <div class="rdu-actions"><button class="rdu-btn rdu-btn-ghost" id="rduSignOut">Sign out</button></div>`;
      if (s.tier !== "paid") wireProCta();
      body.querySelector("#rduSignOut").addEventListener("click", async () => { await RedataUser.signOut(); openAccountModal(); });
    } else {
      body.innerHTML = `
        <div class="rdu-pro-card">${planSummaryHtml(s)}</div>
        <div class="rdu-tabs">
          <button type="button" class="rdu-tab active" data-tab="signin">Sign in</button>
          <button type="button" class="rdu-tab" data-tab="signup">Create account</button>
        </div>
        <div id="rduFormSlot">${signInFormHtml()}</div>`;
      const slot = body.querySelector("#rduFormSlot");
      const tabs = body.querySelectorAll(".rdu-tab");
      tabs.forEach((t) => t.addEventListener("click", () => {
        tabs.forEach((x) => x.classList.remove("active"));
        t.classList.add("active");
        const which = t.dataset.tab;
        slot.innerHTML = which === "signup" ? signUpFormHtml() : signInFormHtml();
        wireAuthForm(which);
      }));
      wireAuthForm("signin");
    }
    els.overlay.hidden = false;
  }

  function signInFormHtml() {
    return `
      <div class="rdu-field"><label for="rduEmail">Email</label><input id="rduEmail" type="email" autocomplete="email" placeholder="you@firm.com"></div>
      <div class="rdu-field"><label for="rduPass">Password</label><input id="rduPass" type="password" autocomplete="current-password" placeholder="••••••••"></div>
      <div class="rdu-msg" id="rduMsg"></div>
      <div class="rdu-actions"><button class="rdu-btn rdu-btn-primary" id="rduSubmit">Sign in</button></div>`;
  }
  function signUpFormHtml() {
    return `
      <div class="rdu-field"><label for="rduEmail">Email</label><input id="rduEmail" type="email" autocomplete="email" placeholder="you@firm.com"></div>
      <div class="rdu-field"><label for="rduPass">Password</label><input id="rduPass" type="password" autocomplete="new-password" placeholder="At least 6 characters"></div>
      <div class="rdu-msg" id="rduMsg"></div>
      <div class="rdu-actions"><button class="rdu-btn rdu-btn-primary" id="rduSubmit">Create free account</button></div>
      <p class="rdu-foot-note">Free accounts get 10 property scores every 4 hours.</p>`;
  }
  function proCtaHtml(compact) {
    return `
      ${compact ? "" : `<div class="rdu-pro-card"><strong>REDATA Pro</strong><span>Up to ${TIERS.paid.limit} property scores per hour and one-click Market-Intel refresh.</span></div>`}
      <div class="rdu-actions"><button class="rdu-btn rdu-btn-primary" id="rduUpgrade">Upgrade to Pro</button></div>
      <p class="rdu-foot-note">REDATA Pro is ${TIERS.paid.priceDisplay} — review and continue from the Plans page.</p>`;
  }

  function wireAuthForm(which) {
    const body = els.modalBody;
    const submit = body.querySelector("#rduSubmit");
    const msg = body.querySelector("#rduMsg");
    if (!submit) return;
    const emailEl = body.querySelector("#rduEmail");
    const passEl = body.querySelector("#rduPass");
    const run = async () => {
      msg.className = "rdu-msg"; msg.textContent = "";
      submit.disabled = true;
      try {
        if (which === "signup") await RedataUser.signUp(emailEl.value, passEl.value);
        else await RedataUser.signIn(emailEl.value, passEl.value);
        msg.className = "rdu-msg ok"; msg.textContent = "Success!";
        setTimeout(closeModal, 350);
      } catch (e) {
        msg.className = "rdu-msg error"; msg.textContent = e.message || "Something went wrong.";
        submit.disabled = false;
      }
    };
    submit.addEventListener("click", run);
    [emailEl, passEl].forEach((el) => el && el.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); }));
  }

  function wireProCta() {
    // The Plans popup is the single place a subscription moves forward; every other
    // "Upgrade" affordance just routes here.
    const btn = els.modalBody.querySelector("#rduUpgrade");
    if (!btn) return;
    btn.addEventListener("click", () => renderPlans());
  }

  async function openAccountModal(tab) {
    await renderModal("account");
    if (tab === "signup") els.modalBody.querySelector('.rdu-tab[data-tab="signup"]')?.click();
  }
  function openUpgradeModal(s, m) { renderModal(m || "quota", s); }

  // ---- Plans / pricing modal ----------------------------------------------
  function planWindowLabel(t) {
    if (!t.windowMs) return "total";
    if (t.windowMs === HOUR) return "per hour";
    return `every ${Math.round(t.windowMs / HOUR)} hours`;
  }

  async function renderPlans() {
    const s = await getQuotaStatus();
    els.modalTitle.textContent = "Plans & pricing";
    if (els.modal) els.modal.classList.add("rdu-modal--wide");

    const card = (tierId, opts) => {
      const t = TIERS[tierId];
      const isCurrent = s.tier === tierId;
      return `
        <div class="rdu-plan-card ${opts.featured ? "featured" : ""} ${isCurrent ? "current" : ""}">
          ${opts.featured ? `<span class="rdu-plan-badge">Best value</span>` : ""}
          <div class="rdu-plan-name">${t.label}</div>
          <div class="rdu-plan-price">${opts.price || "Free"}</div>
          <div class="rdu-plan-quota">${t.limit} property scores <span>${planWindowLabel(t)}</span></div>
          <ul class="rdu-plan-feats">${opts.feats.map((f) => `<li>${f}</li>`).join("")}</ul>
          <div class="rdu-plan-cta">${
            isCurrent
              ? `<button class="rdu-btn rdu-btn-ghost" disabled>Current plan</button>`
              : (opts.cta || "")
          }</div>
        </div>`;
    };

    els.modalBody.innerHTML = `
      <p class="rdu-sub">A “property score” unlocks all data + AI calls for one property (comps, listing parse, and market intel share one credit). Reset starts a new property.</p>
      <div class="rdu-plans-grid">
        ${card("guest", {
          feats: ["No account needed", "Full deal calculator", "Comps, parse &amp; market intel"],
        })}
        ${card("free", {
          feats: ["Everything in Guest", "Resets every 4 hours", "Save your usage to an account"],
          cta: `<button class="rdu-btn rdu-btn-primary" id="rduPlanFree">Create free account</button>`,
        })}
        ${card("paid", {
          featured: true,
          price: TIERS.paid.priceDisplay,
          feats: ["Everything in Free", "Hourly limit, not 4-hourly", "One-click Market-Intel refresh"],
          cta: `<button class="rdu-btn rdu-btn-primary" id="rduPlanPro">Upgrade to Pro</button>`,
        })}
      </div>
      <p class="rdu-foot-note" id="rduPlansNote">REDATA Pro is ${TIERS.paid.priceDisplay}. Choose Upgrade to start secure Stripe checkout.</p>`;

    const setNote = (msg, isError) => {
      const note = els.modalBody.querySelector("#rduPlansNote");
      if (note) { note.textContent = msg; note.style.color = isError ? "#9f342f" : ""; }
    };

    els.modalBody.querySelector("#rduPlanFree")?.addEventListener("click", () => openAccountModal("signup"));
    els.modalBody.querySelector("#rduPlanPro")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const out = await RedataUser.upgradeToPaid();
      if (out.status === "needs_account") { openAccountModal("signup"); return; }   // guest → make an account first
      if (out.status === "redirecting") return;                                       // navigating to Stripe
      if (out.status === "not_configured") setNote("Billing isn’t connected yet — add your Stripe keys to enable checkout.", true);
      else if (out.status === "error") setNote(out.message || "Something went wrong.", true);
      btn.disabled = false;
    });

    els.overlay.hidden = false;
  }

  // ---- Boot ---------------------------------------------------------------
  function boot() {
    injectStyles();
    buildWidget();
    buildModal();
    RedataUser.startNewProperty();
    RedataUser.onChange(refreshWidget);
    refreshWidget();
    // keep the "resets in" copy fresh for windowed tiers
    setInterval(refreshWidget, 60000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
