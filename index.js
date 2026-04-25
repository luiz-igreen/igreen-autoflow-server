const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Rota principal do Webhook (O "Ouvido" do Robô)
app.post('/webhook/igreen', async (req, res) => {
  const data = req.body;
  
  // 1. Resposta imediata: Essencial para a Z-API não ficar a repetir a mesma mensagem
  res.status(200).send("OK");

  // 2. A CAMPAINHA: Isso vai imprimir TUDO o que chegar na tela preta
  console.log(`\n🔔 [CAMPAINHA] A Z-API enviou dados!`);
  console.log(`   -> Tipo: ${data.type || 'Desconhecido'}`);
  console.log(`   -> Telefone: ${data.phone || 'Sem número'}`);
  console.log(`   -> De mim (fromMe): ${data.fromMe}`);

  // 3. FILTRO DE SEGURANÇA: Ignora recibos de entrega e mensagens suas
  if (data.fromMe || data.type === 'ReceivedCallback' || data.type === 'DeliveryCallback' || data.type === 'ReadCallback' || data.type === 'MessageStatus' || data.type === 'PresenceCallback') {
      console.log(`   [SILENCIADO] Era apenas um recibo do sistema. Ignorado.`);
      return; 
  }

  const phone = data.phone;
  const isImage = data.type === 'image' || data.isImage === true || data.type === 'photo';
  const isPDF = data.type === 'document' || data.isDocument === true;

  if (isImage || isPDF) {
    console.log(`\n📸 [SUCESSO] FATURA DETETADA! Cliente: ${phone}.`);
    console.log(`   [IA] A preparar resposta automática...`);
    
    // O Robô responde
    await enviarMensagem(phone, "Recebi a sua fatura! 📄 Estou a analisá-la agora mesmo com a nossa Inteligência Artificial...");
  } else {
    console.log(`   [IGNORADO] Mensagem recebida, mas não é fatura (Tipo: ${data.type}).`);
  }
});

// FUNÇÃO PARA O ROBÔ FALAR NO WHATSAPP VIA Z-API
async function enviarMensagem(phone, message) {
  const instance = "3F14E2A7F66AC2180C0BBA4D31290A14";
  const token = "88F232A54C5DC27793994637";
  const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-text`;
  
  try {
    const numeroLimpo = String(phone).replace(/\D/g, ''); 
    console.log(`   [Z-API] A responder para o número: ${numeroLimpo}`);
    
    await axios.post(url, { 
      phone: numeroLimpo, 
      message: String(message) 
    }, {
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log(`   [Z-API] ✅ MÁGICA FEITA! Mensagem enviada pelo robô.`);
  } catch (e) { 
    console.error("   [ERRO Z-API]:", e.response ? JSON.stringify(e.response.data) : e.message); 
  }
}

// LIGA O MOTOR DO SERVIDOR
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`\n🚀 Motor iGreen com CAMPAINHA LIGADO na porta ${port}!`);
});
