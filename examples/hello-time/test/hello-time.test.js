// hello-time.test.js — 第 6.5 课：插件的第一个测试。
// 关键认知：不启动宿主、不安装插件，直接 import 纯函数来测。
// nowText() 之所以能这样测，是因为第 6 课把它从 apply() 里拆了出来。
import { test } from "node:test";
import assert from "node:assert/strict";
import { nowText } from "../src/index.js";

// 用一个固定的"假现在"——测试永远不要依赖真实时钟（否则每次跑结果都变）。
const T = new Date("2026-10-22T12:08:35"); // 2026-10-22 是星期四

test("默认问候 + HH:mm 格式（不带秒）", () => {
  assert.equal(nowText(T), "你好！现在是 2026-10-22 星期四 12:08（本机时间）。");
});

test("自定义问候语可透传", () => {
  assert.ok(nowText(T, "早上好").startsWith("早上好！现在是"));
});

test("个位数月份/小时/分钟补零到两位", () => {
  const t = new Date("2026-03-05T09:05:00"); // 星期四？不，2026-03-05 是星期四——由断言验证
  const out = nowText(t);
  // 只断言我们关心的格式部分：03-05 与 09:05
  assert.ok(out.includes("2026-3-5"), `日期用原样数字: ${out}`);
  assert.ok(out.includes("09:05"), `时间补零: ${out}`);
});

// ---- 作业验收用例：style === "long" 时应带秒（第 6 课作业） ----
// 当前实现还没把 ss 接进模板 → 这个测试应当【失败】，
// 修复 nowText 后它变绿。这就是"测试先行"的最小循环。
test('style:"long" 返回 HH:mm:ss 带秒', () => {
  const out = nowText(T, "你好", "long");
  assert.ok(out.includes("12:08:35"), `应包含带秒时间 12:08:35，实际: ${out}`);
});

test("style 传其他值/不传 → 保持 HH:mm 不带秒", () => {
  assert.ok(!nowText(T, "你好", "short").includes("12:08:35"));
  assert.ok(!nowText(T).includes("12:08:35"));
});
