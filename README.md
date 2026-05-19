# GROUND

KBO 10구단 매거진 커버 톤의 모바일 우선 앱. 응원 팀의 그날 경기·선발 투수를 풀스크린 히어로 카드로, AI(Replicate LoRA)로 즉석 생성한 9:16 화보를 배경으로 보여준다. 우천 시에는 자동으로 '수중전 모드'로 전환된다.

## Stack

- Next.js 16 (App Router, Turbopack)
- React 19
- Tailwind CSS 3.4
- Framer Motion
- Lucide React
- Replicate (LoRA img2img)
- OpenWeather (구장 위치 기반 실시간 날씨)

## Pages

- `/today` — 응원 팀의 오늘 경기를 풀스크린 히어로 카드로
- `/schedule` — 어제·오늘·내일 경기 리스트
- `/my` — 응원 팀 선택

## Run

```bash
npm install
cp .env.local.example .env.local   # 토큰/키 채우기
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000) 을 열고 모바일 뷰(390x844)로 확인.

## Environment

`.env.local`에 아래 값을 채운다. 키가 비어 있어도 서비스는 fallback으로 정상 동작한다.

| 변수 | 용도 | 미설정 시 동작 |
|---|---|---|
| `REPLICATE_API_TOKEN` | LoRA 이미지 생성 | placeholder ref 이미지로 fallback |
| `REPLICATE_MODEL_VERSION` | 기본 LoRA 모델 | `config/teams.ts`의 팀별 `modelId` 사용 |
| `OPENWEATHER_API_KEY` | 구장 위치 날씨 조회 | `isRainy: false` (항상 맑음) |
| `DATABASE_URL` | Prisma(PostgreSQL) 연결 문자열 | DB 기능 비활성 |
| `APP_ENV` | 서버 실행 환경 (`production` / `alpha`) | 미설정 시 `development` |
| `NEXT_PUBLIC_APP_ENV` | 클라이언트 표시 환경 (`alpha`면 상단 배지 노출) | 배지 미노출 |

### Alpha 배포 운영 권장

- `alpha` 브랜치를 별도 유지하고 Vercel Preview/별도 프로젝트로 고정 URL 운용
- `APP_ENV=alpha`, `NEXT_PUBLIC_APP_ENV=alpha` 설정
- `alpha` 환경에서는 크론 API가 기본적으로 실행되지 않음
  - 대상: `/api/cron/check-score`, `/api/cron/check-lineup`, `/api/cron/notify`, `/api/cron/pregame-preview`
  - 강제 테스트 시에만 `?force=1` 쿼리로 수동 호출

## Prisma (알림 시스템 1단계)

웹 푸시 구독/인앱 알림 저장용 스키마가 `prisma/schema.prisma`에 추가되어 있다.

```bash
# 1) 환경 변수 준비
cp .env.local.example .env.local
# .env.local 의 DATABASE_URL 채우기

# 2) Prisma 클라이언트 생성
npm run db:generate

# 3) 로컬 마이그레이션 생성 + 적용
npm run db:migrate -- --name init_notifications

# 4) 데이터 확인 (선택)
npm run db:studio
```

## Notification (2단계/3단계)

### 2) Web Push + Service Worker + 인앱 알림

- 서비스 워커: `public/sw.js`
- 구독 API: `POST /api/notifications/subscribe`
- 구독 해제 API: `POST /api/notifications/unsubscribe`
- 인앱 알림 조회: `GET /api/notifications`
- 읽음 처리: `POST /api/notifications/read`
- UI: `components/NotificationBell.tsx` (우상단 종 패널)

VAPID 키 생성:

```bash
npx web-push generate-vapid-keys
```

생성된 값을 `.env.local`에 설정:

- `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`

### 3) Vercel Cron 발송 API

- 경로: `GET /api/cron/notify`
- 설정: `vercel.json` (매일 14:00 KST = `0 5 * * *` UTC)
- 메시지: `오늘의 KBO 승부 예측하고 초인간 포카 뽑으세요!`
- 보안: `Authorization: Bearer <CRON_SECRET>` (선택, 로컬은 미설정 허용)

### 4) 실시간 스코어 외부 스케줄러 (권장)

`check-score`는 Vercel Hobby 크론 제약 때문에 기본 스케줄이 하루 1회다.  
실시간 알림을 위해 외부 스케줄러(예: cron-job.org)에서 1분 간격 호출을 권장한다.

- URL: `https://ground-alpha.vercel.app/api/cron/check-score?secret=<CRON_SECRET>&source=external`
- 주기: `* * * * *` (매분)
- 메서드: `GET`
- 성공 기준: JSON 응답 `ok: true`

