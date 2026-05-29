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

    if (!["APPROVED", "PAID", "COMPLETE", "COMPLETED"].includes(status)) {
      return res.status(200).json({ message: "Ignorado. Status: " + status });
    }

    if (!email) {
      return res.status(200).json({ error: "Email nao encontrado" });
    }

    const agora = new Date();
    const expiracao = new Date(agora);

    const nomePlano = (
      (body && body.plan && body.plan.name) ||
      (body && body.product && body.product.name) ||
      (body && body.offer && body.offer.name) ||
      ""
    ).toLowerCase();

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

    const valorPago = (body && body.payment && body.payment.amount)
      ? body.payment.amount / 100
      : (body && body.amount)
      ? body.amount / 100
      : null;

    const metodoPagamento = (body && body.payment && body.payment.method)
      ? body.payment.method
      : (body && body.payment_method)
      ? body.payment_method
      : "desconhecido";

    // ── Transaction ID seguro ──
    const transactionId = extractTransactionId(body, email, valorPago, agora);
    console.log("Transaction ID:", transactionId);

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

    // ── Envia e-mail com o código ──
    const htmlEmail =
      "<div style='font-family:sans-serif;max-width:480px;margin:0 auto;background:#0d1117;color:#fff;padding:32px;border-radius:16px'>" +
      "<h2 style='color:#22c55e;text-align:center'>Bem-vindo ao SureGreen!</h2>" +
      "<p style='color:rgba(255,255,255,.6);text-align:center'>Seu codigo de acesso:</p>" +
      "<div style='background:#1a1f2e;border:1.5px solid #22c55e;border-radius:12px;padding:20px;text-align:center;margin:20px 0'>" +
      "<div style='font-size:28px;font-weight:900;color:#22c55e;letter-spacing:6px;font-family:monospace'>" + codigo + "</div>" +
      "</div>" +
      "<p style='color:rgba(255,255,255,.7);font-size:14px;line-height:1.7'>" +
      "1. Acesse <strong style='color:#22c55e'>suregreen.com.br</strong><br>" +
      "2. Clique em Criar conta<br>" +
      "3. Digite seu e-mail, senha e o codigo acima</p>" +
      "<div style='text-align:center;margin-top:20px'>" +
      "<a href='https://suregreen.com.br' style='background:#22c55e;color:#020d05;padding:14px 32px;border-radius:999px;text-decoration:none;font-weight:800;font-size:15px'>Acessar SureGreen</a>" +
      "</div></div>";

    await resend.emails.send({
      from: "SureGreen <noreply@suregreen.com.br>",
      to: email,
      subject: "Seu acesso SureGreen chegou!",
      html: htmlEmail,
    });

    console.log("Codigo enviado:", codigo, "para:", email);
    return res.status(200).json({ success: true, codigo });

  } catch (err) {
    console.error("Erro:", err.message);
    return res.status(200).json({ error: err.message });
  }
};
