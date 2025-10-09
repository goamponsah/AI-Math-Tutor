// server.js
// Complete app: Express + Prisma + Paystack (plans, webhook, callback)
// + OpenAI (GPT-4 chat w/ images) + diagnostics

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

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";
const PLAN_CODES = {
  premium: process.env.PAYSTACK_PLAN_PREMIUM || "",
  pro: process.env.PAYSTACK_PLAN_PRO || "",
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- MIDDLEWARE (order matters) ----------
// Use raw body only for webhook to verify signature
app.use("/api/paystack/webhook", bodyParser.raw({ type: "*/*" }));

app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public"))); // serves /public (index.html, chat.html, etc.)

// ---------- HELPERS ----------
async function createOrGetUser(email) {
  if (!email) return null;
  let u = await prisma.user.findUnique({ where: { email } });
  if (!u) u = await prisma.user.create({ data: { email } });
  return u;
}

function systemPromptFor(assistant = "Math GPT") {
  return `You are a clear, step-by-step math tutor.
Explain the reasoning simply, show workings line by line, and present the final answer clearly at the end.
Avoid big section headers; keep formatting compact and readable.`;
}

// ---------- DIAGNOSTICS (no secrets exposed) ----------
app.get("/api/paystack/diag", (_req, res) => {
  res.json({
    has_SECRET_KEY: Boolean(PAYSTACK_SECRET_KEY),
    PUBLIC_URL,
    premiumPlanSet: Boolean(PLAN_CODES.premium),
    proPlanSet: Boolean(PLAN_CODES.pro),
    premiumPlanCode_preview: PLAN_CODES.premium ? PLAN_CODES.premium.slice(0, 8) + "…" : null,
    proPlanCode_preview: PLAN_CODES.pro ? PLAN_CODES.pro.slice(0, 8) + "…" : null,
  });
});

// ---------- PAYSTACK: Initialize subscription payment ----------
app.post("/api/paystack/initialize", async (req, res) => {
  try {
    const { email, plan } = req.body || {};
    if (!email || !plan) {
      return res.status(400).json({ error: "email and plan required" });
    }
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({ error: "PAYSTACK_SECRET_KEY missing" });
    }

    const planCode = PLAN_CODES[plan];
    if (!planCode) {
      return res
        .status(400)
        .json({ error: `Unknown plan '${plan}'. Check PAYSTACK_PLAN_${plan.toUpperCase()}.` });
    }

    const user = await createOrGetUser(email);

    const payload = {
      email,
      plan: planCode,              // recurring via plan
      currency: "GHS",
      callback_url: `${PUBLIC_URL}/payment/callback`,
      metadata: { user_id: user?.id || null, plan, source: "math-gpt-landing" },
    };

    const { data } = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      payload,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" } }
    );

    if (!data?.status) {
      return res.status(400).json({
        error: "Paystack init failed",
        message: data?.message || "No message from Paystack",
        raw: data,
      }); // <-- fixed closing ) here
    }

    await prisma.payment.create({
      data: {
        userId: user?.id || null,
        provider: "paystack",
        reference: data.data.reference,
        status: "initialized",
        currency: "GHS",
        rawInitResponse: data.data,
      },
    });

    return res.json({
      authorization_url: data.data.authorization_url,
      reference: data.data.reference,
    });
  } catch (err) {
    const msg = err?.response?.data?.message || err?.message || "Unknown error";
    console.error("Paystack init error:", err?.response?.data || err);
    return res.status(500).json({
      error: "Payment initialization failed",
      message: msg,
      raw: err?.response?.data || null,
    });
  }
});

// ---------- OPTIONAL: one-off amount initialize (diagnostic) ----------
app.post("/api/paystack/initialize-once", async (req, res) => {
  try {
    const { email, amountGHS = 49 } = req.body || {};
    if (!email) return res.status(400).json({ error: "email required" });
    if (!PAYSTACK_SECRET_KEY) return res.status(500).json({ error: "PAYSTACK_SECRET_KEY missing" });

    const payload = {
      email,
      amount: Math.round(Number(amountGHS) * 100), // pesewas
      currency: "GHS",
      callback_url: `${PUBLIC_URL}/payment/callback`,
      metadata: { test_once: true },
    };

    const { data } = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      payload,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" } }
    );

    if (!data?.status) {
      return res.status(400).json({
        error: "Paystack init failed",
        message: data?.message || "No message from Paystack",
        raw: data,
      });
    }

    return res.json({
      authorization_url: data.data.authorization_url,
      reference: data.data.reference,
    });
  } catch (err) {
    console.error("Paystack once-off init error:", err?.response?.data || err);
    return res.status(500).json({
      error: "Payment initialization failed",
      message: err?.response?.data?.message || err?.message || "Unknown error",
    });
  }
});

