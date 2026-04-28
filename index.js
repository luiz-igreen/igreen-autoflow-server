const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

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

const memoriaEstado = new Map();

// OS TEXTOS EXTRAÍDOS RIGOROSAMENTE DOS SEUS ÁUDIOS
const TEXTOS = {
    T01: "Seja muito bem-vinda à iGreen Energy. Pra começarmos a sua simulação, por favor, me envie uma foto bem nítida ou o PDF da sua conta de luz.",
    T02: "Estou analisando a sua fatura e a elegibilidade regional. Por favor, aguarde um instante.",
    T03: "Fatura auditada com sucesso. Identifiquei o seu CEP, mas não encontrei o número da residência. Por favor, digite o número da sua casa ou apartamento pra prosseguirmos.",
    T04: "Fatura auditada com sucesso. Pra darmos continuidade, por favor, envie uma foto nítida apenas da frente do seu RG ou CNH.",
    T05: "Frente guardada. Agora, por favor, envie a foto do verso do documento, onde ficam o número de registro e o órgão emissor.",
    T06: "Estou executando a leitura biométrica avançada, cruzando os dados da frente e do verso. Por favor, aguarde.",
    T07: "Registrado. Pra finalizar, digite o seu melhor e-mail.",
    T08: "Prontinho. O seu pré-cadastro foi concluído com sucesso. Os seus dados já foram enviados pro nosso sistema e muito em breve você receberá o seu link para assinatura. A iGreen Energy agradece a sua confiança.",
    T09: "Aviso, este documento não parece ser uma fatura de energia, ou a imagem está cortada e ilegível. Por favor, envie uma foto correta e bem nítida da sua conta de luz.",
    T10: "Atenção, identificamos que a sua conta possui a classificação de baixa renda ou tarifa social. Para proteger o seu benefício governamental, a iGreen não atende esta modalidade, pois a alteração poderia causar a perda do seu subsídio. O processo foi encerrado por segurança. Agradecemos o seu contacto!",
    T11: "Aviso, o documento está ilegível, ou não é um RG ou CNH brasileiro válido. Por favor, reenvie a foto com mais foco e sem reflexos de luz.",
    T12: "E-mail inválido. Por favor, verifique se digitou corretamente, lembrando que deve conter a arroba, e envie novamente.",
    T13: "Atenção, você solicitou o cancelamento. Tem certeza que deseja excluir todos os dados enviados até agora? Digite um para sim, cancelar tudo, ou dois para não, e continuar o cadastro.",
    T20: "Entendido. Vou transferir o seu atendimento pra um de nossos consultores especialistas. Aguarde um instante, por favor."
};

