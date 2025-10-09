// server.js — Math GPT with GPT-4 chat + Paystack subscriptions
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

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// ✅ These are your Paystack environment variables
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";

// ✅ These match your Railway variable names
const PLAN_CODES = {
  PAYSTACK_PLAN_PREMIUM: process.env.PAYSTACK_PLAN_PREMIUM || "", // e.g. PLN_xxx
  PAYSTACK_PLAN_PRO: process.env.PAYSTACK_PLAN_PRO || ""          // e.g. PLN_xxx
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4";
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- MIDDLEWARE ----------
app.use("/api/paystack/webhook", bodyParser.raw({ type: "*/*" }));
app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- HELPERS ----------
async function createOrGetUser(email) {
  if (!email) return null;
  try {
    let u = await prisma.user.findUnique({ where: { email } });
    if (!u) u = await prisma.user.create({ data: { email } });
    return u;
  } catch (e) {
    console.warn("DB not ready, skipping user persistence:", e.code || e.message);
    return null;
  }
}

function systemPromptFor(assistant = "Math GPT") {
  return `You are a clear, step-by-step math tutor.
Explain reasoning simply, show calculations neatly, and give the final answer clearly.`;
}

async function fetchPlanDetails(planCode) {
  const { data } = await axios.get(
    `https://api.paystack.co/plan/${encodeURIComponent(planCode)}`,
    { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
  );
  return data;
}

// ---------- DIAGNOSTICS ----------
app.get("/api/paystack/diag", (_req, res) => {
  res.json({
    has_SECRET_KEY: Boolean(PAYSTACK_SECRET_KEY),
    PUBLIC_URL,
    premiumPlanSet: Boolean(PLAN_CODES.PAYSTACK_PLAN_PREMIUM),
    proPlanSet: Boolean(PLAN_CODES.PAYSTACK_PLAN_PRO)
  });
});

app.get("/api/paystack/plan/:planKey", async (req, res) => {
  try {
    const planKey = req.params.planKey;
    const planCode = PLAN_CODES[planKey];
    if (!planCode) return res.status(400).json({ error: `Unknown plan '${planKey}'` });
    const info = await fetchPlanDetails(planCode);
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e?.response?.data?.message || e.message });
  }
});

// ---------- PAYSTACK INITIALIZE ----------
app.post("/api/paystack/initialize", async (req, res) => {
  try {
    const { email, plan } = req.body || {};
    if (!email || !plan) return res.status(400).json({ error: "email and plan required" });
    if (!PAYSTACK_SECRET_KEY) return res.status(500).json({ error: "PAYSTACK_SECRET_KEY missing" });

    const planCode = PLAN_CODES[plan];
    if (!planCode) return res.status(400).json({ error: `Unknown plan '${plan}'` });

    // Validate plan details first
    const planInfo = await fetchPlanDetails(planCode);
    const p = planInfo?.data;
    if (!p?.amount || p.amount <= 0)
      return res.status(400).json({ error: "Invalid plan amount", details: p });
    if (String(p.currency).toUpperCase() !== "GHS")
      return res.status(400).json({ error: `Plan currency must be GHS, found ${p.currency}` });

    const user = await createOrGetUser(email);

    const payload = {
      email,
      plan: planCode,
      currency: "GHS",
      callback_url: `${PUBLIC_URL}/payment/callback`,
      metadata: { user_id: user?.id || null, plan }
    };

    const { data } = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      payload,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );

    if (!data?.status)
      return res.status(400).json({ error: data?.message || "Paystack init failed" });

    try {
      await prisma.payment.create({
        data: {
          userId: user?.id || null,
          provider: "paystack",
          reference: data.data.reference,
          status: "initialized",
          currency: "GHS",
          rawInitResponse: data.data
        }
      });
    } catch (e) {
      console.warn("Skipping payment init persistence:", e.code || e.message);
    }

    res.json({
      authorization_url: data.data.authorization_url,
      reference: data.data.reference
    });
  } catch (err) {
    const msg = err?.response?.data?.message || err?.message || "Unknown error";
    console.error("Paystack init error:", err?.response?.data || err);
    res.status(500).json({ error: "Payment initialization failed", message: msg });
  }
});

