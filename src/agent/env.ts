/**
 * Node 执行环境 —— SDK 内建工具（read/write/edit/bash）所需的 FileSystem + Shell
 * 的 node 适配。**工作区围栏住在这里**：所有路径先经 `absolutePath` 解析，
 * 解析结果落在 `cwd` 之外即拒绝——一处实现管住全部工具，与 specs/tools.md 的
 * "resolveWorkspacePath 一份实现" 是同一原则在 SDK 工具形态下的落点。
 */

import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile as fsWriteFile,
  appendFile as fsAppendFile,
  rename,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  err,
  ok,
  ExecutionError,
  FileError,
  type ExecutionEnv,
  type FileInfo,
  type FileKind,
  type Result,
  type ShellExecOptions,
} from "@earendil-works/pi-agent-core";

type FileErrorCode = ConstructorParameters<typeof FileError>[0];

function fileError(error: unknown, path: string): FileError {
  if (error instanceof FileError) return error;
  const code = (error as { code?: string }).code;
  const map: Record<string, FileErrorCode> = {
    ENOENT: "not_found",
    EPERM: "permission_denied",
    EACCES: "permission_denied",
    EISDIR: "is_directory",
    ENOTDIR: "not_directory",
    EEXIST: "unknown",
  };
  return new FileError(
    (code !== undefined && map[code] !== undefined ? map[code] : "unknown") as FileErrorCode,
    error instanceof Error ? error.message : String(error),
    path,
    error instanceof Error ? error : undefined,
  );
}

async function attempt<T>(path: string, body: () => Promise<T>): Promise<Result<T, FileError>> {
  try {
    return ok(await body());
  } catch (error) {
    return err(fileError(error, path));
  }
}

export class NodeExecutionEnv implements ExecutionEnv {
  readonly cwd: string;

  constructor(cwd: string) {
    // 围栏基准：解析后的项目根目录。
    this.cwd = resolve(cwd);
  }

