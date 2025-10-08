// server.js
import express from "express";
import cors from "cors";
import axios from "axios";
import crypto from "crypto";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";

const app = express();
const prisma = new PrismaClient();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY; // sk_live_xxx or sk_test_xxx
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`; // e.g., https://yourapp.up.railway.app

// Plans (create these in Paystack Dashboard -> Plans, then paste plan codes here)
const PLAN_CODES = {
  premium: process.env.PAYSTACK_PLAN_PREMIUM, // e.g. PLN_abc123
  pro: process.env.PAYSTACK_PLAN_PRO // e.g. PLN_def456
};

if (!PAYSTACK_SECRET_KEY) {
  console.warn("⚠️  Missing PAYSTACK_SECRET_KEY in env");
}

// We need raw body for webhook signature verification
app.use("/api/paystack/webhook", bodyParser.raw({ type: "*/*" }));
app.use(express.json());
app.use(cors());

// ---------- Static ----------
app.use(express.static(path.join(__dirname, "public"))); // put index.html, chat.html in ./public

// ---------- Helpers ----------
function toMinorUnits(ghs) {
  // Paystack expects the lowest denomination (pesewas). 49.00 -> 4900
  return Math.round(Number(ghs) * 100);
}

async function createOrGetUser(email) {
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({ data: { email } });
  }
  return user;
}

// ---------- API: Initialize Transaction ----------
app.post("/api/paystack/initialize", async (req, res) => {
  try {
    const { email, plan } = req.body || {};
    if (!email || !plan) return res.status(400).json({ error: "email and plan are required" });

    const planCode = PLAN_CODES[plan];
    if (!planCode) return res.status(400).json({ error: "Unknown plan" });

    const user = await createOrGetUser(email);

    // Initialize a subscription transaction tied to a Plan
    // NOTE: For Ghana (GHS), set currency:'GHS'. Amount is ignored when using plan, but some setups require it present.
    const initPayload = {
      email,
      plan: planCode,
      currency: "GHS",
      callback_url: `${PUBLIC_URL}/payment/callback`,
      metadata: {
        user_id: user.id,
        plan_key: plan,
        source: "math-gpt-landing"
      }
    };

    const { data } = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      initPayload,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" } }
    );

    if (!data?.status) {
      return res.status(400).json({ error: "Paystack init failed", details: data });
    }

    // Persist a pending Payment row
    await prisma.payment.create({
      data: {
        userId: user.id,
        provider: "paystack",
        reference: data.data.reference,
        amountMinor: null, // Paystack with plan doesn't return amount here reliably
        currency: "GHS",
        status: "initialized",
        rawInitResponse: data.data
      }
    });

    return res.status(200).json({
      authorization_url: data.data.authorization_url,
      reference: data.data.reference
    });
  } catch (err) {
    console.error(err?.response?.data || err);
    return res.status(500).json({ error: "Internal error initializing payment" });
  }
});

// ---------- Webhook ----------
app.post("/api/paystack/webhook", async (req, res) => {
  // Verify signature
  const signature = req.headers["x-paystack-signature"];
  const computed = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(req.body).digest("hex");
  if (signature !== computed) {
    return res.status(401).send("Invalid signature");
  }

  try {
    const event = JSON.parse(req.body.toString("utf8"));

    // We care about: charge.success (initial), invoice.create, subscription.create, subscription.disable, invoice.payment_failed, etc.
    const evt = event?.event;

    if (evt === "charge.success") {
      const reference = event?.data?.reference;
      const email = event?.data?.customer?.email;
      const amount = event?.data?.amount; // minor units
      const currency = event?.data?.currency || "GHS";
      const planCode = event?.data?.plan || event?.data?.plan_object?.plan_code;

      if (reference && email) {
        const user = await createOrGetUser(email);

        // Upsert subscription based on plan code
        let planKey = null;
        if (planCode && planCode === PLAN_CODES.premium) planKey = "premium";
        if (planCode && planCode === PLAN_CODES.pro) planKey = "pro";

        // Payment record update
        await prisma.payment.upsert({
          where: { reference },
          update: {
            status: "success",
            amountMinor: amount ?? undefined,
            currency
          },
          create: {
            userId: user.id,
            provider: "paystack",
            reference,
            amountMinor: amount ?? null,
            currency,
            status: "success",
            rawWebhookEvent: event
          }
        });

        // Activate or create subscription
        if (planKey) {
          await prisma.subscription.upsert({
            where: { userId_plan: { userId: user.id, plan: planKey } },
            update: {
              status: "active",
              provider: "paystack",
              providerPlanCode: planCode,
              lastPaidAt: new Date()
            },
            create: {
              userId: user.id,
              plan: planKey,
              status: "active",
              provider: "paystack",
              providerPlanCode: planCode,
              lastPaidAt: new Date()
            }
          });
        }
      }
    }

    // Mark failed payments
    if (evt === "invoice.payment_failed" || evt === "charge.failed") {
      const reference = event?.data?.reference;
      if (reference) {
        await prisma.payment.updateMany({
          where: { reference },
          data: { status: "failed" }
        });
      }
    }

    // Handle subscription disable/cancel
    if (evt === "subscription.disable") {
      const email = event?.data?.customer?.email;
      const planCode = event?.data?.plan || event?.data?.plan_object?.plan_code;
      if (email && planCode) {
        const user = await prisma.user.findUnique({ where: { email } });
        if (user) {
          let planKey = null;
          if (planCode === PLAN_CODES.premium) planKey = "premium";
          if (planCode === PLAN_CODES.pro) planKey = "pro";
          if (planKey) {
            await prisma.subscription.updateMany({
              where: { userId: user.id, plan: planKey },
              data: { status: "canceled" }
            });
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// ---------- Minimal health & fallback ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`✅ Server listening on ${PORT}`);
});
