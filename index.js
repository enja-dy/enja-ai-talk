// index.js — Edward（LINE × AI英会話 完全版）
// ---------------------------------------------
// ・テキストメッセージ → 英文＋日本語訳＋音声(mp3) で返信
// ・音声メッセージ   → 文字起こし → 上と同じく返信
// ・Supabase: edward_messages に履歴保存（直近10件を文脈に使用）
// ・Storage: edward-audio に mp3 を保存して LINE にURLで返す
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
// ※署名検証のため、/callback には bodyParser をかけない
const app = express();

app.get("/", (req, res) => {
  res.send("Edward LINE bot is running.");
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
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
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

/* ========= Edward の人格設定 ========= */
const SYSTEM_PROMPT = `
あなたは「Edward（エドワード）」です。
35歳のアメリカ人男性ニュースアナウンサー。
落ち着いた、丁寧で優しい英会話パートナーとして振る舞ってください。

【キャラクター】
- プロのニュースアナウンサーのように、落ち着いて聞き取りやすい話し方
- 難しすぎない自然な英語（中級レベル）で話す
- 1〜3文程度の英語で返答し、簡単な質問を添えて会話を続ける

【出力形式（厳守）】
必ず次の形式で返してください：

EN: （Edwardの英語の返答）
JP: （上記の自然な日本語訳）
`;

/* ========= Edward の返事（英文＋日本語訳）生成 ========= */
async function createEdwardReply(userText, history) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
    { role: "user", content: userText },
  ];

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
  });

  const fullText = res.choices[0]?.message?.content ?? "";

  const enMatch = fullText.match(/EN:\s*([\s\S]*?)\nJP:/);
  const jpMatch = fullText.match(/JP:\s*([\s\S]*)/);

  const english = enMatch ? enMatch[1].trim() : fullText.trim();
  const japanese = jpMatch ? jpMatch[1].trim() : "";

  return { english, japanese };
}

/* ========= TTS（mp3）生成 ========= */
async function synthesizeEdwardVoice(text) {
  const trimmed = text.slice(0, 800); // 安全のため長文をカット

const mp3 = await openai.audio.speech.create({
  model: "gpt-4o-mini-tts",
  voice: "alloy",
  format: "mp3",
  input: trimmed,
  style: "news",       // ニュースアナウンサー風
  speed: 0.92,         // 少しゆっくり
  pitch: -4,           // かなり低音に寄せる
  emotion: "calm"      // 落ち着いた雰囲気
});


  const arrayBuffer = await mp3.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/* ========= Supabase Storage に音声をアップロード ========= */
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

  const publicUrl = data?.publicUrl;
  return { publicUrl, durationMs: 8000 }; // とりあえず8秒で固定
}

/* ========= 音声 → テキスト（STT） ========= */
async function transcribeAudio(buffer) {
  try {
    // 一時ファイルに書き出してから fs.createReadStream で渡す
    const tmpDir = os.tmpdir();
    const tmpPath = path.join(tmpDir, `edward-${Date.now()}.m4a`);
    fs.writeFileSync(tmpPath, buffer);

    const transcription = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: fs.createReadStream(tmpPath),
    });

    fs.unlink(tmpPath, () => {});
    return transcription.text || "";
  } catch (e) {
    console.error("transcribeAudio error:", e);
    return "";
  }
}

/* ========= LINE Webhook ========= */
app.post("/callback", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (e) {
    console.error("Webhook error:", e);
    res.status(500).end();
  }
});

/* ========= 各イベント処理 ========= */
async function handleEvent(event) {
  if (event.type !== "message") return;

  const replyToken = event.replyToken;
  const userId = event.source.userId;
  const msg = event.message;

  try {
    // ========== テキスト ==========
    if (msg.type === "text") {
      const userText = msg.text.slice(0, 400);

      await saveMessage(userId, "user", userText, "text");
      const history = await getRecentMessages(userId);
      const { english, japanese } = await createEdwardReply(userText, history);
      await saveMessage(userId, "assistant", `${english}\n${japanese}`, "text");

      const audioBuffer = await synthesizeEdwardVoice(english);
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

    // ========== 音声 ==========
    if (msg.type === "audio") {
      const stream = await lineClient.getMessageContent(msg.id);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const audioBuffer = Buffer.concat(chunks);

      const userText = await transcribeAudio(audioBuffer);
      if (!userText) {
        await lineClient.replyMessage(replyToken, {
          type: "text",
          text: "ごめんなさい、音声がうまく聞き取れませんでした。もう一度お願いします。",
        });
        return;
      }

      await saveMessage(userId, "user", userText, "audio");
      const history = await getRecentMessages(userId);
      const { english, japanese } = await createEdwardReply(userText, history);
      await saveMessage(userId, "assistant", `${english}\n${japanese}`, "text");

      const audioReply = await synthesizeEdwardVoice(english);
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

    // それ以外のメッセージタイプは一旦テキストで案内
    await lineClient.replyMessage(replyToken, {
      type: "text",
      text: "テキストか音声メッセージで話しかけてください。",
    });
  } catch (e) {
    console.error("handleEvent error:", e);
    await lineClient.replyMessage(replyToken, {
      type: "text",
      text: "エドワードとの会話中にエラーが起きました。",
    });
  }
}

/* ========= サーバー起動 ========= */
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Edward LINE bot is running on port ${port}`);
});
