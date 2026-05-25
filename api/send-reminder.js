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

const ADMIN_UID = "GsOTllyMKMadvh87Urqg8kgZ8X62";

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido" });

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);

    // Valida que é o admin
    const { adminUid, emails } = body;
    if (adminUid !== ADMIN_UID) {
      return res.status(403).json({ error: "Acesso não autorizado" });
    }

    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: "Nenhum email informado" });
    }

    const resultados = [];

    for (const item of emails) {
      const { email, diasRestantes } = item;
      if (!email) continue;

      const htmlEmail =
        "<div style='font-family:sans-serif;max-width:480px;margin:0 auto;background:#0d1117;color:#fff;padding:32px;border-radius:16px'>" +
        "<h2 style='color:#22c55e;text-align:center;margin-bottom:8px'>Sua assinatura está expirando! ⏰</h2>" +
        "<p style='color:rgba(255,255,255,.6);text-align:center;margin-bottom:24px'>Faltam apenas <strong style='color:#ffb800'>" + diasRestantes + " dia(s)</strong> para seu acesso encerrar.</p>" +
        "<div style='background:#1a1f2e;border:1.5px solid #22c55e;border-radius:12px;padding:20px;text-align:center;margin:20px 0'>" +
        "<p style='color:rgba(255,255,255,.8);font-size:14px;line-height:1.7;margin:0'>Renove agora e continue tendo acesso às melhores surebets do mercado.<br>Não perca sua sequência! 🚀</p>" +
        "</div>" +
        "<div style='text-align:center;margin-top:24px'>" +
        "<a href='https://suregreen.com.br' style='background:#22c55e;color:#020d05;padding:14px 32px;border-radius:999px;text-decoration:none;font-weight:800;font-size:15px'>Renovar agora</a>" +
        "</div>" +
        "<p style='color:rgba(255,255,255,.3);font-size:12px;text-align:center;margin-top:24px'>SureGreen — Apostas inteligentes</p>" +
        "</div>";

      try {
        await resend.emails.send({
          from: "SureGreen <noreply@suregreen.com.br>",
          to: email,
          subject: "⏰ Sua assinatura SureGreen expira em " + diasRestantes + " dia(s)!",
          html: htmlEmail,
        });
        resultados.push({ email, status: "enviado" });
        console.log("Lembrete enviado para:", email);
      } catch (err) {
        resultados.push({ email, status: "erro", erro: err.message });
        console.error("Erro ao enviar para", email, err.message);
      }
    }

    const enviados = resultados.filter(r => r.status === "enviado").length;
    return res.status(200).json({ success: true, enviados, total: emails.length, resultados });

  } catch (err) {
    console.error("Erro geral:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
