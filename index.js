// index.js — Edward（35歳アメリカ人ニュースアナウンサー版）

import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* ========= System Setup ========= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

/* ========= LINE ========= */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(config);

/* ========= OpenAI ========= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ========= Supabase ========= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

/* ========= Character: Edward ========= */
const SYSTEM_PROMPT = `
あなたは Edward（エドワード）です。
35歳のアメリカ人男性。職業はニュースアナウンサー。
とても穏やかで礼儀正しい英会話パートナーとして話してください。

返信は必ずこの3点セットで返すこと：

1. 英文メッセージ
2. 日本語訳
3. 音声（OpenAI TTS, voice="alloy"）

英文は短めで自然な日常会話にしてください。
`;

/* ========= Utility: Save message to Supabase ========= */
async function saveMessage(userId, role, content, type = "text") {
  await supabase.from("edward_messages").insert([
    { user_id: userId, role, content, type },
  ]);
}

/* ========= Generate Edward's Response ========= */
async function generateResponse(userId, userText) {
  await saveMessage(userId, "user", userText, "text");

  const ai = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userText },
    ],
  });

  const english = ai.choices[0].message.content.trim();
  const japanese = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "以下の英文を自然な日本語に翻訳してください。" },
      { role: "user", content: english },
    ],
  });

  const jp = japanese.choices[0].message.content.trim();

  /* ==== Generate TTS Audio ==== */
  const audio = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: english,
    format: "mp3",
  });

  const audioBuffer = Buffer.from(await audio.arrayBuffer());

  // 保存パス
  const fileName = `edward_${Date.now()}.mp3`;
  const filePath = path.join(__dirname, fileName);
  fs.writeFileSync(filePath, audioBuffer);

  /* ==== Supabase Upload ==== */
  const audioUpload = await supabase.storage
    .from("edward-audio")
    .upload(fileName, audioBuffer, {
      contentType: "audio/mpeg",
      upsert: false,
    });

  const audioUrl =
    supabase.storage.from("edward-audio").getPublicUrl(fileName).data.publicUrl;

  await saveMessage(userId, "assistant", english, "text");

  return {
    english,
    japanese: jp,
    audioUrl,
  };
}

/* ========= LINE Webhook (VERY IMPORTANT) ========= */
app.post("/callback", line.middleware(config), async (req, res) => {
  const events = req.body.events;

  for (const event of events) {
    if (event.type !== "message") continue;

    const userId = event.source.userId;

    /* ========== Text Message ========== */
    if (event.message.type === "text") {
      const userText = event.message.text;
      const reply = await generateResponse(userId, userText);

      await lineClient.replyMessage(event.replyToken, [
        { type: "text", text: reply.english },
        { type: "text", text: reply.japanese },
        {
          type: "audio",
          originalContentUrl: reply.audioUrl,
          duration: 5000,
        },
      ]);
    }

    /* ========== Audio Message ========== */
    if (event.message.type === "audio") {
      const buffer = await lineClient.getMessageContent(event.message.id);
      const audio = Buffer.from(await buffer);

      const transcript = await openai.audio.transcriptions.create({
        model: "gpt-4o-mini-transcribe",
        file: audio,
      });

      const text = transcript.text;
      const reply = await generateResponse(userId, text);

      await lineClient.replyMessage(event.replyToken, [
        { type: "text", text: reply.english },
        { type: "text", text: reply.japanese },
        {
          type: "audio",
          originalContentUrl: reply.audioUrl,
          duration: 5000,
        },
      ]);
    }
  }

  res.status(200).end();
});

/* ========= Start Server ========= */
app.listen(10000, () => {
  console.log("Edward AI is running on port 10000");
});