  /** 围栏：解析结果必须落在 cwd 之内（拦截 `..` 与绝对路径两种写法）。 */
  private fence(path: string): string {
    const target = resolve(this.cwd, path);
    const rel = relative(this.cwd, target);
    if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
      throw new FileError(
        "permission_denied",
        `Path resolves outside project directory: ${path}`,
        target,
      );
    }
    return target;
  }

  private static async toInfo(path: string): Promise<FileInfo> {
    const info = await lstat(path);
    const kind: FileKind = info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "file";
    return {
      name: basename(path),
      path,
      kind,
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return attempt(path, async () => this.fence(path));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return attempt(parts.join(","), async () => {
      const joined = join(...parts);
      return this.fence(joined);
    });
  }

  async readTextFile(path: string): Promise<Result<string, FileError>> {
    return attempt(path, async () => readFile(this.fence(path), "utf8"));
  }

  async readTextLines(path: string, options?: { maxLines?: number }): Promise<Result<string[], FileError>> {
    return attempt(path, async () => {
      const text = await readFile(this.fence(path), "utf8");
      const lines = text.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      return options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines);
    });
  }

  async readBinaryFile(path: string): Promise<Result<Uint8Array, FileError>> {
    return attempt(path, async () => new Uint8Array(await readFile(this.fence(path))));
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    return attempt(path, async () => {
      const target = this.fence(path);
      await mkdir(dirname(target), { recursive: true });
      await fsWriteFile(target, content, "utf8");
    });
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    return attempt(path, async () => {
      const target = this.fence(path);
      await mkdir(dirname(target), { recursive: true });
      await fsAppendFile(target, content, "utf8");
    });
  }

  async renameFile(sourcePath: string, destinationPath: string): Promise<Result<void, FileError>> {
    return attempt(sourcePath, async () => {
      const from = this.fence(sourcePath);
      const to = this.fence(destinationPath);
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
    });
  }

  async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
    return attempt(path, async () => NodeExecutionEnv.toInfo(this.fence(path)));
  }

  async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
    return attempt(path, async () => {
      const target = this.fence(path);
      const names = await readdir(target);
      return Promise.all(names.map((name) => NodeExecutionEnv.toInfo(join(target, name))));
    });
  }

  async canonicalPath(path: string): Promise<Result<string, FileError>> {
    return attempt(path, async () => {
      const target = this.fence(path);
      // 双侧 realpath：存在的部分解析符号链接，不存在的前缀按词法保留——
      // symlink 逃逸（link -> /etc/hosts）在这里被拦下。
      const real = await realpath(target).catch(() => null);
      if (real !== null) {
        const realRel = relative(resolve(this.cwd), real);
        if (realRel.startsWith("..") || isAbsolute(realRel)) {
          throw new FileError("permission_denied", `Path resolves outside project directory: ${path}`, target);
        }
        return real;
      }
      // 最近的存在祖先做 realpath，其余词法拼接。
      let prefix = target;
      const tail: string[] = [];
      for (;;) {
        const parent = dirname(prefix);
        if (parent === prefix) break;
        tail.unshift(basename(prefix));
        prefix = parent;
        const real = await realpath(prefix).catch(() => null);
        if (real !== null) {
          const candidate = join(real, ...tail);
          const rel = relative(resolve(this.cwd), candidate);
          if (rel.startsWith("..") || isAbsolute(rel)) {
            throw new FileError("permission_denied", `Path resolves outside project directory: ${path}`, candidate);
          }
          return candidate;
        }
      }
      return target;
    });
  }

  async exists(path: string): Promise<Result<boolean, FileError>> {
    return attempt(path, async () => {
      this.fence(path);
      await stat(this.fence(path));
      return true;
    }).then((result) =>
      result.ok ? result : result.error.code === "not_found" ? ok(false) : result,
    );
  }

  async createDir(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>> {
    return attempt(path, async () => {
      await mkdir(this.fence(path), { recursive: options?.recursive ?? true });
    });
  }

  async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<Result<void, FileError>> {
    return attempt(path, async () => {
      await rm(this.fence(path), { recursive: options?.recursive ?? false, force: options?.force ?? false });
    });
  }

  async createTempDir(prefix?: string): Promise<Result<string, FileError>> {
    return attempt("", async () => mkdtemp(join(tmpdir(), `${prefix ?? "tmp-"}kuse-`)));
  }

  async createTempFile(options?: { prefix?: string; suffix?: string }): Promise<Result<string, FileError>> {
    return attempt("", async () => {
      const file = join(tmpdir(), `${options?.prefix ?? ""}kuse-${Date.now()}-${Math.random().toString(36).slice(2)}${options?.suffix ?? ""}`);
      const handle = await open(file, "w");
      await handle.close();
      return file;
    });
  }

  async cleanup(): Promise<void> {}

  /** Shell：spawn + 超时（秒）+ abort + 流式回调。非零退出**不是错误**（exitCode 返回）。 */
  async exec(
    command: string,
    execOptions?: ShellExecOptions,
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    const cwd = resolve(this.cwd, execOptions?.cwd ?? this.cwd);
    return new Promise((resolvePromise) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = spawn(command, {
        cwd,
        shell: true,
        env:
          execOptions?.inheritEnv === false
            ? { ...(execOptions?.env ?? {}) }
            : { ...process.env, ...(execOptions?.env ?? {}) },
        ...(execOptions?.abortSignal ? { signal: execOptions.abortSignal } : {}),
      });

      const timer =
        execOptions?.timeout === undefined
          ? null
          : setTimeout(() => {
              child.kill("SIGKILL");
            }, execOptions.timeout * 1000);

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        execOptions?.onStdout?.(text);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        execOptions?.onStderr?.(text);
      });

      const finish = (error: ExecutionError | null, exitCode: number): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (error !== null) resolvePromise(err(error));
        else resolvePromise(ok({ stdout, stderr, exitCode }));
      };

      child.on("error", (error) => {
        const aborted = execOptions?.abortSignal?.aborted === true;
        finish(
          new ExecutionError(
            aborted ? "aborted" : "spawn_error",
            error.message,
            error,
          ),
          -1,
        );
      });
      child.on("close", (code, signal) => {
        if (signal !== null && signal !== undefined) {
          const aborted = execOptions?.abortSignal?.aborted === true;
          finish(
            new ExecutionError(
              aborted ? "aborted" : "unknown",
              `进程被 ${signal} 终止`,
            ),
            -1,
          );
          return;
        }
        finish(null, code ?? -1);
      });
    });
  }
}
