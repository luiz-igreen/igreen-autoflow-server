const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Rota principal do Webhook
app.post('/webhook/igreen', async (req, res) => {
  const data = req.body;
  
  // 1. SOLUÇÃO ANTI-SPAM: Responde "OK" imediatamente para a Z-API parar de reenviar a mesma mensagem.
  res.status(200).send("OK");

  // 2. FILTRO DE LIXO: Ignora recibos de entrega, status de leitura, e mensagens enviadas por você mesmo. Sem sujar a tela!
  if (data.fromMe || data.type === 'ReceivedCallback' || data.type === 'DeliveryCallback' || data.type === 'ReadCallback' || data.type === 'MessageStatus' || data.type === 'PresenceCallback') {
      return; // Sai silenciosamente. A tela preta não vai mostrar nada disso.
  }

  const phone = data.phone;
  // Algumas vezes a Z-API manda "type: image", outras vezes manda "isImage: true"
  const tipoReal = data.type || (data.isImage ? 'image' : 'desconhecido'); 
  const isImage = tipoReal === 'image' || data.isImage === true;
  const isPDF = tipoReal === 'document' || data.isDocument === true;

  console.log(`\n[NOVA MENSAGEM] Recebida de: ${phone} | TIPO: ${tipoReal}`);

  if (isImage || isPDF) {
    console.log(`[IA] Imagem detectada! A preparar resposta para o cliente...`);
    await enviarMensagem(phone, "Recebi a sua fatura! 📄 Estou a analisá-la agora mesmo com a nossa Inteligência Artificial...");
  } else {
    console.log(`[IGNORADO] A mensagem não é uma fatura (Tipo: ${tipoReal}).`);
  }
});

// FUNÇÃO BLINDADA PARA O ROBÔ RESPONDER
async function enviarMensagem(phone, message) {
  const instance = "3F14E2A7F66AC2180C0BBA4D31290A14";
  const token = "88F232A54C5DC27793994637";
  const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-text`;
  
  try {
    const numeroLimpo = String(phone).replace(/\D/g, ''); 
    await axios.post(url, { 
      phone: numeroLimpo, 
      message: String(message) 
    }, {
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log(`[Z-API] MÁGICA FEITA! O Robô respondeu no WhatsApp.`);
  } catch (e) { 
    console.error("[Z-API ERRO]:", e.response ? JSON.stringify(e.response.data) : e.message); 
  }
}

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`\n🚀 Motor iGreen Definitivo ligado e blindado na porta ${port}`));  
