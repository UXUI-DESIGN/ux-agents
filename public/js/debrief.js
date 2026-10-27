// 디브리핑 → 마크다운 (세션 상세·마이페이지 '내 디브리핑'에서 함께 쓴다)
//   톱 인사이트 3 · 인상적 인용구 5~7 · 다음 세션에서 고칠 점 · 포화 판단 (사용자 인터뷰 스킬 §5.1)
window.UXA_DEBRIEF = (() => {
  const pad2 = (n) => String(n).padStart(2, "0");
  const when = (sec) => { const d = new Date(sec * 1000); return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  const refs = (list) => (list?.length ? ` _(${list.map((r) => r.ref).join(", ")})_` : "");

  function toMarkdown(c, { sessionName, topic, meta, finalizedAt, isDraft }) {
    const lines = [
      "---", `session: ${sessionName}`, `topic: ${topic}`,
      `status: ${isDraft ? "초안" : "확정"}`, finalizedAt ? `finalized: ${when(finalizedAt)}` : null,
      meta?.participants?.length ? `based_on: ${meta.participants.join(", ")} (완료된 참가자, 분석 제외 구간·철회 기록 제외, 마스킹된 전사 기준)` : null,
      meta?.model ? `drafted_by: ${meta.model} (AI 초안을 리서처가 검토)` : null,
      "---", "", `# ${sessionName} — 디브리핑${isDraft ? " (초안)" : ""}`, "",
    ].filter((l) => l !== null);

    lines.push("## 톱 인사이트", "");
    (c.insights || []).forEach((x, i) => {
      lines.push(`${i + 1}. ${x.text}${refs(x.refs)}`, `   - 확신도: **${x.confidence}**${x.confidence === "낮음" ? " ⚠️ 리서처 확인 필요" : ""}${x.confidence_reason ? ` — ${x.confidence_reason}` : ""}`);
    });
    lines.push("", "## 인상적인 인용구", "");
    (c.quotes || []).forEach((q) => lines.push(`> "${q.text}" — **${q.code}**${q.ref ? ` (${q.ref})` : ""}${q.verified ? "" : " ⚠️ 원문 확인 필요"}`, ...(q.why ? [`>`, `> ${q.why}`] : []), ""));
    lines.push("## 다음 세션에서 고칠 점", "");
    (c.improvements || []).forEach((x) => lines.push(`- **${x.type}**: ${x.text}${refs(x.refs)}`));
    lines.push("", "## 포화 판단", "");
    (c.saturation || []).forEach((x) => lines.push(`- **${x.topic}** — ${x.status}${x.note ? `: ${x.note}` : ""}`));
    if (c.memo?.trim()) lines.push("", "## 리서처 메모", "", c.memo.trim());
    return lines.join("\n") + "\n";
  }

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const fileName = (sessionName, isDraft) => `DEBRIEF_${sessionName.replace(/[\\/:*?"<>|\s]+/g, "_")}${isDraft ? "_초안" : ""}.md`;

  return { toMarkdown, download, fileName };
})();
