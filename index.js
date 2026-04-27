# package.json
{
  "name": "igreen-energy-bot",
  "version": "1.0.0",
  "description": "Bot WhatsApp iGreen Energy para análise de faturas com IA Gemini, Firebase e Z-API",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "nodemon index.js",
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "keywords": ["whatsapp", "bot", "firebase", "gemini", "zapi"],
  "author": "iGreen Energy",
  "license": "ISC",
  "dependencies": {
    "express": "^4.18.2",
    "dotenv": "^16.3.1",
    "firebase-admin": "^12.1.1",
    "@google/generative-ai": "0.2.1",
    "axios": "^1.6.2"
  },
  "devDependencies": {
    "nodemon": "^3.0.2"
  }
}

# .env.example
PORT=3000
ZAPI_INSTANCE=DEFAULT
ZAPI_TOKEN=seu_token_aqui
GEMINI_API_KEY=AIzaSy..._aqui
ADMIN_PHONE=5511999999999@c.us
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"seu-projeto","private_key_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n","client_email":"firebase-adminsdk@seu-projeto.iam.gserviceaccount.com","client_id":"...","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","auth_provider_x509_cert_url":"https://www.googleapis.com/oauth2/v1/certs","client_x509_cert_url":""}
FIREBASE_STORAGE_BUCKET=seu-projeto.appspot.com

# README.md
# Bot iGreen Energy - Versão Final Modular

## Visão Geral
Bot WhatsApp para análise de faturas de energia, verificação de tarifa social, usando Z-API, Gemini AI e Firebase (Firestore + Storage).

Fluxo: Fatura (imagem) -> Extrai dados IA -> Nº casa -> RG frente -> RG verso -> E-mail -> Concluído.

Estados preservados: NOVO, AGUARDANDO_FATURA, AGUARDANDO_CASA, AGUARDANDO_DOC_FRENTE, AGUARDANDO_DOC_VERSO, AGUARDANDO_EMAIL, CONCLUIDO, CONFIRMANDO_CANCELAMENTO, TRANSBORDO_HUMANO, RECUSADO_TARIFA_SOCIAL, RECUSADO_CONSUMO.

## Correções Implementadas
1. **Z-API**: Payload exato (/send-text, /send-voice), baseURL centralizado, funções sendTexto/sendVoice com retry/backoff, sequência texto->áudio com await + 1.5s pausa.
2. **Firebase**: Admin SDK de FIREBASE_SERVICE_ACCOUNT (JSON no .env), upload imagens para Storage com URLs assinadas (30 dias), estado/dados no Firestore (users/{phone}).
3. **Gemini/Leitura**: Prompt aprimorado (baixa res, reflexos, distinção fatura/RG), parser robusto (regex ```json, { }, unescape, fallback null), retry 3x.

**Motivo erro leitura anterior**: Prompts vagos não diferenciavam fatura/docs, parser falhava em markdown/aspas extras/campos faltantes. Corrigido com prompt explícito + parser flexível + retry.

## Setup
1. `npm install`
2. `cp .env.example .env` e preencha vars (Firebase service account como JSON string!).
3. Crie pasta `audios/` com A01.ogg até A19.ogg (áudios WhatsApp OGG, ~3s cada, narrando textos).
4. Firebase: Rules Firestore/Storage allow read,write: if true; (produção: auth.uid).
5. Z-API: Configure webhook para `https://seu-server/webhook`.
6. `npm start` ou `npm run dev`.

## Estrutura
- `index.js`: Express server + webhook.
- `src/`: Modular (config, constants, helpers, services, stateMachine).

## Comandos
- `/start`: Reinicia.
- `cancelar`: Confirma cancel.
- `humano`: Transbordo.

Pronto para produção! 🌿

# index.js
// Entry point: Express server com webhook Z-API
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const config = require('./src/config');
const stateMachine = require('./src/stateMachine');

const app = express();
app.use(express.json());

// Webhook Z-API (ajuste URL conforme payload Z-API exato)
app.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    // Parse Z-API payload (ajustado para formato comum Z-API)
    let phone = payload.phone || payload.sender;
    if (phone && !phone.endsWith('@c.us')) phone += '@c.us';
    let msg = payload.message || payload.body || '';
    const msgType = payload.type;
    const mediaUrl = payload.mediaUrl;
    const mimetype = payload.mimetype || 'image/jpeg';
    const filename = payload.filename;

    let isImage = false;
    let buffer = null;

    if (mediaUrl && (msgType === 'image' || mimetype.startsWith('image/'))) {
      isImage = true;
      const response = await axios.get(mediaUrl, {
        responseType: 'arraybuffer',
        timeout: 30000
      });
      buffer = Buffer.from(response.data);
    }

    await stateMachine.handle(phone, msg, isImage, buffer, mimetype);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: true });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'OK' }));

