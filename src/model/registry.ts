/**
 * 模型注册表 —— provider 目录 + 凭据解析 + 离线 mock 的唯一入口。
 *
 * 目录来自 pi-ai 的生成目录（`builtinProviders()`），不自建名单：
 * 自己维护的 provider 名单会在几周内变成过期数据。凭据从环境解析
 * （各 provider 的 auth 语义由 SDK 定义），绝不写进代码或日志。
 */

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Context,
  type FauxProviderHandle,
  type Model,
} from "@earendil-works/pi-ai";
// 内置 provider 目录在 providers/all 子路径（主入口不导出目录，只导出类型与工具）。
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export interface ResolvedModel {
  readonly model: Model<string>;
  /** `provider/model` 形式，给展示与事件日志用。 */
  readonly name: string;
}

export interface ModelRegistry {
  readonly models: ReturnType<typeof createModels>;
  /** 注册离线剧本 provider（测试与 `--model faux`）。 */
  enableMock(): FauxProviderHandle;
  /**
   * 解析 `provider/model`；`null` = 未指定，取第一个凭据已配置的模型。
   * 解析失败抛带可操作信息的 Error（模型名写错 / 凭据没配）。
   */
  resolve(spec?: string | null): Promise<ResolvedModel>;
}

export function createModelRegistry(): ModelRegistry {
  const models = createModels();
  for (const provider of builtinProviders()) models.setProvider(provider);
  let mock: FauxProviderHandle | null = null;

  return {
    models,

    enableMock() {
      mock = fauxProvider();
      models.setProvider(mock.provider);
      // 默认剧本：回显最后一条 user 消息。离线冒烟要的是"链路通了"，
      // 不是聪明的回答；真剧本（走工具的离线任务）在 e2e 里显式注入。
      mock.setResponses([
        (context: Context) =>
          fauxAssistantMessage(`(mock) 收到：${lastUserText(context)}`),
      ]);
      return mock;
    },

    async resolve(spec) {
      if (spec !== null && spec !== undefined && spec !== "mock") {
        const slash = spec.indexOf("/");
        const provider = slash > 0 ? spec.slice(0, slash) : undefined;
        const id = slash > 0 ? spec.slice(slash + 1) : spec;
        const model = provider !== undefined ? models.getModel(provider, id) : undefined;
        if (model !== undefined) {
          const auth = await models.checkAuth(model.provider);
          if (auth !== undefined) return { model, name: `${model.provider}/${model.id}` };
          throw new Error(
            `provider ${model.provider} 的凭据没有配置：设置它的 API key 环境变量后重试` +
              `（或者用 --model mock 离线冒烟）`,
          );
        }
        const known = models
          .getModels()
          .filter((candidate) => candidate.id === id)
          .map((candidate) => candidate.provider);
        throw new Error(
          known.length > 0
            ? `模型 ${id} 属于 provider：${known.join(", ")}。用 provider/model 的写法，例如 ${known[0]}/${id}`
            : `模型 ${spec} 不在目录里。用 provider/model 的写法；离线冒烟用 --model mock`,
        );
      }

      // mock 已注册时优先它（离线路径必须确定性地走到 faux，不能被
      // 某个恰好有环境凭据的真实 provider 抢走）。
      if (mock !== null) {
        const model = mock.getModel();
        return { model, name: `faux/${model.id}` };
      }
      if (spec === "mock") {
        throw new Error("mock 模型未启用：这是内部错误（enableMock 应先于 resolve 调用）");
      }
      // 未指定：第一个凭据已配置的模型。
      const available = await models.getAvailable();
      const first = available[0];
      if (first !== undefined) return { model: first, name: `${first.provider}/${first.id}` };
      throw new Error(
        "没有已配置凭据的 provider。设置任一 provider 的 API key 环境变量，" +
          "或者用 --model mock 离线冒烟。",
      );
    },
  };
}


function lastUserText(context: Context): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message === undefined || message.role !== "user") continue;
    const content = (message as { content: unknown }).content;
    if (typeof content === "string") return content.slice(0, 200);
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : ""))
        .join(" ")
        .slice(0, 200);
    }
  }
  return "(no user text)";
}
