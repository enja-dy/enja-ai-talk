// index.js — Rachel（LINE × AI英会話 完全版 v2）
// --------------------------------------------------

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
app.get("/", (req, res) => {
  res.send("Rachel LINE bot is running v2.");
});

/* ========= OpenAI ========= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

/* ========= Rachel の人格設定 ========= */
const SYSTEM_PROMPT = `
あなたは「Rachel（レイチェル）」です。
26歳のアメリカ人女性ニュースアナウンサー。

【キャラクター】
- 落ち着いた、丁寧で優しい英会話パートナー
- 中級レベルの自然な英語を使う
- 直近10件の会話履歴を必ず踏まえて返答する
- 1〜3文の英語で話し、最後に簡単な質問を添えて会話を続ける

【重要】
あなたの返答は EN と JP の2種類を必ず返してください。
`;

/* ========= Rachel の返事（英文＋日本語訳） ========= */
async function createRachelReply(userText, history) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },

    // 日本語訳を履歴に混ぜない（assistant は英語だけ保存されている想定）
    ...history.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),

    {
      role: "user",
      content:
        userText +
        "\n\n上記に対する返答を必ず次の形式で返してください。\nEN: （英語の返答）\nJP: （自然な日本語訳）\n絶対にこの形式から外れないこと。",
    },
  ];

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
  });

  const fullText = res.choices[0]?.message?.content ?? "";

  // 強化版パーサー
  const enMatch = fullText.match(/EN:\s*([\s\S]*?)(?:JP:|$)/);
  const jpMatch = fullText.match(/JP:\s*([\s\S]*)/);

  const english = enMatch ? enMatch[1].trim() : "";
  const japanese = jpMatch ? jpMatch[1].trim() : "";

  return { english, japanese };
}

/* ========= TTS（英語だけ） ========= */
async function synthesizeRachelVoice(text) {
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

/* ========= Storage に mp3 保存 ========= */
async function uploadAudioToSupabase(userId, audioBuffer) {
  // バケット名は既存の edward-audio を流用（インフラ名なのでこのままでOK）
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

/* ========= 音声 → 文字起こし ========= */
async function transcribeAudio(buffer) {
  try {
    const tmp = path.join(os.tmpdir(), `rachel-${Date.now()}.m4a`);
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
      const { english, japanese } = await createRachelReply(userText, history);

      // 英語と日本語を別レコードで保存
      await saveMessage(userId, "assistant", english, "text");
      await saveMessage(userId, "assistant", japanese, "text");

      const audioBuffer = await synthesizeRachelVoice(english);
      const { publicUrl, durationMs } = await uploadAudioToSupabase(
        userId,
        audioBuffer
      );

      await lineClient.replyMessage(replyToken, [
        { type: "text", text: english },
        { type: "text", text: japanese || "（日本語訳の生成に失敗しました）" },
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
          text: "音声をうまく認識できませんでした。もう一度お願いします。",
        });
        return;
      }

      await saveMessage(userId, "user", userText, "audio");

      const history = await getRecentMessages(userId);
      const { english, japanese } = await createRachelReply(userText, history);

      await saveMessage(userId, "assistant", english, "text");
      await saveMessage(userId, "assistant", japanese, "text");

      const audioReply = await synthesizeRachelVoice(english);
      const { publicUrl, durationMs } = await uploadAudioToSupabase(
        userId,
        audioReply
      );

      await lineClient.replyMessage(replyToken, [
        { type: "text", text: english },
        { type: "text", text: japanese || "（日本語訳の生成に失敗しました）" },
        {
          type: "audio",
          originalContentUrl: publicUrl,
          duration: durationMs,
        },
      ]);
      return;
    }

    // その他のメッセージ
    await lineClient.replyMessage(replyToken, {
      type: "text",
      text: "テキストか音声メッセージで話しかけてください。",
    });
  } catch (e) {
    console.error("handleEvent error:", e);
    await lineClient.replyMessage(replyToken, {
      type: "text",
      text: "レイチェルとの会話中にエラーが発生しました。",
    });
  }
}

/* ========= サーバー起動 ========= */
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Rachel LINE bot v2 is running on port ${port}`);
});
