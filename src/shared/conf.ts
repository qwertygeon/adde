/**
 * 레인 .conf 파싱 (INI 형식).
 * FR-001/021 (design 03 §7): source/backend/engine/channel/perm_tier/acp_version/allowlist.
 * 누락 필드 기본값 적용, 알 수 없는 키 무시(forward-compat).
 */

export interface LaneConf {
  source: string;
  backend: string;
  engine: string;
  channel: string;
  perm_tier: string;
  acp_version: string;
  allowlist: string[];
}

export function parseLaneConf(text: string): LaneConf {
  const conf: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (key) conf[key] = value;
  }

  const allowlistRaw = conf["allowlist"] ?? "";
  const allowlist = allowlistRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    source: conf["source"] ?? "",
    backend: conf["backend"] ?? "",
    engine: conf["engine"] ?? "",
    channel: conf["channel"] ?? "",
    perm_tier: conf["perm_tier"] ?? "acp",
    acp_version: conf["acp_version"] ?? "v1",
    allowlist,
  };
}
