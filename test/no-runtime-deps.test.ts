import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The first invariant of this repository: the Agent Core must be runnable with
// a fake model and fake tools, without a process, database, network or UI.
// That is only true while the Core has no runtime dependencies at all.
// Every external integration arrives later as an adapter behind a port, and it
// must be justified by a step in the development sequence.
describe("dependency posture", () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as Record<string, unknown>;

  it("declares no runtime dependencies", () => {
    expect(pkg["dependencies"]).toBeUndefined();
  });

  it("requires Node 22 or newer", () => {
    expect((pkg["engines"] as Record<string, string>)["node"]).toBe(">=22");
  });
});

// ---------------------------------------------------------------------------
// 本文件是唯一允许碰 Node 内置模块的地方：它是一台扫描仪，不是被扫描的对象。
// 扫描仪在这里，被扫描的纯度约束在下面两个 describe 里——其中一个扫描的是
// test/core-loop.test.ts 本身：那个测试必须只 import vitest / core / testing。
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const srcDir = join(repoRoot, "src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** 抽出源码里所有模块引用：静态、副作用、动态、require。 */
function importSpecifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const specs: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1];
      if (spec !== undefined) specs.push(spec);
    }
  }
  return specs;
}

// ---------------------------------------------------------------------------
// 假适配器和 Core 一样必须是零依赖的。
// 它们是「Core 能在没有进程、网络、数据库的情况下跑完」这句话的**载体**：
// 假适配器一旦开始碰 node:fs，这句话就只剩口头承诺了。
// ---------------------------------------------------------------------------
describe("fake adapters stay as pure as the Core", () => {
  const teams: ReadonlyArray<readonly [string, string]> = [
    ["src/core", "Core"],
    ["src/testing", "假适配器"],
  ];

  it("has files to check", () => {
    for (const [dir] of teams) {
      expect(listTsFiles(join(repoRoot, dir)).length, dir).toBeGreaterThan(0);
    }
  });

  for (const [dir, label] of teams) {
    it(`${label}（${dir}）不引用 node: 内置模块、不引用任何包`, () => {
      for (const file of listTsFiles(join(repoRoot, dir))) {
        for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
          const relative = file.slice(repoRoot.length);
          expect(spec.startsWith("node:"), `${relative} 引用了 Node 内置模块：${spec}`).toBe(false);
          expect(spec.startsWith("."), `${relative} 引用了包：${spec}`).toBe(true);
          expect(
            resolve(dirname(file), spec).startsWith(srcDir),
            `${relative} 越出了 src：${spec}`,
          ).toBe(true);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 循环测试的纯度。
// 「Core 在没有进程、网络、数据库的情况下跑完」这句话的证据是 test/core-loop.test.ts，
// 而它的证明力取决于它自己引用了什么：只要它 import 了 node:fs 或某个 SDK 客户端，
// 它证明的就不再是 Core 的纯度，而是「测试环境里什么都有」。
// ---------------------------------------------------------------------------
describe("the loop test needs nothing but the Core and the fake adapters", () => {
  const loopTest = join(repoRoot, "test", "core-loop.test.ts");

  it("只 import vitest / core / testing，且不 import 任何 node: 内置模块", () => {
    const specs = importSpecifiers(readFileSync(loopTest, "utf8"));
    expect(specs.length).toBeGreaterThan(0);

    for (const spec of specs) {
      const allowed =
        spec === "vitest" || spec.startsWith("../src/core/") || spec.startsWith("../src/testing/");
      expect(allowed, `test/core-loop.test.ts 只允许 import vitest / core / testing，发现：${spec}`).toBe(
        true,
      );
      expect(spec.startsWith("node:"), `test/core-loop.test.ts 引用了 Node 内置模块：${spec}`).toBe(
        false,
      );
    }
  });
});
