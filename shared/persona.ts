// 페르소나 문서의 기준 스키마
//   페르소나 1장(가로형 1페이지)을 구성하는 모든 영역을 그대로 옮긴 타입이다.
//   화면(/persona/[id]) · AI 생성 프롬프트의 JSON Schema · D1 personas 테이블은 모두 이 파일을 따른다.
//   Worker(JS)에서는  /** @typedef {import("../../shared/persona").Persona} Persona */  처럼 JSDoc으로 참조한다.
//
// 문서 레이아웃과 타입의 대응
//   ┌ 상단      priority 배지 + tagline
//   ├ 왼쪽 패널  photoUrl → profile(이름·성별·나이·취미·직업) → quote
//   ├ 오른쪽 상단 context(서비스 이용 환경 · 성격 · 이용 동기)
//   ├ Lifestyle  lifestyle
//   └ 하단 3열   behavior(해시태그 칩 + 낮음↔높음 슬라이더) / painpoints / needs

/** 배지에 표시되는 페르소나 우선순위 */
export type PersonaPriority = "primary" | "secondary" | "tertiary";

/** 배지 표기 (영문 문서 양식을 그대로 따른다) */
export const PERSONA_PRIORITY_LABEL: Record<PersonaPriority, string> = {
  primary: "Primary Persona",
  secondary: "Secondary Persona",
  tertiary: "Tertiary Persona",
};

/**
 * 강조 표시가 들어가는 문장.
 * 굵게 보일 구간은 `**…**`로 감싼다. 예) "다양한 콘텐츠를 감상하며 **지인과 소통**하고 싶어요"
 * 화면에서는 renderEmphasis()로 <strong>으로 바꿔 그린다. 다른 마크업은 허용하지 않는다.
 */
export type EmphasisText = string;

/** 왼쪽 패널 Profile 영역 */
export interface PersonaProfile {
  /** 이름 (가명) */
  name: string;
  /** 성별: 자유 서술. 예) "여성", "남성", "논바이너리" */
  gender: string;
  /** 나이(만). 화면에서는 "32세"로 표기 */
  age: number;
  /** 취미. 화면에서는 ", "로 이어 붙인다 */
  hobbies: string[];
  /** 직업 */
  job: string;
}

/** 오른쪽 상단 라벨-값 2줄 */
export interface PersonaContext {
  /** 서비스 이용 환경. 예) "스마트폰, 태블릿, 노트북을 자주 사용" */
  environment: string;
  /** 성격 */
  personality: string;
  /** 콘텐츠(서비스) 이용 동기 */
  motivation: string;
}

/** Behavior 열의 해시태그 묶음. 예) 제목 "콘텐츠 이용 행태", 태그 ["밤", "휴식 목적", …] */
export interface BehaviorTagGroup {
  title: string;
  /** '#' 없이 저장한다. 화면에서 '#'을 붙여 칩으로 그린다 */
  tags: string[];
}

/** Behavior 열의 낮음↔높음 슬라이더 한 줄 */
export interface BehaviorScale {
  /** 예) "추천시스템을 활용한 콘텐츠 탐색 선호도" */
  label: string;
  /** 0~100. 슬라이더 손잡이 위치 */
  value: number;
  /** 왼쪽 끝 라벨 (기본 "낮음") */
  lowLabel?: string;
  /** 오른쪽 끝 라벨 (기본 "높음") */
  highLabel?: string;
}

export interface PersonaBehavior {
  tagGroups: BehaviorTagGroup[];
  scales: BehaviorScale[];
}

/** Painpoint · Needs 공통: 제목(굵게) + 설명 */
export interface PersonaPoint {
  title: string;
  description: string;
}

/** 페르소나 문서 본문 — 사용자가 편집하고 AI가 생성하는 부분 */
export interface PersonaContent {
  priority: PersonaPriority;
  /** 상단 한 줄 요약. `**…**`로 핵심어 강조 */
  tagline: EmphasisText;
  /** 인물 사진 URL. 없으면 실루엣 플레이스홀더 */
  photoUrl: string | null;
  profile: PersonaProfile;
  context: PersonaContext;
  /** Lifestyle 단락. 줄바꿈은 "\n" */
  lifestyle: string;
  behavior: PersonaBehavior;
  painpoints: PersonaPoint[];
  needs: PersonaPoint[];
  /** 왼쪽 패널 하단 큰따옴표 인용. `**…**`로 핵심어 강조 */
  quote: EmphasisText;
}

/** 저장된 페르소나 (API 응답 · 화면 입력 형태) */
export interface Persona extends PersonaContent {
  id: string;
  /** 만든 회원 */
  userId: string;
  /** 바탕이 된 인터뷰 세션. 세션 없이 직접 만든 페르소나면 null */
  sessionId: string | null;
  /** epoch ms */
  createdAt: number;
  /** epoch ms */
  updatedAt: number;
}

/** 새로 만들 때 클라이언트가 보내는 본문 */
export type PersonaInput = PersonaContent & { sessionId?: string | null };

/**
 * D1 personas 테이블 한 행 (worker/migrations/0010_personas.sql)
 * - 목록·검색에 쓰는 값은 낱개 컬럼, 구조가 있는 값은 JSON 문자열 컬럼
 */
export interface PersonaRow {
  id: string;
  user_id: string;
  session_id: string | null;
  priority: PersonaPriority;
  tagline: string;
  photo_url: string | null;
  name: string;
  gender: string;
  age: number;
  hobbies: string;      // JSON string[]
  job: string;
  environment: string;
  personality: string;
  motivation: string;
  lifestyle: string;
  behavior: string;     // JSON PersonaBehavior
  painpoints: string;   // JSON PersonaPoint[]
  needs: string;        // JSON PersonaPoint[]
  quote: string;
  created_at: number;
  updated_at: number;
}

/** DB 행 → Persona */
export function rowToPersona(row: PersonaRow): Persona {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    priority: row.priority,
    tagline: row.tagline,
    photoUrl: row.photo_url,
    profile: {
      name: row.name,
      gender: row.gender,
      age: row.age,
      hobbies: JSON.parse(row.hobbies || "[]"),
      job: row.job,
    },
    context: {
      environment: row.environment,
      personality: row.personality,
      motivation: row.motivation,
    },
    lifestyle: row.lifestyle,
    behavior: JSON.parse(row.behavior || '{"tagGroups":[],"scales":[]}'),
    painpoints: JSON.parse(row.painpoints || "[]"),
    needs: JSON.parse(row.needs || "[]"),
    quote: row.quote,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Persona → DB 행 (INSERT/UPDATE 바인딩용) */
export function personaToRow(p: Persona): PersonaRow {
  return {
    id: p.id,
    user_id: p.userId,
    session_id: p.sessionId,
    priority: p.priority,
    tagline: p.tagline,
    photo_url: p.photoUrl,
    name: p.profile.name,
    gender: p.profile.gender,
    age: p.profile.age,
    hobbies: JSON.stringify(p.profile.hobbies),
    job: p.profile.job,
    environment: p.context.environment,
    personality: p.context.personality,
    motivation: p.context.motivation,
    lifestyle: p.lifestyle,
    behavior: JSON.stringify(p.behavior),
    painpoints: JSON.stringify(p.painpoints),
    needs: JSON.stringify(p.needs),
    quote: p.quote,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}
