# Hopo Chase

Hopo Chase는 달리는 차량을 추격하는 몬스터를 총기와 수류탄으로 저지하며 최대한 오래 생존하는 3D 웹 액션 게임입니다. 시간이 흐를수록 몬스터의 접근 속도가 빨라지며, 생존 시간과 주행 거리를 기준으로 기록을 경쟁합니다.

게임 플레이: [https://seramint.github.io/hopo_chase/](https://seramint.github.io/hopo_chase/)

## 주요 기능

- 마우스 조준 기반 소총 사격과 재장전
- 궤적을 조절할 수 있는 수류탄 발사
- 시간에 따라 상승하는 몬스터 추격 난이도
- 쉬움·보통·어려움 난이도와 차등 탄창
  - 쉬움: 30발
  - 보통: 20발
  - 어려움: 10발
- 거리, 생존 시간, 랭크 기반 점수 시스템
- 로컬 저장소 캐시와 Supabase를 이용한 난이도별 리더보드
- 사운드 ON/OFF 선택 및 기본 음소거
- GitHub Pages 자동 배포

## 조작 방법

| 입력 | 동작 |
| --- | --- |
| 마우스 이동 | 조준 |
| 왼쪽 클릭 | 소총 발사 |
| 오른쪽 버튼 누르기 | 수류탄 궤적 조준 |
| 오른쪽 버튼을 누른 채 위·아래 이동 | 수류탄 투척 거리 조절 |
| 오른쪽 버튼 놓기 | 수류탄 발사 |
| `R` 키 | 재장전 |

## 기술 구성

- TypeScript
- Babylon.js
- Vite
- Supabase
- GitHub Actions / GitHub Pages

## 로컬 실행

### 1. 의존성 설치

```bash
npm install
```

### 2. 환경 변수 설정

프로젝트 루트에 `.env.local` 파일을 만들고 Supabase 프로젝트 값을 입력합니다.

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

Supabase에서 익명 로그인을 활성화해야 리더보드 인증이 정상적으로 동작합니다. 환경 변수가 없으면 애플리케이션 초기화 단계에서 오류가 발생합니다.

### 3. 개발 서버 실행

```bash
npm run dev
```

Vite가 출력한 로컬 주소로 접속합니다. 이 프로젝트는 GitHub Pages 배포를 위해 기본 경로가 `/hopo_chase/`로 설정되어 있습니다.

## 빌드 및 미리보기

```bash
npm run build
npm run preview
```

빌드 결과는 `dist/` 디렉터리에 생성됩니다.

## GitHub Pages 배포

`main` 브랜치에 변경사항을 푸시하거나 GitHub Actions에서 `Deploy to GitHub Pages` 워크플로를 직접 실행하면 배포가 진행됩니다.

저장소의 **Settings → Secrets and variables → Actions**에서 다음 Repository secret을 등록해야 합니다.

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

워크플로는 Node.js 22에서 의존성을 설치하고 프로덕션 빌드를 생성한 후 `dist/`를 GitHub Pages에 배포합니다.

## 프로젝트 구조

```text
src/
├─ game/       게임 흐름과 설정
├─ monster/    몬스터 모델, 이동 및 피격 처리
├─ score/      점수와 리더보드
├─ ui/         HUD와 화면 UI
├─ weapon/     소총 및 수류탄 처리
└─ world/      도로, 차량 및 배경 환경
```
