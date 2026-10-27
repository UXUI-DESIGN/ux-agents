// 모델이 JSON 앞뒤에 엉뚱한 글자를 붙이는 경우가 있어, 첫 JSON 객체만 골라 읽는다
export function firstJson(raw) {
  try { return JSON.parse(raw); } catch {}
  for (let start = raw.indexOf("{"); start >= 0; start = raw.indexOf("{", start + 1)) {
    for (let end = raw.indexOf("}", start); end >= 0; end = raw.indexOf("}", end + 1)) {
      try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
    }
  }
  return null;
}
