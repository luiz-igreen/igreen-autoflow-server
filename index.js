const express = require('express');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

// =======================================
// CONFIGURAÇÃO CENTRALIZADA
// =======================================
const CONFIG = {
  ZAPI_INSTANCE: process.env.ZAPI_INSTANCE,
  ZAPI_TOKEN: process.env.ZAPI_TOKEN,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  FIREBASE_SERVICE_ACCOUNT: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}'),
  DATABASE_URL: process.env.FIREBASE_DATABASE_URL,
  PORT: process.env.PORT || 3000,
  SUCCESS_AUDIO_URL: 'https://example.com/audio-sucesso.ogg', // Substitua pela URL do áudio OGG
  THRESHOLD_CONFIDENCE: 0.7,
  MAX_RETRIES: 3
};

const PROMPT_INVOICE = `Analise esta imagem e retorne APENAS um JSON válido, sem texto adicional:
{
  "isFatura": true ou false,
  "confidence": número entre 0 e 1,
  "motivo": "explicação curta (ex: 'Fatura reconhecida', 'Baixa resolução mas válida', 'É RG', 'Foto paisagem irrelevante')"
}

Regras estritas:
- Reconheça FATURAS mesmo em baixa resolução, borradas ou inclinadas.
- NÃO confunda com RG, CNH, CPF, comprovantes bancários, fotos de paisagem, memes ou documentos não-fatura.
- Se dúvida, marque false com confiança baixa.`;

const ZAPI_BASE_URL = `https://api.z-api.io/instances/${CONFIG.ZAPI_INSTANCE}/token/${CONFIG.ZAPI_TOKEN}`;

// =======================================
// INICIALIZAÇÃO
// =======================================
const serviceAccount = CONFIG.FIREBASE_SERVICE_ACCOUNT;
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: CONFIG.DATABASE_URL
});

const db = admin.firestore();
const genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);

const app = express();
app.use(express.json());

// =======================================
// FUNÇÕES AUXILIARES COM RETRY
// =======================================
async function withRetry(fn, maxRetries = CONFIG.MAX_RETRIES) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      console.warn(`Tentativa ${i + 1} falhou:`, error.message);
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

// =======================================
// FUNÇÕES Z-API
// =======================================
async function zapiCall(endpoint, data) {
  return withRetry(async () => {
    const response = await axios.post(`${ZAPI_BASE_URL}/${endpoint}`, data, {
      headers: { 'Content-Type': 'application/json' }
    });
    return response.data;
  });
}

async function sendText(phone, message) {
  return zapiCall('send-text', {
    phone,
    message
  });
}

async function sendVoice(phone, audioUrl) {
  return zapiCall('send-voice', {
    phone,
    audio: audioUrl
  });
}

// =======================================
// FUNÇÕES FIREBASE (STATE MACHINE)
// =======================================
async function getUserState(phone) {
  const doc = await db.collection('users').doc(phone).get();
  return doc.exists ? doc.data() : { state: 'initial', data: {} };
}

