const express = require('express');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const dotenv = require('dotenv');


dotenv.config();

const app = express();
app.use(express.json({ limit: '50mb' }));

// Firebase
let db;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = admin.firestore();
} catch (error) {
  console.error('Firebase init error:', error);
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const ZAPI_BASE_URL = 'https://api.z-api.io/instances';
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';
const AUDIO_BASE_URL = 'https://your-domain.com/audios/';

const log = (level, obj) => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    phone: obj.phone || '',
    state: obj.state || '',
    action: obj.action || '',
    data: obj.data || {},
    error: obj.error || ''
  }));
};

const MESSAGES = [
  {text: "Olá! Seja bem-vindo ao iGreen. Para cadastrar, envie a foto da sua fatura de luz.", audioId: 0},
  {text: "🔍 Analisando sua fatura...", audioId: 1},
  {text: "❌ Fatura não legível. Verifique se UC, consumo, concessionária e data estão visíveis e nítidos. Envie novamente.", audioId: 2},
  {text: "✅ Fatura aprovada! Agora envie a foto da FRENTE do seu RG ou CNH.", audioId: 3},
  {text: "🔍 Analisando frente do documento...", audioId: 4},
  {text: "❌ Frente do documento inválida. Certifique-se de que número, data de emissão estão legíveis. Tente novamente.", audioId: 5},
  {text: "✅ Frente aprovada! Agora envie a foto do VERSO do documento.", audioId: 6},
  {text: "🔍 Analisando verso...", audioId: 7},
  {text: "❌ Verso inválido. Data de validade e órgão emissor devem estar legíveis. Tente novamente.", audioId: 8},
  {text: "✅ Documento completo! Agora digite seu e-mail para finalizar.", audioId: 9},
  {text: "✅ E-mail recebido. Processo concluído com sucesso! Dados salvos no sistema.", audioId: 10},
  {text: "❌ E-mail inválido. Digite um e-mail válido (ex: usuario@exemplo.com).", audioId: 11},
  {text: "✅ Processo cancelado. Digite 'iniciar' ou envie fatura para começar novo cadastro.", audioId: 12},
  {text: "❌ Por favor, siga as instruções. No momento aguardamos imagem.", audioId: 13},
  {text: "❌ UC não encontrado na fatura. Envie fatura com UC visível.", audioId: 14},
  {text: "❌ Consumo não legível. Informe kWh claramente.", audioId: 15},
  {text: "❌ Número do documento não identificado.", audioId: 16},
  {text: "❌ Data de validade ausente ou expirada.", audioId: 17},
  {text: "❌ Órgão emissor não visível.", audioId: 18},
  {text: "📞 Seu atendimento foi transferido para um humano. Aguarde.", audioId: 19}
];

const IMAGE_STATES = ['AGUARDANDO_FATURA', 'AGUARDANDO_DOC_FRENTE', 'AGUARDANDO_DOC_VERSO'];

const PROMPTS = {
  AGUARDANDO_FATURA: `Você é especialista em OCR de faturas de energia brasileira. Analise a imagem e extraia:
- UC: código da unidade consumidora (8 dígitos geralmente)
- consumo: valor em kWh (número)
- concessionaria: nome (ex: CEMIG, COPEL, ENEL)
- data: data de vencimento (DD/MM/YYYY)

Se TODOS legíveis, presentes e válidos (consumo >0, data futura ou atual), responda JSON:
{"valid":true,"uc":"12345678","consumo":250,"concessionaria":"CEMIG","data":"15/10/2024"}
Senão: {"valid":false,"reason":"problema específico, ex: UC ausente"}`,

  AGUARDANDO_DOC_FRENTE: `Analise FRENTE de RG ou CNH brasileira. Extraia:
- numero: número do documento
- dataEmissao: DD/MM/YYYY
- nome: nome completo (se visível)
- tipo: 'RG' ou 'CNH'

Se todos legíveis e válidos, JSON {"valid":true,"numero":"1234567","dataEmissao":"01/01/2000","nome":"Fulano","tipo":"RG"}
Senão {"valid":false,"reason":"ex: número ilegível"}`,

  AGUARDANDO_DOC_VERSO: `Analise VERSO de RG ou CNH. Extraia:
- dataValidade: DD/MM/YYYY (deve ser futura)
- orgaoEmissor: nome (SSP, DETRAN etc)

Se válidos e dataValidade > hoje, {"valid":true,"dataValidade":"31/12/2030","orgaoEmissor":"DETRAN"}
Senão {"valid":false,"reason":"ex: data expirada"}`
};

function getAudioUrl(audioId) {
  return `${AUDIO_BASE_URL}${audioId}.mp3`;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sendText(phone, text, instance) {
  const url = `${ZAPI_BASE_URL}/${instance}/token/${ZAPI_TOKEN}/send-text/${phone}`;
  await axios.post(url, { message: text }, { timeout: 10000 });
}

async function sendAudio(phone, audioUrl, instance) {
  const url = `${ZAPI_BASE_URL}/${instance}/token/${ZAPI_TOKEN}/send-voice/${phone}`;
  await axios.post(url, { url: audioUrl }, { timeout: 10000 });
}

async function enviarFluxo(phone, instance, msgIndex, delay = 2500) {
  const msg = MESSAGES[msgIndex];
  log('info', { phone, action: 'send_text', msgIndex: msgIndex, text: msg.text.slice(0,50) });
  try {
    await sendText(phone, msg.text, instance);
  } catch (e) {
    log('error', { phone, action: 'send_text_fail', error: e.message });
  }
  await new Promise(r => setTimeout(r, delay));
  const audioUrl = getAudioUrl(msg.audioId);
  log('info', { phone, action: 'send_audio', msgIndex: msgIndex, audioUrl });
  try {
    await sendAudio(phone, audioUrl, instance);
  } catch (e) {
    log('error', { phone, action: 'send_audio_fail', error: e.message });
  }
}

async function downloadImage(mediaUrl) {
  const response = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    timeout: 30000
  });
  const contentType = response.headers['content-type'] || 'image/jpeg';
  const buffer = Buffer.from(response.data);
  return {
    base64: buffer.toString('base64'),
    mimeType: contentType.startsWith('image/') ? contentType : 'image/jpeg'
  };
}

