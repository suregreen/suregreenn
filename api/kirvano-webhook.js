const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
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
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo nao permitido" });
  }

  try {
    const body = req.body;
    const status = body && body.data ? body.data.status : body ? body.status : null;
    const email = body && body.data && body.data.customer ? body.data.customer.email : body && body.customer ? body.customer.email : null;

    if (status !== "approved" && status !== "paid" && status !== "complete") {
      return res.status(200).json({ message: "Pagamento nao aprovado, ignorado." });
    }

    if (!email) {
      return res.status(400).json({ error: "Email do cliente nao encontrado." });
    }

    const codigosRef = db.collection("codigos");
    const snap = await codigosRef
      .where("usado", "==", false)
      .where("reservado", "==", false)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(500).json({ error: "Sem codigos disponiveis." });
    }

    const codigoDoc = snap.docs[0];
    const codigo = codigoDoc.id;

    await codigoDoc.ref.update({
      reservado: true,
      email: email,
      reservadoEm: new Date(),
    });

    await resend.emails.send({
      from: "SureGreen <noreply@suregreen.com.br>",
      to: email,
      subject: "Seu acesso SureGreen chegou!",
      html: "<div style='font-family:sans-serif;max-width:480px;margin:0 auto;background:#0d1117;color:#fff;padding:32px;border-radius:16px;'><h2 style='color:#22c55e;'>Bem-vindo ao SureGreen!</h2><p>Seu codigo de acesso exclusivo e:</p><div style='background:#1a1f2e;border:1px solid #22c55e;border-radius:8px;padding:16px;text-align:center;margin:24px 0;'><span style='font-size:24px;font-weight:bold;color:#22c55e;letter-spacing:4px;'>" + codigo + "</span></div><p>Acesse o site, clique em <strong>Criar conta</strong>, insira seu e-mail, uma senha e esse codigo.</p><a href='https://suregreenn.vercel.app' style='display:inline-block;background:#22c55e;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;margin-top:16px;'>Acessar SureGreen</a><p style='color:#666;font-size:12px;margin-top:24px;'>Este codigo e pessoal e intransferivel.</p></div>",
    });

    await codigoDoc.ref.update({ usado: true, reservado: false });

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error("Erro no webhook:", err);
    return res.status(500).json({ error: "Erro interno." });
  }
};
