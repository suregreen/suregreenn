const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { Resend } = require('resend');

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail obrigatório' });

  try {
    const resetLink = await getAuth().generatePasswordResetLink(email);

    await resend.emails.send({
      from: 'noreply@suregreen.com.br',
      to: email,
      subject: 'Redefinição de senha — SureGreen',
      html: `
        <!DOCTYPE html><html lang="pt-BR">
        <body style="margin:0;padding:0;background:#080b0f;font-family:'Inter',Arial,sans-serif">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#080b0f;padding:40px 20px">
            <tr><td align="center">
              <table width="100%" style="max-width:480px;background:#0f1621;border:1px solid rgba(34,240,117,.18);border-radius:16px;overflow:hidden">
                <tr><td style="background:#0b0f15;padding:24px 32px;border-bottom:1px solid rgba(255,255,255,.06)">
                  <span style="font-size:16px;font-weight:800;color:#eef2f0">Sure<span style="color:#22f075">Green</span></span>
                </td></tr>
                <tr><td style="padding:36px 32px">
                  <div style="font-size:36px;margin-bottom:16px">🔐</div>
                  <h1 style="margin:0 0 10px;font-size:22px;font-weight:900;color:#eef2f0">Redefinição de senha</h1>
                  <p style="margin:0 0 24px;font-size:14px;color:#5a7568;line-height:1.7">
                    Recebemos uma solicitação para redefinir a senha da sua conta SureGreen.
                    Clique no botão abaixo para criar uma nova senha.
                  </p>
                  <a href="${resetLink}" style="display:inline-block;background:#22f075;color:#020d05;text-decoration:none;padding:14px 32px;border-radius:999px;font-weight:800;font-size:15px">
                    Redefinir minha senha →
                  </a>
                  <p style="margin:24px 0 0;font-size:12px;color:#2e4038;line-height:1.6">
                    Se não solicitou, ignore este e-mail. O link expira em 1 hora.
                  </p>
                </td></tr>
                <tr><td style="background:#0b0f15;padding:18px 32px;border-top:1px solid rgba(255,255,255,.06);text-align:center">
                  <p style="margin:0;font-size:11px;color:#2e4038">© 2026 SureGreen · <a href="https://suregreen.com.br" style="color:#22f075;text-decoration:none">suregreen.com.br</a></p>
                </td></tr>
              </table>
            </td></tr>
          </table>
        </body></html>
      `,
    });

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Erro reset senha:', err);
    return res.status(500).json({ error: err.message }); // ← agora mostra o erro real
  }
};
