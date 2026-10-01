# Spec + Design + Tasks：TUI

## Spec

用 pi-tui 组件系统实现**全屏交互界面**（alternate screen + 差量渲染）。TUI 只做六件事，零 Agent 逻辑：

```text
Input（Editor：多行输入、历史导航、Enter 提交）
Output / Streaming（assistant 流式文本 → 定型为 Markdown）
Tool Display（● bash … → ✓/✗ 状态翻转）
Permission Prompt（overlay + SelectList：允许一次 / 总是允许 / 拒绝）
Progress（Loader "thinking…" 动画）
Session（/new /resume /sessions）
```

## Design

```text
TuiAltScreen（alt buffer + 差量渲染）
└── VStack
    ├── ScrollView(transcript)   follow:"end"，Markdown 消息 + 工具行
    ├── statusText               状态行（model · tokens）
    ├── Loader                   运行中动画
    └── Editor                   焦点组件
```

- 事件映射（Harness.onEvent 的纯渲染消费）：message_update → 流式 Text；
  message_end(assistant) → 定型 Markdown；tool_execution_start/end → 工具行翻转；
- 权限：showOverlay(SelectList) + addInputListener 路由按键（consume）；
- 键位：Enter 提交 · Ctrl+C 中断（空闲时退出）· Esc 中断；
- 主题：src/tui/theme.ts 一份 ANSI 配色满足 Editor/Markdown/SelectList 三套接口；
- 会话：/new 重建 Harness；/resume 用 bootstrap 的 resume 参数灌回历史。

## Tasks

- [x] theme.ts + 全屏布局（Phase 11 升级）
- [x] 事件映射 + 权限 overlay + 斜杠命令（Phase 11）
- [x] 主题/组件适配单测（Editor/Markdown/SelectList 用我们的主题构造并渲染）
- [x] 交互行为（焦点/按键流）人工在真实终端验收