const port = config.port;
app.listen(port, () => {
  console.log(`🚀 Bot iGreen Energy rodando na porta ${port}`);
});

# src/config.js
// Config centralizada (dotenv já carregado em index.js)
module.exports = {
  port: process.env.PORT || 3000,
  adminPhone: process.env.ADMIN_PHONE,
  zapiInstance: process.env.ZAPI_INSTANCE,
  zapiToken: process.env.ZAPI_TOKEN,
  geminiApiKey: process.env.GEMINI_API_KEY
};

# src/constants.js
// Estados e textos fixos (áudios assumidos em audios/A01.ogg etc.)
module.exports = {
  STATES: {
    NOVO: 'NOVO',
    AGUARDANDO_FATURA: 'AGUARDANDO_FATURA',
    AGUARDANDO_CASA: 'AGUARDANDO_CASA',
    AGUARDANDO_DOC_FRENTE: 'AGUARDANDO_DOC_FRENTE',
    AGUARDANDO_DOC_VERSO: 'AGUARDANDO_DOC_VERSO',
    AGUARDANDO_EMAIL: 'AGUARDANDO_EMAIL',
    CONCLUIDO: 'CONCLUIDO',
    CONFIRMANDO_CANCELAMENTO: 'CONFIRMANDO_CANCELAMENTO',
    TRANSBORDO_HUMANO: 'TRANSBORDO_HUMANO',
    RECUSADO_TARIFA_SOCIAL: 'RECUSADO_TARIFA_SOCIAL',
    RECUSADO_CONSUMO: 'RECUSADO_CONSUMO'
  },
  TEXTS: {
    T01: 'Olá! 🌿 Sou o assistente iGreen Energy. Envie a foto da sua fatura de energia para análise e tarifa social. Boa luz, sem reflexos!',
    T03: '✅ Número da casa confirmado! Envie foto do RG/CNH **FRENTE** (legível).',
    T04: '✅ Frente OK! Agora **VERSO** do documento.',
    T05: '✅ Documentos recebidos! Informe seu e-mail para o relatório:',
    T06: '🎉 Concluído! Relatório enviado em breve para seu e-mail. Obrigado pela confiança! 🌞',
    T07: '❌ Digite APENAS o número da casa (ex: 123). Tente novamente.',
    T08: '❌ E-mail inválido. Exemplo: seuemail@gmail.com',
    T09: 'ℹ️ Aguardo IMAGEM da fatura. /start para ajuda.',
    T10: '⚠️ Não é fatura de energia (RG? Paisagem?). Reenvie com boa qualidade ou /start.',
    T11: '/start para novo atendimento ou "cancelar".',
    T12: 'Momento errado para texto. Siga instruções!',
    T15: '🔄 Confirma cancelar? Digite **SIM** ou **NÃO**.',
    T16: '❌ Cancelado. /start para novo.',
    T17: '✅ Cancelamento desfeito. Continue!',
    T18: '⚠️ Consumo >220kWh: Não elegível tarifa social, mas otimize energia! /start outro serviço.',
    T19: '👤 Transferindo humano... Aguarde contato.',
    T20: 'Obrigado! iGreen Energy 💚'
  }
};

