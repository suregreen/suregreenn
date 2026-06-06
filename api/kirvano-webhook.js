const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { Resend } = require("resend");
const crypto = require("crypto");

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

const db = getFirestore();
const resend = new Resend(process.env.RESEND_API_KEY);

// ── Extrai transaction_id do payload Kirvano ──
function extractTransactionId(body, email, valorPago, agora) {
  const raw =
    (body.id && String(body.id)) ||
    (body.order_id && String(body.order_id)) ||
    (body.payment?.id && String(body.payment.id)) ||
    (body.transaction_id && String(body.transaction_id)) ||
    (body.checkout?.id && String(body.checkout.id));

  if (raw) return raw;

  // Fallback determinístico — mesma compra sempre gera o mesmo ID
  const base = `${email}_${valorPago || 0}_${agora.toISOString().slice(0, 10)}`;
  return "sg_" + crypto.createHash("md5").update(base).digest("hex").slice(0, 12);
}

// ── Envia evento purchase para GA4 via Measurement Protocol ──
async function sendGA4Purchase(transactionId, value, planName) {
  try {
    if (!process.env.GA4_API_SECRET) return;
    const payload = {
      client_id: transactionId,
      events: [{
        name: "purchase",
        params: {
          transaction_id: transactionId,
          value: value || 0,
          currency: "BRL",
          items: [{
            item_name: "SureGreen " + (planName || "mensal"),
            price: value || 0,
            quantity: 1
          }]
        }
      }]
    };
    console.log("=== INICIO SEND GA4 ===");
    console.log("Tentando enviar purchase GA4:", transactionId, value);
    const response = await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=G-E50PBPX0KF&api_secret=${process.env.GA4_API_SECRET}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    );
    console.log("GA4 response status:", response.status);
    console.log("GA4 purchase enviado:", transactionId, value);
  } catch (e) {
    console.error("GA4 erro:", e.message);
  }
}