// WEBHOOK PRINCIPAL (MÁQUINA DE ESTADOS)
app.post('/webhook/igreen', async (req, res) => {
  const data = req.body;
  res.status(200).send("OK"); 

  if (data.fromMe) return;

  const phone = data.phone;
  const isImage = data.type === 'image' || data.isImage === true || data.type === 'photo' || (data.image && data.image.imageUrl) || (data.photo && data.photo.photoUrl);
  const isPDF = data.type === 'document' || data.isDocument === true || (data.document && data.document.documentUrl);
  const textoIn = data.text?.message?.trim() || "";
  
  const db = admin.apps.length > 0 ? admin.firestore() : null;
  const appId = 'igreen-autoflow-v4';
  
  // BUSCA DA SESSÃO ATIVA
  let status = 'NOVO';
  let leadRef = null;
  let mem = memoriaEstado.get(phone);
  let leadData = mem || {};

  if (db) {
      const leadsColl = db.collection('artifacts').doc(appId).collection('public').doc('data').collection('leads');
      
      if (mem && mem.UC) {
          leadRef = leadsColl.doc(mem.UC);
          status = mem.STATUS_CADASTRO;
      } else {
          const snapshot = await leadsColl.where('TELEFONE', '==', phone).get();
          if (!snapshot.empty) {
              let docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
              docs.sort((a, b) => {
                  const ta = a.DATA_PROCESSAMENTO?.toMillis ? a.DATA_PROCESSAMENTO.toMillis() : 0;
                  const tb = b.DATA_PROCESSAMENTO?.toMillis ? b.DATA_PROCESSAMENTO.toMillis() : 0;
                  return tb - ta; 
              });
              
              const latest = docs[0];
              if (!['CONCLUIDO', 'RECUSADO_CONSUMO', 'RECUSADO_TARIFA_SOCIAL', 'NOME_DIVERGENTE', 'CONFIRMANDO_CANCELAMENTO'].includes(latest.STATUS_CADASTRO)) {
                  if (latest.UC) leadRef = leadsColl.doc(latest.UC);
                  status = latest.STATUS_CADASTRO;
                  leadData = latest;
                  memoriaEstado.set(phone, latest);
              }
          }
      }
  }

  console.log(`\n📡 [RADAR] Cliente: ${phone} | Estado: [${status}] | Tipo Msg: ${data.type}`);

  // COMANDOS GLOBAIS
  if (textoIn.toLowerCase() === 'cancelar') {
      await enviarFluxo(phone, TEXTOS.T13, "13");
      atualizarEstado(phone, leadRef, { STATUS_CADASTRO: 'CONFIRMANDO_CANCELAMENTO', PREV_STATUS: status });
      return;
  }
  
  if (textoIn.toLowerCase().match(/(atendente|humano|consultor|especialista|falar com alg)/)) {
      await enviarFluxo(phone, TEXTOS.T20, "20");
      atualizarEstado(phone, leadRef, { STATUS_CADASTRO: 'TRANSBORDO_HUMANO' });
      return;
  }

  if (textoIn.toLowerCase() === 'novo' || textoIn.toLowerCase() === 'reiniciar' || (textoIn.toLowerCase() === 'oi' && status === 'CONCLUIDO')) {
      memoriaEstado.delete(phone);
      await enviarFluxo(phone, TEXTOS.T01, "01");
      memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA', TELEFONE: phone });
      return;
  }
  
  if (status === 'CONFIRMANDO_CANCELAMENTO') {
      if (textoIn === '1') {
          if (leadRef) await leadRef.delete();
          memoriaEstado.delete(phone);
          await enviarMensagem(phone, "Cancelamento confirmado. Dados apagados.");
      } else if (textoIn === '2') {
          await enviarMensagem(phone, "Cancelamento abortado. Por favor, envie o documento solicitado anteriormente.");
          const prev = memoriaEstado.get(phone)?.PREV_STATUS || 'NOVO';
          atualizarEstado(phone, leadRef, { STATUS_CADASTRO: prev });
      }
      return;
  }

  // MÁQUINA DE ESTADOS PRINCIPAL
  switch (status) {
      case 'NOVO':
      case 'AGUARDANDO_FATURA':
          if (!isImage && !isPDF) {
              await enviarFluxo(phone, TEXTOS.T01, "01");
              memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA', TELEFONE: phone });
              return;
          }

          await enviarFluxo(phone, TEXTOS.T02, "02");
          
          try {
              let mediaUrl = obterMediaUrl(data);
              const base64Data = await baixarArquivo(mediaUrl);
              const mimeType = isPDF ? "application/pdf" : "image/jpeg";

              const analise = await auditarFaturaIA(base64Data, mimeType);

              if (!analise.VALIDO) {
                  await enviarFluxo(phone, TEXTOS.T09, "09");
                  return;
              }

              if (analise.TARIFA_SOCIAL) {
                  await enviarFluxo(phone, TEXTOS.T10, "10");
                  memoriaEstado.delete(phone); 
                  return;
              }

              // CÁLCULO MATEMÁTICO EXATO NO SERVIDOR
              let isAlagoas = analise.ESTADO === 'AL' || (analise.DISTRIBUIDORA && analise.DISTRIBUIDORA.toUpperCase().includes('ALAGOAS')) || (analise.DISTRIBUIDORA && analise.DISTRIBUIDORA.toUpperCase().includes('EQUATORIAL'));
              let maxMeses = isAlagoas ? 6 : 12;
              let somaConsumo = 0;
              let mesesComDados = 0;

              for(let i = 1; i <= maxMeses; i++) {
                  let val = Number(analise[`CONSUMO_MES_${i}`]);
                  if(val > 0) {
                      somaConsumo += val;
                      mesesComDados++;
                  }
              }

              if (mesesComDados > 0) {
                  analise.MEDIA_CONSUMO = Math.round(somaConsumo / mesesComDados);
              } else {
                  analise.MEDIA_CONSUMO = Number(analise.MEDIA_CONSUMO) || 0; 
              }

              analise.ELEGIVEL = analise.MEDIA_CONSUMO >= 150;

              if (analise.ELEGIVEL) {
                  let proximoStatus = 'AGUARDANDO_DOC_FRENTE';
                  let proximoTexto = TEXTOS.T04;
                  let proximoAudio = "04";

                  if (analise.ENDERECO_NUMERO) {
                      analise.ENDERECO_NUMERO = String(analise.ENDERECO_NUMERO).replace(/\D/g, '');
                  }

                  let ucLimpa = String(analise.UC || "").replace(/\D/g, '');
                  if (!ucLimpa || ucLimpa === "") ucLimpa = "SEM_UC_" + Date.now();
                  analise.UC = ucLimpa;

                  let leadsColl = null;
                  let docExistente = null;

                  if (db) {
                      leadsColl = db.collection('artifacts').doc(appId).collection('public').doc('data').collection('leads');
                      leadRef = leadsColl.doc(ucLimpa); 
                      docExistente = await leadRef.get();
                  }

                  // ATUALIZAÇÃO CADASTRAL SE FALTAR DOCUMENTO
                  if (docExistente && docExistente.exists) {
                      const dadosAnteriores = docExistente.data();
                      const faltaDocs = !dadosAnteriores.LINK_DOC_FRENTE || !dadosAnteriores.CPF || dadosAnteriores.CPF === "Não consta";

                      if (faltaDocs) {
                          await enviarMensagem(phone, `⚡ Identifiquei a sua Unidade Consumidora (*${ucLimpa}*), mas notei que **faltam documentos** no seu cadastro.\n\nVamos fazer uma rápida atualização cadastral para garantir o seu desconto!`);
                          proximoStatus = 'AGUARDANDO_DOC_FRENTE';
                          proximoTexto = TEXTOS.T04;
                          proximoAudio = "04";
                      } else if (dadosAnteriores.STATUS_CADASTRO === 'CONCLUIDO') {
                          proximoStatus = 'CONCLUIDO';
                          await enviarMensagem(phone, `⚡ Identifiquei que esta Unidade Consumidora (*${ucLimpa}*) já está com o cadastro COMPLETO!\n\nAtualizei a sua média de consumo para *${analise.MEDIA_CONSUMO} kWh* com base na fatura que acabou de enviar.\n\nNão é necessário reenviar os seus documentos.`);
                          proximoTexto = null; 
                          proximoAudio = null;
                      }
                  } else if (!analise.ENDERECO_NUMERO || analise.ENDERECO_NUMERO.trim() === '') {
                      proximoStatus = 'AGUARDANDO_CASA';
                      proximoTexto = TEXTOS.T03;
                      proximoAudio = "03";
                  }

                  atualizarEstado(phone, leadRef, {
                      ...analise,
                      STATUS_CADASTRO: proximoStatus,
                      DATA_PROCESSAMENTO: admin.apps.length > 0 ? admin.firestore.Timestamp.now() : new Date(),
                      LINK_FATURA: mediaUrl,
                      TELEFONE: phone
                  });
                  
                  if (proximoTexto) await enviarFluxo(phone, proximoTexto, proximoAudio);

              } else {
                  await enviarMensagem(phone, `Olá! Agradecemos muito o seu interesse. 💚\n\nApós analisar a sua fatura, verificamos que a sua média de consumo (${analise.MEDIA_CONSUMO || 0} kWh) está abaixo do mínimo exigido no momento para a sua região.\n\nPor isso, não poderemos prosseguir com o cadastro agora. Guardaremos o seu contacto para o avisar em futuras oportunidades!`);
                  memoriaEstado.delete(phone); 
              }
          } catch (e) {
              console.error("❌ ERRO FATURA:", e.message);
              await enviarFluxo(phone, TEXTOS.T09, "09");
          }
          break;

      case 'AGUARDANDO_CASA':
          if (!textoIn) return;
          const numeroLimpoDaMensagem = textoIn.replace(/\D/g, ''); 
          const numeroFinalSalvo = numeroLimpoDaMensagem || "S/N"; 
          
          atualizarEstado(phone, leadRef, { ENDERECO_NUMERO: numeroFinalSalvo, STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE' });
          await enviarFluxo(phone, TEXTOS.T04, "04");
          break;

      case 'AGUARDANDO_DOC_FRENTE':
          if (!isImage) {
              await enviarFluxo(phone, TEXTOS.T11, "11");
              return;
          }
          try {
              let mediaUrlF = obterMediaUrl(data);
              const base64Frente = await baixarArquivo(mediaUrlF);
              const analiseDoc = await analisarDocumentoIA(base64Frente);

              if (analiseDoc.VALIDO) {
                  // CRUZAMENTO DE DADOS (ANTIFRAUDE)
                  const nomeDoc = analiseDoc.NOME_DOCUMENTO || "";
                  const nomeFatura = leadData.NOME_CLIENTE || "";

                  if (nomeDoc !== "Não consta" && !nomesCompativeis(nomeFatura, nomeDoc)) {
                      await enviarMensagem(phone, `⚠️ *Divergência Detectada*\n\nO nome no documento enviado (*${nomeDoc}*) não corresponde ao titular da fatura de energia (*${nomeFatura}*).\n\nPor medidas de segurança antifraude, o sistema foi bloqueado. Por favor, envie uma foto do documento de identificação do titular correto da fatura.`);
                      return; 
                  }

                  let dadosDoc = { LINK_DOC_FRENTE: mediaUrlF, STATUS_CADASTRO: 'AGUARDANDO_DOC_VERSO' };
                  if (analiseDoc.CPF && analiseDoc.CPF !== "Não consta") dadosDoc.CPF = analiseDoc.CPF;
                  if (analiseDoc.DATA_NASCIMENTO && analiseDoc.DATA_NASCIMENTO !== "Não consta") dadosDoc.DATA_NASCIMENTO = analiseDoc.DATA_NASCIMENTO;
                  
                  atualizarEstado(phone, leadRef, dadosDoc);
                  await enviarFluxo(phone, TEXTOS.T05, "05");
              } else {
                  await enviarFluxo(phone, TEXTOS.T11, "11");
              }
          } catch (e) {
              await enviarFluxo(phone, TEXTOS.T11, "11");
          }
          break;

      case 'AGUARDANDO_DOC_VERSO':
          if (!isImage) {
              await enviarFluxo(phone, TEXTOS.T11, "11");
              return;
          }
          try {
              let mediaUrlV = obterMediaUrl(data);
              const base64Verso = await baixarArquivo(mediaUrlV);
              const analiseDoc = await analisarDocumentoIA(base64Verso); 

              if (analiseDoc.VALIDO) {
                  // CRUZAMENTO DE DADOS (ANTIFRAUDE)
                  const nomeDoc = analiseDoc.NOME_DOCUMENTO || "";
                  const nomeFatura = leadData.NOME_CLIENTE || "";

                  if (nomeDoc !== "Não consta" && !nomesCompativeis(nomeFatura, nomeDoc)) {
                      await enviarMensagem(phone, `⚠️ *Divergência Detectada*\n\nO nome no documento enviado (*${nomeDoc}*) não corresponde ao titular da fatura de energia (*${nomeFatura}*).\n\nPor favor, envie o documento de identificação correto.`);
                      return; 
                  }

                  await enviarFluxo(phone, TEXTOS.T06, "06");
                  
                  let dadosDoc = { LINK_DOC_VERSO: mediaUrlV, STATUS_CADASTRO: 'AGUARDANDO_EMAIL' };
                  if (analiseDoc.CPF && analiseDoc.CPF !== "Não consta") dadosDoc.CPF = analiseDoc.CPF;
                  if (analiseDoc.DATA_NASCIMENTO && analiseDoc.DATA_NASCIMENTO !== "Não consta") dadosDoc.DATA_NASCIMENTO = analiseDoc.DATA_NASCIMENTO;
                  
                  atualizarEstado(phone, leadRef, dadosDoc);
                  
                  setTimeout(async () => {
                      await enviarFluxo(phone, TEXTOS.T07, "07");
                  }, 4000); 
              } else {
                  await enviarFluxo(phone, TEXTOS.T11, "11");
              }
          } catch (e) {
              await enviarFluxo(phone, TEXTOS.T11, "11");
          }
          break;

      case 'AGUARDANDO_EMAIL':
          if (!textoIn) return;
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (emailRegex.test(textoIn)) {
              atualizarEstado(phone, leadRef, { EMAIL: textoIn, STATUS_CADASTRO: 'CONCLUIDO' });
              await enviarFluxo(phone, TEXTOS.T08, "08");
          } else {
              await enviarFluxo(phone, TEXTOS.T12, "12");
          }
          break;
          
      case 'CONCLUIDO':
          if (textoIn && !isImage && !isPDF) {
              await enviarMensagem(phone, "O seu pré-cadastro já está finalizado com sucesso no nosso sistema! 🎉\n\n⚡ Se deseja cadastrar uma *NOVA* conta de luz, digite a palavra *NOVO*.\n👤 Se deseja falar com um consultor, digite *ATENDENTE*.");
          } else if (isImage || isPDF) {
              await enviarMensagem(phone, "Identifiquei um novo documento! 📄\n\nSe deseja iniciar um novo cadastro para esta fatura, digite a palavra *NOVO* primeiro para eu reiniciar o sistema.");
          }
          break;
  }
});

// === FUNÇÕES DE APOIO E MATEMÁTICA ===

async function atualizarEstado(phone, leadRef, dados) {
    const atual = memoriaEstado.get(phone) || {};
    memoriaEstado.set(phone, { ...atual, ...dados });
    if (leadRef) {
        await leadRef.set(dados, { merge: true }).catch(e => console.log("Aviso: Falha ao salvar no DB."));
    }
}

function obterMediaUrl(data) {
    const url = data.link || (data.image && data.image.imageUrl) || (data.document && data.document.documentUrl) || (data.photo && data.photo.photoUrl) || "";
    if (!url || !url.startsWith('http')) throw new Error("Link não encontrado.");
    return url;
}

async function baixarArquivo(mediaUrl) {
    let tentativas = 3;
    while (tentativas > 0) {
        try {
            const res = await axios.get(mediaUrl, { 
                responseType: 'arraybuffer',
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            return Buffer.from(res.data, 'binary').toString('base64');
        } catch (err) {
            await new Promise(r => setTimeout(r, 2000));
            tentativas--;
        }
    }
    throw new Error("Falha ao baixar arquivo após 3 tentativas");
}

async function enviarFluxo(phone, texto, prefixoAudio) {
    await enviarMensagem(phone, texto);
    if (prefixoAudio) {
        console.log(`⏱️ Pausa de 2s antes do áudio...`);
        await new Promise(r => setTimeout(r, 2000));
        await enviarAudioDireto(phone, prefixoAudio);
    }
}

// MOTOR DE CRUZAMENTO DE NOMES
function nomesCompativeis(nomeFatura, nomeDoc) {
    if (!nomeFatura || !nomeDoc || nomeFatura === "Não consta" || nomeDoc === "Não consta") return false;
    
    const limpa = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z ]/g, "").split(" ").filter(w => w.length > 2);
    
    const arrayFatura = limpa(nomeFatura);
    const arrayDoc = limpa(nomeDoc);
    
    let matches = 0;
    for (let word of arrayFatura) {
        if (arrayDoc.includes(word)) matches++;
    }
    
    return matches >= 2 || (arrayFatura.length === 1 && matches === 1);
}

// 🧠 MOTOR IA DEFINITIVO COM IDENTIFICAÇÃO DE MÁSCARA (PF/PJ)
async function auditarFaturaIA(base64, mimeType) {
  if (!GEMINI_API_KEY) throw new Error("Chave Gemini ausente!");
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${GEMINI_API_KEY}`;
  
  const prompt = `
    Aja como um auditor de dados rigoroso da iGreen.
    ATENÇÃO: O documento anexo PODE SER UMA FOTO DE UMA TELA DE COMPUTADOR. Isso é 100% VÁLIDO. 
    Desde que a imagem contenha dados de energia (Equatorial, Cemig, Enel, etc.), defina "VALIDO" como true.

    🚨 REGRA DE ILEGIBILIDADE (MUITO IMPORTANTE) 🚨:
    Se a imagem estiver muito embaçada, cortada, ou se for IMPOSSÍVEL ler claramente o "Nome do Titular" ou a "Unidade Consumidora (UC)", você DEVE retornar "VALIDO": false. Não tente adivinhar dados rasurados.

    🚨 REGRA - CPF E CNPJ MASCARADOS (PARA IDENTIFICAR PF OU PJ) 🚨:
    A fatura geralmente contém o CPF ou CNPJ do titular MASCARADO (escondido com asteriscos, ex: ***.123.456-** ou **.***.***/0001-**).
    1. Procure esse dado mascarado na fatura.
    2. Se o formato for de CPF, preencha o campo "MASCARA_CPF" com o valor exato que encontrou (ex: ***.123.456-**) e defina "TIPO_PERFIL" como "PESSOA FISICA".
    3. Se o formato for de CNPJ, preencha o campo "MASCARA_CNPJ" com o valor exato e defina "TIPO_PERFIL" como "PESSOA JURIDICA".
    4. Os campos "CPF", "CNPJ" completos e "DATA_NASCIMENTO" devem continuar ESTRITAMENTE como "Não consta" (o cliente enviará o documento depois). Nunca invente números completos.

    🚨 REGRA DE HISTÓRICO DE CONSUMO 🚨:
    Extraia apenas os NÚMEROS de kWh para os meses apresentados, começando pelo mais recente (Mês 1) indo até o mais antigo.
    Se um mês estiver vazio ou não existir na imagem, preencha com 0.
    NÃO FAÇA NENHUM CÁLCULO DE MÉDIA. O nosso servidor fará isso. Retorne apenas "0" no campo "MEDIA_CONSUMO".
    
    Responda EXATAMENTE com este objeto JSON (sem formatação ou markdown em volta):
    {
      "VALIDO": true,
      "TARIFA_SOCIAL": false,
      "TIPO_PERFIL": "PESSOA FISICA",
      "NOME_CLIENTE": "Nome completo do titular",
      "MASCARA_CPF": "Não consta",
      "CPF": "Não consta",
      "MASCARA_CNPJ": "Não consta",
      "CNPJ": "Não consta",
      "DATA_NASCIMENTO": "Não consta",
      "CEP": "00000-000",
      "ENDERECO": "Rua/Avenida, Bairro",
      "ENDERECO_NUMERO": "Apenas numeros",
      "ESTADO": "Sigla do estado",
      "DISTRIBUIDORA": "Nome da concessionaria",
      "TIPO_LIGACAO": "Monofasico, Bifasico ou Trifasico",
      "UC": "Numero da UC",
      "VALOR_FATURA": 0.00,
      "MEDIA_CONSUMO": 0,
      "CONSUMO_MES_1": 0,
      "CONSUMO_MES_2": 0,
      "CONSUMO_MES_3": 0,
      "CONSUMO_MES_4": 0,
      "CONSUMO_MES_5": 0,
      "CONSUMO_MES_6": 0,
      "CONSUMO_MES_7": 0,
      "CONSUMO_MES_8": 0,
      "CONSUMO_MES_9": 0,
      "CONSUMO_MES_10": 0,
      "CONSUMO_MES_11": 0,
      "CONSUMO_MES_12": 0
    }
  `;
  
  const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }], generationConfig: { responseMimeType: "application/json" } };
  const res = await axios.post(url, payload);
  let textoLimpo = res.data.candidates[0].content.parts[0].text.replace(/```json/g, '').replace(/```/g, '').trim();
  
  console.log(`[IA] Fatura Auditada. A extrair Máscaras e Perfil (PF/PJ)...`);
  return JSON.parse(textoLimpo);
}

// 🧠 MOTOR IA PARA DOCUMENTOS E CRUZAMENTO
async function analisarDocumentoIA(base64) {
  if (!GEMINI_API_KEY) throw new Error("Chave Gemini ausente!");
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${GEMINI_API_KEY}`;
  
  const prompt = `
    A imagem anexa é uma foto de um documento de identidade brasileiro (RG ou CNH, frente ou verso)? 
    Se sim, defina "VALIDO": true.
    Sua segunda tarefa é extrair os seguintes dados, se estiverem visíveis:
    1. O NOME COMPLETO do cidadão (Atribua à variável NOME_DOCUMENTO).
    2. ESTRITAMENTE o número do CPF (retorne APENAS números, sem pontos ou traços).
    3. A Data de Nascimento (formato DD/MM/AAAA).
    Se você não conseguir enxergar algum desses dados com clareza, defina-os como "Não consta".
    Responda APENAS com este JSON (sem markdown):
    {
      "VALIDO": true,
      "NOME_DOCUMENTO": "NOME DO TITULAR",
      "CPF": "00000000000",
      "DATA_NASCIMENTO": "DD/MM/AAAA"
    }
  `;
  
  const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: "image/jpeg", data: base64 } }] }], generationConfig: { responseMimeType: "application/json" } };
  const res = await axios.post(url, payload);
  let textoLimpo = res.data.candidates[0].content.parts[0].text.replace(/```json/g, '').replace(/```/g, '').trim();
  return JSON.parse(textoLimpo);
}

