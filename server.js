// server.js
import express from "express";
import cors from "cors";
import axios from "axios";
import crypto from "crypto";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";
import OpenAI from "openai";

const app = express();
const prisma = new PrismaClient();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- ENV ----
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PLAN_CODES = {
  premium: process.env.PAYSTACK_PLAN_PREMIUM,
  pro: process.env.PAYSTACK_PLAN_PRO,
};
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- MIDDLEWARE ----
app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use("/api/paystack/webhook", bodyParser.raw({ type: "*/*" }));
app.use(express.static(path.join(__dirname, "public")));

// ---- HELPERS ----
async function createOrGetUser(email) {
  if (!email) return null;
  let u = await prisma.user.findUnique({ where: { email } });
  if (!u) u = await prisma.user.create({ data: { email } });
  return u;
}

// ---- PAYSTACK INITIALIZE ----
app.post("/api/paystack/initialize", async (req, res) => {
  try {
    const { email, plan } = req.body || {};
    if (!email || !plan) return res.status(400).json({ error: "email and plan required" });
    const planCode = PLAN_CODES[plan];
    if (!planCode) return res.status(400).json({ error: "Unknown plan" });

    const user = await createOrGetUser(email);

    const payload = {
      email,
      plan: planCode,
      currency: "GHS",
      callback_url: `${PUBLIC_URL}/payment/callback`,
      metadata: { user_id: user.id, plan },
    };

    const { data } = await axios.post("https://api.paystack.co/transaction/initialize", payload, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
    });
    if (!data?.status) return res.status(400).json({ error: "Paystack init failed", details: data });

    await prisma.payment.create({
      data: {
        userId: user.id,
        provider: "paystack",
        reference: data.data.reference,
        status: "initialized",
        currency: "GHS",
        rawInitResponse: data.data,
      },
    });

    res.json({
      authorization_url: data.data.authorization_url,
      reference: data.data.reference,
    });
  } catch (err) {
    console.error("Paystack init error:", err.response?.data || err);
    res.status(500).json({ error: "Payment initialization failed" });
  }
});

// ---- PAYSTACK WEBHOOK ----
app.post("/api/paystack/webhook", async (req, res) => {
  const sig = req.headers["x-paystack-signature"];
  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(req.body).digest("hex");
  if (sig !== hash) return res.sendStatus(401);

  try {
    const event = JSON.parse(req.body.toString("utf8"));
    const evt = event.event;
    const data = event.data || {};
    const email = data.customer?.email;
    const ref = data.reference;
    const planCode = data.plan || data.plan_object?.plan_code;

    if (evt === "charge.success" && email) {
      const user = await createOrGetUser(email);
      let planKey = planCode === PLAN_CODES.premium ? "premium" :
                    planCode === PLAN_CODES.pro ? "pro" : "unknown";

      await prisma.payment.upsert({
        where: { reference: ref },
        update: { status: "success", amountMinor: data.amount, currency: data.currency },
        create: {
          userId: user.id,
          provider: "paystack",
          reference: ref,
          amountMinor: data.amount,
          currency: data.currency,
          status: "success",
          rawWebhookEvent: event,
        },
      });

      await prisma.subscription.upsert({
        where: { userId_plan: { userId: user.id, plan: planKey } },
        update: {
          status: "active",
          providerPlanCode: planCode,
          lastPaidAt: new Date(),
        },
        create: {
          userId: user.id,
          plan: planKey,
          status: "active",
          provider: "paystack",
          providerPlanCode: planCode,
          lastPaidAt: new Date(),
        },
      });
    }

    if (evt === "subscription.disable" && email) {
      const user = await prisma.user.findUnique({ where: { email } });
      if (user) {
        const planKey = planCode === PLAN_CODES.premium ? "premium" : "pro";
        await prisma.subscription.updateMany({
          where: { userId: user.id, plan: planKey },
          data: { status: "canceled" },
        });
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    res.sendStatus(500);
  }
});

// ---- SUBSCRIPTION STATUS ----
app.get("/api/subscription/status/:email", async (req, res) => {
  try {
    const email = req.params.email;
    const user = await prisma.user.findUnique({
      where: { email },
      include: { subscriptions: true },
    });
    if (!user) return res.json({ status: "none" });
    const active = user.subscriptions.find((s) => s.status === "active");
    if (active)
      return res.json({ status: "active", plan: active.plan, since: active.lastPaidAt });
    res.json({ status: "free" });
  } catch (e) {
    res.status(500).json({ error: "Failed to check subscription" });
  }
});

// ---- CHAT (OpenAI GPT-4 text + image) ----
function systemPromptFor(assistant = "Math GPT") {
  return `You are a clear, step-by-step math tutor. 
Explain logic simply. Show work for each step, then give the final answer. 
Avoid markdown headings like ##. Keep the format clean.`;
}

app.post("/api/chat", async (req, res) => {
  try {
    const { email, assistant = "Math GPT", message = "", image = null } = req.body || {};
    if (!message && !image)
      return res.status(400).json({ error: "message or image required" });
    if (email) await createOrGetUser(email).catch(() => {});

    const userContent = [];
    if (message) userContent.push({ type: "text", text: message });
    if (image && typeof image === "string") {
      userContent.push({ type: "image_url", image_url: image });
    }

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPromptFor(assistant) },
        { role: "user", content: userContent },
      ],
    });

    const answer =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "No response from the AI.";

    res.json({ content: answer });
  } catch (err) {
    console.error("Chat error:", err.response?.data || err);
    res.status(500).json({ error: "Failed to get an answer from OpenAI" });
  }
});

// ---- HEALTH & FALLBACK ----
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
