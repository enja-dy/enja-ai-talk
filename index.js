import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import fs from "fs/promises";

/* ========= LINE / OpenAI ========= */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(config);

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ========= Supabase ========= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

/* ========= Rachel の人格設定 ========= */
const SYSTEM_PROMPT = `
あなたは「Rachel（レイチェル）」です。
30歳のアメリカ人女性で、カリフォルニア出身の英語コミュニケーションコーチ。
落ち着いて優しく、学習者を安心させる話し方をします。

【キャラクター】
- 落ち着いた、柔らかいトーンで話す
- 英語は自然で聞き取りやすい中級レベル
- 丁寧で親しみやすく、いつも相手を励ます
- 短い1〜3文で英語で返答し、必要に応じて質問を添える

【出力形式（厳守）】
必ずこの形式で返す：

EN: （Rachelの英語の返答）
JP: （上記の自然な日本語訳）
`;

/* ========= 過去10件の会話を呼び出し ========= */
async function loadHistory(userId) {
  const { data, error } = await supabase
    .from("rachel_messages")
    .select("*")
    .eq("user_id", userId)
    .order("id", { ascending: false })
    .limit(10);

  if (error) {
    console.error("Supabase loadHistory error:", error);
    return [];
  }

  return data.map((m) => ({
    role: m.role,
    content: m.content,
  })).reverse();
}

/* ========= Rachel の返事生成（EN／JP） ========= */
async function createRachelReply(userText, history) {
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
async function synthesizeRachelVoice(text) {
  const trimmed = text.slice(0, 800);

  const mp3 = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",      // 女性声
    format: "mp3",
    input: trimmed,
  });

  return Buffer.from(await mp3.arrayBuffer());
}

/* ========= Supabase へ音声保存 ========= */
async function uploadAudio(userId, audioBuffer) {
  const filename = `rachel_${userId}_${Date.now()}.mp3`;

  const { error } = await supabase.storage
    .from("rachel-audio")
    .upload(filename, audioBuffer, {
      contentType: "audio/mpeg",
      upsert: true,
    });

  if (error) {
    console.error("Supabase audio upload error:", error);
    return null;
  }

  const { data: publicUrlData } = supabase.storage
    .from("rachel-audio")
    .getPublicUrl(filename);

  return publicUrlData.publicUrl;
}

/* ========= 返信を Supabase に保存 ========= */
async function saveReply(userId, english, japanese, audioUrl) {
  await supabase.from("rachel_messages").insert({
    user_id: userId,
    role: "assistant",
    character: "Rachel",
    content: `EN: ${english}\nJP: ${japanese}`,
    audio_url: audioUrl,
  });
}

/* ========= LINE Webhook ========= */
app.post("/webhook", line.middleware(config), async (req, res) => {
  res.sendStatus(200);

  const event = req.body.events[0];
  if (!event || event.type !== "message") return;

  const userId = event.source.userId;
  const msg = event.message;

  let userText = "";

  // テキスト入力
  if (msg.type === "text") {
    userText = msg.text;
  }

  // 音声入力
  else if (msg.type === "audio") {
    const audioBuffer = await lineClient.getMessageContent(msg.id);
    const wav = Buffer.from(await audioBuffer.arrayBuffer());

    const stt = await openai.audio.transcriptions.create({
      file: wav,
      model: "gpt-4o-mini-transcribe",
    });

    userText = stt.text;
  }

  // 会話履歴を取得
  const history = await loadHistory(userId);

  // AI返答生成
  const { english, japanese } = await createRachelReply(userText, history);

  // 音声生成
  const audioBuffer = await synthesizeRachelVoice(english);
  const audioUrl = await uploadAudio(userId, audioBuffer);

  // LINE返信（テキスト）
  await lineClient.replyMessage(event.replyToken, [
    { type: "text", text: `EN: ${english}` },
    { type: "text", text: `JP: ${japanese}` },
    { type: "audio", originalContentUrl: audioUrl, duration: 2000 },
  ]);

  // Supabase 保存
  await saveReply(userId, english, japanese, audioUrl);
});

/* ========= 起動 ========= */
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Rachel LINE bot is running on port ${port}`);
});
