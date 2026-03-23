export default async function handler(req, res) {
  // Apenas POST permitido
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { email } = req.body;

  if (!email || email.indexOf('@') < 1) {
    return res.status(400).json({ error: 'E-mail inválido' });
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'SureGreen <noreply@suregreen.com.br>',
        to: [email],
        subject: 'Redefina sua senha — SureGreen',
        html: `
          <div style="font-family:Inter,sans-serif;background:#080b0f;padding:40px 0;min-height:100vh">
            <div style="max-width:480px;margin:0 auto;background:#0f1621;border:1px solid rgba(34,240,117,.18);border-radius:16px;padding:40px 36px">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:28px">
                <span style="font-size:1.2rem;font-weight:800;color:#eef2f0">Sure<span style="color:#22f075">Green</span></span>
              </div>
              <h1 style="color:#eef2f0;font-size:1.4rem;font-weight:800;margin:0 0 10px;letter-spacing:-.5px">Redefinição de senha</h1>
              <p style="color:#5a7568;font-size:.9rem;line-height:1.7;margin:0 0 28px">
                Recebemos uma solicitação para redefinir a senha da sua conta SureGreen.
                Clique no botão abaixo para criar uma nova senha.
              </p>
              <p style="color:#5a7568;font-size:.85rem;line-height:1.7;margin:0 0 28px">
                Se você não solicitou a redefinição, ignore este e-mail. Sua senha permanece a mesma.
              </p>
              <hr style="border:none;border-top:1px solid rgba(255,255,255,.06);margin:28px 0">
              <p style="color:#2e4038;font-size:.75rem;text-align:center;margin:0">
                © 2026 SureGreen. Todos os direitos reservados.
              </p>
            </div>
          </div>
        `
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(500).json({ error: err.message || 'Erro ao enviar e-mail' });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