# src/helpers.js
// Helpers reutilizáveis: sleep, retry com backoff
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retry(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.warn(`Retry ${i + 1}/${maxRetries}:`, error.message);
      if (i < maxRetries - 1) {
        await sleep(baseDelay * Math.pow(2, i));
      }
    }
  }
  throw lastError;
}

module.exports = { sleep, retry };

# src/services/firebase.service.js
// Integração REAL Firebase Admin + Firestore + Storage (correção ponto 2)
const admin = require('firebase-admin');

// Inicializa de FIREBASE_SERVICE_ACCOUNT (JSON string no .env)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
if (!serviceAccount.project_id) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT inválido no .env');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

const adminInstance = admin;

// Upload imagem -> URL assinada segura (30 dias)
async function uploadMedia(phone, type, buffer, contentType) {
  const timestamp = Date.now();
  const filename = `${phone.replace(/[@.]/g, '_')}_${type}_${timestamp}`;
  const filePath = `igreen/users/${phone}/${filename}`;
  const file = bucket.file(filePath);

  await file.save(buffer, {
    metadata: { contentType }
  });

  // URL assinada (segura, expira)
  const [signedUrl] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30 dias
  });

  console.log(`Upload ${type} para ${phone}: ${signedUrl}`);
  return { path: filePath, url: signedUrl };
}

module.exports = {
  db,
  bucket,
  uploadMedia,
  FieldValue: adminInstance.firestore.FieldValue
};

# src/services/zapi.service.js
// Z-API exata: baseURL central, sendTexto/sendVoice com retry, logs (correção ponto 1)
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { retry, sleep } = require('../helpers');

const baseUrl = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE}/token/${process.env.ZAPI_TOKEN}`;
const headers = { 'Content-Type': 'application/json' };

class ZapiService {
  async sendTexto(phone, texto) {
    const payload = { phone, msg: texto };
    await retry(async () => {
      const res = await axios.post(`${baseUrl}/send-text`, payload, { headers, timeout: 10000 });
      console.log(`📱 Texto > ${phone.slice(0,15)}: ${texto.slice(0,50)}...`);
      return res.data;
    }, 3, 1000);
  }

  async sendVoice(phone, audioBase64, filename = 'voice.ogg') {
    const payload = { phone, audio: audioBase64, filename };
    await retry(async () => {
      const res = await axios.post(`${baseUrl}/send-voice`, payload, { headers, timeout: 15000 });
      console.log(`🔊 Áudio > ${phone.slice(0,15)}`);
      return res.data;
    }, 3, 1000);
  }

  // Sequência TEXTO -> ÁUDIO com pausa (preserva ordem T-A)
  async sendWithAudio(phone, texto, audioId) {
    await this.sendTexto(phone, texto);
    if (audioId) {
      try {
        const audioPath = path.join(__dirname, '../../audios', `${audioId}.ogg`);
        const buffer = fs.readFileSync(audioPath);
        await this.sendVoice(phone, buffer.toString('base64'), `${audioId}.ogg`);
      } catch (e) {
        console.warn(`Áudio não encontrado: ${audioId}`);
      }
    }
    await sleep(1500); // Pausa entre mensagens
  }
}

module.exports = new ZapiService();

# src/services/gemini.service.js
// Gemini aprimorada: prompt robusto, parser flexível, fallback/retry (correção ponto 3)
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { retry } = require('../helpers');

class GeminiService {
  constructor(apiKey) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  }

  // Parser robusto: markdown, texto extra, aspas, campos ausentes
  parseResponse(text) {
    text = text.trim();
    if (text === 'NAO_FATURA') return { error: 'not_fatura' };

    let jsonStr = text.match(/```(?:json)?[\s\n]*([\s\S]*?)[\s\n]*```/)?.[1] ||
                  text.match(/\{[\s\S]*\}/)?.[0] || text;

    // Limpa comuns erros
    jsonStr = jsonStr.replace(/\\"/g, '"').replace(/\n/g, ' ').trim();

    try {
      const parsed = JSON.parse(jsonStr);
      // Valida mínimos
      if (!parsed.numero_conta && !parsed.titular) return { error: 'invalid_fatura' };
      return parsed;
    } catch {
      return null;
    }
  }

  async analyzeFatura(buffer, mimeType) {
    const prompt = `\
