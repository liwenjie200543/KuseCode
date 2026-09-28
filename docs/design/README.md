# Design 约定

本次重构遵循"文档轻量"原则（goals §二/§十七）：

- **每个 Feature 一个文档**，Spec + Design + Tasks 合并在 `docs/specs/<feature>.md` 内
  ——不为小功能单独开 design/ 或 tasks/ 文件。
- `docs/specs/architecture.md` 是主文档：现状审计、目标架构、迁移映射、代码量预算。
- 实施进度以 **Git 历史 + `docs/tasks/roadmap.md` 的勾选**为准，不另写周报式文档。
- 历史文档（`docs/02-11`、`docs/sdd/`、`docs/wiki` 类）是旧定位的开发记录，在
  Phase 15 统一归档/精简，不在本次重构中维护。
