# Spec + Design + Tasks：Permission

## Spec

三种裁决，一个入口，没有更多：

```ts
type Verdict = { action: "allow" | "deny"; reason: string } | { action: "ask" };
```

- 工具只声明 `risk: "safe" | "confirm"`；bash 的命令文本经**风险分类器**细分：
  `safe`（git status/npm test/cat…）、`confirm`（npm install/mkdir/重定向…）、
  `destructive`（rm -rf、sudo、管道进 shell）→ 直接 deny。
- 决策顺序（固定）：硬拒绝（destructive）→ allow → 已记住的 "always allow" 模式
  → `permissionMode==="auto"`（测试/CI）→ **询问回调**（TUI 对话框；无回调则安全拒绝）。
- 交互面只提供一个 `prompt(request): Promise<"once"|"always"|"deny">` 接口，
  TUI 与 headless 各自实现（headless 默认 deny）。

## Design

`permissions/manager.ts`（~90 行）+ `permissions/classifier.ts`（~80 行，按 `&&`/`;`/`|`
分段判定）+ `permissions/rules.ts`（~40 行：safe 工具放行、confirm 工具走询问）。
无 RBAC、无规则语言、无继承。

## Tasks

- [ ] classifier + rules + manager + 单测（含硬拒绝不可被 auto 覆盖）（Phase 5）
