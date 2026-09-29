/**
 * Shell 命令风险分类器：把一条 bash 命令分成三档。
 *
 * - `safe`：只读操作（git status / npm test / cat …）
 * - `confirm`：会改动状态（npm install / mkdir / 重定向 / 未认识的动词——
 *   未认识的按 confirm 处理，宁可多问一次）
 * - `destructive`：直接拒绝（rm -rf / sudo / git reset --hard / 管道进 shell …）
 *
 * 判定是保守的启发式，不是安全边界：真正的边界是操作系统用户权限。
 */

export type CommandRisk = "safe" | "confirm" | "destructive";

/** 分段：&& ; | —— 每段独立判定，取最严档。 */
function segments(command: string): string[] {
  return command
    .split(/&&|;|\|\|/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const DESTRUCTIVE: readonly RegExp[] = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)/i,
  /\bsudo\b/i,
  /\bmkfs/i,
  /\bdd\s+if=/i,
  /\bshutdown\b|\breboot\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bdel\s+\/[sq]/i,
  /\bformat\s+[a-z]:/i,
  /\b>\s*\/dev\//i,
  /\|\s*(sh|bash|zsh|powershell)\b/i,
  /\bchmod\s+777\s+\//i,
  /\bkill\s+-9\s+1\b/i,
];

const SAFE_VERBS: readonly RegExp[] = [
  /^git\s+(status|log|diff|show|branch|remote)\b/i,
  /^ls\b/i,
  /^(cat|head|tail|wc)\b/i,
  /^(grep|rg)\b/i,
  /^find\s+\S+\s+-name\b/i,
  /^(node|python|python3)\s+(-v|--version)\b/i,
  /^npm\s+(test|run\s+(test|build|lint|typecheck))\b/i,
  /^npx\s+(tsc|vitest)\b/i,
  /^(echo|pwd|which|whoami)\b/i,
  /^\s*$/i,
];

function classifySegment(segment: string): CommandRisk {
  const cleaned = segment.replace(/^[(!{\s]+/, "").trim();
  if (DESTRUCTIVE.some((pattern) => pattern.test(cleaned))) return "destructive";
  // 重定向与追加：会改文件系统状态
  if (/>{1,2}\s*\S/.test(cleaned)) return "confirm";
  if (SAFE_VERBS.some((pattern) => pattern.test(cleaned))) return "safe";
  return "confirm";
}

export function classifyCommand(command: string): CommandRisk {
  let worst: CommandRisk = "safe";
  for (const segment of segments(command)) {
    const risk = classifySegment(segment);
    if (risk === "destructive") return "destructive";
    if (risk === "confirm") worst = "confirm";
  }
  return worst;
}
