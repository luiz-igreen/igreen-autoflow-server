/**
 * SERVIDOR AUTOFLOW iGREEN
 * Este servidor processa faturas automaticamente e liga-se ao Dashboard.
 */

const express = require('express');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// Configuração para ler dados JSON
app.use(express.json());

// Rota de Teste (Página Inicial)
app.get('/', (req, res) => {
  res.send(`
    <div style="font-family: sans-serif; text-align: center; padding: 50px; background-color: #0f172a; color: white; min-height: 100vh;">
      <h1 style="color: #10b981;">Motor iGreen Cloud Ativo! 🚀</h1>
      <p style="color: #94a3b8;">O seu servidor de automação está online e pronto para receber faturas.</p>
      <div style="background: #1e293b; padding: 20px; border-radius: 15px; display: inline-block; border: 1px solid #334155;">
        <span style="color: #10b981;">●</span> <strong>Status:</strong> Operacional
      </div>
    </div>
  `);
});

// Rota do Webhook (Onde o Z-API enviará as faturas)
app.post('/webhook/igreen', async (req, res) => {
  console.log('--- Nova mensagem recebida do WhatsApp ---');
  res.status(200).send('Fatura recebida pelo motor iGreen');
});

app.listen(port, () => {
  console.log(`Motor iGreen rodando na porta ${port}`);
});
