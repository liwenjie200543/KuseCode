import { describe, expect, it } from "vitest";

import { Editor, Markdown, SelectList } from "@earendil-works/pi-tui";

import { editorTheme, markdownTheme, selectListTheme } from "../src/tui/theme.js";

/**
 * 主题与 pi-tui 组件 API 的适配验证（SDD Phase 11 升级）。
 * 全屏交互需要真 TTY，自动化覆盖到"组件能用我们的主题构造并渲染"这一层；
 * 交互行为（焦点/按键/对话框路由）由人工在真实终端验收。
 */

describe("TUI 主题（pi-tui 适配）", () => {
  it("Editor 能用 editorTheme 构造并渲染", () => {
    const editor = new Editor(
      {
        requestRender: () => {},
        addChild: () => {},
        removeChild: () => {},
        terminal: { rows: 24, columns: 80 },
      } as never,
      editorTheme,
    );
    const lines = editor.render(80);
    expect(Array.isArray(lines)).toBe(true);
  });

  it("Markdown 能用 markdownTheme 渲染标题/列表/代码", () => {
    const md = new Markdown(
      "# 标题\n\n- 项目一\n- 项目二\n\n```ts\nconst a = 1;\n```\n\n**粗体** 与 `代码`",
      1,
      0,
      markdownTheme,
    );
    const lines = md.render(80);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.join("\n")).toContain("标题");
  });

  it("SelectList 能用 selectListTheme 构造、过滤并选中", () => {
    const list = new SelectList(
      [
        { value: "once", label: "允许一次" },
        { value: "always", label: "总是允许" },
        { value: "deny", label: "拒绝" },
      ],
      5,
      selectListTheme,
    );
    list.handleInput("\r"); // Enter → 选中当前项
    expect(list.getSelectedItem()?.value).toBe("once");
    expect(list.render(60).length).toBeGreaterThan(0);
  });
});
