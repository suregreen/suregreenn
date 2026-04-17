const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { Resend } = require("resend");

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

    // ── Detecta o plano comprado e calcula dias de acesso ──
    const agora = new Date();
    const expiracao = new Date(agora);

    const nomePlano = (
      (body && body.plan && body.plan.name) ||
      (body && body.product && body.product.name) ||
      (body && body.offer && body.offer.name) ||
      ""
    ).toLowerCase();

    console.log("Plano detectado:", nomePlano);

    let diasAcesso = 30; // padrao: mensal
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

    // ── Verifica se esse email já tem um usuário cadastrado ──
    // Se já existe, só renova a assinatura (não precisa de novo código)
    const usuariosSnap = await db
      .collection("usuarios")
      .where("email", "==", email)
      .limit(1)
      .get();

    if (!usuariosSnap.empty) {
      // Cliente já existe — renova a partir da data atual ou do vencimento atual (o que for maior)
      const usuarioDoc = usuariosSnap.docs[0];
      const dadosAtuais = usuarioDoc.data();

      // Se ainda tem dias restantes, soma a partir do vencimento. Senão, soma a partir de hoje.
      let baseRenovacao = new Date();
      if (dadosAtuais.assinatura_expira) {
        const vencimentoAtual = dadosAtuais.assinatura_expira.toDate();
        if (vencimentoAtual > baseRenovacao) {
          baseRenovacao = vencimentoAtual;
        }
      }
      const novaExpiracao = new Date(baseRenovacao);
      novaExpiracao.setDate(novaExpiracao.getDate() + diasAcesso);

      await usuarioDoc.ref.update({
        assinatura_expira: Timestamp.fromDate(novaExpiracao),
        renovadoEm: Timestamp.fromDate(agora),
        plano: nomePlano || "mensal",
      });

      console.log("Assinatura renovada para:", email, "| Dias:", diasAcesso, "| Expira:", novaExpiracao);
      return res.status(200).json({ success: true, renovacao: true, email, diasAcesso });
    }

    // ── Cliente novo — busca um código disponível ──
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

    // Reserva o código (mas NÃO marca usado:true ainda)
    // usado:true só é marcado quando o cliente criar a conta
    await codigoDoc.ref.update({
      reservado: true,
      email: email,
      reservadoEm: Timestamp.fromDate(agora),
      assinatura_expira: assinatura_expira, // salva aqui também para referência
    });

    // ── Salva dados do cliente em usuarios/ (sem uid ainda) ──
    // O uid real é adicionado quando o cliente criar a conta no cadastro.html
    await db.collection("usuarios").doc("pendente_" + codigo).set({
      email: email,
      codigo: codigo,
      assinatura_expira: assinatura_expira,
      criadoEm: Timestamp.fromDate(agora),
      status: "pendente", // vira "ativo" quando criar a conta
    });

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
    return res.status(200).json({ success: true, codigo: codigo });

  } catch (err) {
    console.error("Erro:", err.message);
    return res.status(200).json({ error: err.message });
  }
};
