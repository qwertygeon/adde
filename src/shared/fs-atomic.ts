import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** 프로세스 내 단조 카운터 — pid 만으로는 **같은 프로세스** 안에서 겹치는 동시 호출을 구분하지
 * 못한다(실측: `session-model.test.ts` SC-002 의 동시 `create()` 2건이 같은 tmp 를 써 한쪽이
 * `rename ENOENT` 로 실패했다). pid+카운터로 호출 단위 유일성을 확보한다. */
let tmpCallCounter = 0;

/**
 * tmp 경로 생성 — pid+카운터(동시 호출 유일성, 위 주석) 에 **암호학적으로 예측 불가능한 접미**를
 * 더한다(보안 검토 SEC-006). pid+카운터만으로는 다음 tmp 이름을 예측할 수 있어, 공격자가 그
 * 경로에 심볼릭 링크를 미리 심어 두면(선점) `writeFile` 이 기본 플래그(`w`)로 그 링크를 따라가
 * 엉뚱한 대상 파일에 쓰게 된다(`open(2)` 의 `O_CREAT` 만으로는 대상이 심볼릭 링크여도 그대로
 * 따라간다). 호출부가 `flag: "wx"`(`O_CREAT|O_EXCL`) 로 열어 "이미 있으면 실패" 를 강제하고,
 * 여기서 예측 불가능한 이름을 줘 그 선점 시도 자체를 무력화한다(이중 방어 — `wx` 단독으로도
 * 막히지만, 예측 가능한 이름은 공격자가 반복 선점해 매번 EEXIST 로 쓰기를 막는 DoS 여지가 남는다).
 */
function tmpPathFor(filePath: string, suffix: "tmp" | "reserve.tmp"): string {
  const dir = dirname(filePath);
  const rand = randomBytes(6).toString("hex");
  return join(dir, `.${basename(filePath)}.${process.pid}.${tmpCallCounter++}.${rand}.${suffix}`);
}

/**
 * 같은 디렉터리 tmp→rename 으로 원자 기록 — 부분 쓰기가 최종 경로에 노출되지 않는다.
 * tmp 는 숨김(dot-prefix, 에디터/감시 노출 회피) + pid+카운터+랜덤(프로세스 간·프로세스 내 동시
 * 호출 tmp 이름 충돌 회피·선점 예측 방지, 위 `tmpPathFor` 주석) + `.tmp` 접미(`.msg`/`.out` 등
 * 접미 필터에 걸리지 않음). 대상 디렉터리는 없으면 생성한다. `flag: "wx"` 로 tmp 경로가 이미
 * 있으면(심볼릭 링크 포함) 실패한다 — 이 경로는 항상 새로 생성되므로 `mode` 옵션도 실제로
 * 적용된다(기존엔 이미 있는 파일에 쓰면 `mode` 가 무시됐다). **다른 프로세스**의 동시 호출까지는
 * tmp 이름만으로 막지 못한다(pid 가 서로 다르므로 tmp 자체는 안 겹친다 — 다만 같은 최종 경로로의
 * rename 은 나중에 도착한 쪽이 먼저 쓴 내용을 조용히 덮어쓸 수 있다는 rename(2) 자체의 성질은
 * 남는다. 배타적 "최초 생성" 이 필요하면 `reserveNewFile` 을 쓴다).
 */
export async function atomicWrite(
  filePath: string,
  content: string,
  opts?: { mode?: number },
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = tmpPathFor(filePath, "tmp");
  await writeFile(tmp, content, {
    encoding: "utf8",
    flag: "wx",
    ...(opts?.mode === undefined ? {} : { mode: opts.mode }),
  });
  await rename(tmp, filePath);
}

/**
 * 배타적 신규 생성 — 대상 경로가 **이미 있으면 `EEXIST` 를 던진다**(호출자가 다음 후보로 재시도).
 * `rename()` 은 대상이 있어도 조용히 덮어써 "동시에 같은 이름을 먼저 차지하는 쪽" 판정에 못 쓴다
 * (POSIX `rename(2)` 의 성질 — `RENAME_NOREPLACE` 는 Node fs API 로 노출되지 않는다). 대신
 * `link(2)` 는 대상이 있으면 원자적으로 `EEXIST` 실패한다 — 이를 이용해 tmp 에 내용을 **완전히**
 * 쓴 뒤(부분 쓰기 노출 없음, `atomicWrite` 와 동일 이유) `link()` 로 최종 경로를 배타 확보하고
 * tmp 는 정리한다. tmp 자체도 `flag: "wx"` 로 배타 생성한다(선점된 심볼릭 링크를 따라가지 않음,
 * `atomicWrite` 와 동일 이유) — Darwin `link(2)` 는 **source**(tmp) 가 심볼릭 링크면 그 대상을
 * 따라가므로, tmp 가 공격자 소유 링크였다면 `filePath` 가 그 대상에 하드링크될 수 있었다. tmp
 * 정리 실패해도 이름이 pid+카운터+랜덤으로 유일해 이후 시도와 충돌하지 않는다(고아 tmp 잔존 —
 * 기존 `atomicWrite` 의 rename 실패 시 고아 tmp 위험과 동급이며 새로 도입한 위험이 아니다).
 */
export async function reserveNewFile(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = tmpPathFor(filePath, "reserve.tmp");
  await writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
  try {
    await link(tmp, filePath);
  } finally {
    // 성공(링크 완료)·실패(EEXIST 등) 모두 tmp 는 더 이상 필요 없다 — 원본 에러(EEXIST 포함)는
    // 이 정리와 무관하게 그대로 전파된다.
    await unlink(tmp).catch(() => {});
  }
}

/**
 * 내부 상태·큐 디렉터리를 권한 모드대로 잠근다.
 * private=0700(소유자 전용 — 다중 사용자 호스트에서 타 로컬 유저의 대화/응답 열람 차단),
 * shared=no-op(기존 기본 권한 유지 — 열람 허용을 옵트인한 경우). 부재 디렉터리는 먼저 생성한다
 * (신규 생성은 `mkdir` 의 `mode` 옵션으로 0700 을 즉시 부여 — chmod 를 뒤이어 별도 호출하면 그
 * 사이 기본 권한(0755)의 창이 잠깐 열린다, 보안 검토 SEC-006). 이미 있던 디렉터리는 `mkdir` 의
 * `mode` 가 적용되지 않으므로(recursive 모드에서 기존 디렉터리는 무동작) `chmod` 로 계속
 * 교정한다. chmod 실패는 흡수하지 않고 전파한다(권한이 의도대로 적용됐는지는 보안 신호 —
 * 호출부가 로그/판단).
 */
export async function securePrivateDirs(
  dirs: readonly string[],
  mode: "private" | "shared",
): Promise<void> {
  if (mode !== "private") return;
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
}
