// index.js — Edward（LINE × 英会話）完全版
//
// ■機能
// ・テキスト / 音声の入力を受け取り Edward が英語＋日本語訳＋音声で返す
// ・Supabase に会話履歴を保存し、直近10件を参照して文脈をつなげる
// ・音声は TTS（opus）→ Supabase Storage（edward-audio）→ LINE audioMessage
//
// ■必要な環境変数
// LINE_CHANNEL_ACCESS_TOKEN
// LINE_CHANNEL_SECRET
// OPENAI_API_KEY
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
//

import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

// ========= LINE CONFIG =========
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(config);

// ========= OpenAI =========
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ========= Supabase =========
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ========= Express =========
const app = express();

app.get("/", (req, res) => {
  res.send("Edward LINE bot is running.");
});

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const results = await Promise.all(
      req.body.events.map((event) => handleEvent(event))
    );
    res.json(results);
  } catch (e) {
    console.error("Webhook error:", e);
    res.status(500).end();
  }
});

// ========= MAIN HANDLER =========
async function handleEvent(event) {
  if (event.type !== "message") return;

  const replyToken = event.replyToken;
  const userId = event.source.userId;
  const msg = event.message;

  try {
    let userText = "";

    // ---- Text ----
    if (msg.type === "text") {
      userText = msg.text.slice(0, 400);
    }

    // ---- Audio ----
    else if (msg.type === "audio") {
      const audioBuffer = await getLineAudio(msg.id);
      userText = await transcribeAudio(audioBuffer);

      if (!userText) {
        await lineClient.replyMessage(replyToken, {
          type: "text",
          text: "音声がうまく認識できませんでした。もう一度お願いします。",
        });
        return;
      }
    }

    // Save user message
    await saveMessage(userId, "user", userText, msg.type === "audio" ? "audio" : "text");

    // Load last 10 messages (context)
    const history = await getRecentMessages(userId);

    // Create Edward's reply (English + Japanese)
    const { english, japanese } = await createEdwardReply(userText, history);

    // Save assistant message
    await saveMessage(userId, "assistant", english + "\n" + japanese, "text");

    // Generate Edward's voice
    const audioBuffer = await synthesizeEdwardVoice(english);

    // Upload audio → Supabase → get public URL
    const { publicUrl, durationMs } = await uploadAudio(userId, audioBuffer);

    // ---- Reply to LINE ----
    await lineClient.replyMessage(replyToken, [
      { type: "text", text: english },
      { type: "text", text: japanese },
      {
        type: "audio",
        originalContentUrl: publicUrl,
        duration: durationMs,
      },
    ]);
  } catch (err) {
    console.error(err);
    return lineClient.replyMessage(replyToken, {
      type: "text",
      text: "エドワードとの会話中にエラーが起きました。",
    });
  }
}

// ========= LINE AUDIO FETCHER =========
async function getLineAudio(messageId) {
  const stream = await lineClient.getMessageContent(messageId);

  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// ========= OpenAI TRANSCRIPTION =========
async function transcribeAudio(buffer) {
  try {
    const file = new File([buffer], "voice.m4a", { type: "audio/m4a" });

    const res = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file,
    });

    return res.text || "";
  } catch (e) {
    console.error("Transcription error:", e);
    return "";
  }
}

// ========= LOAD HISTORY =========
async function getRecentMessages(userId, limit = 10) {
  const { data } = await supabase
    .from("edward_messages")
    .select("role, content")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  return data?.reverse() || [];
}

// ========= SAVE MESSAGE =========
async function saveMessage(userId, role, content, type) {
  const { error } = await supabase.from("edward_messages").insert({
    user_id: userId,
    role,
    content,
    type,
  });
  if (error) console.error("saveMessage error:", error);
}

// ========= GENERATE EDWARD'S REPLY =========
async function createEdwardReply(userText, history) {
  const historyMessages = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const systemPrompt = `
あなたは「Edward（エドワード）」です。
アメリカ人男性・35歳・ニュースアナウンサー。
落ち着いた声で、知的で丁寧、明瞭な英語を話す。
ユーザーと自然な英会話を行い、必ず質問を返して会話をつなげる。

【話し方の特徴】
- プロのニュースアナウンサーのように発声が明瞭で落ち着いている
- 中学〜高校レベルの自然な英語で分かりやすく
- 優しくフレンドリー、押し付けがましくない
- 必ず 2〜3 文で返す
- 最後に質問を添えて会話を続ける

【出力形式（厳守）】
EN: （Edward の自然な英語）
JP: （上記の日本語訳）
`;

  const res = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: systemPrompt },
      ...historyMessages,
      { role: "user", content: userText },
    ],
  });

  const text =
    res.output?.[0]?.content?.[0]?.text ||
    res.output?.[0]?.content?.[0]?.value ||
    "";

  const en = text.match(/EN:\s*([\s\S]*?)\nJP:/);
  const jp = text.match(/JP:\s*([\s\S]*)/);

  return {
    english: en ? en[1].trim() : text.trim(),
    japanese: jp ? jp[1].trim() : "",
  };
}

// ========= TTS（Edward の声） =========
async function synthesizeEdwardVoice(text) {
  const trimmed = text.slice(0, 800);

  const result = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy", // 男性・落ち着いた声
    format: "opus",
    input: trimmed,
  });

  const arrayBuffer = await result.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ========= UPLOAD AUDIO TO SUPABASE =========
async function uploadAudio(userId, buffer) {
  const filename = `audio/${userId}-${Date.now()}-${crypto
    .randomBytes(4)
    .toString("hex")}.opus`;

  const { error } = await supabase.storage
    .from("edward-audio")
    .upload(filename, buffer, {
      contentType: "audio/ogg",
    });

  if (error) {
    console.error("Audio upload error:", error);
    throw error;
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from("edward-audio").getPublicUrl(filename);

  // ざっくり8秒
  const durationMs = 8000;

  return { publicUrl, durationMs };
}

// ========= START SERVER =========
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Edward LINE bot is running on port ${port}`);
});
