const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Rota principal do Webhook (Ouvido do Robô)
app.post('/webhook/igreen', async (req, res) => {
  const data = req.body;
  
  // Ignora mensagens enviadas por você mesmo
  if (data.fromMe) return res.status(200).send("Ignored");

  const phone = data.phone;
  const tipoReal = data.type; // <-- NOVO: Pega o tipo exato que a Z-API manda
  const isImage = data.type === 'image';
  const isPDF = data.type === 'document';

  // Log Detetive Melhorado
  console.log(`[LOG] Mensagem de ${phone} | TIPO RECEBIDO: ${tipoReal} | Imagem: ${isImage} | PDF: ${isPDF}`);

  if (!isImage && !isPDF) {
      console.log(`[AVISO] A mensagem chegou, mas a Z-API classificou como '${tipoReal}', por isso o robô ignorou.`);
  }

  if (isImage || isPDF) {
    console.log(`[IA] Iniciando análise de fatura do cliente ${phone}...`);
    
    // O Robô avisa que recebeu e está a analisar
    await enviarMensagem(phone, "Recebi a sua fatura! 📄 Estou a analisá-la agora mesmo com a nossa Inteligência Artificial...");
  }

  res.status(200).send("OK");
});

// FUNÇÃO BLINDADA PARA O ROBÔ RESPONDER (SEM ERRO 400)
async function enviarMensagem(phone, message) {
  // Suas chaves exatas da Z-API
  const instance = "3F14E2A7F66AC2180C0BBA4D31290A14";
  const token = "88F232A54C5DC27793994637";
  const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-text`;
  
  try {
    // A MÁGICA AQUI: Limpa o número
    const numeroLimpo = String(phone).replace(/\D/g, ''); 
    console.log(`[Z-API] A tentar responder para o número: ${numeroLimpo}`);
    
    await axios.post(url, { 
      phone: numeroLimpo, 
      message: String(message) 
    }, {
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log(`[Z-API] MÁGICA FEITA! Mensagem enviada com sucesso.`);
    
  } catch (e) { 
    console.error("Erro Zap Detalhado:", e.response ? JSON.stringify(e.response.data) : e.message); 
  }
}

// Liga o Motor
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Motor iGreen rodando na porta ${port}`));
