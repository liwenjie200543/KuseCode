/**
 * 脱敏 —— 两类"秘密"必须被分开处理的证据。
 *
 * 这个文件的断言分两半，对应 `src/core/redact.ts` 文件头那张表：
 *
 * - **我们自己的凭据**（环境里的、外来的）：必须被抹掉。
 * - **被分析仓库里的秘密**（材料本身）：必须被**保留**。这一半不在本文件里测，
 *   因为它不是"这个函数做了什么"，而是"日志那条路没有调用它"——那种断言只能
 *   对着真跑完的一次 Run 做，它在 `test/cli.test.ts` 里（凭据串不在任何一条
 *   持久化事件里，而仓库里的 key 仍然原样留着）。
 *
 * 这里测的是三个纯函数的边界：哪些值算凭据、什么形状算钥匙、深拷贝时怎么走。
 */

import { describe, expect, it } from "vitest";
import { REDACTED, redactText, redactValue, redactor, secretsFromEnv } from "../src/core/redact.js";

describe("secretsFromEnv：哪些环境变量算凭据", () => {
  it("按**词**认名字，不认子串", () => {
    expect(secretsFromEnv({ MONKEY: "aaaaaaaaaa" })).toEqual([]);
    expect(secretsFromEnv({ API_KEY: "aaaaaaaaaa" })).toEqual(["aaaaaaaaaa"]);
    // 连写与下划线分开都要认：两种写法在真实环境里一样常见。
    expect(secretsFromEnv({ APIKEY: "aaaaaaaaaa" })).toEqual(["aaaaaaaaaa"]);
  });

  it("词在中间也认：`_` 是边界", () => {
    expect(secretsFromEnv({ PG_PASSWORD_FILE: "aaaaaaaaaa" })).toEqual(["aaaaaaaaaa"]);
    expect(secretsFromEnv({ MY_SECRET_THING: "aaaaaaaaaa" })).toEqual(["aaaaaaaaaa"]);
  });

  it("已知缺口：两个词连写、中间没有分隔符的名字不匹配", () => {
    // 这不是疏漏，是"只认词"那条规则的另一面。放宽会多一类误伤，
    // 而这里更想守住的是"不去猜"——见 `src/core/redact.ts` 的已知缺口一节。
    expect(secretsFromEnv({ PGPASSWORD: "aaaaaaaaaa" })).toEqual([]);
  });

  it("太长太短都不当秘密：短值会在文本里到处误伤", () => {
    expect(secretsFromEnv({ TOKEN: "abc" })).toEqual([]);
    expect(secretsFromEnv({ TOKEN: "1234567" })).toEqual([]); // 7 位，差一位
    expect(secretsFromEnv({ TOKEN: "12345678" })).toEqual(["12345678"]);
  });

  it("给的是**值**不是名字，而且长值排在前面", () => {
    const secrets = secretsFromEnv({
      SHORT_KEY: "aaaaaaaa",
      LONG_KEY: "aaaaaaaaaaaaaaaaaaaa",
    });

    // 长值先替换：短值可能是长值的前缀，先换短的会把长的切碎从而换不干净。
    expect(secrets).toEqual(["aaaaaaaaaaaaaaaaaaaa", "aaaaaaaa"]);
  });

  it("空值、只有空白、未定义的变量都被跳过", () => {
    expect(secretsFromEnv({ API_KEY: "", OTHER_TOKEN: "   ", THIRD_SECRET: undefined })).toEqual([]);
  });
});

describe("redactor：两路替换", () => {
  it("环境里的值按**字面量**匹配，正则元字符不生效", () => {
    // 值要比 `MIN_SECRET_LENGTH` 长，否则它根本进不了替换清单（下一条用例守着那个门槛）。
    const redact = redactor(["a.b(c)+d*e"]);

    // 若没转义，`a.b(c)+d*e` 会被当成正则：`aXbc+dde` 那种无关文本会被误伤。
    expect(redact("值：a.b(c)+d*e")).toBe(`值：${REDACTED}`);
    expect(redact("无关：aXbc+dde")).toBe("无关：aXbc+dde");
  });

  it("太短的值进不了替换清单：门槛在 `redactor` 里也有一道", () => {
    // `secretsFromEnv` 会滤掉短值，但调用方可以直接把一串值交给 `redactor`，
    // 所以门槛不能只守在一处——一个 3 字符的"秘密"会在文本里到处误伤。
    expect(redactor(["abc"])("abc 是普通子串")).toBe("abc 是普通子串");
  });

  it("认得常见密钥形状：provider 回显、工具结果、仓库内容都拦得住", () => {
    const redact = redactor([]);

    expect(redact("key=sk-abcdefghijklmn")).toBe(`key=${REDACTED}`);
    expect(redact("ghp_ABCDEFGHIJKLMNOPQRSTUVWX")).toBe(REDACTED);
    expect(redact("github_pat_ABCDEFGHIJKLMNOPQRSTUV")).toBe(REDACTED);
    expect(redact("AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345")).toBe(REDACTED);
    expect(redact("xoxb-1234567890-abcdef")).toBe(REDACTED);
    expect(redact("Authorization: Bearer abcdefgh.ijklmnop")).toContain(REDACTED);
  });

  it("同一段文本里的多处都被换掉，不是只换第一处", () => {
    const redact = redactor(["supersecretvalue"]);

    expect(redact("supersecretvalue 和 supersecretvalue")).toBe(`${REDACTED} 和 ${REDACTED}`);
  });

  it("不匹配的文本原样返回：没抹东西就是没抹", () => {
    const redact = redactor(["supersecretvalue"]);

    expect(redact("这是一句普通的话")).toBe("这是一句普通的话");
  });

  it("redactText 是同一件事的一步写法", () => {
    expect(redactText("TOKEN=supersecretvalue", ["supersecretvalue"])).toBe(`TOKEN=${REDACTED}`);
  });
});

describe("redactValue：深拷贝里逐层抹", () => {
  it("对象与数组里的字符串都被抹掉，结构保持不变", () => {
    const secrets = ["supersecretvalue"];
    const input = { a: "supersecretvalue", b: ["也在这里 supersecretvalue", 42] };

    expect(redactValue(input, secrets)).toEqual({
      a: REDACTED,
      b: [`也在这里 ${REDACTED}`, 42],
    });
  });

  it("不改入参：它是深拷贝，不是一个原地改写", () => {
    const secrets = ["supersecretvalue"];
    const input = { a: "supersecretvalue" };
    redactValue(input, secrets);

    expect(input.a).toBe("supersecretvalue");
  });

  it("非字符串的标量原样通过", () => {
    expect(redactValue({ n: 1, t: true, z: null, u: undefined })).toEqual({
      n: 1,
      t: true,
      z: null,
      u: undefined,
    });
  });

  it("不是普通对象的东西原样交出去：猜它是什么比交出去更危险", () => {
    const when = new Date(0);
    expect(redactValue({ when })).toEqual({ when });
  });

  it("循环引用不会递归到栈溢出（那种失败方式没有用处）", () => {
    const cyclic: Record<string, unknown> = { name: "supersecretvalue" };
    cyclic["self"] = cyclic;

    expect(redactValue(cyclic, ["supersecretvalue"])).toEqual({ name: REDACTED, self: REDACTED });
  });
});