Você é OCR especialista em faturas ENERGIA ELÉTRICA BR (Enel, CPFL, Light etc.).

- NÃO fatura? (RG/CNH/paisagem/objeto/texto/ruído): EXATO "NAO_FATURA".
- SIM fatura (mesmo baixa res/reflexo/distorção): extraia/ESTIME.

JSON PURO (sem ```/markdown/texto extra):
{\"numero_conta\":\"123456\"||null,\"titular\":\"João\"||null,\"endereco\":\"Rua X\"||null,\"mes_referencia\":\"01/2024\"||null,\"consumo_kwh\":150.5||null,\"valor_total\":250.75||null}
Aspas duplas. Null se ilegível.
    `;

    const parts = [{ text: prompt }, { inlineData: { data: buffer.toString('base64'), mimeType } }];
    const result = await this.model.generateContent(parts);
    return this.parseResponse(result.response.text());
  }
}

module.exports = new GeminiService(process.env.GEMINI_API_KEY);

# src/stateMachine.js
// Máquina de estados completa, modular, com fluxos sequenciais (preserva todos estados/pares T-A)
const { db, uploadMedia, FieldValue } = require('./services/firebase.service');
const zapi = require('./services/zapi.service');
const gemini = require('./services/gemini.service');
const config = require('./config');
const { STATES, TEXTS } = require('./constants');
const { retry } = require('./helpers');
const admin = require('firebase-admin');

