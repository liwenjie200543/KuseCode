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
// 存储是唯一允许碰磁盘的地方。
//
// 步 7 把「事件的载体」搬进了仓库（JSONL 文件），于是多了一条必须守住的边界：
// **Runtime 的语义里没有 I/O。** 回放从事件重建状态、预算执法、事件排序——这些
// 都是纯粹的推导，它们一旦自己去读文件，「同一个日志重建出同一个状态」就取决于
// 磁盘上那一刻有什么了。所以：
//
//   1. src/runtime 与 Core 一样，零 node: 引用；
//   2. src/ 下面所有 node: 引用都落在 src/store 里（边界从另一侧也成立）。
//
// 这两条都曾经是真的（步 3~6 的 runtime 一行 I/O 都没有），这一步只是把它变成
// 可执行的约束，而不是一句会慢慢失效的描述。
// ---------------------------------------------------------------------------
describe("I/O 只住在存储层", () => {
  const files = listTsFiles(srcDir);

  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("src/runtime 里没有一行 I/O：Runtime 的语义与它的载体分开", () => {
    for (const file of listTsFiles(join(repoRoot, "src", "runtime"))) {
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        const relative = file.slice(repoRoot.length);
        expect(spec.startsWith("node:"), `${relative} 引用了 Node 内置模块：${spec}`).toBe(false);
      }
    }
  });

  it("src/ 下面所有 node: 引用都在 src/store 里", () => {
    const outside: string[] = [];
    for (const file of files) {
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        if (!spec.startsWith("node:")) continue;
        if (file.slice(repoRoot.length).replace(/\\/g, "/").startsWith("src/store/")) continue;
        outside.push(`${file.slice(repoRoot.length)} → ${spec}`);
      }
    }
    expect(outside, "只有 src/store 可以碰 node: 内置模块").toEqual([]);
  });
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
