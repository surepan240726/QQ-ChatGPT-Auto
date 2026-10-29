#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const sourcePath = path.join(root, "src", "QQ-ChatGPT-Auto.js");
const source = fs.readFileSync(sourcePath, "utf8");
const failures = [];

function requireText(text, label) {
  if (!source.includes(text)) failures.push("缺少：" + label);
}

function forbidText(text, label) {
  if (source.includes(text)) failures.push("仍包含：" + label);
}

requireText('var VERSION = "v0.6.10";', "v0.6.10 版本号");
requireText('ownerNickname: "请填写你的QQ昵称"', "公开版昵称占位符");
requireText("只有最新消息明确@GPT-6A/GPT/ChatGPT时", "@ 才强制回复的规则");
requireText("mergeQqEmojiItems", "emoji 文字合并");
requireText("startsWithNoReplyMarker", "NR 本地过滤");
requireText("qq_chatgpt_per_chat_v0610", "分聊天记忆存储");

[
  ["enableImageRecognition", "图片识别开关"],
  ["sendChatGptImagePrompt", "图片提示发送函数"],
  ["clickChatGptAttach", "图片附件函数"],
  ["findLatestQqVisualCandidate", "图片候选识别函数"],
  ["saveQqVisualSnapshot", "图片截图缓存函数"],
  ["visualCacheDir", "图片缓存目录"],
  ["当前临时关闭图片识别", "临时图片提示"],
  ["当前只处理QQ群聊", "只处理群聊提示"],
].forEach(([text, label]) => forbidText(text, label));

const stripped = source.replace(/ui\.layout\(\s*<vertical[\s\S]*?\n\);/, "ui.layout(null);");
try {
  new Function(stripped);
} catch (error) {
  failures.push("JavaScript 语法检查失败：" + error.message);
}

if (failures.length) {
  console.error(failures.map((x) => "- " + x).join("\n"));
  process.exit(1);
}

console.log("v0.6.10 静态检查通过");

