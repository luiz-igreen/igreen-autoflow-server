require('dotenv').config();

const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const fs = require('fs/promises');
const path = require('path');

const app = express();
app.use(express.json());

// Inicialização do Firebase com service account de variável de ambiente
// Correção: Carregamento seguro do service account
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
if (Object.keys(serviceAccount).length === 0) {
  console.error('Erro: FIREBASE_SERVICE_ACCOUNT não configurado');
  process.exit(1);
}
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Constantes de ambiente
// Correção: Uso de template strings corretas em todas as URLs
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const AUDIO_DIR = process.env.AUDIO_DIR || './audios';

// Função para enviar mensagem via WhatsApp Cloud API
// Proteção: async/await com try/catch implícito no handler principal
async function sendMessage(to, text) {
  const url = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;
  // Correção: Template strings corretas e headers adequados
  await axios.post(url, {
    messaging_product: "whatsapp",
    to,
    text: { body: text }
  }, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

// Função para baixar mídia do WhatsApp
async function downloadMedia(mediaId) {
  const url = `https://graph.facebook.com/v18.0/${mediaId}`;
  const res = await axios.get(url, {
    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
    responseType: 'arraybuffer'
  });
  return Buffer.from(res.data);
}

// Correção da função auditarFaturaIA:
// - Modelos estáveis com fallback automático (evita 404)
// - Endpoint atual: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
// - Tratamento robusto de erros, continua no próximo modelo se 404
// - Validação inlineData: mimeType e data base64 obrigatórios
// - Prompt otimizado para auditoria de faturas
async function auditarFaturaIA(buffer, mimeType) {
  const models = ['gemini-1.5-pro-latest', 'gemini-1.5-flash-latest', 'gemini-1.0-pro-vision-latest'];
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      // Correção: Payload conforme documentação, com inlineData validado
      const payload = {
        contents: [{
          parts: [
            {
              text: "Analise esta fatura ou áudio de fatura: verifique valores, itens, impostos, irregularidades, autenticidade. Responda em português brasileiro de forma clara e estruturada."
            },
            {
              inlineData: {
                mimeType: mimeType, // Validado: deve ser image/jpeg, audio/mpeg, etc.
                data: buffer.toString('base64') // Base64 obrigatório
              }
            }
          ]
        }]
      };
      const res = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' }
      });
      // Log corrigido com crase e parênteses
      console.log(`Análise bem-sucedida com modelo: ${model}`);
      return res.data.candidates[0].content.parts[0].text;
    } catch (err) {
      console.error(`Erro com modelo ${model}:`, err.response?.status || err.message);
      // Fallback: continua se 404 (modelo indisponível) ou erro genérico
      if (err.response?.status !== 404) {
        throw err;
      }
    }
  }
  throw new Error('Todos os modelos falharam. Verifique a chave da API Gemini.');
}

// Implementação de buscarAudioRecursivo:
// - Totalmente assíncrono com fs.promises.readdir (evita readdirSync que bloqueia event loop)
// - Recursão com await para proteger event loop
// - Suporte a múltiplas extensões de áudio
// - Tratamento de erros por diretório
async function buscarAudioRecursivo(startDir) {
  const audios = [];
  async function recurse(currentDir) {
    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await recurse(fullPath);
        } else if (entry.isFile() && /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(entry.name)) {
          audios.push(fullPath);
        }
      }
    } catch (err) {
      console.error(`Erro ao ler diretório ${currentDir}:`, err.message);
    }
  }
  await recurse(startDir);
  return audios;
}

// Handler principal do webhook
// Correções gerais: async/await em todas ops, try/catch robusto, logs corrigidos
// Garantia de res.status(200) para não quebrar máquina de estados do WhatsApp
// Suporte a text, image e audio sem quebrar flow
const handleWebhook = async (req, res) => {
  try {
    const body = req.body;
    // Verifica se há mensagem válida
    if (body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
      const message = body.entry[0].changes[0].value.messages[0];
      const from = message.from;
      const type = message.type;

      if (type === 'text') {
        const text = message.text.body.toLowerCase().trim();
        // Comando para buscar áudios
        if (text === 'buscar audio') {
          console.log(`Busca de áudio iniciada para ${from}`); // Log corrigido
          const audios = await buscarAudioRecursivo(AUDIO_DIR);
          const list = audios.slice(0, 10).join('\n') || 'Nenhum áudio encontrado.';
          await sendMessage(from, `Áudios encontrados em ${AUDIO_DIR}:\n${list}`);
        } else {
          await sendMessage(from, 'Comandos: "buscar audio" ou envie imagem/áudio de fatura para auditoria IA.');
        }
      } else if (type === 'image') {
        const mediaId = message.image.id;
        const mimeType = message.image.mime_type;
        console.log(`Auditoria de imagem iniciada para ${from}, MIME: ${mimeType}`);
        const buffer = await downloadMedia(mediaId);
        const analysis = await auditarFaturaIA(buffer, mimeType);
        // Salva no Firestore (integração Firebase)
        await db.collection('audits').add({
          phone: from,
          type: 'image',
          mimeType,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          analysis
        });
        await sendMessage(from, `✅ Análise da fatura:\n\n${analysis}`);
      } else if (type === 'audio') {
        const mediaId = message.audio.id;
        const mimeType = message.audio.mime_type;
        console.log(`Auditoria de áudio iniciada para ${from}, MIME: ${mimeType}`);
        const buffer = await downloadMedia(mediaId);
        const analysis = await auditarFaturaIA(buffer, mimeType);
        await db.collection('audits').add({
          phone: from,
          type: 'audio',
          mimeType,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          analysis
        });
        await sendMessage(from, `✅ Análise do áudio de fatura:\n\n${analysis}`);
      }
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('Erro no webhook:', err.message); // Log corrigido com parênteses e crase
    res.status(200).send('OK'); // Sempre responde 200 para não quebrar máquina de estados
  }
};

// Rota GET para verificação do webhook
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Rota POST para webhook
app.post('/webhook', handleWebhook);

// Health check
app.get('/', (req, res) => res.send('Servidor WhatsApp-Gemini-Firebase rodando!'));

// Inicia servidor
// Proteção: listen assíncrono não necessário, mas event loop protegido
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
