import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The first invariant of this repository: the Agent Core must be runnable with
// a fake model and fake tools, without a process, database, network or UI.
// That is only true while the Core has no runtime dependencies at all.
// Every external integration arrives later as an adapter behind a port, and it
// must be justified by a step in the development sequence.
//
// 步 8 改了这条断言，而改法本身就是一句结论：**"零依赖"变成了"恰好一个依赖，
// 而且它被关在一个目录里"。** 原来那条（`dependencies` 必须是 `undefined`）在
// 步 8 之后会说谎——我们确实依赖 Pi Agent SDK 了。但它真正要守的东西没变：
// 依赖必须少、必须被指名、必须钉死版本、必须只出现在适配器目录里。
// 所以断言换成了四条更具体的，最后一条由下面的扫描负责。
describe("dependency posture", () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as Record<string, unknown>;

  it("运行时依赖恰好是那两个被钉死的 SDK 包", () => {
    const deps = (pkg["dependencies"] ?? {}) as Record<string, string>;
    expect(Object.keys(deps).sort()).toEqual([
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
    ]);
  });

  it("SDK 版本是精确的，不是一个范围", () => {
    const deps = (pkg["dependencies"] ?? {}) as Record<string, string>;
    for (const [name, range] of Object.entries(deps)) {
      // `install latest` 会当场让 Skill 里那份 API 映射表失效（版本基线 0.84.2）
      expect(range, `${name} 必须钉死版本`).toMatch(/^\d+\.\d+\.\d+$/);
    }
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
//
// 步 8 的追加：第 2 条放宽到了 `src/tools`。那不是妥协，而是这条边界本来就该有的
// 形状——"I/O 只准住在存储层"说的其实是**语义层不许有 I/O**。真实工具是"材料从哪来"
// 的答案，它去读文件系统是它的职责本身；而 Runtime 仍然是零 I/O 的（第 1 条没动）。
// 所以放宽的是"谁的职责就是碰世界"，收紧的是核心语义——方向恰好相反的两件事。
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

  it("src/ 下面所有 node: 引用都落在允许碰外部世界的目录里", () => {
    const outside: string[] = [];
    for (const file of files) {
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        if (!spec.startsWith("node:")) continue;
        const relative = file.slice(repoRoot.length).replace(/\\/g, "/");
        // `src/store`：事件的载体（步 7）
        // `src/tools`：真实工具真的去读文件系统（步 8）——它就是"材料从哪来"的答案
        // `src/cli`：产品面就是进程本身（步 9）——它读 argv、写 stdout、接 SIGINT
        if (
          relative.startsWith("src/store/") ||
          relative.startsWith("src/tools/") ||
          relative.startsWith("src/cli/")
        ) {
          continue;
        }
        outside.push(`${relative} → ${spec}`);
      }
    }
    expect(outside, "只有 src/store、src/tools 与 src/cli 可以碰 node: 内置模块").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 步 9 的那条边界：**产品面在最上面，没人可以回头 import 它。**
//
// "CLI 在上面"这句话如果只写在分层图里，它会在第一次图方便的时候失效——
// 比如 Runtime 想"顺手"读一下 `process.env`，或者 Core 想借 CLI 的渲染函数
// 打印点什么。那一次改动不会报错，只会把最下面那层的纯度作废，
// 而"Core 能在没有进程的情况下跑完"就不再成立了。
//
// 所以这条检查拦的是**方向**，不是位置：`src/cli` 可以 import 任何人，
// 而任何人都不许 import `src/cli`。它与"SDK 只准住在 src/adapter"是一对——
// 一条管外来的东西不能进去，一条管上面的东西不能被拉下去。
// ---------------------------------------------------------------------------
describe("产品面在最上面：下面各层不许回头 import 它", () => {
  // 扫描范围是**被点名的六层**，不是整个 `src/`。
  //
  // 差别在根目录那个 `src/index.ts`：它是包的公共出口，职责恰恰是把所有东西
  // （包括 CLI）聚合起来再交出去。把它算进来，这条检查就变成了"谁也不许导出 CLI"，
  // 那是另一条规矩，而且是错的。要守的是**方向**——层里的人不能回头望，
  // 站在最上面的出口不算"下面某一层"。
  const layers = ["core", "runtime", "store", "tools", "adapter", "testing"];

  it("src/{core,runtime,store,tools,adapter,testing} 里没有任何一条 import 指向 src/cli", () => {
    const offenders: string[] = [];
    for (const layer of layers) {
      for (const file of listTsFiles(join(srcDir, layer))) {
        const relative = file.slice(repoRoot.length).replace(/\\/g, "/");
        for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
          const target = spec.startsWith(".")
            ? resolve(dirname(file), spec)
            : spec;
          if (typeof target === "string" && /[\\/]cli[\\/]/.test(target)) {
            offenders.push(`${relative} → ${spec}`);
          }
        }
      }
    }
    expect(offenders, "src/cli 是最上面那一层，它不能被下面的任何一层 import").toEqual([]);
  });

  it("bin/ 只 import dist 与 node: 内置模块", () => {
    for (const name of readdirSync(join(repoRoot, "bin"))) {
      const file = join(repoRoot, "bin", name);
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        const ok = spec.startsWith("node:") || spec.startsWith("../dist/");
        expect(ok, `bin/${name} 只该 import dist 或 node: 内置模块，发现：${spec}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 步 8 的那条铁律：**SDK 只准出现在 src/adapter 里。**
//
// "把 SDK 挡在端口后面"这句话，如果没有一条可执行的检查，就只是一张架构图。
// 这条检查比"不许 import node: 内置模块"更强，因为它拦的是**所有裸包名**：
//
//   - `src/core` 与 `src/runtime` 里出现任何裸包名都算越界——不只是 SDK。
//     一个 `import { z } from "zod"` 同样会把第三方形状带进 Core 的语义里，
//     而 Core 的词汇应该是我们自己推导出来的，不是借来的。
//   - 相对路径也必须留在 src 之内（不许 `../../node_modules/...` 这种绕法）。
//
// 反过来说：如果这条测试是绿的，那么"删掉整个 src/adapter 目录，Core 与 Runtime
// 仍然编译、仍然跑得完假模型"就成立——这才是"SDK 可替换"的可执行含义。
// ---------------------------------------------------------------------------
describe("SDK 只住在适配器里", () => {
  const guarded: ReadonlyArray<readonly [string, string]> = [
    ["src/core", "Core"],
    ["src/runtime", "Runtime"],
  ];

  it("has files to check", () => {
    for (const [dir] of guarded) {
      expect(listTsFiles(join(repoRoot, dir)).length, dir).toBeGreaterThan(0);
    }
  });

  for (const [dir, label] of guarded) {
    it(`${label}（${dir}）不 import 任何包：没有 SDK，也没有别的第三方`, () => {
      for (const file of listTsFiles(join(repoRoot, dir))) {
        for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
          const relative = file.slice(repoRoot.length);
          expect(spec.startsWith("."), `${relative} 引用了包：${spec}`).toBe(true);
          expect(
            resolve(dirname(file), spec).startsWith(srcDir),
            `${relative} 越出了 src：${spec}`,
          ).toBe(true);
        }
      }
    });
  }

  it("没有任何一个 SDK 的 import 落在 src/adapter 之外", () => {
    const sdk = /^@earendil-works\//;
    const outside: string[] = [];
    for (const file of listTsFiles(srcDir)) {
      if (file.slice(repoRoot.length).replace(/\\/g, "/").startsWith("src/adapter/")) continue;
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        if (sdk.test(spec)) outside.push(`${file.slice(repoRoot.length)} → ${spec}`);
      }
    }
    expect(outside, "只有 src/adapter 可以 import SDK").toEqual([]);
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
