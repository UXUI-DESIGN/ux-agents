// Janus AI 공통 상단 메뉴
//   - 대메뉴는 더블 다이아몬드 4단계(발견 · 정의 · 발전 · 전달), 각 에이전트는 그 아래 하위 메뉴
//   - 메뉴를 추가하려면 아래 MENU의 해당 단계 items에 한 줄만 넣으면 모든 페이지에 반영된다
//   - 각 페이지의 <header class="nav"> 안 <nav>를 이 스크립트가 채운다
(() => {
  // path: 이 경로로 시작하는 페이지에서 '현재 메뉴'로 표시한다
  const MENU = [
    {
      ko: "발견", en: "Discover", desc: "사용자를 만나 문제를 넓게 탐색합니다",
      items: [
        { label: "인터뷰 가이드", hint: "리서치 목표 → 인터뷰 질문지", path: "/guide/" },
        { label: "인터뷰 모더레이터", hint: "AI가 진행하는 사용자 인터뷰", path: "/moderator/" },
      ],
    },
    {
      ko: "정의", en: "Define", desc: "발견한 것에서 핵심 문제를 좁혀 정의합니다",
      items: [
        { label: "페르소나", hint: "인터뷰 기록 → 사용자 유형", path: "/persona/" },
        { label: "저니맵", hint: "단계별 행동 · 감정 · 페인포인트", path: "/journey/" },
      ],
    },
    {
      ko: "발전", en: "Develop", desc: "해결 아이디어를 넓게 펼쳐 봅니다",
      items: [
        { label: "시나리오 보드", hint: "개선 경험을 콘티 · 컷으로", path: "/scenario/" },
      ],
    },
    {
      ko: "전달", en: "Deliver", desc: "검증하고 다듬어 결과물로 전달합니다",
      items: [],
    },
  ];

  const nav = document.querySelector(".nav .container > nav");
  if (!nav) return;

  const style = document.createElement("style");
  style.textContent = `
    .nav nav { min-width: 0; }
    .gnb { display: flex; gap: 4px; list-style: none; }
    .gnb > li { position: relative; }
    .gnb-top {
      display: flex; align-items: baseline; gap: 6px; padding: 8px 14px; border: 0; border-radius: 999px;
      background: none; font: inherit; font-size: 14px; font-weight: 600; color: var(--text-sub); white-space: nowrap; cursor: pointer;
    }
    .gnb-top small { font-size: 11px; font-weight: 500; letter-spacing: 0.02em; opacity: 0.7; }
    .gnb-top::after {
      content: ""; align-self: center; width: 6px; height: 6px; margin-left: 2px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
      transform: translateY(-2px) rotate(45deg); transition: transform 0.15s; opacity: 0.6;
    }
    .gnb > li.open > .gnb-top, .gnb-top:hover { background: var(--accent-soft); color: var(--accent); }
    .gnb > li.open > .gnb-top::after { transform: translateY(1px) rotate(225deg); }
    .gnb > li.current > .gnb-top { color: var(--accent); font-weight: 700; }
    .gnb-sub { display: none; position: absolute; top: 100%; left: 0; z-index: 20; padding-top: 8px; }
    .gnb > li:nth-last-child(-n+2) > .gnb-sub { left: auto; right: 0; }
    .gnb > li.open > .gnb-sub { display: block; }
    .gnb-panel {
      min-width: 250px; padding: 8px; border: 1px solid var(--line); border-radius: 14px;
      background: #fff; box-shadow: 0 12px 32px rgba(20, 22, 31, 0.12);
    }
    .gnb-desc { padding: 6px 10px 8px; font-size: 12px; color: var(--text-sub); white-space: nowrap; }
    .gnb-panel ul { list-style: none; }
    .gnb-panel a { display: block; padding: 9px 10px; border-radius: 10px; }
    .gnb-panel a b { display: block; font-size: 14px; font-weight: 600; color: var(--text); }
    .gnb-panel a span { display: block; font-size: 12px; color: var(--text-sub); }
    .gnb-panel a:hover, .gnb-panel a[aria-current="page"] { background: var(--accent-soft); }
    .gnb-panel a:hover b, .gnb-panel a[aria-current="page"] b { color: var(--accent); }
    .gnb-empty { padding: 9px 10px; border-radius: 10px; background: var(--bg-soft, #f6f7fb); font-size: 13px; color: var(--text-sub); }
    @media (hover: hover) {
      .gnb > li:hover > .gnb-top { background: var(--accent-soft); color: var(--accent); }
      .gnb > li:hover > .gnb-sub { display: block; }
    }
    /* 좁은 화면: 하위 메뉴를 메뉴 줄 전체 폭으로 펼친다 */
    @media (max-width: 640px) {
      .gnb { position: relative; gap: 0; margin-left: -10px; }
      .gnb > li { position: static; }
      .gnb-top { padding: 8px 10px; }
      .gnb-top small { display: none; }
      .gnb-sub, .gnb > li:nth-last-child(-n+2) > .gnb-sub { left: 0; right: 0; padding-top: 4px; }
      .gnb-panel { min-width: 0; }
      .gnb-desc { white-space: normal; }
    }`;
  document.head.appendChild(style);

  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };

  const here = location.pathname;
  const list = el("ul", { className: "gnb" });

  MENU.forEach((stage, i) => {
    const id = `gnb-sub-${i}`;
    const top = el("button", { type: "button", className: "gnb-top" }, stage.ko, el("small", { textContent: stage.en }));
    top.setAttribute("aria-expanded", "false");
    top.setAttribute("aria-controls", id);

    const panel = el("div", { className: "gnb-panel" }, el("p", { className: "gnb-desc", textContent: stage.desc }));
    let current = false;
    if (stage.items.length) {
      const sub = el("ul");
      for (const item of stage.items) {
        const a = el("a", { href: item.path }, el("b", { textContent: item.label }), el("span", { textContent: item.hint }));
        if (here.startsWith(item.path)) { a.setAttribute("aria-current", "page"); current = true; }
        sub.append(el("li", {}, a));
      }
      panel.append(sub);
    } else {
      panel.append(el("p", { className: "gnb-empty", textContent: "준비 중인 메뉴입니다." }));
    }

    const li = el("li", { className: current ? "current" : "" }, top, el("div", { className: "gnb-sub", id }, panel));
    top.addEventListener("click", () => setOpen(li.classList.contains("open") ? null : li));
    list.append(li);
  });

  // 한 번에 하나만 펼친다
  function setOpen(target) {
    for (const li of list.children) {
      const open = li === target;
      li.classList.toggle("open", open);
      li.querySelector(".gnb-top").setAttribute("aria-expanded", String(open));
    }
  }
  document.addEventListener("click", (e) => { if (!list.contains(e.target)) setOpen(null); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = list.querySelector("li.open .gnb-top");
    setOpen(null);
    if (open) open.focus();
  });

  nav.setAttribute("aria-label", "메뉴");
  nav.replaceChildren(list);
})();
