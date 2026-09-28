# Spec + Design + Tasks：TUI

## Spec

用 `pi-tui` 组合（不手写 ANSI 屏幕）。TUI 只做六件事，**零 Agent 逻辑**：

```text
Input（多行编辑、历史、斜杠自动补全）
Output / Streaming（token 级直播；终态消息渲染为 Markdown）
Tool Display（● bash npm test → ✓ exit 0 · 2.4s；edit 的 diff 预览）
Permission Prompt（居中对话框：Allow once / Always allow this pattern / Deny）
Progress（◐ thinking…、运行中工具计数）
Session（/new /resume /sessions；状态栏：model · cwd · ctx ~Nk）
```

结构：AltScreen → ScrollView(transcript) → [Loader, Editor, StatusBar]。
订阅 Agent 事件流映射到组件；组件变更后显式 `requestRender()`。

斜杠命令（第一版）：`/help /new /clear /resume /sessions /model /skills /mcp /compact /exit`。
Ctrl+C：生成中 = abort，空闲时两次退出；Esc = abort。

## Tasks

- [ ] `tui/app.ts` + transcript/tool-view/status-bar/permission-dialog（Phase 11）
- [ ] 斜杠命令 + 键位 + pty 冒烟测试（Phase 11）
