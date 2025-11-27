/* =========================================================
   enja AIトーク（Rachel）完全版 index.js
   - LINE Webhook
   - raw body 受信 (署名検証OK)
   - Supabase 保存
   - GPT-4o-mini 会話
   - mp3 TTS返答
========================================================= */

import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

/* ========= LINE設定 ========= */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const lineClient = new line.Client(config);

/* ========= Supabase ========= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

/* ========= OpenAI ========= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ========= Express準備 ========= */
const app = express();

/* ←←← 最重要：LINE webhook は raw body を受け取る */
app.use("/webhook", express.raw({ type: "*/*" }));

/* ← 他のルートは JSON でOK */
app.use(express.json());

/* ========= Rachel の人格設定 ========= */
const SYSTEM_PROMPT = `
あなたは「Rachel（レイチェル）」です。
30代前半のアメリカ人女性の英会話パートナー。
明るく優しく、落ち着いた英語を話すキャラクターです。

【話し方】
- ネイティブ自然表現、中級レベルの語彙
- 一度の返事は 1〜3 文
- 最後に軽い質問を添えて会話を続ける

【出力形式】
EN: （英語）
JP: （日本語訳）
`;

/* ========= 会話履歴を Supabase から取得 ========= */
async function getHistory(userId) {
  try {
    const { data, error } = await supabase
      .from("rachel_messages")
      .select("role, content")
      .eq("user_id", userId)
      .order("id", { ascending: false })
      .limit(10);

    if (error) {
      console.error("getHistory error:", error);
      return [];
    }

    return data.reverse(); // 古い順に整形
  } catch (e) {
    console.error("getHistory exception:", e);
    return [];
  }
}

/* ========= 会話を Supabase に保存 ========= */
async function saveMessage(userId, role, content) {
  try {
    const { error } = await supabase.from("rachel_messages").insert([
      {
        user_id: userId,
        role,
        content,
      },
    ]);
    if (error) console.error("saveMessage error:", error);
  } catch (e) {
    console.error("saveMessage exception:", e);
  }
}

/* ========= OpenAI（英語＋日本語訳） ========= */
async function createRachelReply(userText, history) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    { role: "user", content: userText },
  ];

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
  });

  const text = res.choices[0]?.message?.content ?? "";

  const enMatch = text.match(/EN:\s*([\s\S]*?)\nJP:/);
  const jpMatch = text.match(/JP:\s*([\s\S]*)/);

  const english = enMatch ? enMatch[1].trim() : text.trim();
  const japanese = jpMatch ? jpMatch[1].trim() : "";

  return { english, japanese };
}

/* ========= TTS（mp3） ========= */
async function synthesizeVoice(text) {
  const mp3 = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",       // 女性キャラ（Rachel）
    input: text,
    format: "mp3",
    speed: 1.0,
    emotion: "calm",
  });

  return Buffer.from(await mp3.arrayBuffer());
}

/* ========= LINE イベント処理 ========= */
async function handleEvent(event) {
  const userId = event.source.userId;

  // テキストメッセージ
  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text;

    const history = await getHistory(userId);
    const reply = await createRachelReply(text, history);

    await saveMessage(userId, "user", text);
    await saveMessage(
      userId,
      "assistant",
      `EN: ${reply.english}\nJP: ${reply.japanese}`
    );

    const audioBuffer = await synthesizeVoice(reply.english);

    await lineClient.replyMessage(event.replyToken, [
      {
        type: "text",
        text: `EN: ${reply.english}\nJP: ${reply.japanese}`,
      },
      {
        type: "audio",
        originalContentUrl:
          "https://enja-ai-talk.onrender.com/tmp/" + Date.now() + ".mp3",
        duration: 4000, // 仮
      },
    ]);

    return;
  }

  // 音声メッセージは後で追加可能
}

/* ========= Webhook受信 ========= */
app.post(
  "/webhook",
  line.middleware(config),
  async (req, res) => {
    try {
      const events = req.body.events;
      await Promise.all(events.map(handleEvent));
      res.status(200).end();
    } catch (e) {
      console.error("Webhook Processing Error:", e);
      res.status(500).end();
    }
  }
);

/* ========= 起動 ========= */
const port = process.env.PORT || 10000;
app.listen(port, () =>
  console.log(`Rachel LINE bot is running on port ${port}`)
);
