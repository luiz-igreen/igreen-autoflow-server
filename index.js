const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// A SUA CHAVE DA IA (Deve ser colocada no Render depois)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

app.post('/webhook/igreen', async (req, res) => {
  const data = req.body;
  res.status(200).send("OK"); // Corta o spam da Z-API

  // Filtro: Ignora recibos, status e mensagens suas
  if (data.fromMe || data.type === 'ReceivedCallback' || data.type === 'DeliveryCallback' || data.type === 'ReadCallback' || data.type === 'MessageStatus') {
      return; 
  }

  const phone = data.phone;
  const isImage = data.type === 'image' || data.isImage === true || data.type === 'photo';
  const isPDF = data.type === 'document' || data.isDocument === true;

  if (isImage || isPDF) {
    console.log(`\n📸 [NOVA FATURA] Recebida de: ${phone}`);
    console.log(`🧠 [IA] Iniciando Leitura Avançada (Imagem/PDF)...`);
    
    await enviarMensagem(phone, "Recebi o seu documento! 📄 A nossa Inteligência Artificial está a ler os dados para calcular o seu desconto. Aguarde uns segundos...");

    try {
      // 1. Pega a URL da Imagem ou PDF que a Z-API enviou
      const mediaUrl = data.image?.imageUrl || data.document?.documentUrl;
      
      // 2. Faz o download do arquivo
      const fileResponse = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
      const base64Data = Buffer.from(fileResponse.data, 'binary').toString('base64');
      const mimeType = isPDF ? "application/pdf" : "image/jpeg";

      // 3. Acorda a IA (Gemini) e manda ela ler tudo, mesmo cortado
      const analise = await analisarComIA(base64Data, mimeType);
      
      console.log(`✅ [IA RESULTADO]:`, analise);

      // 4. O Robô toma a decisão e responde ao cliente
      if (analise.aprovado) {
        const msgAprovado = `🎉 *Parabéns, ${analise.nome.split(' ')[0]}!*\n\nA nossa IA leu a sua fatura (Consumo: ${analise.consumo} kWh).\nVocê foi *APROVADO* para receber o desconto na conta de luz! ⚡\n\nO consultor Luiz Jorge vai gerar o seu termo de adesão em breve.`;
        await enviarMensagem(phone, msgAprovado);
      } else {
        const msgRecusado = `Olá ${analise.nome.split(' ')[0]},\n\nA nossa IA analisou a fatura. O consumo identificado foi de ${analise.consumo} kWh.\nNo momento, para a sua região, exigimos um mínimo de 150 kWh para aplicar o desconto. 😔\nFicaremos com o seu contacto para futuras campanhas!`;
        await enviarMensagem(phone, msgRecusado);
      }

    } catch (erro) {
      console.error("❌ ERRO NA IA:", erro.message);
      await enviarMensagem(phone, "Tive uma dificuldade em ler esta imagem. Pode tentar enviar uma foto mais nítida ou o PDF original, por favor? 🤖");
    }
  }
});

// MOTOR DA INTELIGÊNCIA ARTIFICIAL (GEMINI)
async function analisarComIA(base64, mimeType) {
  if (!GEMINI_API_KEY) throw new Error("Chave do Gemini não configurada no Render!");
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`;
  
  const prompt = `
    Aja como um auditor especialista em contas de energia.
    Leia este documento (pode estar cortado ou bagunçado).
    Extraia as seguintes informações e devolva APENAS um JSON válido:
    1. "nome": Nome do titular da conta.
    2. "consumo": O consumo em kWh (se tiver histórico, calcule a média. Se não, pegue o atual). Apenas o número.
    3. "aprovado": true se o consumo for MAIOR ou IGUAL a 150, false se for menor.
    
    Exemplo de saída: {"nome": "João da Silva", "consumo": 180, "aprovado": true}
  `;

  const payload = {
    contents: [{
      parts: [{ text: prompt }, { inlineData: { mimeType: mimeType, data: base64 } }]
    }],
    generationConfig: { responseMimeType: "application/json" }
  };

  const resposta = await axios.post(url, payload);
  return JSON.parse(resposta.data.candidates[0].content.parts[0].text);
}

// FUNÇÃO PARA ENVIAR MENSAGEM (Z-API)
async function enviarMensagem(phone, message) {
  const instance = "3F14E2A7F66AC2180C0BBA4D31290A14";
  const token = "88F232A54C5DC27793994637";
  const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-text`;
  const numeroLimpo = String(phone).replace(/\D/g, ''); 
  await axios.post(url, { phone: numeroLimpo, message: String(message) }, { headers: { 'Content-Type': 'application/json' } });
}

app.listen(process.env.PORT || 10000, () => {
  console.log(`\n🤖 MOTOR DE IA DEFINITIVO LIGADO!`);
});  
