# 마크다운 노트로 ADDE 사용하기

버튼이 없는 환경에서는 **마크다운 노트 파일 편집만으로** AI 레인을 구동합니다. 지시는 인박스 노트에 체크박스로 보내고, 권한은 승인 노트의 체크박스로 허용/거부하며, 응답은 출력 노트로 받습니다.

이 방식은 임의의 마크다운 에디터에서 동작하지만, **Obsidian + 동기(Obsidian Sync / Syncthing)** 조합이 가장 잘 맞습니다 — 서버 없이 모바일까지 노트가 동기되고, 체크박스를 탭으로 토글할 수 있기 때문입니다. 이 문서는 Obsidian 을 대표 예시로 설명합니다.

## 목차

- [동작 개요](#동작-개요)
- [1. 레인 설정](#1-레인-설정)
- [2. 레인 기동](#2-레인-기동)
- [3. 지시 보내기 (인박스)](#3-지시-보내기-인박스)
- [4. 응답 받기 (출력 노트)](#4-응답-받기-출력-노트)
- [5. 권한 승인 (승인 노트)](#5-권한-승인-승인-노트)
- [여러 메모·프로젝트 매핑](#여러-메모프로젝트-매핑)
- [동기 충돌·주의사항](#동기-충돌주의사항)
- [트러블슈팅](#트러블슈팅)

## 동작 개요

```
[inbox 노트]      --(send 체크박스)-->  ADDE  --(ACP)-->  AI 엔진(claude 등)
[approvals 노트]  <--(권한 요청 블록)-- ADDE
[approvals 노트]   --(allow/deny 체크)-->  ADDE (게이트 반영)
[out/ 노트]       <--(응답 1메시지=1파일)-- ADDE
```

- 한 레인 = `(마크다운 노트 ↔ 프로젝트 폴더)` 한 쌍. 여러 레인을 등록해 여러 메모·폴더를 각각 매핑할 수 있습니다.
- 푸시 알림은 없습니다(파일 기반). 노트를 열어두고 보는 **능동 세션**을 전제로 합니다.

## 1. 레인 설정

레인은 설정 파일 1개 = 레인 1개입니다. `~/.config/adde/<proj>/lanes.d/<lane>.conf` 에 작성합니다(`<proj>`·`<lane>` 은 임의 이름).

```ini
source=markdown
backend=acp
engine=claude-code-acp
channel=markdown
perm_tier=acp
acp_version=v1

# AI 엔진이 실제로 작업할 프로젝트 폴더(절대경로)
cwd=/Users/me/work/my-project

# 마크다운 루트 디렉터리(절대경로, 예: Obsidian vault)
root=/Users/me/ObsidianVault

# root 상대 경로 — 입력 노트(필수)
inbox=adde/my-lane/inbox.md

# 선택(미지정 시 inbox 형제로 자동): 승인 노트 / 출력 디렉터리
approvals=adde/my-lane/approvals.md
outbox=adde/my-lane/out/

# 선택: 자주 쓰는 도구를 미리 허용해 승인 빈도 축소(게이트는 유지)
allowlist=Read,Grep
```

- `cwd` 가 이 레인 AI 의 작업 폴더입니다. **레인마다 다른 폴더**를 지정하면 메모와 프로젝트가 1:1로 묶입니다.
- `root` 만 절대경로, `inbox`·`approvals`·`outbox` 는 root 기준 상대경로입니다. (Obsidian 을 쓴다면 `root` 가 vault 경로입니다.)
- 입력 노트(`inbox.md`)는 에디터에서 직접 만들어 두세요(없으면 지시를 받을 수 없습니다).
- ⚠️ **제어 노트는 `cwd` 밖에 두세요**: inbox·approvals·outbox 가 AI 작업폴더(`cwd`) 내부에 있으면 AI 가 자기 작업 중 승인 노트를 위조할 수 있어 **기동이 거부**됩니다(fail-closed). vault 와 프로젝트 폴더를 분리하세요.
- ⚠️ **allowlist 는 자동 실행**: allowlist 에 넣은 도구는 채널 승인 없이 자동 허용됩니다(프롬프트 생략, 트랜스크립트에는 기록). `Bash`·파일 쓰기 등 광범위 도구는 넣지 마세요(자기승인 위험).

## 2. 레인 기동

```bash
adde up <proj>     # lanes.d 의 모든 레인을 기동
adde down <proj>   # 레인 종료
```

기동되면 ADDE 가 inbox·approvals 노트와 출력 디렉터리를 감시하기 시작합니다.

## 3. 지시 보내기 (인박스)

입력 노트(`inbox.md`)에서:

1. 보낼 메시지(프롬프트)를 자유롭게 작성합니다.
2. 그 **아래 줄**에 send 체크박스를 만듭니다:
   ```markdown
   여기에 AI 에게 보낼 지시를 작성합니다.
   여러 줄 가능.
   - [ ] 📤 send
   ```
3. 보낼 준비가 되면 체크박스를 탭/체크합니다: `- [x] 📤 send`.
4. ADDE 가 감지해 메시지를 AI 에 전달합니다. 그 줄은 두 단계로 바뀝니다:
   ```markdown
   - [x] ⏳ sending a1b2c3d4   ← 전송 시작(내구 기록)
   - [x] ✅ sent a1b2c3d4      ← 전송 완료
   ```
   `✅ sent` 가 보이면 완료입니다. 만약 중간에 ADDE 가 죽어 `⏳ sending` 에서 멈춰도, 재기동 시 누락분만 정확히 1회 다시 전송하고 `✅ sent` 로 마무리합니다(중복/유실 없음).

다음 메시지는 그 아래에 또 작성하고 새 send 박스를 만들면 됩니다. `✅ sent` 줄이 메시지 구분선 역할을 하므로, 이전 메시지가 다음 메시지에 섞이지 않습니다.

> **트리거는 라벨이 정확히 `send` 인 체크박스만**입니다(앞 이모지는 허용 — `- [x] 📤 send`). `- [x] 메일 send 해줘` 처럼 다른 단어가 섞인 체크박스는 트리거가 아니라 일반 메시지 본문으로 취급되므로, 메시지 안에 할 일 체크박스를 자유롭게 써도 됩니다. 빈 메시지를 체크하면 전송되지 않고 `⚠️ empty` 로 표시됩니다.

## 4. 응답 받기 (출력 노트)

AI 응답은 출력 디렉터리(`adde/<lane>/out/`)에 **메시지 1건당 노트 1개**(`<id>.md`)로 생성됩니다. 노트 상단에 원본 메시지 역참조가 붙습니다:

```markdown
> ↩ a1b2c3d4

(AI 응답 본문)
```

에디터에서 해당 노트를 열어 읽으면 됩니다.

## 5. 권한 승인 (승인 노트)

AI 가 파일 쓰기·Bash 실행 등 권한이 필요한 도구를 호출하면, 승인 노트(`approvals.md`)에 요청 블록이 추가됩니다:

```markdown
### ⏳ req 7f3a · Bash
> rm -rf build/  (cwd: /Users/me/work/my-project)
- [ ] allow
- [ ] deny
<!-- adde:perm id=7f3a status=pending -->
```

1. 허용하려면 `- [ ] allow` 를 `- [x]` 로 체크합니다(거부는 `deny` 체크).
2. **정확히 하나만** 체크하세요. 둘 다 체크하거나 둘 다 비우면 모호로 간주해 무시합니다(다시 하나만 체크).
3. ADDE 가 감지해 결정을 반영하고, 블록을 종단 처리합니다(헤딩이 `✅`/`⛔` 로, 마커가 `status=allow|deny` 로 변경).
4. **무응답 시 기본 10분 후 자동 거부(deny)** 됩니다(fail-closed). 채널 도달 실패·오류도 거부로 처리됩니다.

`allowlist` 에 도구를 넣어두면 그 도구는 매번 묻지 않아 승인 빈도가 줄어듭니다(게이트 자체는 유지).

## 여러 메모·프로젝트 매핑

`lanes.d/` 에 conf 파일을 여러 개 두면 레인이 여러 개 동시에 구동됩니다. 각 레인은 자기 `root`/`inbox`/`approvals`/`outbox` 와 `cwd`(프로젝트 폴더)를 가지므로, **메모와 프로젝트 폴더를 각각 매핑해 N개 등록**할 수 있습니다.

```
~/.config/adde/work/lanes.d/
  frontend.conf   # inbox=adde/frontend/inbox.md   cwd=/work/web-app
  backend.conf    # inbox=adde/backend/inbox.md     cwd=/work/api-server
  docs.conf       # inbox=adde/docs/inbox.md        cwd=/work/handbook
```

`adde up work` 한 번으로 세 레인이 각자의 메모↔폴더 쌍으로 동시에 떠 있게 됩니다.

## 동기 충돌·주의사항

- **충돌 파일 격리**: Obsidian Sync / Syncthing 이 만드는 `*.sync-conflict*`·`(conflicted copy)` 파일은 ADDE 가 `.conflicts/` 폴더로 격리하고 **절대 실행하지 않습니다**.
- **자기쓰기 안전**: ADDE 가 인박스/승인 노트를 갱신해도(상태 마커) 재전송 루프는 발생하지 않습니다(마커로 멱등 처리).
- **동시 편집 주의**: ADDE 가 노트를 갱신하는 순간 같은 줄을 동시에 편집하면 동기 충돌이 날 수 있습니다. 한 기기에서 보는 능동 세션을 권장합니다.

## 트러블슈팅

| 증상 | 확인 |
|---|---|
| 체크해도 전송 안 됨 | inbox 경로가 conf 와 일치하는지, send 박스가 체크(`[x]`)됐는지, 메시지 본문이 비어있지 않은지 |
| 레인이 안 뜸 | `root` 절대경로가 실제 존재하는지(없으면 fail-closed 로 기동 거부) |
| 권한이 항상 거부됨 | 10분 타임아웃 전에 allow 를 체크했는지, 정확히 하나만 체크했는지 |
| 응답 노트가 안 보임 | `outbox` 디렉터리 경로 확인, AI 턴이 끝났는지(idle) |
