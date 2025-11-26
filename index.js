import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

/* ========= LINE CONFIG ========= */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(config);

/* ========= Express ========= */
const app = express();
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf }
}));

/* ========= OpenAI ========= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* ========= Supabase ========= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

/* ========= Utility: Save message ========= */
async function saveMessage(userId, role, content) {
  await supabase.from("chat_logs").insert({
    user_id: userId,
    role,
    content
  });
}

/* ========= Utility: Load last 10 messages ========= */
async function loadMessages(userId) {
  const { data } = await supabase
    .from("chat_logs")
    .select("*")
    .eq("user_id", userId)
    .order("id", { ascending: false })
    .limit(10);

  if (!data) return [];
  return data.reverse().map(row => ({
    role: row.role,
    content: row.content
  }));
}

/* ========= Edward System Prompt ========= */
const EDWARD_PROMPT = `
あなたは Edward（エドワード）です。
35歳のアメリカ人男性ニュースアナウンサー。
知的で落ち着いていて、優しい話し方。
語尾はフレンドリーに。短すぎず長すぎない自然な返答を。
`;

/* ========= Generate AI Text ========= */
async function generateText(userId, userMessage) {
  const history = await loadMessages(userId);

  const messages = [
    { role: "system", content: EDWARD_PROMPT },
    ...history.map(h => ({
      role: h.role,
      content: h.content
    })),
    { role: "user", content: userMessage }
  ];

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    messages
  });

  return response.output_text;
}

/* ========= Generate AI Voice (mp3) ========= */
async function generateVoice(text) {
  const response = await openai.responses.create({
    model: "gpt-4o-mini-tts",
    input: text,
    audio: {
      voice: "alloy",
      format: "mp3"
    }
  });

  const audioBase64 = response.output[0].audio.data;
  return Buffer.from(audioBase64, "base64");
}

/* ========= Image Analysis ========= */
async function analyzeImage(imageBuffer) {
  const base64 = imageBuffer.toString("base64");

  const result = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: `data:image/jpeg;base64,${base64}`
          }
        ]
      }
    ]
  });

  return result.output_text;
}

/* ========= LINE Webhook ========= */
app.post("/callback", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).end();
  }
});

/* ========= Handle each event ========= */
async function handleEvent(event) {
  if (event.type !== "message") return;

  const userId = event.source.userId;

  // TEXT
  if (event.message.type === "text") {
    const userMessage = event.message.text;

    await saveMessage(userId, "user", userMessage);

    const aiText = await generateText(userId, userMessage);
    await saveMessage(userId, "assistant", aiText);

    const voice = await generateVoice(aiText);

    return lineClient.replyMessage(event.replyToken, [
      { type: "text", text: aiText },
      {
        type: "audio",
        originalContentUrl: await uploadTempAudio(voice),
        duration: 3000
      }
    ]);
  }

  // IMAGE
  if (event.message.type === "image") {
    const stream = await lineClient.getMessageContent(event.message.id);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const aiText = await analyzeImage(buffer);

    await saveMessage(userId, "assistant", aiText);

    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: aiText
    });
  }
}

/* ========= Temporary audio uploader (Render static) ========= */
/* ここでは base64→音声URL化のため、簡易的に data:URL を返す */
async function uploadTempAudio(buffer) {
  const base64 = buffer.toString("base64");
  return `data:audio/mp3;base64,${base64}`;
}

/* ========= Start Server ========= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Edward AI running on port " + PORT);
});
