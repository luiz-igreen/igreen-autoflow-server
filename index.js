/**
 * iGreen AutoFlow - AI Image Processor (V5 - High Accuracy)
 * Servidor optimizado para faturas da Equatorial (Alagoas) e outras.
 */

const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

// 1. FIREBASE ADMIN SETUP
// No Render, a chave será injetada por variável de ambiente
const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : {};

if (Object.keys(firebaseConfig).length > 0) {
  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig)
  });
}

const db = admin.firestore();
const app = express();
app.use(express.json());

const apiKey = process.env.GEMINI_API_KEY || "";
const CONFIG = {
  APP_ID: "igreen-autoflow-v4",
  ZAPI_INSTANCE: process.env.ZAPI_INSTANCE || "3F14E2A7F66AC2180C0BBA4D31290A14",
  ZAPI_TOKEN: process.env.ZAPI_TOKEN || "88F232A54C5DC27793994637",
  MODEL: "gemini-2.5-flash-preview-09-2025"
};

// ROTA DO WEBHOOK (Onde o Z-API vai bater)
app.post('/webhook/igreen-ia', async (req, res) => {
  const data = req.body;
  
  // Ignora mensagens enviadas por você mesmo
  if (data.fromMe) return res.sendStatus(200);

  const phone = data.phone;
  const tipoMsg = data.type;

  if (tipoMsg === 'image' || tipoMsg === 'document') {
    const mediaUrl = data.image?.imageUrl || data.document?.documentUrl;
    
    console.log(`[LOG] Iniciando análise de fatura para: ${phone}`);
    await enviarMensagem(phone, "Identifiquei o seu documento. A nossa Inteligência Artificial está a extrair os dados técnicos agora... 🤖🔋");

    try {
      // 1. Capturar imagem da fatura
      const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
      const base64Image = Buffer.from(response.data, 'binary').toString('base64');

      // 2. Prompt Especializado para a IA
      const prompt = `
        Aja como um auditor de faturas de energia elétrica da iGreen Energy.
        Extraia os seguintes dados da imagem no formato JSON estrito:
        - nome_cliente: Nome completo do titular.
        - cpf_cnpj_limpo: Apenas os números.
        - distribuidora: Nome da concessionária (ex: EQUATORIAL AL).
        - uc: Número da Unidade Consumidora.
        - media_consumo: Calcule a média aritmética dos últimos 12 meses apresentados no histórico. Se não houver histórico, use o consumo atual.
        - is_apto: true se media_consumo >= 150 (Critério para Alagoas), false caso contrário.
        - justificativa: Breve explicação técnica do cálculo.
      `;

      // 3. Chamar a IA (Gemini)
      const aiResponse = await callGemini(prompt, base64Image);
      const result = JSON.parse(aiResponse);

      // 4. Gravar no seu Banco de Dados (Firestore)
      const leadRef = db.collection('artifacts').doc(CONFIG.APP_ID)
                        .collection('public').doc('data')
                        .collection('leads').doc(phone);

      await leadRef.set({
        ...result,
        telefone: phone,
        status_cadastro: result.is_apto ? 'AUDITORIA_IA' : 'RECUSADO_IA',
        data_atualizacao: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // 5. Enviar resposta final pelo WhatsApp
      if (result.is_apto) {
        const msg = `Parabéns, ${result.nome_cliente.split(' ')[0]}! 🎉\n` +
                    `Analisámos a sua UC ${result.uc} e verificámos um consumo médio de ${result.media_consumo} kWh.\n\n` +
                    `Você é ELEGÍVEL para o desconto iGreen! O consultor Luiz Jorge vai agora gerar o seu termo de adesão no portal.`;
        await enviarMensagem(phone, msg);
      } else {
        await enviarMensagem(phone, `Olá. A sua média de ${result.media_consumo} kWh está abaixo do mínimo de 150 kWh exigido para Alagoas neste momento. Ficaremos com o seu contacto para futuras expansões!`);
      }

    } catch (error) {
      console.error("[ERROR]", error);
      await enviarMensagem(phone, "Não consegui ler todos os dados da fatura. Pode enviar uma foto com mais iluminação ou o PDF original?");
    }
  }
  res.sendStatus(200);
});

// Funções de apoio
async function callGemini(prompt, base64) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODEL}:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{
      parts: [{ text: prompt }, { inlineData: { mimeType: "image/png", data: base64 } }]
    }],
    generationConfig: { responseMimeType: "application/json" }
  };
  const res = await axios.post(url, payload);
  return res.data.candidates[0].content.parts[0].text;
}

async function enviarMensagem(phone, message) {
  const url = `https://api.z-api.io/instances/${CONFIG.ZAPI_INSTANCE}/token/${CONFIG.ZAPI_TOKEN}/send-text`;
  await axios.post(url, { phone, message });
}

// Inicia o servidor
app.listen(process.env.PORT || 3000, () => console.log("iGreen AI Engine Ready!"));