// ---------- PAYSTACK: Webhook ----------
app.post("/api/paystack/webhook", async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const computed = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY || "").update(req.body).digest("hex");
  if (signature !== computed) {
    return res.sendStatus(401);
  }

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
        planCode === PLAN_CODES.pro ? "pro" :
        "unknown";

      // Upsert payment
      await prisma.payment.upsert({
        where: { reference: reference || "" },
        update: { status: "success", amountMinor: amount ?? undefined, currency, rawWebhookEvent: event },
        create: {
          userId: user?.id || null,
          provider: "paystack",
          reference: reference || `ref_${Date.now()}`,
          amountMinor: amount ?? null,
          currency,
          status: "success",
          rawWebhookEvent: event,
        },
      });

      // Activate subscription (if plan recognized)
      if (planKey !== "unknown") {
        await prisma.subscription.upsert({
          where: { userId_plan: { userId: user?.id || "", plan: planKey } },
          update: { status: "active", providerPlanCode: planCode, lastPaidAt: new Date() },
          create: {
            userId: user?.id || "",
            plan: planKey,
            status: "active",
            provider: "paystack",
            providerPlanCode: planCode || null,
            lastPaidAt: new Date(),
          },
        });
      }
    }

    if (evt === "invoice.payment_failed" || evt === "charge.failed") {
      if (reference) {
        await prisma.payment.updateMany({ where: { reference }, data: { status: "failed" } });
      }
    }

    if (evt === "subscription.disable" && email && planCode) {
      const user = await prisma.user.findUnique({ where: { email } });
      if (user) {
        const planKey = planCode === PLAN_CODES.premium ? "premium" : planCode === PLAN_CODES.pro ? "pro" : null;
        if (planKey) {
          await prisma.subscription.updateMany({
            where: { userId: user.id, plan: planKey },
            data: { status: "canceled" },
          });
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// ---------- Subscription status (used by chat gating) ----------
app.get("/api/subscription/status/:email", async (req, res) => {
  try {
    const { email } = req.params;
    if (!email) return res.status(400).json({ error: "email required" });

    const user = await prisma.user.findUnique({
      where: { email },
      include: { subscriptions: true },
    });

    if (!user) return res.json({ status: "none" });

    const activeSub = user.subscriptions.find((s) => s.status === "active");
    if (activeSub) {
      return res.json({ status: "active", plan: activeSub.plan, since: activeSub.lastPaidAt });
    }
    return res.json({ status: "free" });
  } catch (err) {
    console.error("Status error:", err);
    res.status(500).json({ error: "Failed to check subscription status" });
  }
});

// ---------- Chat (GPT-4 text + image) ----------
app.post("/api/chat", async (req, res) => {
  try {
    const { email, assistant = "Math GPT", message = "", image = null } = req.body || {};
    if (!message && !image) return res.status(400).json({ error: "message or image required" });

    if (email) await createOrGetUser(email).catch(() => {});

    const userContent = [];
    if (message && message.trim()) userContent.push({ type: "text", text: message.trim() });
    if (image && typeof image === "string") {
      // Accept data URLs or remote URLs
      userContent.push({ type: "image_url", image_url: image });
    }

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL, // defaults to gpt-4 via env
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPromptFor(assistant) },
        { role: "user", content: userContent },
      ],
    });

    const answer = completion?.choices?.[0]?.message?.content?.trim() || "No response from the AI.";
    res.json({ content: answer });
  } catch (err) {
    console.error("Chat error:", err?.response?.data || err);
    res.status(500).json({ error: "Failed to get an answer from OpenAI" });
  }
});

// ---------- Callback page (user redirect after Paystack checkout) ----------
app.get("/payment/callback", (_req, res) => {
  // Display a simple confirmation; the webhook is the source of truth.
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment callback</title>
<style>
  body{margin:0;background:linear-gradient(180deg,#0b0c10 0%,#0f1118 100%);color:#e9edf5;
       font-family:Inter,system-ui,Segoe UI,Roboto,Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}
  .card{background:#141720;border:1px solid #232635;border-radius:16px;padding:28px;max-width:520px;text-align:center}
  .btn{display:inline-block;margin-top:14px;background:#5b8cff;color:#fff;border:none;border-radius:12px;padding:12px 16px;font-weight:700;text-decoration:none}
  .muted{color:#9aa3b2}
</style></head>
<body>
  <div class="card">
    <h2>Payment received</h2>
    <p class="muted">Thanks! If this was successful, your subscription will activate shortly.</p>
    <a class="btn" href="/chat.html">Go to Chat</a>
    <p class="muted" style="margin-top:10px">If your access hasn't updated yet, wait a few seconds and refresh — activation is handled by the webhook.</p>
  </div>
</body></html>`);
});

// ---------- Health & Fallback ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// SPA fallback: serve index for unknown routes
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
