// index.js — Edward（LINE × AI英会話 完全修正版）
// ---------------------------------------------

import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import os from "os";
import path from "path";

/* ========= LINE CONFIG ========= */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(config);

/* ========= Express ========= */
const app = express();
app.get("/", (req, res) => res.send("Edward is running."));

/* ========= OpenAI ========= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ========= Supabase ========= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  {
    auth: { autoRefreshToken: false, persistSession: false },
  }
);

/* ========= Supabase: 会話履歴 ========= */
async function saveMessage(userId, role, content, type = "text") {
  const { error } = await supabase.from("edward_messages").insert({
    user_id: userId,
    role,
    content,
    type,
  });
  if (error) console.error("saveMessage error:", error);
}

async function getRecentMessages(userId, limit = 10) {
  const { data, error } = await supabase
    .from("edward_messages")
    .select("role, content")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("getRecentMessages error:", error);
    return [];
  }
  return (data || []).reverse();
}

/* ========= Edward の人格 ========= */
const SYSTEM_PROMPT = `
あなたは「Edward（エドワード）」です。
35歳のアメリカ人男性ニュースアナウンサー。

【キャラクター】
- 直近の会話履歴（最大10件）を必ず踏まえて返答
- 落ち着いた丁寧な英語
- 1〜3文の英語で返答し、質問を添える
- 日本語訳も返すが、履歴に日本語は含めない

【出力形式】
必ず次の形式で返答すること：

EN: （Edwardの英語の返答）
JP: （自然な日本語訳）
`;

/* ========= Edward の返事（英文＋日本語訳） ========= */
async function createEdwardReply(userText, history) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content, // ← 日本語が混ざらないように修正済
    })),
    { role: "user", content: userText },
  ];

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
  });

  const fullText = res.choices[0]?.message?.content ?? "";

  // 強化版パーサー
  const enMatch = fullText.match(/EN:\s*([\s\S]*?)\nJP:/);
  const jpMatch = fullText.match(/JP:\s*([\s\S]*)/);

  const english = enMatch ? enMatch[1].trim() : fullText.trim();
  const japanese = jpMatch ? jpMatch[1].trim() : "（日本語訳の抽出に失敗しました）";

  return { english, japanese };
}

/* ========= TTS（英語のみ） ========= */
async function synthesizeEdwardVoice(text) {
  const trimmed = text.slice(0, 800);
  const mp3 = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    format: "mp3",
    input: trimmed,
  });

  const arrayBuffer = await mp3.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/* ========= Storageに音声アップロード ========= */
async function uploadAudioToSupabase(userId, audioBuffer) {
  const fileName = `audio/${userId}-${Date.now()}.mp3`;

  const { error } = await supabase.storage
    .from("edward-audio")
    .upload(fileName, audioBuffer, {
      contentType: "audio/mpeg",
      upsert: false,
    });

  if (error) {
    console.error("audio upload error:", error);
    throw error;
  }

  const { data } = supabase.storage
    .from("edward-audio")
    .getPublicUrl(fileName);

  return { publicUrl: data.publicUrl, durationMs: 8000 };
}

/* ========= STT ========= */
async function transcribeAudio(buffer) {
  try {
    const tmp = path.join(os.tmpdir(), `edward-${Date.now()}.m4a`);
    fs.writeFileSync(tmp, buffer);

    const result = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: fs.createReadStream(tmp),
    });

    fs.unlink(tmp, () => {});
    return result.text || "";
  } catch (e) {
    console.error("transcribeAudio error:", e);
    return "";
  }
}

/* ========= Webhook ========= */
app.post("/callback", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (e) {
    console.error("Webhook error:", e);
    res.status(500).end();
  }
});

/* ========= イベント処理 ========= */
async function handleEvent(event) {
  if (event.type !== "message") return;

  const replyToken = event.replyToken;
  const userId = event.source.userId;
  const msg = event.message;

  try {
    /* ====== テキスト ====== */
    if (msg.type === "text") {
      const userText = msg.text.slice(0, 400);

      await saveMessage(userId, "user", userText, "text");

      const history = await getRecentMessages(userId);
      const { english, japanese } = await createEdwardReply(userText, history);

      // ★ 英語と日本語を別レコードで保存 ← これが重要！
      await saveMessage(userId, "assistant", english, "text");
      await saveMessage(userId, "assistant", japanese, "text");

      const audioBuffer = await synthesizeEdwardVoice(english);
      const { publicUrl, durationMs } = await uploadAudioToSupabase(
        userId,
        audioBuffer
      );

      await lineClient.replyMessage(replyToken, [
        { type: "text", text: english },
        { type: "text", text: japanese },
        {
          type: "audio",
          originalContentUrl: publicUrl,
          duration: durationMs,
        },
      ]);
      return;
    }

    /* ====== 音声 ====== */
    if (msg.type === "audio") {
      const stream = await lineClient.getMessageContent(msg.id);
      const chunks = [];
      for await (const c of stream) chunks.push(c);
      const audioBuf = Buffer.concat(chunks);

      const userText = await transcribeAudio(audioBuf);
      if (!userText) {
        await lineClient.replyMessage(replyToken, {
          type: "text",
          text: "音声を認識できませんでした。もう一度お願いします。",
        });
        return;
      }

      await saveMessage(userId, "user", userText, "audio");

      const history = await getRecentMessages(userId);
      const { english, japanese } = await createEdwardReply(userText, history);

      await saveMessage(userId, "assistant", english, "text");
      await saveMessage(userId, "assistant", japanese, "text");

      const audioReply = await synthesizeEdwardVoice(english);
      const { publicUrl, durationMs } = await uploadAudioToSupabase(
        userId,
        audioReply
      );

      await lineClient.replyMessage(replyToken, [
        { type: "text", text: english },
        { type: "text", text: japanese },
        {
          type: "audio",
          originalContentUrl: publicUrl,
          duration: durationMs,
        },
      ]);
      return;
    }

    await lineClient.replyMessage(replyToken, {
      type: "text",
      text: "テキストか音声で話しかけてください。",
    });
  } catch (e) {
    console.error("handleEvent error:", e);
    await lineClient.replyMessage(replyToken, {
      type: "text",
      text: "エラーが発生しました。",
    });
  }
}

/* ========= 起動 ========= */
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Edward running on port ${port}`));