async function analyzeImage(state, imageData) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json"
      }
    });

    const prompt = PROMPTS[state];
    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: imageData.base64,
          mimeType: imageData.mimeType
        }
      }
    ]);

    const text = result.response.text().trim();
    return JSON.parse(text);
  } catch (e) {
    log('error', { action: 'gemini_analyze_fail', state, error: e.message });
    return { valid: false, reason: 'Erro na análise da imagem' };
  }
}

async function resetConversation(phone) {
  await db.collection('conversations').doc(phone).set({
    state: 'NOVO',
    phone,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    expireAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 30 * 60 * 1000))
  });
}

async function getConversation(phone) {
  const docRef = db.collection('conversations').doc(phone);
  const doc = await docRef.get();
  let data = doc.exists ? doc.data() : { state: 'NOVO', phone };

  // Check timeout
  if (data.expireAt && data.expireAt.toDate() < new Date()) {
    log('info', { phone, action: 'timeout_reset' });
    await resetConversation(phone);
    data = { state: 'NOVO', phone };
  }

  return { docRef, data };
}

app.post('/webhook', async (req, res) => {
  try {
    const { instance, sender, message } = req.body;
    const phone = sender.replace(/@c\.us$/, '');

    const { docRef, data } = await getConversation(phone);
    log('info', { phone, state: data.state, msgType: message.type, action: 'webhook_received' });

    if (data.state === 'CONCLUIDO') {
      await enviarFluxo(phone, instance, 10); // success msg again
      res.sendStatus(200);
      return;
    }

    if (message.type === 'chat') {
      const text = message.body.toLowerCase().trim();

      if (text.includes('cancelar') || text === 'iniciar' || text === '/start') {
        await resetConversation(phone);
        await enviarFluxo(phone, instance, 12); // cancel msg
      } else if (data.state === 'AGUARDANDO_EMAIL' && text) {
        const email = message.body.trim();
        if (isValidEmail(email)) {
          await docRef.set({ ...data, email, state: 'CONCLUIDO', expireAt: null }, { merge: true });
          await enviarFluxo(phone, instance, 10);
        } else {
          await enviarFluxo(phone, instance, 11);
        }
      } else if (text.includes('transbordo') || text.includes('humano') || text.includes('ajuda')) {
        if (ADMIN_PHONE) {
          await sendText(ADMIN_PHONE, `Transbordo: ${phone}. Estado: ${data.state}. Dados: ${JSON.stringify(data)}`, instance);
        }
        await enviarFluxo(phone, instance, 19);
      } else {
        const wrongMsgIndex = data.state === 'AGUARDANDO_EMAIL' ? 11 : 13;
        await enviarFluxo(phone, instance, wrongMsgIndex);
      }
    } else if (message.type === 'image' && IMAGE_STATES.includes(data.state)) {
      await enviarFluxo(phone, instance, data.state === 'AGUARDANDO_FATURA' ? 1 : data.state === 'AGUARDANDO_DOC_FRENTE' ? 4 : 7);

      const imageData = await downloadImage(message.mediaUrl);
      const analysis = await analyzeImage(data.state, imageData);

      let nextState, msgIndex;
      if (analysis.valid) {
        await docRef.set({ ...data, ...analysis }, { merge: true });
        if (data.state === 'AGUARDANDO_FATURA') {
          nextState = 'AGUARDANDO_DOC_FRENTE';
          msgIndex = 3;
        } else if (data.state === 'AGUARDANDO_DOC_FRENTE') {
          nextState = 'AGUARDANDO_DOC_VERSO';
          msgIndex = 6;
        } else {
          nextState = 'AGUARDANDO_EMAIL';
          msgIndex = 9;
        }
        await docRef.set({ state: nextState, expireAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 30 * 60 * 1000)) }, { merge: true });
      } else {
        let invalidIndex = data.state === 'AGUARDANDO_FATURA' ? 2 : data.state === 'AGUARDANDO_DOC_FRENTE' ? 5 : 8;
        const reason = analysis.reason.toLowerCase();
        if (data.state === 'AGUARDANDO_FATURA') {
          if (reason.includes('uc')) invalidIndex = 14;
          else if (reason.includes('consumo') || reason.includes('kwh')) invalidIndex = 15;
        } else if (data.state === 'AGUARDANDO_DOC_FRENTE') {
          if (reason.includes('numero')) invalidIndex = 16;
        } else {
          if (reason.includes('data') || reason.includes('validade')) invalidIndex = 17;
          else if (reason.includes('org')) invalidIndex = 18;
        }
        msgIndex = invalidIndex;
      }
      await enviarFluxo(phone, instance, msgIndex);
    } else {
      // Wrong type
      await enviarFluxo(phone, instance, 13);
    }

    res.sendStatus(200);
  } catch (error) {
    log('error', { phone: req.body.sender, action: 'webhook_error', error: error.message });
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
