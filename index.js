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

// Conexão com o Banco de Dados (Firestore)
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

// WEBHOOK PRINCIPAL
app.post('/webhook/igreen', async (req, res) => {
  const data = req.body;
  res.status(200).send("OK"); 

  console.log(`\n📡 [RADAR] SINAL RECEBIDO! Tipo: ${data.type} | De: ${data.phone}`);

  if (data.fromMe) return;

  const phone = data.phone;
  const isImage = data.type === 'image' || data.isImage === true || data.type === 'photo' || (data.image && data.image.imageUrl) || (data.photo && data.photo.photoUrl);
  const isPDF = data.type === 'document' || data.isDocument === true || (data.document && data.document.documentUrl);
  const isTexto = data.text && data.text.message;

  // CENÁRIO 1: O CLIENTE ENVIOU UM TEXTO ("Oi")
  if (isTexto && !isImage && !isPDF) {
      console.log(`💬 TEXTO RECEBIDO: "${data.text.message}"`);
      // TEXTO EXATO DA SUA PLANILHA:
      const txtBoasVindas = "Oi! Tudo bem? Aqui é o assistente virtual da iGreen Energy. Para eu simular a sua economia hoje, preciso que me envie uma foto nítida da sua Fatura de Energia mais recente.";
      
      await enviarMensagem(phone, txtBoasVindas);
      await enviarAudio(phone, await gerarAudio(txtBoasVindas));
      return; 
  }
  
  // CENÁRIO 2: O CLIENTE ENVIOU A FATURA
  if (isImage || isPDF) {
    console.log(`📸 FATURA RECEBIDA. Iniciando processo...`);
    // TEXTO EXATO DA SUA PLANILHA:
    const txtInicial = "Estou analisando a sua fatura e a elegibilidade regional. Por favor, aguarde um instante.";
    
    await enviarMensagem(phone, txtInicial);
    await enviarAudio(phone, await gerarAudio(txtInicial));

    try {
      let mediaUrl = data.link || 
                     (data.image && data.image.imageUrl) || 
                     (data.document && data.document.documentUrl) || 
                     (data.photo && data.photo.photoUrl) || "";

      if (!mediaUrl || !mediaUrl.startsWith('http')) {
          throw new Error("Link da mídia não encontrado.");
      }

      console.log(`🔗 Preparando para baixar a foto...`);

      let fileResponse = null;
      let tentativas = 5; 
      while (tentativas > 0) {
          try {
              console.log(`➡️ Tentativa de download (${6 - tentativas}/5)...`);
              fileResponse = await axios.get(mediaUrl, { 
                  responseType: 'arraybuffer',
                  headers: {
                      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
                  }
              });
              console.log(`✅ FOTO BAIXADA COM SUCESSO!`);
              break; 
          } catch (err) {
              const statusErro = err.response ? err.response.status : 'Desconhecido';
              console.log(`⚠️ Servidor de imagens atrasou (Erro ${statusErro}). Aguardando 3 segundos...`);
              if (tentativas === 1) throw new Error("Falha ao baixar imagem.");
              await new Promise(r => setTimeout(r, 3000));
              tentativas--;
          }
      }

      const base64Data = Buffer.from(fileResponse.data, 'binary').toString('base64');
      const mimeType = isPDF ? "application/pdf" : "image/jpeg";

      console.log(`🧠 Gemini IA a ler os dados (Modelo 3.1 Pro)...`);
      const analise = await analisarComIA(base64Data, mimeType);
      console.log(`✅ LEITURA CONCLUÍDA! Resultado: Elegível? ${analise.ELEGIVEL}`);

      // Atualiza o Status para pedir o documento a seguir
      let statusCadastro = analise.ELEGIVEL ? 'AGUARDANDO_DOC_FRENTE' : 'RECUSADO_IA';

      if (admin.apps.length > 0) {
          const db = admin.firestore();
          const appId = process.env.RENDER_SERVICE_ID || 'igreen-autoflow-v4';
          await db.collection('artifacts').doc(appId).collection('public').doc('data').collection('leads').doc(phone).set({
              ...analise,
              STATUS_CADASTRO: statusCadastro,
              DATA_PROCESSAMENTO: admin.firestore.Timestamp.now(),
              TELEFONE: phone,
              LINK_FATURA: mediaUrl
          }, { merge: true });
          console.log(`💾 Cliente salvo no banco de dados Cloud com status: ${statusCadastro}`);
      }

      if (analise.ELEGIVEL) {
        // AGUARDANDO OS SEUS TEXTOS EXATOS:
        const txtAprovado = `Aprovado! Consumo: ${analise.MEDIA_CONSUMO} kWh. [AGUARDANDO SEU TEXTO EXATO PARA PEDIR CNH/RG]`;
        await enviarMensagem(phone, txtAprovado);
        await enviarAudio(phone, await gerarAudio(txtAprovado));
      } else {
        // AGUARDANDO OS SEUS TEXTOS EXATOS:
        const txtRecusado = `Recusado: ${analise.MOTIVO_RECUSA}. [AGUARDANDO SEU TEXTO EXATO DE RECUSA]`;
        await enviarMensagem(phone, txtRecusado);
        await enviarAudio(phone, await gerarAudio(txtRecusado));
      }
      
      console.log(`🏁 ATENDIMENTO FINALIZADO PARA: ${phone}\n=========================================`);

    } catch (erro) {
      console.error("❌ ERRO NO FLUXO:", erro.message);
      // TEXTO EXATO DA SUA PLANILHA:
      const txtErro = "Infelizmente o sistema não conseguiu ler a imagem. Verifique se a foto está clara, sem cortes, e envie novamente, por favor.";
      await enviarMensagem(phone, txtErro);
      await enviarAudio(phone, await gerarAudio(txtErro));
    }
  }
});

