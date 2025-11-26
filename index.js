// index.js — Edward（AI英会話 LINE版）
// ────────────────────────────────
// ✔ テキスト & 音声入力両対応
// ✔ 英文・日本語訳・音声の3点セット返信
// ✔ Supabase へのログ保存
// ✔ 音声(mp3)を Supabase Storage に保存
// ✔ LINE 署名検証エラー対策済み（express.json位置調整）
// ✔ Supabase v2 対応 createClient（authオプション付き）
// ────────────────────────────────

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

/* ========= LINE ========= */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(config);

/* ========= OpenAI ========= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ========= Supabase（v2フォーマット）========= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    }
  }
);

/* ========= Edward の設定 ========= */
const SYSTEM_PROMPT = `
あなたは Edward（エドワード）です。
35歳のアメリカ人男性で、職業はニュースアナウンサー。
落ち着いた優しい英会話パートナーとして会話してください。

返信は必ず以下の3点セット：

1. 英文メッセージ
2. 日本語訳
3. 英文を読み上げた音声（mp3 / alloy）

英文は短く自然に、初心者も理解しやすい語彙で話してください。
`;

/* ========= Supabase 保存 ========= */
async function saveMessage(userId, role, content, type = "text") {
  await supabase.from("edward_messages").insert([
    { user_id: userId, role, content, type }
  ]);
}

/* ========= 生成ロジック ========= */
async function generateResponse(userId, textInput) {

  await saveMessage(userId, "user", textInput, "text");

  // 英文生成
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: textInput }
    ],
  });

  const english = response.choices[0].message.content.trim();

  // 日本語訳
  const jpResp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "以下の英文を自然な日本語に翻訳してください。" },
      { role: "user", content: english }
    ],
  });
  const japanese = jpResp.choices[0].message.content.trim();

  // 音声 (TTS)
  const tts = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    format: "mp3",
    input: english,
  });

  const audioBuffer = Buffer.from(await tts.arrayBuffer());

  const fileName = `edward_${Date.now()}.mp3`;
  const filePath = path.join(__dirname, fileName);

  fs.writeFileSync(filePath, audioBuffer);

  // Supabase Storage 保存
  await supabase.storage
    .from("edward-audio")
    .upload(fileName, audioBuffer, {
      contentType: "audio/mpeg",
      upsert: false,
    });

  const audioUrl = supabase.storage
    .from("edward-audio")
    .getPublicUrl(fileName).data.publicUrl;

  await saveMessage(userId, "assistant", english, "text");

  return { english, japanese, audioUrl };
}

/* ========= LINE Webhook ========= */
/*
 ※絶対に順番重要！
   express.json() を先に書くと署名エラーが必ず出る
*/

app.post("/callback", line.middleware(config), async (req, res) => {
  const events = req.body.events;

  for (const event of events) {
    if (event.type !== "message") continue;

    const userId = event.source.userId;

    /* ===== Text ===== */
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
        }
      ]);
    }

    /* ===== Audio ===== */
    if (event.message.type === "audio") {
      const stream = await lineClient.getMessageContent(event.message.id);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const audioBuffer = Buffer.concat(chunks);

      const transcription = await openai.audio.transcriptions.create({
        model: "gpt-4o-mini-transcribe",
        file: audioBuffer,
      });

      const text = transcription.text;
      const reply = await generateResponse(userId, text);

      await lineClient.replyMessage(event.replyToken, [
        { type: "text", text: reply.english },
        { type: "text", text: reply.japanese },
        {
          type: "audio",
          originalContentUrl: reply.audioUrl,
          duration: 5000,
        }
      ]);
    }
  }

  res.status(200).end();
});

/* ========= 他ルートのための JSON ========= */
app.use(express.json());

/* ========= 起動 ========= */
app.listen(10000, () => {
  console.log("Edward AI is running on port 10000");
});
