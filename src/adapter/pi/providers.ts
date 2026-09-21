/**
 * 真实 provider 的解析 —— 「`--model deepseek/deepseek-v4-flash` 该去找谁」。
 *
 * 这是本仓库唯一一处**为真实调用做准备**的代码，而且它刻意做得很薄：它只解析
 * 「用哪个 provider 的哪个模型」，然后把这个模型交给 `piModelAdapter`。
 * 真正的模型目录与凭据解析属于 SDK（`pi-coding-agent` 的 `ModelRuntime`），
 * 我们不自建一份——一份自己维护的 provider 名单会在几周内变成过期数据。
 *
 * ## 为什么它值得存在，尽管这里跑不通
 *
 * `ModelRuntime.create()` 交出的是一份带 41 个 provider 目录的 `Models`，凭据从
 * 环境或凭据库解析。于是"接真实 provider"不是一段文档，而是一条**可执行的路径**：
 * 配好凭据的那台机器上，`piModelAdapter` 收到的 `Models` 与离线模式收到的
 * 是同一个形状的参数。这正是"SDK 可替换"的最后一次应用——换 provider，
 * 调用方一行不改。
 *
 * 本机没有凭据，所以**成功路径没有被验证过**（这是步 8 就记下的局限，本步不改变它）。
 * 但失败路径是完整可测的，而且失败路径恰恰是用户最容易撞上的那两条：
 * 模型名写错、凭据没配。两条都给出可执行的下一步，而不是一句"出错了"。
 *
 * ## 它不联网
 *
 * `refreshOnCreate: false` + `allowModelNetwork: false`：目录刷新需要网络，
 * 而"能不能跑"不该取决于网络。代价是极新的模型可能不在目录里——
 * 那种情况下报错会说清"目录里这个 provider 有哪些模型"。
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model, Models } from "@earendil-works/pi-ai";

/** `provider/model` 的解析结果。 */
export interface ModelSpec {
  readonly provider: string;
  readonly model: string;
}

/**
 * `provider/model` → 两半。分不出就返回 `null`。
 *
 * 分隔符只认第一个 `/`，因为 provider 的模型 id 里可以带斜杠
 * （例如各家网关的 `vendor/name` 写法）。
 */
export function parseModelSpec(spec: string): ModelSpec | null {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

/** 解析出来的模型，以及它属于哪个 provider。 */
export interface ResolvedModel {
  readonly models: Models;
  readonly model: Model<string>;
  readonly provider: string;
  readonly modelId: string;
  /** 这个 provider 目录里已知的模型 id（有界的一小段），出错时用来提示。 */
  readonly known: readonly string[];
}

/**
 * 解析的结果。用联合类型而不是抛异常，因为"模型名写错了"不是异常，
 * 而是**一条要给用户看的消息**：CLI 把它打到 stderr 然后以用法错误退出。
 */
export type ModelResolution =
  | { readonly ok: true; readonly resolved: ResolvedModel }
  | { readonly ok: false; readonly reason: string };

/** 目录可能很大（openai 有 38 个），提示里只列前几个。 */
const HINT_LIMIT = 6;

function hint(models: readonly Model<string>[]): string {
  const ids = models.map((model) => model.id);
  if (ids.length === 0) return "（这个 provider 的目录是空的）";
  const shown = ids.slice(0, HINT_LIMIT).join(", ");
  return ids.length > HINT_LIMIT ? `${shown} 等 ${ids.length} 个` : shown;
}

/**
 * 建一份带真实 provider 目录的 `Models`。
 *
 * 分离出来单独暴露，是为了让"目录里有什么"这件事可以被直接检查——
 * 包括在测试里断言"没有凭据时它明确说不认识凭据"，而不是安静地假装就绪。
 */
export async function createEnvModels(): Promise<Models> {
  return await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
}

/**
 * `provider/model` → 一个可以真正发起调用的模型。
 *
 * 三步，顺序就是用户排查的顺序：
 *
 * 1. **语法**：`provider/model` 分不出来 → 说清格式。
 * 2. **存在**：目录里没有这个 provider 或这个模型 → 把目录里有的列出来。
 *    这一步能拦住绝大多数拼写错误，而且不需要网络。
 * 3. **凭据**：provider 认识、模型也在，但没有配置凭据 → 说清"要配什么"。
 *    它必须在**发起请求之前**报出来，否则用户会看到一次 provider 的 401，
 *    而那个 401 会被归一成 `auth` 落到事件日志里——一条本来就不该发生的失败。
 */
export async function resolveProviderModel(spec: string): Promise<ModelResolution> {
  const parsed = parseModelSpec(spec);
  if (parsed === null) {
    return {
      ok: false,
      reason: `模型名要写成 provider/model（例如 deepseek/deepseek-v4-flash），收到的是 ${JSON.stringify(spec)}`,
    };
  }

  const models = await createEnvModels();
  const provider = parsed.provider;
  const catalog = models.getModels(provider) as readonly Model<string>[];

  if (catalog.length === 0) {
    return {
      ok: false,
      reason:
        `模型目录里没有 provider ${JSON.stringify(provider)}。` +
        `目录里的 provider 有：${models
          .getModels()
          .slice(0, HINT_LIMIT)
          .map((model) => model.provider)
          .filter((id, index, all) => all.indexOf(id) === index)
          .join(", ")} …`,
    };
  }

  const model = models.getModel(provider, parsed.model) as Model<string> | undefined;
  if (model === undefined) {
    return {
      ok: false,
      reason: `provider ${provider} 不认识模型 ${JSON.stringify(parsed.model)}。它有：${hint(catalog)}`,
    };
  }

  const runtime = models as unknown as { hasConfiguredAuth?: (id: string) => boolean };
  if (typeof runtime.hasConfiguredAuth === "function" && !runtime.hasConfiguredAuth(provider)) {
    return {
      ok: false,
      reason:
        `provider ${provider} 没有配置凭据，所以这次调用发不出去。` +
        `凭据从环境变量或 SDK 的凭据库解析（不要把 key 写进这个仓库）。` +
        `想先验证整条链路，用 --model faux 跑一次离线冒烟。`,
    };
  }

  return {
    ok: true,
    resolved: {
      models,
      model,
      provider,
      modelId: parsed.model,
      known: catalog.map((candidate) => candidate.id),
    },
  };
}
