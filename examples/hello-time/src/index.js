// index.js — hello-time 插件入口。
// DSH 插件的四个导出，一个都不能少（参见第 2 课）：
//   name / inject / Config / apply
import z from "@deepseek-ai/schemastery";

export const name = "hello-time";
export const inject = ["tools"]; // 需要 tools 服务（注册工具要用它）

// ---- ③ 配置层：schemastery Schema，每个字段都带默认值 → 开箱即用 ----
export const Config = z.object({
  enable: z.boolean().default(true),
  greeting: z.string().default("你好"),
});

// 一个纯函数：把时间格式化成人类友好的句子。
// 插件里尽量把"逻辑"拆成这种可单测的纯函数（第 6.5 课写测试时直接测它）。
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function nowText(now = new Date(), greeting = "你好", style = "short") {
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  var time = `${hh}:${mm}`
  if (style === "long") {
    time = `${hh}:${mm}:${ss}`
  }
  return `${greeting}！现在是 ${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} 星期${WEEKDAYS[now.getDay()]} ${time}（本机时间）。`;
}

// ---- ④ 插件本体：激活时执行一次，之后全靠这里注册的回调 ----
export function apply(ctx, config) {
  if (config.enable === false) return; // 用户关掉了 → 什么都不做

  // 耳朵 1：会话开始 → 注入时间提示（第 3 课事件表第 1 行）
  ctx.on("agent/session-start", async (agent, next) => {
    const out = await next(); // 先让宿主走完原流程（中间件礼貌）
    try {
      const text = nowText(new Date(), config.greeting);
      if (typeof agent?.inject === "function") agent.inject(`[hello-time] ${text}`);
    } catch { /* 提示失败不该弄崩宿主 */ }
    return out;
  });

  // 手：注册 hello_now 工具（第 4 课的四件套：name/description/parameters/output）
  ctx.tools.register({
    name: "hello_now",
    // description 是写给"模型"的说明书——它据此决定何时调用你
    description:
      "Report the current local date, time and weekday. Use when the user asks what time it is now.",
    // parameters：严格 JSON Schema，required 只出现在顶层
    parameters: {
      type: "object",
      properties: {
        timezone_note: {
          type: "string",
          description: "Optional note about which timezone the user means",
        },
        style: {
          type: "string",
          description: "Optional, pass 'long' return format will contains seconds, else don't contains seconds"
        }
      },
      required: [],
      additionalProperties: false,
    },
    // output 契约：schema 描述 execute 的返回值；render 负责展示
    output: {
      schema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    // execute：直接返回数据对象，不要包 { content: [...] }
    async execute(args) {
      return { text: nowText(new Date(), config.greeting, args.style)};
    },
  });
}
