// 회원가입·로그인·세션
//   비밀번호: PBKDF2-SHA256(무작위 salt, 10만 회)로 해시해서만 저장. 원래 값은 로그·DB 어디에도 남기지 않는다.
//   세션: 무작위 토큰을 브라우저에 주고, DB에는 토큰의 SHA-256 해시만 저장한다.

const PBKDF2_ITERATIONS = 100000; // Workers WebCrypto의 PBKDF2 상한
const SESSION_DAYS_REMEMBER = 30; // 가입 직후, '로그인 상태 유지'를 고른 로그인
const SESSION_DAYS_SHORT = 1; // '로그인 상태 유지'를 고르지 않은 로그인
const RATE_WINDOW_SEC = 10 * 60; // 10분 동안
const RATE_LIMITS = { signup: 5, login: 10, interview: 30, sample: 20 }; // 같은 IP에서 허용하는 시도 횟수 (sample: 로그인 없는 샘플 페르소나 채팅)

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVALID_LOGIN = "이메일 또는 비밀번호를 확인해 주세요.";

// 페이지의 비밀번호 규칙과 같다
export function passwordProblems(pw) {
  const problems = [];
  if (pw.length < 8) problems.push("8자 이상");
  if (pw.length > 64) problems.push("64자 이하");
  if (!/[A-Za-z]/.test(pw)) problems.push("영문 포함");
  if (!/[0-9]/.test(pw)) problems.push("숫자 포함");
  return problems;
}

export async function signup(request, env, json) {
  const now = Math.floor(Date.now() / 1000);
  const limited = await rateLimit(request, env, json, "signup", "가입", now);
  if (limited) return limited;

  let body;
  try { body = await request.json(); } catch { return json({ error: "JSON 본문이 필요해요." }, 400); }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: "이메일 형식을 확인해 주세요.", field: "email" }, 400);
  const problems = passwordProblems(password);
  if (problems.length) return json({ error: `비밀번호 규칙을 확인해 주세요: ${problems.join(", ")}`, field: "password" }, 400);
  if (!name || name.length > 30) return json({ error: "표시 이름은 1~30자로 적어 주세요.", field: "name" }, 400);
  if (body.agree !== true) return json({ error: "서비스 이용 및 개인정보 처리 안내에 동의해 주세요.", field: "agree" }, 400);

  const exists = await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first();
  if (exists) return json({ error: "이미 가입된 이메일입니다. 로그인해 주세요.", code: "email_exists", field: "email" }, 409);

  const user = { id: crypto.randomUUID(), email, name };
  try {
    await env.DB.prepare("INSERT INTO users (id, email, password_hash, display_name, agreed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(user.id, email, await hashPassword(password), name, now, now).run();
  } catch (err) {
    // 같은 이메일로 동시에 가입한 경우
    if (/UNIQUE/i.test(String(err))) return json({ error: "이미 가입된 이메일입니다. 로그인해 주세요.", code: "email_exists", field: "email" }, 409);
    throw err;
  }

  const token = await createSession(env, user.id, now, SESSION_DAYS_REMEMBER);
  return json({ token, user, remember: true }, 201);
}

export async function login(request, env, json) {
  const now = Math.floor(Date.now() / 1000);
  const limited = await rateLimit(request, env, json, "login", "로그인", now);
  if (limited) return limited;

  let body;
  try { body = await request.json(); } catch { return json({ error: "JSON 본문이 필요해요." }, 400); }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const remember = body.remember === true;

  // 없는 이메일이어도 같은 만큼 계산해서, 응답 내용·시간으로 가입 여부를 알 수 없게 한다
  const row = email && password
    ? await env.DB.prepare("SELECT id, email, display_name, password_hash FROM users WHERE email = ?").bind(email).first()
    : null;
  const ok = await verifyPassword(password, row ? row.password_hash : await dummyHash());
  if (!row || !ok) return json({ error: INVALID_LOGIN, code: "invalid_credentials" }, 401);

  const token = await createSession(env, row.id, now, remember ? SESSION_DAYS_REMEMBER : SESSION_DAYS_SHORT);
  return json({ token, user: { id: row.id, email: row.email, name: row.display_name }, remember });
}

export async function logout(request, env, json) {
  const token = bearer(request);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  return json({ ok: true });
}

export async function me(request, env, json) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: "로그인이 필요해요.", code: "unauthorized" }, 401);
  return json({ user });
}

export async function currentUser(request, env) {
  const token = bearer(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT u.id, u.email, u.display_name AS name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?"
  ).bind(await sha256Hex(token), Math.floor(Date.now() / 1000)).first();
  return row || null;
}

function bearer(request) {
  const auth = request.headers.get("Authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

// 같은 IP에서 짧은 시간 반복 시도를 막는다 (성공·실패 모두 센다). 막을 때만 응답을 돌려준다
export async function rateLimit(request, env, json, action, label, now) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = `${action}:` + (await sha256Hex(ip));
  const since = now - RATE_WINDOW_SEC;
  const { n, oldest } = await env.DB.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM auth_attempts WHERE key = ? AND created_at > ?")
    .bind(key, since).first();
  if (n >= RATE_LIMITS[action]) {
    const retryAfter = Math.max(1, oldest + RATE_WINDOW_SEC - now);
    return json({ error: `${label} 시도가 너무 많아요. ${Math.ceil(retryAfter / 60)}분 뒤에 다시 시도해 주세요.`, code: "rate_limited", retryAfter }, 429);
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO auth_attempts (key, created_at) VALUES (?, ?)").bind(key, now),
    env.DB.prepare("DELETE FROM auth_attempts WHERE created_at < ?").bind(now - 86400),
  ]);
  return null;
}

async function createSession(env, userId, now, days) {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, now, now + days * 86400).run();
  return token;
}

// 저장 형식: pbkdf2$반복횟수$salt(hex)$hash(hex)
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

async function verifyPassword(password, stored) {
  const [scheme, iterations, saltHex, hashHex] = stored.split("$");
  if (scheme !== "pbkdf2") return false;
  const actual = await pbkdf2(password, fromHex(saltHex), Number(iterations));
  const expected = fromHex(hashHex);
  return actual.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(actual, expected);
}

let dummy;
const dummyHash = async () => (dummy ||= await hashPassword(crypto.randomUUID()));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

async function sha256Hex(text) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