// MOTOR IA (Gemini 3.1 Pro Preview - FORÇANDO PORTUGUÊS)
async function analisarComIA(base64, mimeType) {
  if (!GEMINI_API_KEY) throw new Error("Chave Gemini ausente!");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${GEMINI_API_KEY}`;
  
  // REGRA BLINDADA PARA EVITAR INGLÊS E VOZ COM SOTAQUE ESTRANHO
  const prompt = `
    Aja como auditor iGreen. Extraia dados em JSON: NOME_CLIENTE, CPF, CNPJ, UC, MEDIA_CONSUMO (kWh), ELEGIVEL (true/false), MOTIVO_RECUSA. 
    Regras: Grupo B, Consumo > 150kWh, Sem tarifa social, Titular vivo.
    MÁXIMA IMPORTÂNCIA: Responda ABSOLUTAMENTE TUDO em Português do Brasil (PT-BR). Se a fatura for ilegível, devolva ELEGIVEL como false e MOTIVO_RECUSA como "A imagem enviada está ilegível ou não é uma fatura válida". Nunca use inglês.
  `;
  
  const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }], generationConfig: { responseMimeType: "application/json" } };
  const res = await axios.post(url, payload);
  return JSON.parse(res.data.candidates[0].content.parts[0].text);
}

// MOTOR DE VOZ (Estritamente Voz Premium "Kore" - Sem falhas lentas)
async function gerarAudio(texto) {
  if (!GEMINI_API_KEY) return null;
  console.log(`🎙️ Gerando áudio Premium (Kore)...`);
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${GEMINI_API_KEY}`;
  
  const payload = {
    contents: [{ parts: [{ text: texto }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Kore" }
        }
      }
    },
    model: "gemini-2.5-flash-preview-tts"
  };

  try {
    const resposta = await axios.post(url, payload);
    const pcmBase64 = resposta.data.candidates[0].content.parts[0].inlineData.data;
    const pcmBuffer = Buffer.from(pcmBase64, 'base64');
    const wavBuffer = pcmToWav(pcmBuffer, 24000);
    return `data:audio/wav;base64,${wavBuffer.toString('base64')}`;
  } catch (error) {
    console.error("❌ ERRO NA GERAÇÃO DE VOZ PREMIUM:", error.message);
    return null; // Retorna nulo e não envia áudio, mas evita mandar áudio robótico lento.
  }
}

function pcmToWav(pcmDataBuffer, sampleRate = 24000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmDataBuffer.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); 
  buffer.writeUInt16LE(1, 20); 
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmDataBuffer.copy(buffer, 44);

  return buffer;
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
