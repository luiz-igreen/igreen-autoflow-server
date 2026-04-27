const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// CHAVES DA Z-API CENTRALIZADAS
const ZAPI_INSTANCE = "3F14E2A7F66AC2180C0BBA4D31290A14";
const ZAPI_TOKEN = "88F232A54C5DC27793994637";
const ZAPI_CLIENT_TOKEN = "F177679f2434d425e9a3e58ddec1d4cf0S"; 

// Conexão segura com o Banco de Dados (Firestore)
try {
  const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
  if (firebaseConfig) {
    if (admin.apps.length === 0) {
      admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
    }
    console.log("✅ Banco de Dados conectado com sucesso!");
  } else {
    console.log("⚠️ Banco de Dados aguardando credenciais (FIREBASE_CONFIG).");
  }
} catch (e) {
  console.error("Erro na base de dados:", e.message);
}

// Saudação Dinâmica
function obterSaudacao() {
    const horaAtual = new Date().toLocaleString("pt-BR", { timeZone: "America/Maceio", hour: "numeric", hour12: false });
    const h = parseInt(horaAtual);
    if (h >= 5 && h < 12) return "Bom dia";
    if (h >= 12 && h < 18) return "Boa tarde";
    return "Boa noite";
}

// WEBHOOK PRINCIPAL
app.post('/webhook/igreen', async (req, res) => {
  const data = req.body;
  res.status(200).send("OK"); 

  // LOG DE ENTRADA
  console.log(`\n📡 [RADAR] SINAL RECEBIDO! Tipo: ${data.type} | De: ${data.phone}`);

  if (data.fromMe) return; // Ignora o que o próprio robô escreve

  const phone = data.phone;
  const isImage = data.type === 'image' || data.isImage === true || data.type === 'photo' || (data.image && data.image.imageUrl);
  const isPDF = data.type === 'document' || data.isDocument === true || (data.document && data.document.documentUrl);
  const isTexto = data.text && data.text.message;
  const saudacao = obterSaudacao();

  // CENÁRIO 1: O CLIENTE ENVIOU UM TEXTO ("Oi")
  if (isTexto && !isImage && !isPDF) {
      console.log(`💬 TEXTO RECEBIDO: "${data.text.message}"`);
      const txtBoasVindas = `${saudacao}! Seja muito bem-vindo à iGreen Energy! 🌿\n\nPara eu simular a sua economia hoje, preciso que me envie uma foto bem nítida ou o PDF da sua conta de luz mais recente.`;
      const vozBoasVindas = `${saudacao}! Seja muito bem-vindo à i Green Energy! Para começarmos a sua simulação, por favor, me envie uma foto bem nítida ou o P D F da sua conta de luz.`;
      
      await enviarMensagem(phone, txtBoasVindas);
      await enviarAudio(phone, await gerarAudioGemini(vozBoasVindas));
  }
  
  // CENÁRIO 2: O CLIENTE ENVIOU A FATURA
  if (isImage || isPDF) {
    console.log(`📸 FATURA RECEBIDA. Analisando...`);
    const txtInicial = `${saudacao}! Recebi a sua fatura. 📄 Aguarde um instante enquanto faço a auditoria...`;
    const vozInicial = `${saudacao}! Recebi a sua fatura. A nossa Inteligência Artificial está fazendo a auditoria completa. Aguarde só um instante.`;
    
    await enviarMensagem(phone, txtInicial);
    await enviarAudio(phone, await gerarAudioGemini(vozInicial));

    try {
      let mediaUrl = data.link || (data.image ? data.image.imageUrl : (data.document ? data.document.documentUrl : ""));
      if (!mediaUrl) throw new Error("Link da mídia não encontrado.");

      // CORREÇÃO: Download simples sem o Header do Token, para evitar o erro 404 no servidor de arquivos
      const fileResponse = await axios.get(mediaUrl, { 
          responseType: 'arraybuffer'
      });
      const base64Data = Buffer.from(fileResponse.data, 'binary').toString('base64');
      const mimeType = isPDF ? "application/pdf" : "image/jpeg";

      const analise = await analisarComIA(base64Data, mimeType);

      if (analise.ELEGIVEL && admin.apps.length > 0) {
          const db = admin.firestore();
          const appId = process.env.RENDER_SERVICE_ID || 'igreen-autoflow-v4';
          await db.collection('artifacts').doc(appId).collection('public').doc('data').collection('leads').doc(phone).set({
              ...analise,
              DATA_PROCESSAMENTO: admin.firestore.Timestamp.now(),
              TELEFONE: phone,
              LINK_FATURA: mediaUrl
          }, { merge: true });
      }

      const primeiroNome = analise.NOME_CLIENTE ? analise.NOME_CLIENTE.split(' ')[0] : "Cliente";
      if (analise.ELEGIVEL) {
        const txtAprovado = `🎉 *Parabéns, ${primeiroNome}!*\n\nSua conta foi *APROVADA*! O consultor Luiz Jorge entrará em contato em breve.`;
        const vozAprovado = `Parabéns, ${primeiroNome}! Sua conta foi aprovada! O consultor Luiz Jorge entrará em contato em breve para gerar seu desconto.`;
        await enviarMensagem(phone, txtAprovado);
        await enviarAudio(phone, await gerarAudioGemini(vozAprovado));
      } else {
        const txtRecusado = `Olá ${primeiroNome}, sua fatura não atende aos critérios: ${analise.MOTIVO_RECUSA}`;
        const vozRecusado = `Olá ${primeiroNome}, sua fatura não atende aos critérios da i Green pelo seguinte motivo: ${analise.MOTIVO_RECUSA}`;
        await enviarMensagem(phone, txtRecusado);
        await enviarAudio(phone, await gerarAudioGemini(vozRecusado));
      }
    } catch (erro) {
      console.error("❌ ERRO:", erro.message);
    }
  }
});

