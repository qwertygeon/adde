# Changelog

이 프로젝트의 주목할 변경을 기록합니다. [Keep a Changelog](https://keepachangelog.com/) 형식, [SemVer](https://semver.org/) 준수.

## [Unreleased]

### Added

- **`adde doctor`/`adde sessions` 에 `--json` 기계가독 출력 추가** — 스크립트·모니터링·CI 가 진단 점검 목록(`doctor [<proj>] --json`, 각 점검 name·level·detail·경고/실패 시 hint)과 세션 장부(`sessions <proj> <lane> --json`, id·label·lastActivityAt·현재 세션 여부)를 JSON 으로 파싱할 수 있다. `--json` 모드는 사람용 요약·업데이트 알림 텍스트를 출력에 섞지 않으며, 기존 텍스트 출력·종료 코드는 완전히 불변(additive). `sessions` 의 위치인자 파싱도 정리해 `--json` 플래그가 어느 위치에 있어도 proj/lane 값으로 오인되지 않는다.
- **`adde logs <proj> <lane> --follow`(단축 `-f`) 라이브 tail** — transcript(기본) 또는 `--engine` 지정 시 engine 로그의 신규 추가 라인을 실시간 출력한다. 로그가 5MB 세대 회전되거나 truncate 되어도 유실·중복 없이 새 파일로 이어서 추적하며, `Ctrl-C`(SIGINT) 수신 시 CPU 를 점유하는 대기 없이 즉시 정지·정상 종료한다(hang 없음). `--daemon` 로그는 follow 대상에서 제외된다(스냅샷만 출력). 대상 로그가 시작 시 없으면 생성을 기다리며 상주하지 않고 부재 안내 후 종료한다. 아울러 `adde logs` 의 줄수 인자가 비숫자이거나 0·음수이면 이제 stderr 경고를 출력하고 기본 50 줄로 폴백한다(기존: 무경고 폴백).
- **`adde restart` 결과 표면화** — launchctl 재적재 후 각 레인의 기동 결과를 짧게 폴링해 실패 레인 목록과 요약(`N running · M failed · K pending`)을 표시한다(기존: 재적재 성공 여부와 무관하게 조용히 종료해 레인 기동 실패를 알 수 없었다). 폴링 대기 상한은 `adde up` 과 동일하게 `ADDE_UP_POLL_MS`(ms, 양수만 유효, 기본 8000)로 조정 가능(느린 머신 대응).
- 메인 도움말(`adde` 인자 없이 실행)의 `status` 행에 `--json` 옵션 표기를 추가(기존에 누락돼 있었다).

### Changed

- **[behavior-change] `adde restart` 종료 코드 변경** — 기동 실패 레인이 1개 이상이면 이제 exit code 1 을 반환한다(기존: launchctl 재적재 자체가 예외를 던지지 않는 한 항상 exit 0 이라, 레인 기동 실패가 성공처럼 보였다). 전 레인 기동 성공 시에는 기존처럼 exit 0.
- **[BREAKING] `adde status --json` 최상위 출력 구조 재구성** — 기존 레인 배열(`LaneStatusRow[]`)에서 `{ "lanes": [...], "halt": ... }` 객체로 바뀐다(`halt` 는 크래시루프 자가정지 상태를 프로젝트 단위로 담는다). **마이그레이션**: 기존 최상위 배열 참조를 `.lanes` 로 바꿔라 — 예: `adde status --json | jq '.[]'` → `jq '.lanes[]'`(단일 프로젝트 뷰는 `halt: HaltRecord|null`, 인자 없는 집계 뷰는 `halt: {"<proj>": HaltRecord|null, ...}`). 텍스트(비-JSON) 출력 형식은 불변.
- `adde status`(텍스트·`--json` 공통)는 대상에 크래시루프 자가정지(halt) 기록이 있으면 이제 exit code 1 을 반환한다(기존: halt 는 텍스트 경고만 출력하고 종료 코드엔 반영되지 않았다 — `dead`/`stale`/`error` 레인 존재 시의 exit 1 판정은 기존과 동일하게 유지되며 halt 가 그 신호에 더해진다).

### Added

- **markdown 레인 오래된 산출물 자동 백업 이관** — 24시간 상주하는 레인의 vault(동기화 폴더)에 출력노트·결정된 승인 기록·전송 아카이브가 무한히 쌓여 동기화 부담·에디터 색인 비용이 커지던 문제를 해소한다. 레인 conf 에 `markdown.backup=<로컬 폴더 경로>` 를 지정하면(미지정 시 완전히 꺼짐, 옵트인), 지정한 일수(`markdown.retention_days`, 기본 2일)보다 오래된 산출물을 매일 1회 그 폴더로 옮긴다 — 삭제가 아니라 이동이라 필요하면 그대로 다시 열어볼 수 있다. 이관은 사본이 안전하게 완성된 뒤에만 원본을 지우므로, 이동 중 ADDE 가 죽거나 재시작해도 파일이 사라지지 않는다(중단된 이관은 다음 실행에서 이어서 처리). 백업 폴더 경로는 vault 밖 어디든(외장 드라이브 포함) 지정할 수 있으나, 실수로 vault·내부 상태 폴더와 겹치면 기동이 거부된다. **백업 폴더로 옮겨간 노트의 vault 내 위키링크(`[[...]]`)는 더 이상 그 자리에 없어 클릭해도 열리지 않는다** — 자주 참조하는 응답은 `retention_days` 이내에 두거나 백업 폴더에서 직접 연다.
- iCloud 로 동기화되는 vault 를 위한 `markdown.sync_provider=icloud` 옵션 — 이 기기로 아직 내려받지 않은(placeholder) 파일을 백업 이관 전에 자동으로 다운로드 완료까지 기다리고, 다운로드가 지연·실패하면 그 파일만 건너뛰어 다음 날 다시 시도한다(전체 이관이 멈추지 않는다). 미설정 시(기본 `local`)에는 이런 대기 없이 그대로 이동한다. 새 동기화 서비스를 위한 확장 지점도 함께 마련했다(현재 지원은 `local`·`icloud` 뿐).
- (옵트인, 기본 off) `markdown.out_retention_days` — 전송 완료 여부를 추적하는 내부 관리 파일(사용자 눈에 보이지 않는 상태 폴더, vault 밖)을 일정 기간 지나면 삭제해 정리하는 옵션. 켜려면 이관 기준일(`retention_days`)보다 최소 하루 더 긴 값을 지정해야 하며(짧으면 기동이 거부됨), 아직 처리 중인 항목은 절대 삭제하지 않는다.

### Changed

- **markdown 레인 출력노트·결정된 승인 기록이 날짜별(`YYYY-MM-DD`) 하위 폴더에 쌓인다** — 위 백업 이관을 폴더 단위로 다루기 위한 구조 변경으로, `markdown.backup` 을 설정하지 않아도 **항상** 적용된다(예: 응답 노트가 `out/20260710-162045 a1b2.md` 대신 `out/2026-07-10/20260710-162045 a1b2.md` 에 생성). 위키링크·전송 확인·응답 알림 동작에는 영향이 없으며, 파일을 직접 찾을 때는 날짜 하위 폴더를 확인하면 된다. 전송 시각(stamp)이 없는 예전 파일은 그대로 최상위에 남는다.
- **[주의] `markdown.archive` 가 이제 파일이 아니라 디렉터리로 해석된다** — 전송 아카이브를 날짜별 파일(`YYYY-MM-DD.md`)로 나눠 담기 위한 변경이다. 이 값을 특정 `.md` 파일 경로로 지정해 뒀던 레인은, 다음 기동 시 기존 단일 파일이 (백업 폴더가 설정돼 있으면) 백업으로 자동 이관되거나 (아니면) `.legacy` 접미가 붙어 곁에 보존되고, 이후 새 전송 내용은 같은 이름의 디렉터리 아래 날짜별 파일에 쌓인다(기존 내용 손실 없음). 값을 지정하지 않은 레인은 영향 없다(기본 위치가 `sent-archive/` 디렉터리로 자동 정렬).

### Docs

- 마크다운 노트 우선 정체성 정렬 — `package.json` 설명문·keywords(`markdown`/`notes` 추가), README 미션 문장을 "마크다운 노트에서 AI 구동(로컬 파일 — 채팅은 부가)" 으로 조정. 마크다운 가이드의 동기화 프레이밍을 특정 도구(Obsidian) 격상에서 **도구 중립("어떤 동기화 도구를 쓰든 안전")·로컬 노트 우선**으로 정렬(Obsidian 은 예시로 강등). getting-started 미션 문장도 동일 정렬.

### Added

- markdown inbox 의 **전송된(`✅ sent`) 메시지 본문을 아카이브 파일로 이관** — 24시간 상주 시 inbox 에 무한 누적되던 전송 본문을 걷어낸다. 두 경로: ⓐ 레인 conf `markdown.archive=<경로>` 옵트인 시 **전송 시점에** 그 메시지 본문을 아카이브로 옮기고 inbox 엔 `✅ sent [[...]]` 마커 한 줄만 남긴다(미지정 시 현행대로 본문 잔존), ⓑ `- [x] 🗄️ archive` 체크 시 기존 `✅ sent` 본문을 일괄 이관(설정 무관, 완료된 sent 세그먼트만 — 작성 중 메시지는 불건드림). 아카이브는 append 전용 로그. **무손실 불변**: `out/` dedup 앵커·큐·응답 노트를 건드리지 않고 inbox 표면만 재작성하며, 아카이브 append→inbox 재작성 순서라 어떤 크래시 지점에서도 본문이 유실·재전송되지 않는다(엄격 `✅ sent [[stamp id]]` 마커만 이관 대상 — 수동 입력 `✅ sent`·레거시 형식은 제외).
- markdown inbox 에 **상시 빈 `- [ ] send` 트리거 유지** — 메시지를 전송(`✅ sent` 종단)하면 소모된 send 를 대체할 빈 트리거를 같은 쓰기에서 하나 준비하고, 재기동·수동 삭제로 미체크 send 가 사라진 경우에도 self-heal 로 하나를 보충한다. 사용자가 매번 send 줄을 직접 만들 필요가 없다. 추가분은 미체크라 파싱에서 전송 액션이 되지 않으며(오전송 없음), 중복 추가·자기쓰기 재트리거는 방지된다.
- 레인 conf `gate_timeout_sec` — 권한 승인 대기 타임아웃(초)을 레인별로 재정의하는 옵트인 키. 미지정 시 기본 600초(동작 불변). 사람 승인 레인은 길게, 자동화 레인은 짧게 조정 가능. 게이트·markdown 승인 블록 기한·어댑터 로컬 타임아웃이 동일 값으로 정렬된다. (종전 "conf 재정의 가능" 문서화가 실제로는 미배선이던 dead config 를 해소.)
- **엔진 크래시 자가 회복** — 핸드셰이크 이후 레인 엔진 child 프로세스가 크래시로 죽어도 데몬이 이를 감지하지 못해 조용히 회복불가 상태에 빠지고 `adde status` 는 계속 `running` 으로 오표기하던 결함을 해소한다. 기본(default-on) 동작: 크래시 감지 시 유계 지수 백오프(1s→2s→4s→8s→16s, 최대 5회 시도)로 **동일 세션·구독자·권한 핸들러를 승계**하며 재기동하고, 상한 초과 시 재기동을 중단해 레인 상태를 `error` 로 기록하고 채널 통지를 정확히 1회 보낸다. 크래시 시점에 승계되지 않는 대기 중 권한 승인은 (재기동 활성 여부와 무관하게) 즉시 거부(fail-closed)로 종결해 게이트 타임아웃(기본 600초)까지 채널이 멈추지 않는다. 재시도 중인 레인은 하트비트를 의도적으로 갱신하지 않아 `adde status` 가 `running` 으로 오표기되지 않는다(대신 `stale`). 레인 conf **`auto_relaunch=false`**(옵트아웃, boolean, 미지정/무효값은 기본 `true`)로 자동 재기동만 비활성화할 수 있다 — OFF 여도 크래시 감지·즉시 `error` 확정·승인 거부·통지 1회는 그대로 유지된다. 의도적 재기동(`adde restart`·`/clear`·`/resume`) 중에는 감시자가 스스로 비활성화(disarm)되어 이중 기동이 발생하지 않는다. `runtime.json` 스키마(v:1)·기존 명령 표면은 불변.
- **데몬 크래시 안전망 + 로그 회전 + 크래시 루프 자가 정지** — 데몬 프로세스(엔진 child 가 아니라 데몬 자체) 상주 신뢰성을 강화하는 3건을 기본 활성한다.
  - **크래시 가드**: 데몬 워커에서 미처리 예외(`uncaughtException`)가 발생하면 시크릿 마스킹된 오류·스택을 로그에 남기고 유계 정리(5초) 후 반드시 비정상 종료해 launchd 재기동에 위임하며(crash-only), 미처리 거부(`unhandledRejection`)는 마스킹 로그 후 흡수해 프로세스를 계속 상주시킨다(동일 원인 반복 로그는 분당 1회로 제한). 단발 CLI 명령에는 설치되지 않아 그 실패는 은폐 없이 그대로 노출된다.
  - **로그 회전**: `transcript.log`·`engine.log` 가 5MB 도달 시 2세대 rename 회전을 수행해(회전 중에도 기록 손실 0), 24시간 상주 시 로그가 디스크를 무한히 채워 이후 모든 원자적 파일 쓰기(큐·출력·runtime·장부)를 ENOSPC 로 실패시키던 경로를 없앤다. `launchd` 표준출력/오류 로그(`.out/.err.log`)는 데몬 (재)적재 시점에 끝부분만 유지하도록 트림된다. `adde logs` 는 회전 후에도 계약대로 정상 동작한다.
  - **크래시 루프 자가 정지**: 데몬이 기동 직후 짧은-수명(60초 미만 생존) 사망을 연속 5회 반복하면 자가 정지(확정 종료)해 원인 미해결 상태의 재기동 폭주를 막고, 정지 원인·시점을 기록해 `adde status`/`adde doctor` 로 표면화한다. `adde up`/`adde restart` 로 명시적으로 재시도하면 이 상태가 초기화된다.
  - **`proj.conf` 로 무인 자동 재기동 opt-out**: 프로젝트 수준 설정 파일 `<base>/<proj>/proj.conf` 에 `auto_restart=false` 를 명시하면(기본 on, CLI 미노출, 파일 편집 전용) 데몬이 크래시해도 launchd 가 재기동하지 않는다(재부팅 시 자동 복구는 그대로 유지). off 상태에서 크래시가 발생하면 데몬은 죽은 채로 남고 그 상태가 `adde status`/`adde doctor` 로 표면화된다(거짓 UP 표기 없음). 변경 반영은 `adde restart`.

### Fixed

- telegram 레인이 크래시-재시작 시 같은 응답을 **중복 전송**하던 결함 정정 — 응답을 채널로 실제 전송(HTTP)한 뒤 완료 마킹 전에 데몬이 죽으면, 재시작 시 미전송으로 오인해 다시 전송하던 문제(멀티청크 응답은 부분 전송 후 앞 청크까지 재전송). 이제 전송 직전 진행 마커(`out/<id>.sending`)를 남겨, 재시작 시 이 마커가 남아 있으면(=전송 도중 중단, 전달 여부 불확실) **재전송하지 않고** "전송 중 중단·전달 여부 불확실"을 채널에 정확히 1회 통지한 뒤 종단한다(중복보다 안전한 방향). 프로세스가 살아 있는 동안의 일시적 전송 실패(레이트리밋·네트워크 순단 등)는 기존처럼 다음 턴에 자동 재시도한다. markdown 소스는 재렌더가 멱등(동일 노트 재작성)이라 이 저널을 적용하지 않고 기존 재전송 동작을 유지한다(소스별 `deliveryIdempotent` 선언으로 구분).
- telegram 레인 기동 시 봇 토큰 오류·API 접속 불가로 폴링이 실패해도 조용히 `running` 으로 기록되던 결함 정정 — 기동 시 1회 연결 확인(최대 10초, 무응답 시 상한으로 종결)을 수행하고 실패하면(토큰 불량·네트워크 불가·API 오류 등 원인 불문) 레인을 `error` 로 격리한다. 연결 확인 성공 이후 발생하는 일시적 폴링 오류는 기존처럼 로그 후 재시도한다(상태 전환 없음). markdown 소스 기동도 동일 비동기 계약 하에서 기존 관측 동작(루트 부재 시 `error`)을 그대로 유지한다.
- markdown inbox 재작성 시 트레일링 개행이 매번 누적되던(재작성마다 빈 줄 1개씩 증가) `joinLines` 결함 정정 — 이미 개행으로 끝나면 덧붙이지 않도록 멱등화하고, 상시 빈 send 는 끝의 빈 줄 앞에 삽입해 sent 와 빈 send 사이 공백줄이 쌓이지 않게 한다(inbox 비대화 방지).
- 권한 게이트 타임아웃 타이머가 결정 승리(사용자 allow/deny)·전송 오류 종결 경로에서 `clearTimeout` 되지 않아, 결정 후에도 최대 `gate_timeout_sec`(기본 10분)만큼 타이머가 상주하던 누수를 제거. 24시간 상주 시 요청마다 누적되던 상주 타이머를 종결 즉시 정리한다.
- markdown inbox 파서가 ADDE 자신의 경계 마커(`sending`/`sent`/`empty`/`archived`)를 이모지 앵커 없이 접두 텍스트만으로 오인식하던 결함 정정 — "sent invoice to client" 같은 사용자 일상 메모가 종단 경계로 오판되어 앞 메시지가 조용히 유실되거나, "sending report to boss" 같은 문구가 크래시 재개로 오해석되어 원문 줄이 덮어써지거나, 자동 아카이브 ON 상태에서 사용자 초안이 아카이브로 잘못 이관될 수 있었다. 이제 ADDE 고유 앵커(`⏳`/`✅`/`⚠️`/`🗄️`)가 있는 라인만 경계로 인식하며(`sending` 은 체크됨(`[x]`)도 함께 요구), 앵커가 없는 라인은 항상 메시지 본문으로 보존된다. 레거시·크래시 재개 중이던 마커(스탬프·위키링크 일부 부재)는 앵커만 있으면 계속 인식되어 회귀가 없다.

### Changed

- 24시간 상주 I/O 효율화(markdown 어댑터·injector) — 유휴/메시지당 비용이 누적 이력에 비례해 증가하던 낭비를 제거한다.
  - **미전송 재전송 추적을 in-memory 로 전환**: 매 턴 `out/` 전체를 `readdir` 하던 O(총 이력) 스캔을 제거하고, 기동 시 1회만 스캔해 시드한 뒤 메모리 집합으로 추적한다.
  - **처리 완료 `processing/<id>.msg` 정리**: `out/` 기록(중복 방지 앵커) 후 잉여가 된 processing 파일을 제거해 무한 증가를 막는다(중복 제거 불변식 보존 — 재확인은 `out/` 기준).
  - **결정완료 승인 파일을 `approvals/.decided/` 로 이관**: 폴·스캔이 미결정(pending) 파일만 훑도록 해, 누적 승인 수에 비례하던 매 틱 `stat` 비용을 없앤다(pending 은 절대 이동하지 않음 — 게이트 무결성 불변, 종단 판정은 파일 marker 기준이라 재기동에도 안전).
  - **폴 백스톱 적응형·`.unref()`**: 고정 2초 폴을 무변경 지속 시 최대 10초까지 늘어나는 적응형으로 바꾸고(변경 감지 시 즉시 복귀) 타이머를 `unref` 해 유휴 wakeup 을 줄인다.
  - **읽기·렌더 중복 I/O 제거**: 안정화 읽기를 stat 비교 기반으로(정지 파일은 2회 read·지연 없이 즉시), 응답 렌더는 방금 메모리에서 쓴 텍스트·sidecar 를 재사용(디스크 재read 생략, 크래시 복구 경로는 종전대로 디스크 read).
- **[BREAKING] 레인 conf 어댑터 키 네임스페이스화** — 어댑터 전용 키를 `<source>.<field>` 로 네임스페이스한다: `root`/`inbox`/`approvals`/`outbox` → `markdown.root`/`markdown.inbox`/`markdown.approvals`/`markdown.outbox`, `chat_id`/`allow_from` → `telegram.chat_id`/`telegram.allow_from`. 공통 키(source·backend·engine·cwd·lang·file_mode·allow/deny리스트)는 최상위 유지. **구 평면 키는 폐기(back-compat read 없음)** — 파서가 무시하므로 값이 반영되지 않는다. `adde doctor` 가 구 키를 `conf format` FAIL 로 감지해 마이그레이션을 안내하고, `adde up` 기동 시에도 경고를 남긴다.
  - **마이그레이션**: 기존 레인 conf 의 위 키에 `markdown.`/`telegram.` 접두어를 붙이거나, `adde lane rm` 후 `adde lane add` 로 재생성한다(CLI 플래그 `--root`·`--chat-id`·`--allow-from` 등은 불변).
  - **근거**: 어댑터별 설정을 타입·구조로 격리해 새 소스 어댑터를 충돌 없이 확장 가능하게 한다.
- 소스 어댑터 레지스트리화(내부 리팩터) — 소스 선택을 `SOURCE_REGISTRY`(id→팩토리) 단일 SoT 로 통합. 경계의 닫힌 `"telegram"|"markdown"` 유니온을 열린 문자열로 개방하고, **미등록 소스를 조용히 telegram 으로 폴백하던 동작을 제거**(이제 해당 레인만 `error` 로 격리 — fail-closed). telegram 인바운드 인증셋 조립(chat_id ∪ allow_from)을 supervisor 인라인에서 telegram 어댑터로 이관(fail-closed 불변식 보존, 독립 검토 확인).
- 소스 확장 지점 정비(내부 리팩터, 관측 동작 무변경) — 지원 소스 목록을 `SOURCE_REGISTRY` 파생 단일 목록으로 통합해 별개 하드코딩 배열(레인 생성 거부 판정용)을 제거하고, 소스별 conf 검증·doctor 진단·CLI 위저드 프롬프트/생성 후 힌트를 각 소스 정의(descriptor)로 위임한다. 새 소스를 추가할 때 레지스트리 등록(+필요한 훅)만으로 지원 목록·거부 판정·doctor·CLI 프롬프트 전 지점에 반영되며, 소스별 하드코딩 분기를 여러 파일에 추가할 필요가 없다. 기존 conf 포맷·검증/진단 메시지·하드 오류/경고 구분은 그대로 보존된다.
- **데몬 launchd 재기동 시맨틱 조정(기본 동작 변화)** — 종전에는 `KeepAlive=true` 무조건 설정이라 정상 종료(exit 0 포함)에도 launchd 가 약 10초 간격으로 데몬을 무한 재기동했다. 이제 `KeepAlive` 를 `{SuccessfulExit:false, Crashed:true}` 로 조건부 렌더한다.
  - **수동 `SIGTERM` graceful 정지(및 `adde down`) 시 재기동하지 않는다** — 정상 종료(exit 0)로 귀결되어 launchd 가 다시 띄우지 않는다(종전엔 수동 정지도 수 초 내 재기동되던 결함).
  - **사용자 명령 맥락(`adde up`/`restart`)의 결정적 부팅 실패는 재기동하지 않는다** — 상주할 이유가 없는 부팅 실패(레인 0개·부팅 결정적 예외)는 정상 종료(exit 0)로 귀결되어 무한 재기동 루프가 사라진다. 실패 표면화(`adde up` 폴링 출력·`runtime.json status:error`)는 그대로 유지된다(은폐 없음). 부팅 도중 비결정적 크래시는 여전히 비정상 종료(exit 1)로 재기동 대상이다.
  - **기존에 등록된 데몬은 `adde restart` 로 신 plist(위 조건부 `KeepAlive`)를 적용해야** 새 재기동 시맨틱이 반영된다(plist 는 매 `up`/`restart` 시 재작성 — 별도 마이그레이션 명령 불요).

### Security

- 권한 승인 상관키를 세션 id 에서 **요청당 고유키**(`<세션프리픽스>-<인스턴스 카운터>`, charset `[A-Za-z0-9_-]`)로 교체 — 세션 내 전 권한요청이 같은 상관키(sessionId)를 공유해 ⓐ 타임아웃된 이전 요청의 스테일 버튼이 지금 대기 중인 다른 요청을 승인시키고 ⓑ 병렬 tool 호출이 supervisor 대기자 맵·markdown 승인파일을 상호 덮어쓰던 **게이트 오귀속(fail-safe 아님)** 을 차단한다. telegram callback_data(≤64B)·markdown 파일명·envelope msg-id 정규식 모두에 안전한 문자집합. markdown 승인파일 경로가드는 방어심화로 유지.
- autopass/safe_defaults 권한 게이트를 **정규화 기반 인식기**로 견고화 — 리터럴 글롭이 플래그 순서·번들·롱숏·절대경로·래퍼·이중공백·셸 중첩으로 우회되던 공백을 일괄 차단한다. 명령을 정규화(경로 `/bin/rm`→`rm`·래퍼 `env`/`nice`/`command`/`time`/`timeout`/`nohup`/`xargs`/`\` 벗김·따옴표·이중공백 흡수·`$HOME`/`${HOME}`→홈 확장·`sh -c`/`bash -c` 페이로드 재귀 분해)한 뒤 형태 불문으로 대조:
  - **rm**: 재귀 플래그(`-r`·`-R`·`-fr`·`-rfv`·`--recursive`·번들) + 대상 스코프(`/`·`~`·`.`·`$HOME`). `-f` 없는 `rm -r`·`rm -rf $HOME` 등 포섭(상대경로 대상은 종전대로 자율 허용 — 스코프 불변).
  - **git**: 전역옵션(`-C`·`-c` 등)을 건너뛴 서브커맨드 기준 — `push` 강제(`--force`/`--force-with-lease`/`-f`/**`+refspec`**), `reset --hard`, `clean` 강제(`-f`; `-d` 없이도). `git push origin +main`·`git -C <dir> push --force`·`git clean -df` 등 포섭.
  - **권한상승**: `sudo`·`doas`(경로·래퍼 불문).
  - **셸 중첩·래퍼**: `sh -c "rm -rf /"`·`timeout 5 rm -rf /`·`nohup`·`xargs rm -rf /` 등 래퍼/인터프리터 안의 실제 명령까지 인식.
  - **자격증명 경로**: 기존 `Read` 전용 보호를 `Write`/`Edit`/`NotebookEdit` 및 Bash args(`cat`/`cp` 등)까지 교차 확장하고, 디렉터리 통째 접근(`tar`/`cp -r ~/.ssh`)·`opt=path`(`dd if=~/.aws/x`)·`..` 트래버설까지 대조.
    기본 denylist 엔트리 문자열은 유지(하위호환·conf 무변경)하며 매칭 로직만 강화. 인식 애매 시 리터럴 매칭 폴백 + 과매칭=채널(fail-closed).

## [0.1.4] - 2026-07-05

### Added

- `adde proj ls` / `adde proj rm <proj>` — 프로젝트 단위 명령. `ls` 는 등록된 프로젝트와 레인·실행 수를 표(또는 `--json`)로 보여주고(레인 단위 `status` 와 상보), `rm` 은 프로젝트 디렉터리 전체(lanes.d + state + queue + processing + out)를 삭제한다. 파괴적이라 실행 중 레인이 있으면 거부(`--force` 로 우회)하고, TTY 에선 프로젝트 이름 재입력 확인, 비대화형에선 `--force` 를 요구한다. 삭제 전 launchd 데몬을 unload 해 고아 plist 등록이 남지 않게 한다.
- `adde lane rm <proj> <lane> --purge` — conf 만 지우던 기존 동작에 더해 해당 레인의 state/queue/processing/out 디렉터리까지 정리하는 옵션(고아 데이터 정리). 파괴적이라 `proj rm` 과 동일하게 실행 중 레인이면 거부(`--force` 우회)하고 TTY 에선 레인 이름 재입력 확인·비대화형에선 `--force` 를 요구한다. `--purge` 없으면 종전대로 conf 만 삭제.
- `adde logs <proj> --daemon [N]` — launchd 데몬 로그(`~/Library/Logs/adde/<proj>.err.log`) 최근 N줄. 데몬(분리 프로세스)에서 발생한 기동 실패 원인 등이 여기 쌓이는데 기존 `adde logs` 는 레인 transcript/engine 로그만 읽어 볼 수 없던 것을 노출.
- 대화형 레인 생성(번호 선택·경로 자동완성) — `adde init`·`adde lane add --interactive` 에서 enum 필드(source·perm_tier·file_mode·lang)를 번호(1/2)로 고를 수 있게 하고(값 직접 입력도 계속 허용), cwd/root 등 **경로 필드에만** Tab 디렉터리 자동완성을 적용(enum·확인·가려진 토큰 입력에서는 비활성 — 토큰 버퍼 오염 방지).
- `adde init` 셸 자동완성 설정 안내 — 별칭 설치 단계에 이어, 감지된 셸(bash/zsh)에 맞는 자동완성 설치 명령을 옵트인으로 안내(셸 rc/fpath 를 대신 수정하지 않고 실행할 명령을 출력). `adde completion` 도움말을 "왜·무엇·어디에·어떻게 결정하는지" 로 상세화하고, 터미널에서 바로 실행 시 설치 힌트를 stderr 로 표시(리다이렉트 시엔 stdout 순수 유지).
- `adde up` 이미 기동 중 안내 — 데몬이 이미 등록·상주 중일 때 재실행하면 launchctl 재등록 실패(혼란스러운 오류) 대신 "이미 기동 중"(실행 중/전체 레인 수)과 조치 힌트(status/restart/down)를 사용자 터미널에 표면화. 종전엔 중복 기동 가드가 데몬 내부(분리 프로세스) stderr 로만 기록돼 `adde up` 사용자에게 보이지 않던 것을 CLI 단에서 표면화.

### Changed

- `adde up` 기동 결과 즉시 표기 — 데몬이 각 레인 상태를 runtime.json 에 남길 때까지 짧게 폴링해 **성공/실패 레인을 up 커맨드에서 바로 요약**하고(실패 시 종료코드 1), 레인 기동 실패를 runtime.json 에 `error` 상태로 남겨 `adde status`·`adde doctor` 대신 status 가 `stopped`(미기동)와 구분해 **`error` 로 표시**한다(실패 사유·조치 힌트 포함). 종전엔 기동 실패가 데몬 stderr(어떤 CLI 도 안 읽는 launchd 로그)로만 가고 status 는 stopped 로 보여 진단 불가였다.
- CLI 방어코드·에러 출력 보강 — `adde status`/`adde doctor` 가 잘못된 `<proj>` 이름에 원시 예외 대신 명령 스코프 친절 메시지를 내고, `adde alias`·`adde lane`·`adde proj` 의 예기치 못한 예외(fs/OS 오류 등)도 스택 대신 친절 메시지로 표면화한다. `sessions`·`alias`·`completion` 도움말을 왜/무엇/어디에로 상세화.
- 레인 conf 의 사문화된 `channel` 필드 제거 — 소스 스위치를 **`source` 하나로 일원화**. 런타임 라우팅 채널은 종전대로 `source` 에서 유도되며(`conf.channel` 은 어디서도 읽히지 않던 dead 필드였다), `--channel` 플래그·대화형 `channel` 프롬프트·직렬화를 제거했다. conf 파서는 기존 conf 파일의 `channel=` 줄을 미지의 키로 무시하므로 **하위호환**된다.

- ACP 엔진 어댑터 마이그레이션 — deprecated·이름변경된 `@zed-industries/claude-code-acp`(0.16.2)를 후속 `@agentclientprotocol/claude-agent-acp`(0.55.0)로 교체하고 `@agentclientprotocol/sdk` 를 0.14.1 → 1.1.0 으로 승급. 기본 엔진 프로필·바이너리 해석·`--engine` 안내·문서를 새 이름(`claude-agent-acp`)으로 갱신. 권한 게이트 매칭 키(`_meta.claudeCode.toolName`)와 ACP 프로토콜 버전(v1) 유지를 신규 어댑터 소스로 실측 확인했고, requestPermission 의 도구명·인자 추출·결정 배선을 통합 테스트로 회귀 보호. `npm i -g adde-acp` 설치 시 출력되던 `npm warn deprecated` 가 사라짐.
- 기본 소스 어댑터 `telegram` → **`markdown`** — `--source` 미지정 시(비대화형·대화형 프롬프트 기본값) 생성되는 레인의 기본 소스를 markdown 으로 변경. 마크다운은 봇 토큰 없이 로컬 노트만으로 바로 동작하므로 "설정 없이 되는" 기본에 부합. `--source telegram` 명시는 종전대로 동작. 문서·자동완성·help 의 나열 순서도 markdown 우선으로 정렬. 아울러 오구성 격리 보강 — root/inbox 없는 markdown 레인의 소스 생성 실패가 `adde up` 전체를 중단시키지 않고 **해당 레인만 error 로 격리**하며, `adde doctor` 가 markdown 레인의 root/inbox 누락·부재를 **기동 전에 FAIL 로 검출**한다.

### Fixed

- `adde lane add --force` 가 기존 `.env` 봇 토큰(시크릿)을 덮어쓸 때 경고를 출력 — 이전엔 조용히 파괴됐다.
- 셸 자동완성 배선 정정 — `--purge` 는 `lane rm`, `--json` 은 `proj ls` 에 맞게 완성되도록 수정(이전엔 `proj rm` 에 무효 `--purge` 가 붙고 `lane rm --purge`·`proj ls --json` 은 완성되지 않았다).
- `adde up` 이 **이미 기동 중**인 데몬을 만났을 때 비정상 레인(error/dead/stale)을 표기하지 않고 항상 종료코드 0 을 내던 문제 — 비정상 레인을 stderr 로 표면화하고 종료코드 1 을 반환한다(하트비트 끊긴 `stale` 레인 포함 — 상주 데몬에서 가장 알려야 할 상태).
- `adde up` 이 **데몬 부팅 자체 실패**(runtime.json 을 아무도 남기지 못함)를 "기동 중(pending)"·종료코드 0 으로 보고해 하드 실패가 성공처럼 보이던 문제 — 대기 상한까지 어떤 레인도 기동/실패를 확정하지 못하면 데몬 로그 확인 안내와 함께 종료코드 1 을 반환한다. 대기 상한은 `ADDE_UP_POLL_MS`(양수 ms) 로 조정 가능(느린 머신).
- `adde lane rm --purge` 가 `error` 상태(기동 실패 잔존, 데몬이 살아있을 수 있음) 레인의 state/큐/토큰을 `--force` 없이 삭제할 수 있던 문제 — `error` 도 활성 레인 가드에 포함해 `--force` 를 요구한다. (`proj rm` 은 삭제 전 데몬을 unload 하므로 `error` 를 가드에 넣지 않아도 안전 — 두 가드는 이 지점에서 갈린다.)

## [0.1.3] - 2026-07-04

### Security

- Telegram 인바운드 발신자 인증 — 인바운드 메시지·권한 승인 콜백을 허용 발신자(`chat_id` ∪ 신규 `allow_from`)만 처리하고 그 외는 무시(fail-closed). 허용 집합이 비면 전 인바운드 거부. 봇에 도달 가능한 임의 사용자가 호스트 실행 세션에 프롬프트를 주입하거나 무단으로 권한을 승인하던 경계 공백을 차단. `chat_id` 설정 시 자기 chat 자동 인증, 그룹·복수 사용자는 `--allow-from` 으로 확장.
- 레인 상태·출력·큐 디렉터리 권한 옵션 `file_mode`(`--file-mode`) — 기본 `private` 는 `state`/`out`/`queue`/`processing`/`lanes.d` 디렉터리를 0700(소유자 전용)으로 잠가 다중 사용자 호스트에서 타 로컬 사용자의 대화·응답·설정 메타 열람을 차단. `shared` 는 잠그지 않는 옵트인(기존 umask 기본 권한 유지, 통상 0755). (봇 토큰 `.env` 는 종전대로 항상 0600.)
- 엔진 stderr 로그(`engine.log`) 마스킹 — transcript 만 마스킹하던 것을 엔진 stderr 캡처 경로에도 라인 단위 시크릿 마스킹을 적용해 토큰·민감 경로가 side channel 로 평문 기록되지 않도록 보강.
- 방어심화 하드-거부 `hard_deny`(`--hard-deny`/`--safe-defaults`) — 매칭 도구를 **티어 무관하게 즉시 거부**(채널 승인 프롬프트도 없음)하는 레이어. autopass 의 denylist("물어봄")보다 강하며 기본 `acp` 티어에도 적용돼, 파괴적 명령(sudo·rm -rf·git 강제·자격증명 읽기)이 실수로 승인되는 것을 원천 차단. `--safe-defaults` 로 내장 위험 목록을 채우며 대화형 생성 시 기본 켬을 질의. 하드-거부 히트는 transcript 기록 + 채널 통지.
- `adde doctor` 파일 권한 감사 — 레인별로 `.env`(봇 토큰)가 그룹/기타에서 읽히면(0600 기대) WARN, `file_mode=private` 인데 state 디렉터리가 0700 이 아니면 WARN(+chmod/재시작 조치). `shared` 모드는 의도된 선택이라 경고하지 않음. (env·state 는 독립 점검이라 둘 다 느슨하면 둘 다 경고.)
- denylist·hard_deny 매칭 강화 — 셸 명령 체이닝(`cd /tmp && sudo …`)·파이프·서브셸/그룹(`(sudo …)`·`{ … }`)·명령치환(`$(…)`·백틱)·선행 환경변수 대입(`FOO=1 sudo …`)을 세그먼트 분해로 잡아, 전체-문자열 접두 앵커 글롭을 우회하던 위험 하위 명령을 차단(best-effort, 완전한 셸 파서는 아님 — 래퍼 `bash -c "…"`·따옴표 안 실행은 범위 밖, `--safe-defaults` 는 인용부 연산자 substring 을 포함한 정상 명령을 거부할 수 있음). 기본 자격증명 저장소 목록 확대(ssh·aws 에 더해 npm·gh·kube·docker·gcloud 토큰/키). 권한 결정 순서(hard-deny→자동허용→채널 승인)를 단일 출처로 고정해 순서 회귀를 테스트로 방지.

### Added

- 세션 제어(채널 명령) — Claude Code 의 /clear·/compact·/resume 등가 기능. Telegram 은 정확 일치 명령(`/clear`·`/compact`·`/resume [번호|세션id]`), 마크다운은 send 형 전용 체크박스 라벨(`clear`·`compact`·`resume [n]`). 제어는 메시지 큐에 직렬 처리(진행 중 턴 존중)되고 결과가 채널 응답으로 통지됩니다.
  - clear: 엔진을 새 세션으로 재기동(이전 대화 맥락 소거). compact: 엔진 압축 명령 위임 실행.
  - resume: 세션 장부(`state/<lane>/sessions.json`, 레인당 최근 20개 — 첫 프롬프트 발췌·**마지막 대화 시각** 기록)에서 목록 조회·선택 복귀. 복귀 실패 시 새 세션 폴백 통지. 레인 재기동은 종전대로 새 세션(자동 재개 없음).
  - clear/resume 의 엔진 재기동이 실패하면 일반 오류와 구분해 채널로 복구 절차(`adde restart <proj>`)를 명시 통지하고, 재기동 중 구독자(권한 핸들러 등) 승계를 원자화해 유실 창을 제거.
- `adde sessions <proj> <lane>` — 세션 장부 목록 CLI(번호·발췌·마지막 대화 시각·현재 세션 표시).
- npm 발행 파이프라인 — `npm i -g adde-acp` 로 설치 가능하도록 발행 배선. `package.json` 에 `prepack`(발행 시 자동 빌드로 `dist/` 보장)·`repository`/`homepage`/`bugs`/`keywords` 추가, `release.yml` 이 태그·GitHub Release 뒤 `npm publish`(러너 Node 24·registry 인증·동일 버전 재발행 skip)를 수행. 인증은 최초 1회 `NPM_TOKEN` 부트스트랩 후 OIDC Trusted Publishing 전환 예정.
- `adde init [<proj>]` — 온보딩 위저드(TTY 전용). 환경 점검(doctor) → 짧은 별칭 설치(옵트인) → 대화형 레인 생성을 한 흐름으로 안내. 토큰은 화면 노출을 피해 받지 않고 생성 후 안내로 위임.
- `adde alias [names...]` — 짧은 별칭(기본 `ad`·`add`)을 `adde` 실행 파일 옆에 심볼릭 링크로 설치. PATH 에 동명 명령이 이미 있으면 그 별칭은 실패로 건너뜀(덮어쓰지 않음), 이미 adde 를 가리키면 멱등. 전역 설치가 아니면 안내 후 종료.
- 업데이트 알림 — `adde status`·`adde doctor` 가 npm 레지스트리의 최신 버전을 비교해 새 버전이 있으면 안내 한 줄 출력(24h 캐시, 대화형 TTY 에서만 네트워크 조회, `ADDE_NO_UPDATE_CHECK` 로 비활성화).
- 자동완성 강화 — `adde completion <bash|zsh>` 가 (1) proj/lane **이름 동적 완성**(`${ADDE_HOME:-~/.config/adde}` 스캔, node 스폰 없음), (2) enum 플래그 값(`--source`·`--perm-tier`·`--file-mode`·`--lang`), (3) `--cwd`/`--root` 디렉터리, (4) `adde`+짧은 별칭(`ad`·`add`) 등록, (5) zsh 명령 설명까지 완성. 명령/플래그 SSOT(`cli/spec.ts`)에서 생성.

### Fixed

- launchd 데몬 PATH 주입 — launchd 는 최소 PATH(`/usr/bin:/bin:/usr/sbin:/sbin`)만 주는데 ACP 엔진 어댑터가 `claude` CLI 를 `#!/usr/bin/env node` 로 스폰하므로, node·`claude` 가 그 PATH 에 없어 엔진 핸드셰이크가 30초 타임아웃하고 레인이 기동되지 않던 문제 수정. `adde up` 이 실행 시점의 PATH(node 디렉터리를 앞에 붙여 승계)를 plist `EnvironmentVariables.PATH` 에 구워 넣어 재부팅 후에도 유지(PATH 만, 시크릿 미포함).
- 데몬 실행 파일 부재 방어 — `pnpm run dev up`(tsx)은 데몬 실행 파일이 존재하지 않는 `src/cli/adde.js` 로 해석돼 데몬이 `MODULE_NOT_FOUND` 로 크래시루프하던 문제를, `adde up` 이 실행 파일 존재를 먼저 확인하고 부재 시 빌드/전역 설치 안내와 함께 명시 거부하도록 보강(launchd 워커는 분리 프로세스라 tsx 트랜스파일 불가). `adde doctor` 도 데몬 진입 파일 존재를 사전 점검(부재 시 WARN + 빌드 안내).
- 마크다운 동기 충돌 파일(`*.sync-conflict*` 등) 격리 백스톱 — 기존엔 fs.watch 생성 이벤트에만 의존해 이벤트를 놓치면 충돌 파일이 방치될 수 있었음. 2초 폴링 백스톱이 인박스 디렉터리를 직접 스캔해 격리하도록 보강.
- `adde alias`·`adde init` 별칭 설치 크래시 방어 — 심링크 생성 실패(루트 소유 bin 의 EACCES·동명 비심링크 파일의 EEXIST)가 스택트레이스로 프로세스를 죽이고 `init` 위저드를 레인 생성 전에 중단시키던 문제 수정. 실패한 별칭만 사유와 함께 건너뛰고 흐름을 계속하며, CLI 엔트리포인트에 예기치 못한 예외의 최종 방어선을 추가.
- 업데이트 알림 semver 비교 — 프리릴리스(예: `x.y.z-rc.1`) 사용자가 동일 core 의 정식 릴리스(`x.y.z`)를 통지받도록 프리릴리스가 정식보다 낮게 정렬되게 수정(종전엔 프리릴리스를 제거·동일 취급해 통지 누락).

### Changed

- 내부 중복 정리(동작보존 리팩터) — 경로 포함/중첩 판정·원자적 파일 쓰기(tmp→rename)·오류 메시지 표기·sidecar 읽기를 shared 공통 모듈로 일원화(생성 시 사전 경고와 기동 거부 가드가 같은 판정 규칙을 공유), 테스트 공용 픽스처(test/helpers) 신설.
- 문서 정리 — 마크다운 트러블슈팅 표를 트러블슈팅 문서로 단일화(가이드는 포인터), 레인 생성 기본값 표의 기준을 명령 레퍼런스로 고정, allowlist 경고 문구 통일.
- 사용자 문서 보완 — 권한 가이드(`docs/permissions.md`) 신설(게이트 개념·acp/autopass 티어·allowlist/denylist·매칭 한계·드리프트·권장 베이스라인 SSOT, 흩어진 권한 서술은 포인터화). 트러블슈팅에 `stale`(행)·launchd 등록 불일치·재부팅 복구·orphan 정리 항목 추가. Telegram 가이드에 전체 흐름 조감도·봇 토큰 공유(폴링 409) 경고·승인 시 프롬프트 인젝션 주의 추가, 마크다운 가이드에 승인 인젝션 주의 추가. README 에 사용 시나리오·데이터 흐름/프라이버시 고지·ACP 어댑터 요구 명시. getting-started 성공 판정 기준 추가.
- 버전 SoT 를 루트 `VERSION` 파일에서 `package.json.version` 단일로 전환 — `VERSION` 파일 제거, `adde --version`·릴리스 트리거·발행이 모두 `package.json.version` 을 참조(SoT 이원화 제거). 릴리스 트리거는 `main` 의 `package.json` push 로 변경되며, 버전이 안 바뀐 변경은 태그·발행 멱등 가드가 no-op 처리.
- 설치 문서 발행 전환 — `npm i -g adde-acp` 정식 설치 안내, 업데이트(`npm i -g adde-acp@latest` + 실행 중 데몬 `adde restart`)·권한 오류(EACCES) 안내 추가.
- 미지원 최상위 명령 종료 코드 — 오타 등 알 수 없는 명령은 stderr 에 `Unknown command` + 근접 명령 추정(`Did you mean: …?`)을 내고 종료 코드 1 을 반환(종전엔 사용법 출력 후 0 이라 스크립트에서 오타가 조용히 성공 처리되던 문제). 인자 없음·`-h`/`--help`/`help` 는 종전대로 사용법 출력 후 0.
- 셸 자동완성 `adde completion <bash|zsh>` — 명령·플래그 자동완성 스크립트 생성(zsh·bash). 명령/플래그 SSOT(`cli/spec.ts`)에서 파생돼 명령 추가 시 자동완성·도움말·오타 힌트가 함께 갱신됨(확장성).
- 서브커맨드별 도움말 `adde <command> --help`(`-h`) — 각 명령의 사용법을 출력. `adde lane <sub> --help` 는 lane 전체 옵션 출력. 최상위 usage 에 `completion` 및 명령별 `--help` 안내 추가.
- 발행 전 사용자 문서 보완 — `claude`(Anthropic) 인증 전제·`node` PATH 요구를 요구사항에 명시, 제거(uninstall) 절차(`adde down` → `npm uninstall -g`) 추가, 트러블슈팅에 npm 설치 직후 문제(command not found·EACCES·claude 미인증) 절 추가, Telegram 가이드에 인바운드 인증 절 추가.
- 짧은 별칭 `add` 를 `package.json` `bin` 에서 제거 — `npm i -g` 시 자동 설치되던 흔한 명령명(`add`)이 타 도구와 충돌하던 문제를 없애고, `adde init`/`adde alias` 옵트인 설치로 전환(`ad`·`add`).
- 영문 사용자 문서 병기 — README·`docs/*` 를 영문 기본(`.md`) + 한국어(`.ko.md`) 이중 구조로 재편(언어 토글 링크), `package.json` description 영문화. 해외 npm 사용자 진입점(README) 확보.
- `adde lane add` 대화형 default — TTY 이고 필드 플래그 미지정 시 대화형 위저드가 자동 실행(`--interactive` 불요). 필드 플래그·`--no-interactive`·비TTY 는 비대화형(스크립트 호환). 대화형에서 enum·숫자 필드(perm_tier·file_mode·lang·chat_id·allow_from)를 입력 시점에 검증·재질의하고, telegram 봇 토큰을 **가려진 입력**으로 받아 `.env`(0600)에 기록(빈 입력이면 생성 후 위임).

## [0.1.2] - 2026-07-03

### Added

- 마크다운 어댑터 전송 스탬프 — inbox `✅ sent` 마커와 out 응답 노트 파일명에 전송 시각(`YYYYMMDD-HHmmss`, 로컬)을 동일 표기. 응답 노트가 시간순 정렬되고 언제 보낸 메시지인지 파일명만으로 식별.
- inbox `sent` 마커에 응답 노트 위키링크(`✅ sent [[<전송시각> <id>]]`) — 응답 노트 생성 시 링크가 해소되어 질문→응답 한 번에 이동(Obsidian 등). 구버전 `sending <id>`/`sent <id>` 라인도 하위호환 파싱.
- out 응답 노트 헤더 확장 — 원본 질문 발췌(첫 줄 80자, 시크릿 마스킹)와 요청·완료 시각 메타(`> ❓ ...` / `> 🕒 요청 ... · 완료 ...`)를 역참조와 함께 표기. 구버전 sidecar(메타 없음)는 종전 형식 유지.
- 승인 노트에 요청 시각·자동 거부 기한 표기(`> 🕒 요청 ... · 무응답 시 ... 자동 거부`) — 언제 요청됐고 언제 자동 deny 되는지 노트에서 바로 확인.
- 메시지 처리(주입) 실패의 채널 표면화 — 실패 시 `.failed` 내부 기록에 더해 채널 알림(markdown `_adde-notice.md` 노트 / telegram 메시지)으로 실패 사실·조치 안내 전달(레인 언어 적용, 메시지는 보존되어 재기동 시 재처리).

### Changed

- 개발 툴체인 승급(런타임 영향 없음) — typescript 6.0, eslint 10(+@eslint/js 10, 신규 no-useless-assignment 룰 대응), prettier 3.9, typescript-eslint 8.62.1, GitHub Actions(checkout v7·setup-node v6·pnpm/action-setup v6). @vitest/coverage-v8 4.x(vitest 4 전용)·ACP SDK 1.x(엔진 어댑터가 아직 0.14.1)는 보류.

## [0.1.1] - 2026-07-03

### Added

- i18n(en/ko) — 사용자 대면 문자열 전반(CLI 사용법·오류·doctor/status·채널 알림·경고 배너·운영 로그 — 내부 개발자용 throw 제외)을 i18next 기반 en/ko 카탈로그로 이전. 로케일 자동 감지(`ADDE_LANG` > `LC_ALL` > `LC_MESSAGES` > `LANG` > 기본 en — 한국어 환경은 기존과 동일하게 한국어 출력).
- 레인별 채널 메시지 언어 `lang` conf 필드 + `adde lane add --lang <en|ko>` — 권한 프롬프트·경고 배너·알림 노트를 레인 단위로 언어 고정(미지정 시 전역 로케일, 옵트인·기본 동작 불변). 미지원 값은 생성 시 비차단 경고.
- i18n 패리티 검사 `pnpm run i18n:check`(키·보간 플레이스홀더·빈 문자열) + CI 게이트. 키 패리티는 타입(`ko satisfies typeof en`)으로도 컴파일 타임 강제.
- 권한 티어 `autopass`(레인별 옵트인) — `--perm-tier autopass --denylist Bash,Write` 로 생성. denylist 도구만 채널 승인(fail-closed 게이트 유지)을 거치고 그 외 전 도구는 자동 허용, 자동 허용 내역은 전량 transcript 기록. 기본 티어(`acp`) 동작 불변.
- 레인 conf `denylist` 필드 + `adde lane add --denylist` 옵션(대화형 `--interactive` 는 autopass 선택 시에만 질문).
- autopass 레인 기동 시 채널 경고 배너 — 자동 허용 모드임과 denylist 구성을 채널(telegram 메시지 / markdown `_adde-notice.md` 노트)로 고지.
- 소스 어댑터 운영 알림(`notify`) — 권한 설정 드리프트 경고 등 운영 경고가 콘솔·transcript 외에 채널로도 전달.
- `adde lane add` 생성 경고 확장 — 알 수 없는 `perm_tier` 값(오타) 경고, autopass 위험 고지·빈 denylist 경고.
- denylist `Tool(글롭)` 패턴 — 도구의 대표 인자(Bash=명령, Read/Write/Edit=경로, WebFetch=URL)를 글롭으로 매칭해 "git push --force 만 확인" 같은 세분 제어 지원. 인자 미확인·미지원 도구는 도구명 일치만으로 채널 승인(과매칭=안전 방향).
- autopass 기본 denylist — `--denylist` 생략 시 파괴적 명령·자격증명 읽기를 차단하는 내장 기본 목록(sudo·rm -rf·git force-push/reset --hard/clean·`~/.ssh`·`~/.aws` 읽기 — 전신 프로젝트 운영값 승계)을 conf 에 명시 기록.
- markdown 레인 경로 상호 배타 가드 — inbox/approvals/outbox 가 같거나 포함 관계면 기동 거부(fail-closed) + 생성 시 사전 경고(출력·알림 노트가 승인 감시에 잡히는 오동작 예방).
- 문서: 동기화 vault 민감 정보 노출 가이드(`docs/markdown.md`) — 노트로 나가는 내용·로컬에만 남는 것·민감 프로젝트 권장 배치.
- `adde up <proj>` — macOS launchd LaunchAgent 데몬으로 기동. `adde up` 자체는 plist 등록 후 즉시 종료되고, 실제 레인은 백그라운드에서 상주. 터미널을 닫아도 동작, 재부팅·로그아웃 후 자동 복구(`KeepAlive`/`RunAtLoad`).
- `adde down <proj>` — 어느 터미널에서든 launchd 데몬을 종료(교차 프로세스 종료). 이전의 동일 프로세스 내 종료(in-memory) 방식에서 변경.
- `adde restart <proj>` — `down` + `up` 편의 래퍼. 설정 변경 후 데몬 재기동에 사용.
- `adde up` 중복 기동 가드 — 이미 실행 중인 레인은 경고 메시지(`↳ 조치:` 힌트 포함)와 함께 스킵. Telegram getUpdates 이중 롱폴·409 충돌 방지.
- `adde doctor <proj>` launchd 등록 상태 점검 — plist 존재 여부와 launchctl 등록 여부를 교차 확인. 불일치(`WARN`) 시 조치 힌트 표시.
- graceful shutdown 강화 — launchd SIGTERM 수신 시 소스 어댑터 stop → ACP 엔진 백엔드 close 순서로 정리. 5초(`CHILD_GRACE_MS`) 내 미종료 자식은 SIGKILL. 비정상 종료(크래시) 후 재기동 시 dead runtime.json 자동 정리.

### Fixed

- 권한 설정 차이(엔진이 정책보다 느슨, 예: bypassPermissions) 확인·확인불가 모두 콘솔·채널·transcript 경고 후 기동 계속(요청별 권한 게이트는 계속 강제). autopass 레인은 엔진 bypass 시 denylist 가 무력화됨을 별도 사유로 고지.
- allowlist/denylist 매칭 키를 권한 요청의 표시 제목(`toolCall.title`, 인자 포함 문자열)에서 **원시 도구명**(tool_call 업데이트 `_meta.claudeCode.toolName` 채집)으로 교체 — 제목 정확일치라 allowlist 자동 허용이 사실상 발화하지 않던 결함 수정. 도구명 미해석 시 자동 허용하지 않음(fail-closed, 채널 승인 폴백). allowlist·denylist 에 같은 도구가 있으면 denylist 우선(생성 시 경고).
- 권한 승인 프롬프트의 도구 표시를 "도구명 · 제목" 으로 확장하고 마스킹 적용 — 제목에 도구 인자(명령 문자열 등)가 포함되어 시크릿이 노출될 수 있던 경로 차단.
- 전송 신뢰성 — 채널 전송 성공을 별도 마커(`out/<id>.sent`)로 분리. 응답 기록 후 채널 전송(render)이 실패하면 응답이 `out/` 에 보존되고 다음 처리 사이클·재기동에서 재전송(미전달 영구 손실 차단). telegram 멀티청크 응답의 부분 전송 실패도 재전송 경로로 흡수(at-least-once — 부분 전송 후 앞 청크 중복 가능).
- 큐 신뢰성 — 손상(파싱 불가) 큐 메시지를 격리(`processing/<id>.msg.corrupt` + `out/<id>.failed`)하고 다음 메시지로 진행(매 기동 동일 파싱 오류 반복 차단). `claimNext` 가 경합·손상 메시지를 건너뛰고 다음 유효 메시지를 claim.
- 권한 게이트 — 결정 대기자(pendingDecisions)를 타임아웃 포함 모든 종결 경로에서 정리(장기 상주 시 누수 차단).
- Telegram 입력 검증 — 콜백 decision 값이 allow/deny 가 아니면 무시·로그(fail-closed), 비숫자 `channel_msg_id` 의 `reply_to_message_id` 생략.
- 사용자 편의 — `adde up` 이 레인 기동 실패 시 어떤 레인이 왜 실패했는지 + 조치(`doctor`/`logs`)를 함께 표면화하고, 기동할 레인이 없으면 `adde lane add` 를 안내. `docs/getting-started.md` 에 설치 후 `adde doctor` 프리플라이트 안내 추가.
- 마크다운 enqueue 연속 실패 알림 — 임계 도달 시 outbox 노트(`_enqueue-alert.md`)로 1회 운영자 알림(telegram 패턴과 일관), 성공 시 리셋.
- 엔진 child 종료 견고성 — `closeChild`/`killChild` 의 `child.kill()` 전송 실패(이미 종료·EPERM)를 흡수해, executor throw 로 인한 종료(`down`/셧다운) 중단·`exit` 리스너 잔존·`runtime.json` 미정리를 차단.
- 죽은 배선 제거 — 미사용 `idleCallbacks`/`setIdleCallback`(inject() resolve 로 turn 종료를 감지하므로 불필요) 정리.

### Security

- 권한 요청 detail 마스킹 — 권한 요청 상세(toolCall)가 채널(텔레그램 메시지·마크다운 승인 노트)에 표면화되기 전 시크릿 마스킹 적용.
- `adde logs` 경로 탈출 차단 — `proj`/`lane` 을 경로 구성 SSOT(`lanePaths`)에서 일괄 검증(영숫자·`_`·`-` 만 허용)해, 다른 레인 명령과 달리 누락돼 있던 `..` 탈출 읽기를 차단(레인 격리 일관성 확보).
- 마크다운 승인파일 경로 탈출 차단 — 승인 파일명에 쓰이는 엔진 제어 `req.id`(sessionId)가 `..`·구분자를 포함하면 fail-closed(게이트 deny)로 거부해, AI 가 승인 노트를 마크다운 root 밖에 위조·기록하는 것을 차단.
- 봇 토큰 마스킹 견고성 — 토큰부 길이를 `{35}` 고정에서 `{30,}` 하한으로 완화해, 형식 드리프트(35자 비보장)로 인한 과소마스킹(토큰 누출) 가능성 축소.

## [0.1.0] - 2026-06-30

### Added

- 레포 메타: `README.md` · `VERSION`(0.1.0) · `CHANGELOG.md` · `.gitignore`.
- TypeScript 개발환경 스캐폴드: pnpm · `tsconfig`(strict) · ESLint/Prettier · vitest · CI/release 워크플로 · `src/` 골격.
- ACP 백엔드 + Telegram 소스 어댑터 + 직렬 인젝터 + fail-closed 권한 게이트(PoC 수직 슬라이스).
- 마크다운 소스 어댑터(예: Obsidian): 노트 파일 핸드셰이크(인박스 체크박스 송신 · 승인 노트 권한 · 출력 노트 · 동기 충돌 격리).
- 레인별 프로젝트 폴더 매핑(`cwd`) — 레인마다 다른 작업 폴더에서 엔진 기동.
- 레인 설정 서브커맨드 `adde lane add/ls/show/rm` — `.conf` 파일 생성·조회·삭제(검증 후 원자적 기록, telegram 토큰 stdin→`.env` 0600).
- conf `cwd`/`root` 경로의 선행 `~` 홈 디렉터리 확장.
- 사용자 문서: `docs/getting-started.md` · `docs/markdown.md` · `docs/README.md`.
- `adde up` 그레이스풀 셧다운 — SIGINT/SIGTERM 수신 시 레인을 정리(엔진 종료 포함)한 뒤 종료.
- 차단·예외 시 "상황 + 조치" 액션형 알림 — 무엇이 일어났고 어떻게 조치할지를 항상 함께 고지.
- 운영 가시성 명령 `adde status` · `doctor` · `logs` — 레인 상태(`running`/`dead`/`stopped`) 조회, 환경·설정 정적 점검(조치 힌트 포함), 레인 transcript 최근 N줄. `adde up` 이 기동 시 레인 라이브니스 상태 파일(`state/<lane>/runtime.json`)을 기록해 별도 프로세스인 `status` 가 교차 조회.
- 레인 하트비트 — `adde up` 이 주기적으로 상태 파일 mtime 을 갱신하고, `status` 가 `stale`(프로세스는 살아있으나 응답 없음 = 행/hung)을 정상(`running`)과 구분해 표면화(SEEN 컬럼·경고·비정상 종료코드).
- `adde logs <proj> <lane> --engine` — 엔진 서브프로세스 stderr 를 레인별 `engine.log` 로 캡처하고 조회(기본 transcript, `--engine` 시 엔진 출력).
- `adde lane add --interactive` — 대화형 레인 생성(TTY 전용, 봇 토큰은 화면 노출 회피 위해 비수집). 생성 시 `cwd` 부재·markdown `root` 부재·telegram 토큰 형식 이상을 경고로 안내(생성은 진행).
- 공개 문서 확장: `docs/telegram.md` · `docs/commands.md`(명령 레퍼런스) · `docs/troubleshooting.md`.
- 레포 메타: `LICENSE` · `SECURITY.md` · `CONTRIBUTING.md` · 이슈/PR 템플릿 · dependabot · `.editorconfig` + 테스트 커버리지 도구.

### Fixed

- 신뢰성 하드닝(P0): `adde down`/셧다운 시 ACP 엔진 자식 프로세스를 정리(SIGTERM→유예→SIGKILL)해 좀비 누수 차단. 엔진 핸드셰이크에 타임아웃을 둬 무응답 시 영구 대기 대신 기동 실패. 소스 정지(`stop`)를 비동기화해 진행 중 작업·롱폴 정리 후 종료(임시 리소스 정리 뒤 오류 방지). ACP 세션 이벤트 구독자 오류를 무음 흡수하지 않고 기록.
- 권한 설정 차이가 _확인되면_(엔진이 정책보다 느슨) 기동을 fail-closed 로 거부. 단 엔진이 실효 설정 조회를 미지원하는 경우는 경고 후 계속(요청별 권한 게이트가 계속 강제).

- `adde up` 이 레인 기동 후 메시지를 처리·응답하지 못하던 문제 — 수신 트리거(소스 enqueue→injector in-process 통지)·turn 연쇄·엔진 응답 캡처(`agent_message_chunk` 누적→`out/`→채널 렌더)를 배선. 내부 핸드오프는 fs.watch 대신 in-process 콜백(외부 inbox 감지만 watch 유지).
- `adde up` CLI 가 supervisor 기동 전 즉시 종료되던 문제 — 진입 로직 비동기화 및 포그라운드 상주.
- ACP 권한 핸들러를 `launch` 이전에 등록해 실패하던 순서 오류, 어댑터 바이너리 경로 오해석(`dist/index.js`), 엔진 spawn 오류 미처리 프로세스 크래시 수정.

- 마크다운 어댑터 크래시 시 중복 전송 — send 처리에 2단계 내구 마킹(`sending`→`sent`) + 존재검사 재개로 정확히 1회 보장.
- 마크다운 전송 트리거 오발동 — 트리거를 체크박스 라벨이 정확히 `send` 인 경우로 한정(메시지 본문의 'send' 포함 줄·사용자 todo 체크박스 오인 방지).
- allowlist 가 승인 경로에 미배선이던 문제 — 도구명이 allowlist 에 있으면 자동 allow 로 결정(채널 프롬프트 생략, 트랜스크립트 기록).

- 안전 표면: `out/` 출력과 사이드카(`.out.json`) 쓰기 순서 정리로 부분 기록 노출 차단, `claimNext` 의 파일 부재(정상)와 실제 오류를 구분(오류는 전파·로그), Telegram enqueue 연속 실패 감지·알림·백오프.
- 마크다운 `fs.watch` 누락 이벤트 보정 — 2초 주기 mtime+size 폴링 백스톱(감시 이벤트가 유실돼도 변경을 포착).
- 마크다운 부분 동기 읽기 방지 — 파일 내용이 안정될 때까지 재확인 후 처리(쓰는 도중 읽어 깨진 입력 방지).
- Telegram 4096자 초과 응답 청킹 — 줄 경계 우선으로 분할해 순차 전송(첫 청크만 원문 인용).
- Telegram 회복탄력성 — 429 응답의 `retry_after` 만큼 대기 후 재시도(횟수·상한 제한), 폴링 연속 실패 시 지수 백오프.
- 승인 요청당 파일 분리(`approvals/<req-id>.md`) — 동시 다중 승인 요청의 단일 파일 편집 충돌면 축소.
- 신뢰성: inject 실패 메시지를 `.failed` 로 보존(유실 방지), transcript 감사 기록 오류를 무음 흡수 대신 승격, injector 의 claim 을 직렬화해 동일 메시지 중복 처리 차단.
- 테스트 안정화 — 폴링 헬퍼를 실시간 타이머 + 시한초과 throw 로 전환해 부하 시 위양성(silent timeout) 제거.

### Security

- 마크다운 자기승인 경계 — 제어 노트(inbox·approvals·outbox)가 AI 작업폴더(`cwd`) 내부면 fail-closed 로 레인 기동 거부(AI 의 승인/지시 노트 위조 차단).
- 입력 검증·노출 표면 강화 — envelope 텍스트 길이/형식·`channel_msg_id`·첨부 필드 검증, 마크다운 노트 경로의 디렉터리 탈출(`..`·절대경로) 차단, allowlist 항목 문자셋 제한, 로그·전사 시크릿 마스킹 패턴 확대(API 키·Bearer·`KEY=값`).

### Decided

- 구현 언어: TypeScript + Node.js LTS.
- 엔진 통합: ACP(Agent Client Protocol) 우선, protocolVersion 1.
