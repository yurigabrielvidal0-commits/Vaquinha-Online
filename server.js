const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

const API = "https://pixghost.site/api.php";
const STATUS = "https://pixghost.site/check_status.php";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// =====================================================
// BANCO DE DADOS
// =====================================================

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS donations (
      id SERIAL PRIMARY KEY,
      external_id TEXT UNIQUE NOT NULL,
      pix_id TEXT,
      amount NUMERIC(12,2) NOT NULL,
      amount_net NUMERIC(12,2),
      status TEXT NOT NULL DEFAULT 'pending',
      customer_name TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      paid_at TIMESTAMP
    )
  `);

  console.log("Banco de dados pronto.");
}

// =====================================================
// WEBHOOK LUNARPAY
// =====================================================

app.post(
  "/webhook/lunarpay",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const key = process.env.LUNARPAY_API_KEY;

      if (!key) {
        return res.sendStatus(500);
      }

      const signature = req.get("X-LunarPay-Signature") || "";
      const raw = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from("");

      const expected =
        "sha256=" +
        crypto
          .createHmac("sha256", key)
          .update(raw)
          .digest("hex");

      const a = Buffer.from(signature);
      const b = Buffer.from(expected);

      if (
        a.length !== b.length ||
        !crypto.timingSafeEqual(a, b)
      ) {
        console.log("Webhook: assinatura inválida.");
        return res.sendStatus(401);
      }

      const data = JSON.parse(raw.toString("utf8"));

      console.log("Webhook LunarPay:", data);

      if (
        data.event === "payment.completed" ||
        data.status === "paid"
      ) {
        if (data.external_id) {
          await pool.query(
            `
            UPDATE donations
            SET
              status = 'paid',
              pix_id = COALESCE($1, pix_id),
              amount_net = COALESCE($2, amount_net),
              customer_name = COALESCE($3, customer_name),
              paid_at = COALESCE(paid_at, NOW())
            WHERE external_id = $4
            `,
            [
              data.pix_id || null,
              data.amount_net || null,
              data.customer_name || null,
              data.external_id
            ]
          );
        }
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error("Erro no webhook:", error);
      return res.sendStatus(400);
    }
  }
);

// =====================================================
// JSON
// =====================================================

app.use(express.json({ limit: "100kb" }));

app.use(express.static(path.join(__dirname)));

// =====================================================
// URL PÚBLICA
// =====================================================

function publicUrl(req) {
  return (
    process.env.PUBLIC_URL ||
    `${req.protocol}://${req.get("host")}`
  ).replace(/\/$/, "");
}

// =====================================================
// CRIAR COBRANÇA PIX
// =====================================================

app.post("/api/create-charge", async (req, res) => {
  try {
    const amount = Number(req.body?.amount);

    if (!Number.isFinite(amount) || amount < 5) {
      return res.status(400).json({
        success: false,
        error: "O valor mínimo para a doação é R$ 5,00."
      });
    }

    const external_id =
      `doacao_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;

    const response = await fetch(API, {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${process.env.LUNARPAY_API_KEY || ""}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        amount: Math.round(amount * 100) / 100,
        external_id,
        callback_url:
          `${publicUrl(req)}/webhook/lunarpay`
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.success) {
      return res.status(response.status || 502).json({
        success: false,
        error:
          data.error ||
          data.message ||
          "A LunarPay não conseguiu gerar o Pix."
      });
    }

    // Salva a doação como pendente
    await pool.query(
      `
      INSERT INTO donations
        (external_id, pix_id, amount, status)
      VALUES
        ($1, $2, $3, 'pending')
      ON CONFLICT (external_id) DO NOTHING
      `,
      [
        external_id,
        data.pix_id || null,
        Number(data.amount || amount)
      ]
    );

    res.json({
      success: true,
      external_id,
      pix_id: data.pix_id,
      amount: data.amount,
      pix_code: data.pix_code,
      qr_image: data.qr_image
    });

  } catch (error) {
    console.error("Erro ao criar cobrança:", error);

    res.status(500).json({
      success: false,
      error: "Erro interno ao gerar o Pix."
    });
  }
});

// =====================================================
// CONSULTAR STATUS DO PAGAMENTO
// =====================================================

app.get("/api/status", async (req, res) => {
  try {
    const external_id =
      String(req.query.external_id || "").trim();

    if (!external_id) {
      return res.status(400).json({
        success: false,
        error: "external_id obrigatório."
      });
    }

    const response = await fetch(
      `${STATUS}?external_id=${encodeURIComponent(external_id)}`,
      {
        headers: {
          Authorization:
            `Bearer ${process.env.LUNARPAY_API_KEY || ""}`,
          Accept: "application/json"
        }
      }
    );

    const data = await response.json().catch(() => ({}));

    // Se a LunarPay confirmar pagamento,
    // atualizamos também o nosso banco.
    if (
      response.ok &&
      (data.status === "paid" ||
        data.event === "payment.completed")
    ) {
      await pool.query(
        `
        UPDATE donations
        SET
          status = 'paid',
          amount_net = COALESCE($1, amount_net),
          paid_at = COALESCE(paid_at, NOW())
        WHERE external_id = $2
        `,
        [
          data.amount_net || null,
          external_id
        ]
      );
    }

    res
      .status(response.ok ? 200 : response.status || 502)
      .json(data);

  } catch (error) {
    console.error("Erro ao consultar status:", error);

    res.status(500).json({
      success: false,
      error: "Erro interno ao consultar o pagamento."
    });
  }
});

// =====================================================
// TOTAL DA VAQUINHA
// =====================================================

app.get("/api/campaign", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COALESCE(SUM(amount), 0) AS total,
        COUNT(*) AS supporters
      FROM donations
      WHERE status = 'paid'
    `);

    const total = Number(result.rows[0].total || 0);
    const supporters = Number(result.rows[0].supporters || 0);

    res.json({
      success: true,
      total,
      supporters,
      goal: 10000,
      progress: Math.min((total / 10000) * 100, 100)
    });

  } catch (error) {
    console.error("Erro ao consultar campanha:", error);

    res.status(500).json({
      success: false,
      error: "Erro ao consultar os dados da campanha."
    });
  }
});

// =====================================================
// TESTE
// =====================================================

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      database: true
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      database: false
    });
  }
});

// =====================================================
// PÁGINA PRINCIPAL
// =====================================================

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// =====================================================
// INICIAR
// =====================================================

async function start() {
  try {
    await initDatabase();

    app.listen(PORT, () => {
      console.log(
        `Vaquinha Online na porta ${PORT}`
      );
    });

  } catch (error) {
    console.error(
      "Erro ao iniciar o banco:",
      error
    );

    process.exit(1);
  }
}

start();
