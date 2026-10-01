/**
 * KuseCode 的 pi-tui 主题 —— 三套接口（Editor/Markdown/SelectList）共用一份
 * ANSI 配色。全部字段是 (text) => string 的着色函数，深浅由终端自己解释。
 */

import type { EditorTheme } from "@earendil-works/pi-tui/dist/components/editor.js";
import type { MarkdownTheme } from "@earendil-works/pi-tui/dist/components/markdown.js";
import type { SelectListTheme } from "@earendil-works/pi-tui/dist/components/select-list.js";

const wrap =
  (open: string, close = "\x1b[0m") =>
  (text: string): string =>
    text.length > 0 ? `${open}${text}${close}` : text;

const dim = wrap("\x1b[2m");
const cyan = wrap("\x1b[36m");
const green = wrap("\x1b[32m");
const red = wrap("\x1b[31m");
const yellow = wrap("\x1b[33m");
const bold = wrap("\x1b[1m");
const underline = wrap("\x1b[4m");
const strikethrough = wrap("\x1b[9m");
const italic = wrap("\u001b[3m");
const magenta = wrap("\x1b[35m");

export const markdownTheme: MarkdownTheme = {
  heading: (text) => bold(cyan(text)),
  link: (text) => underline(text),
  linkUrl: (text) => dim(text),
  code: (text) => yellow(text),
  codeBlock: (text) => dim(text),
  codeBlockBorder: (text) => dim(text),
  quote: (text) => dim(text),
  quoteBorder: (text) => dim(text),
  hr: (text) => dim(text),
  listBullet: (text) => cyan(text),
  bold: (text) => bold(text),
  italic: (text) => italic(text),
  strikethrough: (text) => strikethrough(text),
  underline: (text) => underline(text),
};

export const editorTheme: EditorTheme = {
  borderColor: (text) => dim(text),
  selectList: {
    selectedPrefix: (text) => cyan("❯ ") + text,
    selectedText: (text) => bold(cyan(text)),
    description: (text) => dim(text),
    scrollInfo: (text) => dim(text),
    noMatch: (text) => red(text),
  } satisfies SelectListTheme,
};

export const selectListTheme: SelectListTheme = editorTheme.selectList;

export const statusColors = {
  dim,
  cyan,
  green,
  red,
  yellow,
  bold,
  magenta,
};
