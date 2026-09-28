# Spec + Design + Tasks：Coding Tools

## Spec

统一接口（不抽象更多）：

```ts
export interface Tool<P = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JsonObjectSchema;        // SDK 用它校验参数
  risk: "safe" | "confirm";            // permissions/ 消费
  execute(args: P, ctx: ToolContext): Promise<ToolOut>;   // ToolOut = { content, details? }
}
```

七个工具（全部手写、只依赖 node: 内置模块，每个尽量 ≤ 100 行）：

| 工具 | risk | 行为要点 |
|---|---|---|
| `read` | safe | 行号、offset/limit 窗口、二进制探测 |
| `write` | confirm | 建父目录、回报 `+a -d` 统计 |
| `edit` | confirm | 精确匹配替换；0 命中/多命中（无 replaceAll）即失败；返回统一 diff |
| `bash` | confirm | 超时 + abort + SIGKILL 升级；头尾保留输出（100KB 上限） |
| `grep` | safe | JS 正则按行扫文本文件；`include` glob；跳过 node_modules/.git/二进制 |
| `find` | safe | glob（`**` 跨目录），相对路径排序输出 |
| `ls` | safe | 类型标记 + 大小，目录优先 |

- **路径围栏**：所有路径参数经 `resolveWorkspacePath`（resolve + 双侧 realpath），
  symlink 逃逸报模型可读错误。围栏一个文件一份实现（`tools/paths.ts`）。
- diff 只做"edit 的统一 diff 预览"一个用途，不引依赖。
- 错误即内容：`execute` 抛出的异常被 registry 包成 `isError` 结果，模型看到一句话。

## Tasks

- [ ] `tools/registry.ts`（Map + 重名即抛）+ `paths.ts` + `diff.ts`（Phase 4）
- [ ] read / ls / grep / find（Phase 4）
- [ ] write / edit / bash（Phase 4）
- [ ] 每个工具至少 2 个单测（正常 + 越界/失败）（Phase 4）