async function handle(phone, msg, isImage, buffer, mimeType) {
  if (!phone) return;

  const userRef = db.collection('users').doc(phone);
  const userDoc = await userRef.get();
  let state = userDoc.exists ? userDoc.data().state || STATES.NOVO : STATES.NOVO;
  let data = userDoc.data()?.data || {};

  console.log(`🤖 ${phone} | state: ${state} | msg: ${msg.slice(0,50)} | image: ${isImage}`);

  // Comando humano (qualquer estado)
  const lowerMsg = msg.toLowerCase().trim();
  if (lowerMsg.includes('humano') || lowerMsg.includes('atendente')) {
    state = STATES.TRANSBORDO_HUMANO;
    await userRef.set({ state, data }, { merge: true });
    await zapi.sendWithAudio(phone, TEXTS.T19, 'A19');
    await zapi.sendTexto(config.adminPhone, `🆘 Humano pedido: ${phone} | Dados: ${JSON.stringify(data)}`);
    return;
  }

  // /start
  if (lowerMsg === '/start') {
    state = STATES.NOVO;
    data = {};
  }

  if (isImage) {
    // Determina tipo baseado em state
    let type;
    if (state === STATES.AGUARDANDO_FATURA) type = 'fatura';
    else if (state === STATES.AGUARDANDO_DOC_FRENTE) type = 'rg_frente';
    else if (state === STATES.AGUARDANDO_DOC_VERSO) type = 'rg_verso';
    else {
      await zapi.sendWithAudio(phone, TEXTS.T12, 'A12');
      return;
    }

    // Upload Firebase Storage
    const media = await uploadMedia(phone, type, buffer, mimeType);
    data[type] = media.url;

    if (state === STATES.AGUARDANDO_FATURA) {
      // Análise Gemini + retry + parser robusto
      let parsed = await retry(() => gemini.analyzeFatura(buffer, mimeType), 3);
      if (!parsed || parsed.error || !parsed.numero_conta) {
        await zapi.sendWithAudio(phone, TEXTS.T10, 'A10');
        return;
      }

      data.fatura_extracted = parsed;

      // Check consumo (exemplo lógica recusa)
      if (parsed.consumo_kwh > 220) {
        state = STATES.RECUSADO_CONSUMO;
        await userRef.set({ state, data }, { merge: true });
        await zapi.sendWithAudio(phone, TEXTS.T18, 'A18');
        return;
      }

      state = STATES.AGUARDANDO_CASA;
      const casaText = `✅ Fatura OK!\nConta: ${parsed.numero_conta}\nTitular: ${parsed.titular || 'N/A'}\nConsumo: ${parsed.consumo_kwh}kWh\n\nNúmero da casa? (ex: 123)`;
      await zapi.sendWithAudio(phone, casaText, 'A02');
    } else if (state === STATES.AGUARDANDO_DOC_FRENTE) {
      state = STATES.AGUARDANDO_DOC_VERSO;
      await zapi.sendWithAudio(phone, TEXTS.T04, 'A04');
    } else if (state === STATES.AGUARDANDO_DOC_VERSO) {
      state = STATES.AGUARDANDO_EMAIL;
      await zapi.sendWithAudio(phone, TEXTS.T05, 'A05');
    }

    await userRef.set({ state, data }, { merge: true });
    return;
  }

  // Textos
  if (lowerMsg.includes('cancelar')) {
    state = STATES.CONFIRMANDO_CANCELAMENTO;
    await userRef.set({ state }, { merge: true });
    await zapi.sendWithAudio(phone, TEXTS.T15, 'A15');
    return;
  }

  switch (state) {
    case STATES.NOVO:
    case STATES.CONCLUIDO:
      await zapi.sendWithAudio(phone, TEXTS.T01, 'A01');
      state = STATES.AGUARDANDO_FATURA;
      data.createdAt = FieldValue.serverTimestamp();
      break;

    case STATES.AGUARDANDO_FATURA:
      await zapi.sendWithAudio(phone, TEXTS.T09, 'A09');
      return;

    case STATES.AGUARDANDO_CASA:
      const casaNum = parseInt(lowerMsg);
      if (isNaN(casaNum) || casaNum < 1) {
        await zapi.sendWithAudio(phone, TEXTS.T07, 'A07');
        return;
      }
      data.casa = casaNum;
      state = STATES.AGUARDANDO_DOC_FRENTE;
      await zapi.sendWithAudio(phone, TEXTS.T03, 'A03');
      break;

    case STATES.AGUARDANDO_DOC_FRENTE:
      await zapi.sendWithAudio(phone, TEXTS.T03, 'A03'); // Reenviar instrução
      return;

    case STATES.AGUARDANDO_DOC_VERSO:
      await zapi.sendWithAudio(phone, TEXTS.T04, 'A04');
      return;

    case STATES.AGUARDANDO_EMAIL:
      const emailRegex = /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i;
      const emailMatch = lowerMsg.match(emailRegex);
      if (!emailMatch) {
        await zapi.sendWithAudio(phone, TEXTS.T08, 'A08');
        return;
      }
      data.email = emailMatch[1];
      state = STATES.CONCLUIDO;
      data.concludedAt = FieldValue.serverTimestamp();
      await zapi.sendWithAudio(phone, TEXTS.T06, 'A06');
      // Notifica admin
      const report = `Novo lead ${phone}: ${JSON.stringify(data, null, 2)}`;
      await zapi.sendTexto(config.adminPhone, report);
      break;

    case STATES.CONFIRMANDO_CANCELAMENTO:
      if (lowerMsg.includes('sim') || lowerMsg.includes('s')) {
        await userRef.delete();
        await zapi.sendWithAudio(phone, TEXTS.T16, 'A16');
      } else {
        state = STATES.AGUARDANDO_FATURA;
        data = {};
        await zapi.sendWithAudio(phone, TEXTS.T17, 'A17');
      }
      return;

    case STATES.TRANSBORDO_HUMANO:
    case STATES.RECUSADO_CONSUMO:
    case STATES.RECUSADO_TARIFA_SOCIAL:
      await zapi.sendWithAudio(phone, TEXTS.T11, null);
      return;

    default:
      await zapi.sendWithAudio(phone, TEXTS.T11, 'A11');
  }

  await userRef.set({ state, data }, { merge: true });
}

module.exports = { handle };