async function setUserState(phone, state, data = {}) {
  await db.collection('users').doc(phone).set({
    state,
    data,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

// =======================================
// PARSER JSON RESILIENTE
// =======================================
function parseJsonSafely(text) {
  try {
    // Remove markdown, quebras e espaços extras
    let cleaned = text
      .replace(/```(?:json)?\n?|\n?```/g, '')
      .replace(/\n/g, ' ')
      .trim();
    return JSON.parse(cleaned);
  } catch (error) {
    console.warn('JSON malformado, fallback:', text);
    // Fallback simples: tenta extrair com regex básica
    const match = text.match(/\{[^}]+\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
    return { isFatura: false, confidence: 0, motivo: 'Resposta inválida do IA' };
  }
}

// =======================================
// DOWNLOAD IMAGEM
// =======================================
async function downloadImage(imageUrl) {
  const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  return Buffer.from(response.data, 'binary').toString('base64');
}

// =======================================
// ANÁLISE GEMINI
// =======================================
async function analyzeInvoice(imageUrl) {
  const base64Image = await downloadImage(imageUrl);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  return withRetry(async () => {
    const result = await model.generateContent([
      PROMPT_INVOICE,
      {
        inlineData: {
          data: base64Image,
          mimeType: 'image/jpeg' // ou detect
        }
      }
    ]);
    const responseText = result.response.text();
    return parseJsonSafely(responseText);
  });
}

// =======================================
// WEBHOOK PRINCIPAL (STATE MACHINE)
// =======================================
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');

  try {
    // Assume payload Z-API: { event: 'message', data: { from: '55...', message: { type: 'image', body: url } } }
    // Ajuste conforme documentação exata da Z-API
    const event = req.body;
    const phone = event.data?.from || event.phone || event.from; // Normalizar
    const msgType = event.data?.message?.type || event.type;
    const content = event.data?.message?.body || event.message || event.content;

    if (!phone) return;

    const user = await getUserState(phone);

    console.log(`Mensagem de ${phone} (estado: ${user.state})`);

    switch (user.state) {
      case 'initial':
        await sendText(phone, 'Olá! 🤖 Sou o bot de validação de faturas. Envie uma imagem de fatura para análise.');
        await setUserState(phone, 'waiting_image');
        break;

      case 'waiting_image':
        if (msgType === 'image' && content) {
          await setUserState(phone, 'processing');
          await sendText(phone, '🔍 Analisando sua imagem... Aguarde!');

          const analysis = await analyzeInvoice(content);
          console.log('Análise:', analysis);

          if (analysis.isFatura && analysis.confidence >= CONFIG.THRESHOLD_CONFIDENCE) {
            await sendText(phone, `✅ Fatura válida! Confiança: ${(analysis.confidence * 100).toFixed(1)}%. Motivo: ${analysis.motivo}`);
            await sendVoice(phone, CONFIG.SUCCESS_AUDIO_URL); // Áudio APÓS texto, síncrono
            // Próximo estado: ex. 'waiting_payment' - personalize
            await setUserState(phone, 'waiting_image'); // Loop simples
          } else {
            await sendText(phone, `❌ Não é uma fatura válida. Confiança: ${(analysis.confidence * 100).toFixed(1)}%. Motivo: ${analysis.motivo}\n\nEnvie outra imagem.`);
            await setUserState(phone, 'waiting_image');
          }
        } else {
          await sendText(phone, 'Por favor, envie UMA IMAGEM de fatura. Não texto ou outros tipos. 📸');
        }
        break;

      case 'processing':
        await sendText(phone, 'Ainda processando... Aguarde um momento.');
        break;

      default:
        await sendText(phone, 'Comando não reconhecido. Envie /start para reiniciar.');
        await setUserState(phone, 'initial');
        break;
    }
  } catch (error) {
    console.error('Erro no webhook:', error);
    // Envia feedback de erro sem quebrar estado
    try {
      const phone = req.body.data?.from || req.body.phone;
      if (phone) {
        await sendText(phone, '😔 Erro interno. Tente enviar a imagem novamente.');
      }
    } catch (e) {}
  }
});

// =======================================
// INICIALIZAÇÃO DO SERVIDOR
// =======================================
app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Bot rodando na porta ${CONFIG.PORT}`);
});

// =======================================
// COMANDOS PARA GOOGLE APPS SCRIPT / TESTE
// =======================================
// module.exports = { sendText, analyzeInvoice }; // Compatibilidade se necessário

/*
INSTALAÇÃO:
1. npm init -y
2. npm i express firebase-admin @google/generative-ai axios
3. Defina .env com vars (ZAPI_INSTANCE, ZAPI_TOKEN, GEMINI_API_KEY, FIREBASE_SERVICE_ACCOUNT_JSON, etc.)
4. Configure webhook Z-API para POST /webhook
5. node app.js
*/