// ENVIO DE TEXTO
async function enviarMensagem(phone, message) {
  const numeroLimpo = String(phone).replace(/\D/g, ''); 
  try {
      await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, { 
          phone: numeroLimpo, 
          message: String(message) 
      }, { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } });
  } catch (e) {
      console.error("[Z-API ERRO]:", e.response ? JSON.stringify(e.response.data) : e.message); 
  }
}

// RASTREADOR UNIVERSAL DE ÁUDIOS
function buscarAudioRecursivo(diretorio, prefixo) {
    let arquivos = fs.readdirSync(diretorio);
    for (let arquivo of arquivos) {
        if (arquivo === 'node_modules' || arquivo === '.git') continue; 
        
        let caminhoCompleto = path.join(diretorio, arquivo);
        let stat = fs.statSync(caminhoCompleto);
        
        if (stat.isDirectory()) {
            let encontrado = buscarAudioRecursivo(caminhoCompleto, prefixo); 
            if (encontrado) return encontrado;
        } else {
            if (arquivo.startsWith(prefixo) && arquivo.toLowerCase().endsWith('.mp3')) {
                return caminhoCompleto; 
            }
        }
    }
    return null;
}

async function enviarAudioDireto(phone, prefixo) {
    try {
        console.log(`[ÁUDIO] A vasculhar o GitHub à procura do áudio '${prefixo}'...`);
        
        const filePath = buscarAudioRecursivo(__dirname, prefixo);
        
        if (!filePath) {
            console.error(`[ERRO CRÍTICO] O áudio '${prefixo}' NÃO EXISTE em nenhuma pasta do seu GitHub! Por favor, verifique se fez o upload.`);
            return;
        }

        const base64Audio = fs.readFileSync(filePath, { encoding: 'base64' });
        const dataUri = `data:audio/mpeg;base64,${base64Audio}`;
        const numeroLimpo = String(phone).replace(/\D/g, ''); 
        
        await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-audio`, 
            { phone: numeroLimpo, audio: dataUri }, 
            { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } }
        );
        console.log(`🔊 Sucesso! Áudio encontrado em: ${filePath}`);
    } catch (e) {
        console.error(`❌ Erro ao enviar áudio ${prefixo}:`, e.message);
    }
}

app.listen(process.env.PORT || 10000, () => console.log(`🚀 SERVIDOR ON!`));
