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

    // Kirvano envia status em MAIÚSCULO: "APPROVED"
    const status = (body?.status || body?.data?.status || "").toUpperCase();
    const email = body?.customer?.email || body?.data?.customer?.email;

    if (status !== "APPROVED") {
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
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0d1117;color:#fff;padding:32px;border-radius:16px;">
          <div style="text-align:center;margin-bottom:24px">
            <div style="display:inline-block;background:#22c55e;color:#020d05;font-size:12px;font-weight:800;padding:6px 16px;border-radius:999px;letter-spacing:1px">ACESSO LIBERADO ✅</div>
          </div>
          <h2 style="color:#22c55e;text-align:center;font-size:24px;margin-bottom:8px">Bem-vindo ao SureGreen!</h2>
          <p style="color:rgba(255,255,255,.6);text-align:center;margin-bottom:28px">Seu código de acesso exclusivo é:</p>
          <div style="background:#1a1f2e;border:1.5px solid #22c55e;border-radius:12px;padding:20px;text-align:center;margin-bottom:28px;">
            <div style="font-size:11px;color:rgba(255,255,255,.4);margin-bottom:8px;letter-spacing:2px">CÓDIGO DE ACESSO</div>
            <div style="font-size:28px;font-weight:900;color:#22c55e;letter-spacing:6px;font-family:monospace">${codigo}</div>
          </div>
          <p style="color:rgba(255,255,255,.7);font-size:14px;line-height:1.7;margin-bottom:24px">
            Para acessar a plataforma:<br>
            1. Acesse <strong style="color:#22c55e">suregreen.com.br</strong><br>
            2. Clique em <strong>Criar conta</strong><br>
            3. Digite seu e-mail, uma senha e o código acima
          </p>
          <div style="text-align:center">
            <a href="https://suregreen.com.br" style="display:inline-block;background:#22c55e;color:#020d05;padding:14px 32px;border-radius:999px;text-decoration:none;font-weight:800;font-size:15px;">
              Acessar SureGreen →
            </a>
          </div>
          <p style="color:rgba(255,255,255,.3);font-size:11px;text-align:center;margin-top:24px">Este código é pessoal e intransferível.</p>
        </div>
      `,
    });

    await codigoDoc.ref.update({ usado: true, reservado: false });

    return res.status(200).json({ success: true, message: "Codigo enviado com sucesso!" });

  } catch (err) {
    console.error("Erro no webhook:", err);
    return res.status(500).json({ error: "Erro interno: " + err.message });
  }
};
