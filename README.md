# 주간 근무 스케줄

정적 HTML/CSS/JS 기반 주간(월~토) 배정 달력입니다.

## GitHub

저장소: `kanraaac/weekly-work-schedule`

## Render 배포

1. [Render](https://dashboard.render.com) 로그인 → **New +** → **Blueprint**
2. GitHub의 이 저장소를 연결하고 **Apply** (또는 **New → Static Site** 로 동일 저장소 선택)
3. **Static Site**로 만들 경우:
   - **Root Directory**: 비움
   - **Build Command**: 비움
   - **Publish Directory**: `.`
4. 배포 완료 후 표시되는 `*.onrender.com` URL로 접속

`render.yaml`이 있으면 Blueprint로 연결 시 위 설정이 반영됩니다.
