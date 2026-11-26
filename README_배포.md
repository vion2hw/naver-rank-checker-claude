# 네이버 순위체커 — 외부 서버 배포 안내

이 폴더를 그대로 올리면 PC를 꺼도 링크 + 비밀번호로 쓸 수 있다.
(원본: `D:\claude\output\네이버순위체커\` — 같은 소스. PC용 실행·웹공유 기능은 원본에 그대로 있음)

## 이 프로그램이 서버에 요구하는 것
- **Chrome(Chromium)을 띄울 수 있는 컨테이너/서버** — 플레이스·통검노출 확인에 필요. 메모리 최소 1GB, 권장 2GB.
- **한국(또는 가까운) 지역 서버** — 네이버는 해외·데이터센터 주소에서 결과가 다르거나 보안 확인이 더 잦을 수 있다.
- **상시 실행** — 검사는 버튼을 누른 뒤 서버에서 계속 돌고, 화면이 1.5초마다 진행 상황을 물어온다.
- 서버가 1대여야 한다(로그인·진행 상황을 서버 메모리에 둠).

## 무료 후보 비교 (2026-11 조사 기준, 조건은 자주 바뀜)

| 서비스 | 무료 한도 | 카드 | 지역 | 이 프로그램 적합성 |
|---|---|---|---|---|
| **Google Cloud Run** (추천) | 매월 무료 사용량(CPU·메모리 초 단위) 안에서는 0원. 가볍게 쓰면 한도 안 | 결제 계정에 카드 등록 필요 | **서울(asia-northeast3)** | Chrome 됨, 2GB 가능, 이 폴더 그대로 배포(빌드는 구글이 함) |
| Oracle Cloud Always Free | Arm 서버 평생 무료(최근 축소 보도: 2코어·12GB) | 카드 인증 필요(결제 X) | **춘천·서울** | 가장 넉넉하지만 무료 서버 재고가 자주 없음, 서버 설정을 직접 해야 함, 7일 넘게 놀리면 회수될 수 있음 |
| Hugging Face Spaces (Docker) | 무료 CPU 칸(48시간 안 쓰면 잠듦) | 없을 수 있음(무료 Docker 여부 정보가 엇갈림) | 미국 | Chrome 됨, 하지만 미국 서버라 네이버 결과가 다를 가능성 큼 — 시험용 |
| Render / Koyeb 무료 | 512MB | Render 일부 필요, Koyeb 필요 | 해외 | Chrome 돌리기엔 메모리 부족 — 비추천 |
| 지금 방식(사무실 PC + 무료 링크) | 0원 | 없음 | 사무실 | 결과 가장 정확. PC가 켜져 있어야 함 |

## A. Google Cloud Run(서울)에 올리기 — 추천
사용자가 할 일: 구글 계정으로 Google Cloud 가입 → 결제 계정(카드) 등록 → 프로젝트 만들기 → (선택) 예산 알림 1,000원 설정.
그다음은 Claude Code/Codex가 이 PC에서 진행 가능(구글 클라우드 CLI 설치 후 사용자가 브라우저에서 로그인 1회).

```
gcloud run deploy naver-rank ^
  --source . ^
  --region asia-northeast3 ^
  --memory 2Gi --cpu 1 ^
  --no-cpu-throttling ^
  --min-instances 0 --max-instances 1 ^
  --timeout 3600 --session-affinity ^
  --allow-unauthenticated ^
  --set-env-vars WEB_PASSWORD=원하는비밀번호
```
- `--no-cpu-throttling`: 버튼 누른 뒤 서버가 계속 검사하도록(요청이 없을 때도 CPU 유지).
- `--max-instances 1`: 로그인·진행 상황이 서버 1대에 있어야 함.
- `--min-instances 0`: 안 쓸 때는 꺼져서 무료 한도를 아낌. 대신 첫 접속은 10~20초 느림.
- 배포가 끝나면 `https://naver-rank-xxxx.a.run.app` 같은 **고정 주소**가 나온다(무료 링크처럼 바뀌지 않음).
- 주의: Cloud Run 디스크는 임시라 서버가 다시 켜지면 저장한 업체 목록·순위기록이 초기화될 수 있다. 결과는 엑셀 다운로드로 보관. (계속 보관하려면 Cloud Storage 연결 추가 작업 필요)

## B. Oracle Cloud Always Free(춘천)에 올리기
사용자가 할 일: Oracle Cloud 가입(카드 인증) → 홈 지역을 춘천 또는 서울로 선택 → Arm(Ampere A1) 서버 1대 만들기(Ubuntu, 2코어 이상·4GB 이상) → SSH 키 받기.
그다음 서버에서:
```
sudo apt-get update && sudo apt-get install -y docker.io
# 이 폴더를 서버로 복사한 뒤
sudo docker build -t naver-rank .
sudo docker run -d --restart=always -p 80:8080 -e WEB_PASSWORD=원하는비밀번호 -v /srv/naver-rank:/data naver-rank
```
- 이후 `http://서버공인IP` 로 접속(서버 방화벽에서 80번 열기). 주소를 https로 쓰려면 도메인 연결 추가.
- `/srv/naver-rank` 에 설정·결과가 남아 다시 켜도 유지된다.

## 올린 뒤 꼭 할 확인
같은 키워드로 사무실 PC 결과와 비교:
- 플레이스: 청주치과 27위(5페이지 7번째 칸) · 금천동치과 1위
- 통검노출: 금천동치과 14위 외부 블로그 · 청주임플란트 16~17위 외부 카페
- 통검클립: 충치치료·치아미백 있음, 청주치과·금천동치과 없음
결과가 크게 다르거나 "확인필요"(보안 확인)가 많으면 그 서버 위치에서는 쓰기 어렵다는 뜻 → 사무실 PC 방식 유지.

## 환경변수
| 이름 | 뜻 | 기본값 |
|---|---|---|
| PORT | 서버 포트. 있으면 서버 모드(0.0.0.0 바인딩, 브라우저 자동 열기 없음) | 4417(PC 모드) |
| WEB_PASSWORD | 접속 비밀번호 | 없으면 6자리 자동 생성 후 설정.json 저장 |
| DATA_DIR | 설정.json·결과·브라우저프로필 저장 위치 | 프로그램 폴더 |
| CHROME_PATH | Chrome 실행 파일 직접 지정(보통 불필요) | — |