중요:
- 서버는 중복 실행을 DB advisory lock으로 막는다. (동일 시점 겹침 실행 자동 스킵)
- 월요일/무경기/전체취소 상황은 조기 종료되어 불필요한 LLM/푸시 호출을 하지 않는다.

## 디버그 쿼리

- `?director=1` — 디렉터 퀵 네비(10구단 즉시 전환) 강제 ON (`?director=0`로 OFF)
- `?forceWeather=rain` / `?forceWeather=clear` — 날씨 강제 오버라이드 (수중전 UI 검수)

## 디렉터리

```
app/
  layout.tsx           // 루트 + BottomNav
  page.tsx             // /today 리다이렉트
  today/page.tsx       // 응원 팀 히어로 카드
  schedule/page.tsx    // 어제/오늘/내일 일정
  my/page.tsx          // 응원 팀 선택
  api/
    generate/route.ts  // Replicate img2img 프록시 (mode/isRainy 분기)
    logos/route.ts     // /public/images/logos 매니페스트
    weather/route.ts   // OpenWeather 프록시 (force=rain|clear 디버그)

components/
  HeroCard.tsx         // 히어로 카드 (배경 / 슬로건 / 정보 / 수중전 배지)
  LogoImage.tsx        // 로고 (매니페스트 lookup + 텍스트 폴백)
  BottomNav.tsx        // 메인 탭 바
  DirectorNav.tsx      // dev/디렉터 퀵 스위처

config/
  teams.ts             // KBO 10구단 → modelId / triggerWord / 슬로건(ready·victory·rainy)

lib/
  teams.ts             // 팀 메타 (이름/컬러/매니페스토)
  games.ts             // mock 경기 데이터 (yesterday/today/tomorrow)
  stadiums.ts          // 10구단 홈구장 위경도
  useWeather.ts        // 구장별 싱글톤 캐시 훅
  useMyTeam.ts         // 응원 팀 영속화 훅 (localStorage)
  director.ts          // 디렉터 모드 토글 훅
  logoManifest.ts      // 로고 매니페스트 클라이언트 훅
  dailySlogan.ts       // (서버) 결정론적 일일 카피 풀
  replicate.ts         // 프롬프트 빌더 + 트리거 처리
```

## 슬로건 우선순위

`api/generate` 응답의 `sloganSource`로 노출:

1. **rainy** — `isRainy=true` AND `TEAM_CONFIG.sloganRainy` 존재
2. **daily** — `lib/dailySlogan.ts`의 결정론적 풀에서 픽
3. **fallback** — `TEAM_CONFIG.sloganReady` (또는 victory)
4. **none** — 슬로건 없음 → 클라가 `team.manifestoEn`으로 최종 폴백

## 레퍼런스 이미지 폴더 규칙

`public/images/refs/{ready,victory}/`에 jpg/png/webp 파일을 두면 자동 픽.

- 파일명에 `rain`/`rainy`/`rainny` 키워드 포함 → 우천 시 우선 사용
- 그 외 → 비 오지 않을 때 우선 사용
- 매칭 풀이 비면 전체 풀에서 fallback

## 로고 폴더 규칙

`public/images/logos/`에 파일을 떨어뜨리면 끝. 케이스/확장자 무관.

- 우선순위: SVG > PNG > WebP > JPG
- 케이스 무관 매칭 (`Lg.png`, `LG.png`, `lg.png` 모두 OK)
- 매칭 실패 시 → 텍스트 워드마크 폴백 (예: "KIA TIGERS"). 엑박 절대 안 뜸.
