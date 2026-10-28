// UXA 공통 로그인 상태
//   - 세션(토큰 + 사용자 정보)을 '로그인 상태 유지'면 localStorage, 아니면 sessionStorage에 둔다
//   - 내비게이션 오른쪽에 로그인 · 회원가입 / 표시 이름 · 마이페이지 · 로그아웃을 그린다
//   - <body data-auth="required">인 페이지는 로그인하지 않으면 로그인 페이지로 보낸다 (로그인 후 돌아옴)
//   페이지 스크립트는 window.UXA로 쓴다.
(() => {
  // 로컬 Worker로 붙어 보려면 콘솔에서 localStorage.setItem("uxa.apiBase", "http://localhost:8787") (지우면 원래대로)
  const API_BASE = (() => { try { return localStorage.getItem("uxa.apiBase") || ""; } catch { return ""; } })() || "https://uxa-api.kopeakai88.workers.dev";
  const KEY = "uxa.session";
  const stores = () => [window.localStorage, window.sessionStorage];

  function getSession() {
    for (const store of stores()) {
      try {
        const raw = store.getItem(KEY);
        if (!raw) continue;
        const s = JSON.parse(raw);
        if (s && s.token && s.user) return s;
        store.removeItem(KEY);
      } catch {
        // 예전 형식(토큰 문자열만 저장)이거나 저장소를 못 쓰는 경우
        try { store.removeItem(KEY); } catch {}
      }
    }
    return null;
  }

  function setSession({ token, user }, remember) {
    clearSession();
    try { (remember ? localStorage : sessionStorage).setItem(KEY, JSON.stringify({ token, user })); } catch {}
    renderNav();
  }

  function clearSession() {
    for (const store of stores()) { try { store.removeItem(KEY); } catch {} }
  }

  async function api(path, { method = "GET", body } = {}) {
    const session = getSession();
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (session) headers.Authorization = `Bearer ${session.token}`;
    const res = await fetch(API_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  const currentPath = () => location.pathname + location.search + location.hash;

  // 로그인 뒤 돌아갈 주소는 이 사이트 안의 경로만 허용한다 (다른 사이트로 보내는 링크 악용 방지)
  function safeNext(raw, fallback = "/mypage/") {
    if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
    if (/^\/(login|signup)\//.test(raw)) return fallback;
    return raw;
  }

  const loginUrl = (next = currentPath()) => `/login/?next=${encodeURIComponent(safeNext(next))}`;
  const signupUrl = (next = currentPath()) => `/signup/?next=${encodeURIComponent(safeNext(next))}`;

  // 로그인했으면 세션을, 아니면 로그인 페이지로 보내고 null을 돌려준다
  function requireLogin(next = currentPath()) {
    const session = getSession();
    if (!session) location.replace(loginUrl(next));
    return session;
  }

  async function logout() {
    try { await api("/api/auth/logout", { method: "POST" }); } catch {}
    clearSession();
    location.href = "/";
  }

  // ── 내비게이션 오른쪽 ──
  const style = document.createElement("style");
  style.textContent = `
    .nav-auth { flex: none; display: flex; align-items: center; gap: 4px; font-size: 14px; white-space: nowrap; }
    .nav-auth a, .nav-auth button { padding: 6px 10px; border: 0; border-radius: 999px; background: none; font: inherit; font-weight: 500; color: var(--text-sub); cursor: pointer; }
    .nav-auth a:hover, .nav-auth button:hover { background: var(--accent-soft); color: var(--accent); }
    .nav-auth .sep { color: var(--line); }
    .nav-auth .who { max-width: 140px; overflow: hidden; text-overflow: ellipsis; margin-right: 2px; font-weight: 700; color: var(--text); }
    .nav-auth .primary { background: var(--accent); color: #fff; font-weight: 600; }
    .nav-auth .primary:hover { background: #4338ca; color: #fff; }
    /* 좁은 화면: 첫 줄에 로고와 로그인 메뉴, 둘째 줄에 에이전트 메뉴 */
    @media (max-width: 960px) {
      .nav .container { flex-direction: row; flex-wrap: wrap; align-items: center; height: auto; padding-top: 10px; padding-bottom: 6px; row-gap: 4px; }
      .nav .container > nav { order: 3; width: 100%; }
    }
    @media (max-width: 640px) {
      .nav-auth { font-size: 13px; }
      .nav-auth a, .nav-auth button { padding: 6px 8px; }
      .nav-auth .who { max-width: 90px; }
    }`;
  document.head.appendChild(style);

  function renderNav() {
    const container = document.querySelector(".nav .container");
    if (!container) return;
    let box = container.querySelector(".nav-auth");
    if (!box) {
      box = document.createElement("div");
      box.className = "nav-auth";
      container.appendChild(box);
    }
    const session = getSession();
    const onAuthPage = /^\/(login|signup)\//.test(location.pathname);
    const next = onAuthPage ? new URLSearchParams(location.search).get("next") || "" : currentPath();
    box.replaceChildren();
    const link = (text, href, cls) => Object.assign(document.createElement("a"), { textContent: text, href, className: cls || "" });
    const sep = () => Object.assign(document.createElement("span"), { textContent: "·", className: "sep" });
    if (session) {
      const who = Object.assign(document.createElement("span"), { className: "who", textContent: session.user.name, title: session.user.email });
      const out = Object.assign(document.createElement("button"), { type: "button", textContent: "로그아웃" });
      out.addEventListener("click", logout);
      box.append(who, link("마이페이지", "/mypage/"), sep(), out);
    } else {
      box.append(link("로그인", next ? loginUrl(next) : "/login/"), sep(), link("회원가입", next ? signupUrl(next) : "/signup/"));
    }
  }

  window.UXA = { API_BASE, getSession, setSession, clearSession, api, safeNext, loginUrl, signupUrl, requireLogin, logout };

  if (document.body.dataset.auth === "required" && !requireLogin()) return;
  renderNav();

  // 저장된 세션이 아직 유효한지 서버에 확인 (만료·로그아웃된 세션 정리, 표시 이름 갱신)
  const session = getSession();
  if (session) {
    api("/api/auth/me").then(({ res, data }) => {
      // 확인하는 동안 로그아웃·재로그인했으면 그 상태를 덮어쓰지 않는다
      if (getSession()?.token !== session.token) return;
      if (res.status === 401) {
        clearSession();
        if (document.body.dataset.auth === "required") location.replace(loginUrl());
        else renderNav();
      } else if (res.ok && data.user) {
        const remember = (() => { try { return !!localStorage.getItem(KEY); } catch { return false; } })();
        try { (remember ? localStorage : sessionStorage).setItem(KEY, JSON.stringify({ token: session.token, user: data.user })); } catch {}
        renderNav();
      }
    }).catch(() => {});
  }
})();