// ---------- PAYSTACK WEBHOOK ----------
app.post("/api/paystack/webhook", async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const computed = crypto
    .createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(req.body)
    .digest("hex");
  if (signature !== computed) return res.sendStatus(401);

  try {
    const event = JSON.parse(req.body.toString("utf8"));
    const evt = event?.event;
    const data = event?.data || {};
    const email = data?.customer?.email;
    const reference = data?.reference;
    const planCode = data?.plan || data?.plan_object?.plan_code;
    const amount = data?.amount;
    const currency = data?.currency || "GHS";

    if (evt === "charge.success" && email) {
      const user = await createOrGetUser(email);
      const planKey =
        planCode === PLAN_CODES.premium ? "premium" :
        planCode === PLAN_CODES.pro ? "pro" : "unknown";

      try {
        await prisma.payment.upsert({
          where: { reference: reference || "" },
          update: { status: "success", amountMinor: amount, currency, rawWebhookEvent: event },
          create: {
            userId: user?.id || null,
            provider: "paystack",
            reference: reference || `ref_${Date.now()}`,
            amountMinor: amount,
            currency,
            status: "success",
            rawWebhookEvent: event
          }
        });
      } catch (e) {
        console.warn("Skipping payment upsert:", e.code || e.message);
      }

      if (planKey !== "unknown" && user?.id) {
        try {
          await prisma.subscription.upsert({
            where: { userId_plan: { userId: user.id, plan: planKey } },
            update: { status: "active", providerPlanCode: planCode, lastPaidAt: new Date() },
            create: {
              userId: user.id,
              plan: planKey,
              status: "active",
              provider: "paystack",
              providerPlanCode: planCode,
              lastPaidAt: new Date()
            }
          });
        } catch (e) {
          console.warn("Skipping subscription upsert:", e.code || e.message);
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// ---------- SUBSCRIPTION STATUS ----------
app.get("/api/subscription/status/:email", async (req, res) => {
  try {
    const { email } = req.params;
    if (!email) return res.status(400).json({ error: "email required" });

    const user = await prisma.user.findUnique({
      where: { email },
      include: { subscriptions: true }
    });

    if (!user) return res.json({ status: "free" });
    const activeSub = user.subscriptions.find((s) => s.status === "active");
    if (activeSub)
      return res.json({ status: "active", plan: activeSub.plan, since: activeSub.lastPaidAt });
    res.json({ status: "free" });
  } catch (err) {
    console.warn("Status fallback:", err.code || err.message);
    res.json({ status: "free" });
  }
});

// ---------- GPT-4 CHAT ----------
app.post("/api/chat", async (req, res) => {
  try {
    const { email, assistant = "Math GPT", message = "", image = null } = req.body || {};
    if (!message && !image) return res.status(400).json({ error: "message or image required" });
    if (email) await createOrGetUser(email).catch(() => {});

    const userContent = [];
    if (message && message.trim()) userContent.push({ type: "text", text: message.trim() });
    if (image && typeof image === "string") userContent.push({ type: "image_url", image_url: image });

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPromptFor(assistant) },
        { role: "user", content: userContent }
      ]
    });

    const answer = completion?.choices?.[0]?.message?.content?.trim() || "No response from AI.";
    res.json({ content: answer });
  } catch (err) {
    console.error("Chat error:", err?.response?.data || err);
    res.status(500).json({ error: "Failed to get answer from OpenAI" });
  }
});

// ---------- CALLBACK PAGE ----------
app.get("/payment/callback", (_req, res) => {
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment callback</title>
<style>
body{margin:0;background:#0b0c10;color:#e9edf5;font-family:Inter,system-ui,sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh}
.card{background:#141720;border:1px solid #232635;border-radius:16px;padding:28px;max-width:520px;text-align:center}
.btn{display:inline-block;margin-top:14px;background:#5b8cff;color:#fff;border:none;border-radius:12px;padding:12px 16px;font-weight:700;text-decoration:none}
.muted{color:#9aa3b2}
</style></head>
<body>
  <div class="card">
    <h2>Payment received</h2>
    <p class="muted">Thanks! If successful, your subscription activates soon.</p>
    <a class="btn" href="/chat.html">Go to Chat</a>
  </div>
</body></html>`);
});

// ---------- HEALTH + FALLBACK ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
