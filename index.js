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

  console.log(`\n📡 [RADAR] SINAL RECEBIDO! Tipo: ${data.type} | De: ${data.phone}`);

  if (data.fromMe) return;

  const phone = data.phone;
  const isImage = data.type === 'image' || data.isImage === true || data.type === 'photo' || (data.image && data.image.imageUrl) || (data.photo && data.photo.photoUrl);
  const isPDF = data.type === 'document' || data.isDocument === true || (data.document && data.document.documentUrl);
  const isTexto = data.text && data.text.message;
  const saudacao = obterSaudacao();

  // CENÁRIO 1: O CLIENTE ENVIOU UM TEXTO ("Oi")
  if (isTexto && !isImage && !isPDF) {
      console.log(`💬 TEXTO RECEBIDO: "${data.text.message}"`);
      const txtBoasVindas = `${saudacao}! Seja muito bem-vindo à iGreen Energy! 🌿\n\nPara eu simular a sua economia hoje, preciso que me envie uma foto bem nítida ou o PDF da sua conta de luz mais recente.`;
      const vozBoasVindas = `${saudacao}! Seja muito bem-vindo à i Green Energy! Para começarmos a sua simulação, por favor, me envie uma foto bem nítida ou o P D F da sua conta de luz.`;
      
      await enviarMensagem(phone, txtBoasVindas);
      await enviarAudio(phone, await gerarAudio(vozBoasVindas));
      return; 
  }
  
  // CENÁRIO 2: O CLIENTE ENVIOU A FATURA
  if (isImage || isPDF) {
    console.log(`📸 FATURA RECEBIDA. Iniciando processo...`);
    const txtInicial = `${saudacao}! Recebi a sua fatura. 📄 Aguarde um instante enquanto faço a auditoria...`;
    const vozInicial = `${saudacao}! Recebi a sua fatura. A nossa Inteligência Artificial está fazendo a auditoria completa. Aguarde só um instante.`;
    
    await enviarMensagem(phone, txtInicial);
    await enviarAudio(phone, await gerarAudio(vozInicial));

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

      console.log(`🧠 Gemini IA a ler os dados (Modelo 3.1 Pro Atualizado)...`);
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

      const primeiroNome = analise.NOME_CLIENTE ? analise.NOME_CLIENTE.split(' ')[0] : "Cliente";
      
      if (analise.ELEGIVEL) {
        // TEXTOS CORRIGIDOS PARA PEDIR O DOCUMENTO!
        const txtAprovado = `🎉 *Parabéns, ${primeiroNome}!*\n\nA sua conta foi *APROVADA*! O consumo lido foi de ${analise.MEDIA_CONSUMO} kWh.\n\nPara darmos andamento à sua adesão e garantir o seu desconto, por favor, envie agora uma *foto da FRENTE do seu documento de identidade* (RG ou CNH).`;
        const vozAprovado = `Parabéns, ${primeiroNome}! Sua conta foi aprovada com sucesso. Para darmos andamento ao seu desconto, por favor, me envie agora uma foto da frente do seu documento de identidade, que pode ser R G ou C N H. Fico no aguardo!`;
        
        await enviarMensagem(phone, txtAprovado);
        await enviarAudio(phone, await gerarAudio(vozAprovado));
      } else {
        const txtRecusado = `Olá ${primeiroNome}, sua fatura não atende aos critérios: ${analise.MOTIVO_RECUSA}`;
        const vozRecusado = `Olá ${primeiroNome}, sua fatura não atende aos critérios da i Green pelo seguinte motivo: ${analise.MOTIVO_RECUSA}`;
        await enviarMensagem(phone, txtRecusado);
        await enviarAudio(phone, await gerarAudio(vozRecusado));
      }
      
      console.log(`🏁 ATENDIMENTO FINALIZADO PARA: ${phone}\n=========================================`);

    } catch (erro) {
      console.error("❌ ERRO NO FLUXO:", erro.message);
      const txtErro = "Tivemos uma falha temporária ao ler a sua imagem. Pode enviar a fatura novamente, por favor?";
      await enviarMensagem(phone, txtErro);
    }
  }
});

// MOTOR IA (Mantido no 3.1 Pro Preview)
async function analisarComIA(base64, mimeType) {
  if (!GEMINI_API_KEY) throw new Error("Chave Gemini ausente!");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${GEMINI_API_KEY}`;
  const prompt = `Aja como auditor iGreen. Extraia dados em JSON: NOME_CLIENTE, CPF, CNPJ, UC, MEDIA_CONSUMO (kWh), ELEGIVEL (true/false), MOTIVO_RECUSA. Regras: Grupo B, Consumo > 150kWh, Sem tarifa social, Titular vivo.`;
  const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }], generationConfig: { responseMimeType: "application/json" } };
  const res = await axios.post(url, payload);
  return JSON.parse(res.data.candidates[0].content.parts[0].text);
}

// MOTOR DE VOZ (Voltamos para a versão Premium "Kore" que estava 100% perfeita)
async function gerarAudio(texto) {
  if (!GEMINI_API_KEY) return null;
  console.log(`🎙️ Gerando áudio Premium (Kore)...`);
  
  // Usando o endpoint oficial TTS que não falha
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
    return null;
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