module.exports = async function handler(req, res) {
  console.log("Metodo:", req.method);
  console.log("Headers:", JSON.stringify(req.headers));
  console.log("Body:", JSON.stringify(req.body));

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);

    const status = ((body && body.status) ? body.status : "").toUpperCase();
    const email = body && body.customer ? body.customer.email : null;

    console.log("Status:", status, "Email:", email);
    console.log("STATUS RECEBIDO KIRVANO:", status);
    console.log("BODY COMPLETO KIRVANO:", JSON.stringify(body));

    // ── REEMBOLSO / CHARGEBACK — revoga acesso imediatamente ──
    const REFUND_STATUSES = ["REFUNDED", "REFUND", "CHARGEBACK", "CHARGEBACKED", "CANCELLED", "CANCELED", "DISPUTE", "DISPUTED"];
    if (REFUND_STATUSES.includes(status)) {
      console.log("Evento de reembolso detectado:", status, "Email:", email);

      if (!email) {
        return res.status(200).json({ message: "Reembolso sem email" });
      }

      const agora = new Date();
      const snap = await db.collection("usuarios").where("email", "==", email).limit(1).get();

      if (!snap.empty) {
        await snap.docs[0].ref.update({
          assinatura_expira: Timestamp.fromDate(agora),
          status: "revogado",
          revoadadoEm: Timestamp.fromDate(agora),
          motivoRevogacao: status,
        });
        console.log("Acesso revogado:", email, "| Motivo:", status);
      } else {
        console.log("Reembolso recebido mas usuário não encontrado:", email);
      }

      return res.status(200).json({ message: "Acesso revogado", email, status });
    }

    if (!["APPROVED", "PAID", "COMPLETE", "COMPLETED"].includes(status)) {
      return res.status(200).json({ message: "Ignorado. Status: " + status });
    }

    if (!email) {
      return res.status(200).json({ error: "Email nao encontrado" });
    }

    const agora = new Date();
    const expiracao = new Date(agora);

    const nomePlano = (
      body?.plan?.name ||
      body?.product?.name ||
      body?.offer?.name ||
      (Array.isArray(body?.products) && body.products[0]?.name) ||
      ""
    ).toLowerCase();
    console.log("Plano normalizado:", nomePlano);

    console.log("Plano detectado:", nomePlano);

    let diasAcesso = 30;
    if (nomePlano.includes("trimestral") || nomePlano.includes("3 meses")) {
      diasAcesso = 90;
    } else if (nomePlano.includes("semestral") || nomePlano.includes("6 meses")) {
      diasAcesso = 180;
    } else if (nomePlano.includes("anual") || nomePlano.includes("12 meses")) {
      diasAcesso = 365;
    }

    console.log("Dias de acesso:", diasAcesso);

    expiracao.setDate(expiracao.getDate() + diasAcesso);
    const assinatura_expira = Timestamp.fromDate(expiracao);

    const valorPago = (() => {
      if (body?.payment?.amount) return body.payment.amount / 100;
      if (body?.amount && typeof body.amount === "number") return body.amount / 100;
      if (body?.total_price) {
        const n = parseFloat(String(body.total_price).replace(/[^0-9,]/g, "").replace(",", "."));
        return isNaN(n) ? null : n;
      }
      return null;
    })();
    console.log("Valor pago normalizado:", valorPago);

    const metodoPagamento = (body && body.payment && body.payment.method)
      ? body.payment.method
      : (body && body.payment_method)
      ? body.payment_method
      : "desconhecido";

    // ── Transaction ID seguro ──
    let transactionId = extractTransactionId(body, email, valorPago, agora);

    // ── Detecta webhook de teste ──
    const isTestWebhook = !!(
      body.test === true ||
      body.mode === "test" ||
      body.is_test === true ||
      body.event === "test" ||
      body.environment === "test" ||
      body.customer?.email === "exemplo@email.com"
    );

    console.log("Webhook teste Kirvano?", isTestWebhook);

    if (isTestWebhook) {
      transactionId = transactionId + "_test_" + Date.now();
    }

    console.log("Transaction ID final:", transactionId);

    // ── Verifica se usuário já existe (renovação) ──
    const usuariosSnap = await db
      .collection("usuarios")
      .where("email", "==", email)
      .limit(1)
      .get();

    if (!usuariosSnap.empty) {
      // ── RENOVAÇÃO ──
      const usuarioDoc = usuariosSnap.docs[0];
      const dadosAtuais = usuarioDoc.data();

      let baseRenovacao = new Date();
      if (dadosAtuais.assinatura_expira) {
        const vencimentoAtual = dadosAtuais.assinatura_expira.toDate();
        if (vencimentoAtual > baseRenovacao) baseRenovacao = vencimentoAtual;
      }
      const novaExpiracao = new Date(baseRenovacao);
      novaExpiracao.setDate(novaExpiracao.getDate() + diasAcesso);

      await usuarioDoc.ref.update({
        assinatura_expira: Timestamp.fromDate(novaExpiracao),
        renovadoEm: Timestamp.fromDate(agora),
        plano: nomePlano || "mensal",
      });

      // ── Tenta criar pagamento — .create() falha se já existe ──
      try {
        await db.collection("pagamentos").doc(transactionId).create({
          email,
          tipo: "renovacao",
          plano: nomePlano || "mensal",
          diasAcesso,
          valor: valorPago,
          metodoPagamento,
          transaction_id: transactionId,
          criadoEm: Timestamp.fromDate(agora),
        });
        // Só chega aqui se criou com sucesso — envia GA4 (sem await — não bloqueia o webhook)
        try {
          console.log("=== ANTES DO GA4 ===");
          console.log("transactionId:", transactionId);
          console.log("valorPago:", valorPago);
          console.log("nomePlano:", nomePlano);
          console.log("GA4_API_SECRET existe?", !!process.env.GA4_API_SECRET);
          await sendGA4Purchase(transactionId, valorPago, nomePlano);
        } catch (ga4Error) {
          console.error("GA4 falhou, mas venda continua:", ga4Error.message);
        }
      } catch (e) {
        if (e.code === 6 || e.code === "already-exists" || String(e.message).includes("Already exists")) {
          console.log("Pagamento duplicado ignorado (renovacao):", transactionId);
        } else {
          throw e;
        }
      }

      console.log("Assinatura renovada para:", email, "| Dias:", diasAcesso);
      return res.status(200).json({ success: true, renovacao: true, email, diasAcesso });
    }

    // ── NOVO CLIENTE ──
    const snap = await db
      .collection("codigos")
      .where("usado", "==", false)
      .where("reservado", "==", false)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(200).json({ error: "Sem codigos disponiveis" });
    }

    const codigoDoc = snap.docs[0];
    const codigo = codigoDoc.id;

    await codigoDoc.ref.update({
      reservado: true,
      email,
      reservadoEm: Timestamp.fromDate(agora),
      assinatura_expira,
    });

    await db.collection("usuarios").doc("pendente_" + codigo).set({
      email,
      codigo,
      assinatura_expira,
      criadoEm: Timestamp.fromDate(agora),
      status: "pendente",
    });

    // ── Tenta criar pagamento — .create() falha se já existe ──
    try {
      await db.collection("pagamentos").doc(transactionId).create({
        email,
        tipo: "novo_cliente",
        plano: nomePlano || "mensal",
        diasAcesso,
        valor: valorPago,
        metodoPagamento,
        transaction_id: transactionId,
        criadoEm: Timestamp.fromDate(agora),
      });
      // Só chega aqui se criou com sucesso — envia GA4
      try {
        console.log("=== ANTES DO GA4 ===");
        console.log("transactionId:", transactionId);
        console.log("valorPago:", valorPago);
        console.log("nomePlano:", nomePlano);
        console.log("GA4_API_SECRET existe?", !!process.env.GA4_API_SECRET);
        await sendGA4Purchase(transactionId, valorPago, nomePlano);
      } catch (ga4Error) {
        console.error("GA4 falhou, mas venda continua:", ga4Error.message);
      }
    } catch (e) {
      if (e.code === 6 || e.code === "already-exists" || String(e.message).includes("Already exists")) {
        console.log("Pagamento duplicado ignorado (novo_cliente):", transactionId);
      } else {
        throw e;
      }
    }

    // ── Envia e-mail com o código (premium) ──
    const linkAcesso = "https://suregreen.com.br/?codigo=" + codigo;
    const htmlEmail =
      "<div style='background:#060a0f;padding:40px 20px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif'>" +
        "<div style='max-width:480px;margin:0 auto;background:linear-gradient(160deg,#0e1621,#0a0f17);border:1px solid rgba(34,197,94,.15);border-radius:20px;overflow:hidden'>" +
          "<div style='padding:36px 32px 28px;text-align:center;border-bottom:1px solid rgba(255,255,255,.05)'>" +
            "<div style='font-size:22px;font-weight:800;letter-spacing:-.5px'><span style='color:#fff'>Sure</span><span style='color:#22c55e'>Green</span></div>" +
            "<div style='color:rgba(255,255,255,.4);font-size:12px;margin-top:6px;letter-spacing:.5px'>GESTAO PROFISSIONAL DE APOSTAS</div>" +
          "</div>" +
          "<div style='padding:36px 32px'>" +
            "<h1 style='color:#fff;font-size:22px;font-weight:700;margin:0 0 8px;text-align:center'>Pagamento confirmado!</h1>" +
            "<p style='color:rgba(255,255,255,.55);font-size:14px;line-height:1.6;text-align:center;margin:0 0 28px'>Sua conta esta pronta. Clique no botao abaixo para ativar seu acesso — seu codigo ja vai preenchido.</p>" +
            "<div style='text-align:center;margin:0 0 28px'>" +
              "<a href='" + linkAcesso + "' style='display:inline-block;background:linear-gradient(135deg,#22c55e,#16a34a);color:#04140a;padding:16px 40px;border-radius:999px;text-decoration:none;font-weight:800;font-size:16px;box-shadow:0 8px 24px rgba(34,197,94,.3)'>Ativar meu acesso &rarr;</a>" +
            "</div>" +
            "<div style='background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:18px;text-align:center'>" +
              "<div style='color:rgba(255,255,255,.4);font-size:11px;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px'>Seu codigo de acesso</div>" +
              "<div style='font-size:24px;font-weight:800;color:#22c55e;letter-spacing:5px;font-family:monospace'>" + codigo + "</div>" +
            "</div>" +
            "<p style='color:rgba(255,255,255,.35);font-size:12px;line-height:1.6;text-align:center;margin:20px 0 0'>O botao acima ja abre o cadastro com seu codigo preenchido.<br>Se preferir, acesse <strong style='color:rgba(255,255,255,.6)'>suregreen.com.br</strong> e digite o codigo manualmente.</p>" +
          "</div>" +
          "<div style='padding:20px 32px;border-top:1px solid rgba(255,255,255,.05);text-align:center'>" +
            "<p style='color:rgba(255,255,255,.3);font-size:11px;margin:0;line-height:1.6'>Precisa de ajuda? Responda este e-mail.<br>SureGreen &copy; 2026</p>" +
          "</div>" +
        "</div>" +
      "</div>";

    await resend.emails.send({
      from: "SureGreen <noreply@suregreen.com.br>",
      to: email,
      subject: "Seu acesso SureGreen esta pronto",
      html: htmlEmail,
    });

    console.log("Codigo enviado:", codigo, "para:", email);
    return res.status(200).json({ success: true, codigo });

  } catch (err) {
    console.error("Erro:", err.message);
    return res.status(200).json({ error: err.message });
  }
};