// MOTOR IA (Gemini)
async function analisarComIA(base64, mimeType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`;
  const prompt = `Aja como auditor iGreen. Extraia dados em JSON: NOME_CLIENTE, CPF, CNPJ, UC, MEDIA_CONSUMO (kWh), ELEGIVEL (true/false), MOTIVO_RECUSA. Regras: Grupo B, Consumo > 150kWh, Sem tarifa social, Titular vivo.`;
  const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }], generationConfig: { responseMimeType: "application/json" } };
  const res = await axios.post(url, payload);
  return JSON.parse(res.data.candidates[0].content.parts[0].text);
}

// MOTOR DE VOZ
async function gerarAudioGemini(texto) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${GEMINI_API_KEY}`;
  const payload = { contents: [{ parts: [{ text: texto }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } } };
  try {
    const res = await axios.post(url, payload);
    const pcm = Buffer.from(res.data.candidates[0].content.parts[0].inlineData.data, 'base64');
    return `data:audio/wav;base64,${pcmToWav(pcm).toString('base64')}`;
  } catch { return null; }
}

function pcmToWav(pcm) {
  const s = 24000, c = 1, b = 16;
  const buf = Buffer.alloc(44 + pcm.length);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(c, 22); buf.writeUInt32LE(s, 24);
  buf.writeUInt32LE(s*c*b/8, 28); buf.writeUInt16LE(c*b/8, 32); buf.writeUInt16LE(b, 34); buf.write('data', 36);
  buf.writeUInt32LE(pcm.length, 40); pcm.copy(buf, 44);
  return buf;
}

// ENVIOS Z-API
async function enviarMensagem(phone, message) {
  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;
  await axios.post(url, { phone: phone.replace(/\D/g,''), message }, { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } }).catch(e => console.log("Erro texto"));
}

async function enviarAudio(phone, audio) {
  if (!audio) return;
  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-audio`;
  await axios.post(url, { phone: phone.replace(/\D/g,''), audio }, { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } }).catch(e => console.log("Erro audio"));
}

app.listen(process.env.PORT || 10000, () => console.log(`🚀 SERVIDOR ON!`));
