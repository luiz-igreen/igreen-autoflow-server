const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// Conexão segura com o Banco de Dados (Firestore)
try {
  const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
  if (firebaseConfig) {
    admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
    console.log("✅ Banco de Dados conectado com sucesso!");
  } else {
    console.log("⚠️ Banco de Dados aguardando credenciais (FIREBASE_CONFIG).");
  }
} catch (e) {
  console.error("Erro na base de dados:", e.message);
}

app.post('/webhook/igreen', async (req, res) => {
  const data = req.body;
  
  // Resposta imediata para a Z-API entender que recebemos
  res.status(200).send("OK"); 

  // IGNORA ABSOLUTAMENTE TODOS os recibos chatos de entrega/leitura da Z-API
  if (data.type === 'ReceivedCallback' || data.type === 'DeliveryCallback' || data.type === 'ReadCallback' || data.type === 'MessageStatus' || data.type === 'PresenceCallback') {
      return; 
  }

  const phone = data.phone;
  const isImage = data.type === 'image' || data.isImage === true || data.type === 'photo';
  const isPDF = data.type === 'document' || data.isDocument === true;

  console.log(`\n=========================================`);
  console.log(`📩 NOVA MENSAGEM REAL DE: ${phone} | TIPO: ${data.type}`);
  
  if (isImage || isPDF) {
    console.log(`📸 Documento detectado. Iniciando robô de extração...`);
    
    await enviarMensagem(phone, "Recebi a sua fatura! 📄 A nossa Inteligência Artificial está a ler os dados para avaliar o seu desconto. Aguarde uns segundos...");

    try {
      // Pega o arquivo seja ele Imagem ou PDF
      let mediaUrl = "";
      if (isImage && data.image && data.image.imageUrl) mediaUrl = data.image.imageUrl;
      else if (isPDF && data.document && data.document.documentUrl) mediaUrl = data.document.documentUrl;
      else if (data.link) mediaUrl = data.link;

      if (!mediaUrl) throw new Error("A Z-API não enviou o link do arquivo.");

      // Faz o download do arquivo
      const fileResponse = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
      const base64Data = Buffer.from(fileResponse.data, 'binary').toString('base64');
      const mimeType = isPDF ? "application/pdf" : "image/jpeg";

      // Extrai os dados com a Inteligência Artificial
      const analise = await analisarComIA(base64Data, mimeType);
      console.log(`✅ DADOS EXTRAÍDOS COM SUCESSO:`, analise);

      // SALVA NO BANCO DE DADOS (Substitui a antiga Planilha)
      if (admin.apps.length > 0) {
          const db = admin.firestore();
          await db.collection('leads').doc(phone).set({
              telefone: phone,
              nome_cliente: analise.nome || "Não identificado",
              consumo_kwh: analise.consumo || 0,
              status: analise.aprovado ? 'APROVADO' : 'RECUSADO',
              data_processamento: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          console.log(`💾 Dados salvos na base de dados com sucesso!`);
      }

      // Envia a resposta calculada para o WhatsApp do cliente
      if (analise.aprovado) {
        const msgAprovado = `🎉 *Parabéns, ${analise.nome.split(' ')[0]}!*\n\nA nossa IA leu a sua fatura (Consumo: ${analise.consumo} kWh).\nVocê foi *APROVADO* para receber o desconto na conta de luz! ⚡\n\nO consultor Luiz Jorge vai gerar o seu termo de adesão em breve.`;
        await enviarMensagem(phone, msgAprovado);
      } else {
        const msgRecusado = `Olá ${analise.nome.split(' ')[0]},\n\nO seu consumo identificado foi de ${analise.consumo} kWh. No momento, exigimos um mínimo de 150 kWh para aplicar o desconto. 😔\nFicaremos com o seu contacto!`;
        await enviarMensagem(phone, msgRecusado);
      }

    } catch (erro) {
      console.error("❌ ERRO NO PROCESSAMENTO:", erro.message);
      await enviarMensagem(phone, "Tive uma dificuldade em ler esta imagem. Pode tentar enviar uma foto mais nítida ou o PDF original, por favor?");
    }
  } else if (data.text) {
    console.log(`💬 Texto ignorado: ${data.text.message}`);
  }
});

// MOTOR DA INTELIGÊNCIA ARTIFICIAL (GEMINI)
async function analisarComIA(base64, mimeType) {
  if (!GEMINI_API_KEY) throw new Error("Chave do Gemini não configurada!");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`;
  
  const prompt = `
    Aja como um auditor especialista em contas de energia.
    Leia este documento com precisão militar.
    Extraia as seguintes informações e devolva APENAS um JSON válido:
    1. "nome": Nome completo do titular da conta.
    2. "consumo": O consumo em kWh (apenas o número).
    3. "aprovado": true se o consumo for MAIOR ou IGUAL a 150, false se for menor.
    Exemplo de saída: {"nome": "João da Silva", "consumo": 180, "aprovado": true}
  `;

  const payload = {
    contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mimeType, data: base64 } }] }],
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
  console.log(`\n🚀 SERVIDOR IGREEN IA + BANCO DE DADOS LIGADO!`);
});
