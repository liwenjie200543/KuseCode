/**
 * 脱敏 —— 「我们自己的凭据不许出现在证据里」这条规矩的唯一实现。
 *
 * 它是一个**纯函数模块**，没有 import 任何东西（连 `process` 都没有：环境变量由
 * 调用方读进来，这样它可以被逐条验证，不需要真的设一个环境变量）。
 *
 * ## 它守的是什么，不守什么
 *
 * 这里必须把两类"秘密"分开，因为它们的正确处理方式完全不同：
 *
 * | | 例子 | 从哪来 | 怎么办 |
 * |---|---|---|---|
 * | **我们自己的凭据** | provider 的 API key | 进程环境 | **落盘之前就抹掉**（本文件） |
 * | **被分析仓库里的秘密** | 仓库某行里写死的 key | 材料本身 | **保留原样**，因为那正是要报告的东西 |
 *
 * 第二类不能在这里改写，理由是本项目的全部价值都压在"证据是真的"上：一次
 * `read_file` 拿回来的原文如果被我们改过，那么"这条论断指向这个文件的这一行"
 * 就不再可核对。所以脱敏只作用于**第一类**（外来的、属于我们运行环境的东西），
 * 以及**给人看的输出**（终端与 CI 日志是另一个泄漏面）。
 *
 * ## 两个入口
 *
 * 1. **适配器**：provider 的报错原文在变成 `RunError.message` 之前过一遍。
 *    这是外部字符串进入我们词汇表的唯一一条路，也是我们自己的 key 唯一可能
 *    （被 provider 回显）流进事件日志的地方。堵住它，这条路径就是闭合的——
 *    守着它的测试是 `test/pi-adapter-sdk.test.ts` 的「脱敏接在错误分类之前」
 *    （凭据被抹掉，而错误码不退化）。
 * 2. **CLI 输出**：终端上的每一行都过一遍。若被分析的仓库里恰好有一个 key，
 *    它不该被我们的进度输出抄到 CI 日志里（但日志文件里它仍然是原文，
 *    见上面的表）。守着它的是 `test/cli.test.ts` 的「脱敏」一节，那里的每条用例
 *    都拿**同一个字符串**同时断言两件事：输出里它被抹了，事件日志里它还在。
 */

/** 被抹掉的部分替换成什么。用一个显眼的标记，而不是删成空白——"这里有过东西"是信息。 */
export const REDACTED = "[已脱敏]";

/**
 * 太短的值不当秘密。
 *
 * 一个 3 个字符的 `TOKEN=abc` 会在文本里到处误伤（`abc` 是个普通子串）。
 * 门槛的作用是让"误伤"不可能发生在常见的短值上，代价是一个真的只有 5 位长的
 * 弱口令不会被抹掉——而那种口令本来也不该被当作凭据依赖。
 */
const MIN_SECRET_LENGTH = 8;

/**
 * 环境变量名的形状。
 *
 * 只认**词**，不认子串：`MONKEY` 不是 `KEY`，所以前后都要有边界（`^` 或 `_`）。
 *
 * 已知缺口（**故意不补**）：`PGPASSWORD` 这种"两个词连写、中间没有分隔符"的
 * 名字不匹配——PASSWORD 前面是 `G`，既不是行首也不是 `_`。放宽到"允许小写→大写
 * 的转换处也当边界"能把它捞进来，但那条规则的边界在哪没有依据（`XKEYS`？
 * `aToken`？），而每放宽一步就多一类误伤。误伤一个真凭据只是不抹（本来就只剩
 * "provider 回显"这一条泄漏路径），误伤一段正常文本却会让证据变得不可读。
 * 这条缺口与 `MIN_SECRET_LENGTH` 是同一类判断：**有代价的保守**。
 */
const SECRET_NAME = /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|ACCESS_KEY|PRIVATE_KEY)(?:$|_)/i;

/**
 * 密钥的**形状**。
 *
 * 它对付的是"值不在环境里、但我们一眼认得出它是钥匙"的情况（provider 回显、
 * 工具结果、仓库内容）。这张表故意短：每多一条就会多一类误伤，而误伤证据
 * 比漏掉一个形状更糟。认不出来的就交给环境值那一路。
 */
const SECRET_SHAPES: readonly RegExp[] = Object.freeze([
  // OpenAI / Anthropic 风格
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // GitHub
  /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  // Google
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  // Slack
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // 传输层最常见的那一种：`Authorization: Bearer <...>`
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
]);

/** 正则元字符转义。环境值当成**字面量**匹配，不然一个含 `.` 的值会误伤一大片。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 环境里哪些变量的值算凭据。
 *
 * 返回**值**而不是名字，因为调用方要拿它去文本里做替换。
 * 返回的顺序是确定的（按名字排序），所以同一份环境每次得到同一份清单。
 */
export function secretsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const found: string[] = [];
  for (const name of Object.keys(env).sort()) {
    if (!SECRET_NAME.test(name)) continue;
    const value = env[name]?.trim();
    if (value === undefined || value.length < MIN_SECRET_LENGTH) continue;
    found.push(value);
  }
  // 长值先替换：短值可能是长值的前缀，先换短的会把长的切碎从而换不干净。
  return found.sort((left, right) => right.length - left.length);
}

/**
 * 造一个脱敏函数。
 *
 * 之所以返回函数而不是让每个调用点自己拼：替换规则有两路（环境值 + 形状），
 * 两路都要跑、顺序还要固定。把它们封装成一个函数，调用方就不可能只跑一半。
 */
export function redactor(secrets: readonly string[] = []): (text: string) => string {
  const literal = secrets
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .sort((left, right) => right.length - left.length)
    .map((secret) => new RegExp(escapeRegExp(secret), "g"));

  return (text: string): string => {
    let out = text;
    for (const pattern of literal) out = out.replace(pattern, REDACTED);
    for (const pattern of SECRET_SHAPES) out = out.replace(pattern, REDACTED);
    return out;
  };
}

/** 一句话的脱敏。 */
export function redactText(text: string, secrets: readonly string[] = []): string {
  return redactor(secrets)(text);
}

/**
 * 一个可 JSON 表示的值的脱敏（深拷贝，不改入参）。
 *
 * 它只递归数组与普通对象；`Date`、`Map` 这些不是我们的词汇（事件里的值必须可
 * JSON 表示，见步 6 的 `findJsonProblem`），所以遇到了就原样交出去——
 * 在这个函数里"猜它是什么"比"原样交出去"更危险。
 *
 * `seen` 防的是循环引用：我们的值不可能有环（同一个准入检查挡着），
 * 但这个函数也可能被用在别处，而"深拷贝递归到栈溢出"不是一个有用的失败方式。
 */
export function redactValue(value: unknown, secrets: readonly string[] = []): unknown {
  const redact = redactor(secrets);

  const walk = (node: unknown, seen: WeakSet<object>): unknown => {
    if (typeof node === "string") return redact(node);
    if (node === null || typeof node !== "object") return node;
    if (seen.has(node)) return REDACTED;
    seen.add(node);

    if (Array.isArray(node)) return node.map((item) => walk(item, seen));

    const prototype: unknown = Object.getPrototypeOf(node);
    if (prototype !== Object.prototype && prototype !== null) return node;

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(node)) {
      out[key] = walk((node as Record<string, unknown>)[key], seen);
    }
    return out;
  };

  return walk(value, new WeakSet());
}
