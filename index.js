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
const timersInatividade = new Map();

// DICIONÁRIO DE TEXTOS COMPLETOS
const TEXTOS = {
    T01: "Seja muito bem-vinda à iGreen Energy. Pra começarmos a sua simulação, por favor, me envie uma foto bem nítida ou o PDF da sua conta de luz.",
    T02: "Estou analisando a sua fatura e a elegibilidade regional. Por favor, aguarde um instante.",
    T03: "Fatura auditada com sucesso. Identifiquei o seu CEP, mas não encontrei o número da residência. Por favor, digite o número da sua casa ou apartamento pra prosseguirmos.",
    T04: "Fatura auditada com sucesso. Pra darmos continuidade, por favor, envie uma foto nítida apenas da frente do seu RG ou CNH.",
    T05: "Frente guardada. Agora, por favor, envie a foto do verso do documento, onde ficam o número de registro e o órgão emissor.",
    T06: "Estou executando a leitura biométrica avançada, cruzando os dados da frente e do verso. Por favor, aguarde.",
    T07: "Registrado. Pra finalizar, digite o seu melhor e-mail.",
    T08: "Prontinho. O seu pré-cadastro foi concluído com sucesso. Os seus dados já foram enviados pro nosso sistema e muito em breve você receberá o seu link para assinatura. A iGreen Energy agradece a sua confiança.",
    T09: "Aviso: Esta fatura de energia ou conta de luz, não é válida. Está ilegível. Enviar uma fatura de energia ou conta de luz válida para continuarmos o nosso processamento cadastral.",
    T10: "Atenção, identificamos que a sua conta possui a classificação de baixa renda ou tarifa social. Para proteger o seu benefício governamental, a iGreen não atende esta modalidade, pois a alteração poderia causar a perda do seu subsídio. O processo foi encerrado por segurança. Agradecemos o seu contacto!",
    T11: "Aviso, a imagem enviada não é um documento de identificação (RG/CNH) válido ou está muito ilegível. Por favor, reenvie a foto do documento com mais foco.",
    T12: "E-mail inválido. Por favor, verifique se digitou corretamente, lembrando que deve conter a @ e envie novamente.",
    T13: "Atenção, você solicitou o cancelamento. Tem certeza que deseja excluir todos os dados enviados até agora? Digite um para sim, cancelar tudo, ou dois para não, e continuar o cadastro.",
    T14: "O seu contrato chegou. A sua proposta de economia já está pronta. Clique no link da mensagem pra ler os termos e assinar digitalmente de forma rápida e segura. Qualquer dúvida, estou aqui.",
    T15: "Falta muito pouco pra começar a poupar. Verificamos que ainda não assinou o seu termo de adesão da iGreen Energy. Lembre-se, não há custos de adesão, obras ou fidelidade. O link ainda está disponível na mensagem.",
    T16: "Parabéns. A sua concessionária local acabou de aprovar a injeção da nossa energia solar na sua rede. A partir do próximo ciclo, você já começará a notar a redução no valor da sua fatura.",
    T17: "A sua fatura iGreen está pronta. Este mês a sua energia mais barata já foi processada. Segue na mensagem o seu boleto unificado. Parabéns por poupar com energia limpa.",
    T18: "Você já ativou o seu iGreen Club? Como nosso cliente, você tem descontos em milhares de estabelecimentos no Brasil. Baixe o nosso aplicativo no link da mensagem e comece a aproveitar hoje mesmo.",
    T19: "Quer zerar a sua conta de luz? Na iGreen Energy você ganha cashback por cada amigo ou familiar que indicar. Acesse o seu aplicativo, pegue seu link de indicação e partilhe.",
    T20: "Entendido. Vou transferir o seu atendimento pra um de nossos consultores especialistas. Aguarde um instante, por favor.",
    T21: "Devido à falta de resposta por um longo período, o seu pré-cadastro foi cancelado por medida de segurança.\n\nQuando estiver com os seus documentos em mãos, basta enviar a palavra *NOVO* para recomeçarmos o processo. A iGreen agradece!",
    T22: "⚠️ *Divergência Detectada*\n\nO nome no documento enviado não corresponde ao titular da fatura de energia.\n\nPor medidas de segurança antifraude, o processo foi bloqueado. Por favor, envie a foto do documento de identificação do titular correto da fatura.",
    T23: "⚡ Identifiquei a sua Unidade Consumidora, mas notei que **faltam documentos** no seu cadastro.\n\nVamos fazer uma rápida atualização cadastral para garantir o seu desconto! Por favor, envie uma foto nítida apenas da frente do seu RG ou CNH.",
    T24: "⚡ Identifiquei que esta Unidade Consumidora já possui um cadastro **COMPLETO** e ativo no nosso sistema!\n\nVocê enviou esta fatura por engano? 🤔\n\nSe deseja cadastrar um **outro imóvel** em seu nome, por favor, envie a foto da fatura dessa **outra** instalação (com uma UC diferente desta).\n\nEstou no aguardo!",
    T25: "Olá! Agradecemos muito o seu interesse. 💚\n\nApós analisar a sua fatura, verificamos que a sua média de consumo está abaixo do mínimo exigido no momento para a sua região.\n\nPor isso, não poderemos prosseguir com o cadastro agora. Guardaremos o seu contacto para o avisar em futuras oportunidades!",
    T26: "✅ Os seus documentos foram atualizados com sucesso e o seu cadastro agora está **COMPLETO** no nosso sistema! 🎉\n\nA iGreen Energy agradece a sua confiança.",
    T27: "Aviso: A nossa Inteligência Artificial analisou a imagem e identificou que você enviou um objeto diferente, ao invés do documento solicitado. Por favor, envie a foto correta para continuarmos o seu cadastro.",
    T28: "⚡ Identifiquei que esta fatura já está cadastrada no nosso sistema!\n\nComo encontrei campos em branco no seu cadastro antigo, já aproveitei para os *atualizar* com as informações de Vencimento e Mês da Conta extraídas desta imagem.\n\nDeseja continuar e fazer um *NOVO* cadastro substituindo os documentos enviados anteriormente?\n\nDigite *1* para SIM (Novo Cadastro)\nDigite *2* para CANCELAR (Manter os dados atuais seguros)",
    T29: "Operação cancelada com sucesso! ✅\n\nOs seus dados atualizados foram mantidos em total segurança no nosso Banco de Dados.\n\nA iGreen Energy agradece o seu contato e a sua confiança! Tenha um excelente dia! 💚"
};

function cancelarTimeout(phone) {
    if (timersInatividade.has(phone)) {
        clearTimeout(timersInatividade.get(phone));
        timersInatividade.delete(phone);
    }
}

function configurarTimeoutInatividade(phone, ucInacabada = null) {
    cancelarTimeout(phone); 
    
    const timeoutId = setTimeout(async () => {
        console.log(`[TIMEOUT] Cancelando espera do cliente ${phone}`);
        await enviarFluxo(phone, TEXTOS.T21, "21");
        
        if (ucInacabada) {
            const db = admin.apps.length > 0 ? admin.firestore() : null;
            if (db) {
                const appId = 'igreen-autoflow-v4';
                await db.collection('artifacts').doc(appId).collection('public').doc('data').collection('leads').doc(ucInacabada).delete().catch(()=>console.log("Falha ao limpar DB"));
            }
        }
        
        memoriaEstado.delete(phone);
        timersInatividade.delete(phone);
    }, 15 * 60 * 1000); 
    
    timersInatividade.set(phone, timeoutId);
}

// WEBHOOK PRINCIPAL
app.post('/webhook/igreen', async (req, res) => {
  const data = req.body;
  res.status(200).send("OK"); 

  if (data.fromMe) return;

  const phone = data.phone;
  const isImage = data.type === 'image' || data.isImage === true || data.type === 'photo' || (data.image && data.image.imageUrl) || (data.photo && data.photo.photoUrl);
  const isPDF = data.type === 'document' || data.isDocument === true || (data.document && data.document.documentUrl);
  const textoIn = data.text?.message?.trim() || "";
  
  cancelarTimeout(phone);
  
  const db = admin.apps.length > 0 ? admin.firestore() : null;
  const appId = 'igreen-autoflow-v4';
  
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

  console.log(`\n📡 [RADAR] Cliente: ${phone} | Estado: [${status}] | Tipo Msg: ${data.type} | Texto: ${textoIn}`);

  if (textoIn.toLowerCase() === 'cancelar') {
      await enviarFluxo(phone, TEXTOS.T13, "13");
      atualizarEstado(phone, leadRef, { STATUS_CADASTRO: 'CONFIRMANDO_CANCELAMENTO', PREV_STATUS: status });
      configurarTimeoutInatividade(phone, mem?.UC);
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
      configurarTimeoutInatividade(phone, null);
      return;
  }
  
  if (status === 'CONFIRMANDO_CANCELAMENTO') {
      const txtLimpo = textoIn.replace(/\D/g, '');
      if (txtLimpo === '1') {
          if (leadRef) await leadRef.delete();
          memoriaEstado.delete(phone);
          await enviarMensagem(phone, "Cancelamento confirmado. Dados apagados. A iGreen agradece o seu contato!");
      } else if (txtLimpo === '2') {
          await enviarMensagem(phone, "Cancelamento abortado. Por favor, envie o documento solicitado anteriormente.");
          const prev = memoriaEstado.get(phone)?.PREV_STATUS || 'NOVO';
          atualizarEstado(phone, leadRef, { STATUS_CADASTRO: prev });
          configurarTimeoutInatividade(phone, mem?.UC);
      } else {
          await enviarMensagem(phone, "Opção inválida. Digite 1 para cancelar ou 2 para continuar.");
          configurarTimeoutInatividade(phone, mem?.UC);
      }
      return;
  }

  switch (status) {
      case 'NOVO':
      case 'AGUARDANDO_FATURA':
          if (!isImage && !isPDF) {
              await enviarFluxo(phone, TEXTOS.T01, "01");
              memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA', TELEFONE: phone });
              configurarTimeoutInatividade(phone, null);
              return;
          }

          await enviarFluxo(phone, TEXTOS.T02, "02");
          
          try {
              let mediaUrl = obterMediaUrl(data);
              const base64Data = await baixarArquivo(mediaUrl);
              const mimeType = isPDF ? "application/pdf" : "image/jpeg";

              const analise = await auditarFaturaIA(base64Data, mimeType);

              if (!analise.VALIDO) {
                  if (analise.OBJETO_IDENTIFICADO && analise.OBJETO_IDENTIFICADO.trim() !== "") {
                      const msgVisao = `Aviso: Identifiquei que você me enviou *${analise.OBJETO_IDENTIFICADO}* ao invés de uma conta de luz. 👀😅\n\nPor favor, envie uma fatura de energia válida para continuarmos o cadastro.`;
                      await enviarMensagem(phone, msgVisao);
                      await new Promise(r => setTimeout(r, 2000));
                      await enviarAudioDireto(phone, "27", TEXTOS.T27);
                  } else {
                      await enviarFluxo(phone, TEXTOS.T09, "09");
                  }
                  
                  memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA', TELEFONE: phone });
                  configurarTimeoutInatividade(phone, null);
                  return;
              }

              if (analise.TARIFA_SOCIAL) {
                  await enviarFluxo(phone, TEXTOS.T10, "10");
                  memoriaEstado.delete(phone); 
                  return;
              }

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

                  if (docExistente && docExistente.exists) {
                      const dadosAnteriores = docExistente.data();
                      const faltaDocs = !dadosAnteriores.LINK_DOC_FRENTE || !dadosAnteriores.CPF || dadosAnteriores.CPF === "Não consta";

                      if (faltaDocs) {
                          await enviarFluxo(phone, TEXTOS.T23, "23");
                          proximoStatus = 'AGUARDANDO_DOC_FRENTE';
                          proximoTexto = null;
                          proximoAudio = null;
                      } else if (dadosAnteriores.STATUS_CADASTRO === 'CONCLUIDO') {
                          proximoStatus = 'CONFIRMANDO_RECADASTRO';
                          proximoTexto = TEXTOS.T28;
                          proximoAudio = null; 
                      }
                  } else if (!analise.ENDERECO_NUMERO || analise.ENDERECO_NUMERO.trim() === '') {
                      proximoStatus = 'AGUARDANDO_CASA';
                      proximoTexto = TEXTOS.T03;
                      proximoAudio = "03";
                  }

                  // 🛡️ ESCUDO DE DADOS (V24): PROTEÇÃO CONTRA SOBRESCRITA INDEVIDA 🛡️
                  let payloadUpdate = {};
                  
                  if (proximoStatus === 'CONFIRMANDO_RECADASTRO') {
                      // O Robô APENAS atualiza o mês e o vencimento. Nome e CPF do banco ficam seguros!
                      payloadUpdate = {
                          STATUS_CADASTRO: proximoStatus,
                          DATA_PROCESSAMENTO: admin.apps.length > 0 ? admin.firestore.Timestamp.now() : new Date(),
                          TELEFONE: phone
                      };
                      if (analise.CONTA_MES && analise.CONTA_MES !== "Não consta") payloadUpdate.CONTA_MES = analise.CONTA_MES;
                      if (analise.VENCIMENTO && analise.VENCIMENTO !== "Não consta") payloadUpdate.VENCIMENTO = analise.VENCIMENTO;
                  } else {
                      // Se for cliente NOVO, pode injetar tudo livremente
                      payloadUpdate = {
                          ...analise,
                          STATUS_CADASTRO: proximoStatus,
                          DATA_PROCESSAMENTO: admin.apps.length > 0 ? admin.firestore.Timestamp.now() : new Date(),
                          LINK_FATURA: mediaUrl,
                          TELEFONE: phone
                      };
                  }

                  atualizarEstado(phone, leadRef, payloadUpdate);
                  
                  if (proximoTexto) {
                      await enviarFluxo(phone, proximoTexto, proximoAudio);
                      configurarTimeoutInatividade(phone, ucLimpa);
                  }

              } else {
                  await enviarFluxo(phone, TEXTOS.T25, "25");
                  memoriaEstado.delete(phone); 
              }
          } catch (e) {
              console.error("❌ ERRO FATURA:", e.message);
              await enviarFluxo(phone, TEXTOS.T09, "09");
              memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA', TELEFONE: phone });
              configurarTimeoutInatividade(phone, null);
          }
          break;

      case 'CONFIRMANDO_RECADASTRO':
          const tLimpo = textoIn.replace(/\D/g, ''); 
          
          if (tLimpo === '1' || textoIn.toLowerCase().includes('sim') || textoIn.toLowerCase().includes('novo')) {
              atualizarEstado(phone, leadRef, { STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE' });
              await enviarFluxo(phone, TEXTOS.T04, "04");
              configurarTimeoutInatividade(phone, mem.UC);
          } else if (tLimpo === '2' || textoIn.toLowerCase().includes('nao') || textoIn.toLowerCase().includes('cancelar')) {
              // Devolve ao status de CONCLUÍDO. O nome antigo está seguro devido ao escudo na V24!
              atualizarEstado(phone, leadRef, { STATUS_CADASTRO: 'CONCLUIDO' });
              await enviarMensagem(phone, TEXTOS.T29); 
              cancelarTimeout(phone);
          } else {
              await enviarMensagem(phone, "Opção inválida. Digite *1* para Novo Cadastro ou *2* para Cancelar e manter seguro.");
              configurarTimeoutInatividade(phone, mem.UC);
          }
          break;

      case 'AGUARDANDO_CASA':
          if (!textoIn) {
              configurarTimeoutInatividade(phone, mem.UC);
              return;
          }
          const numeroLimpoDaMensagem = textoIn.replace(/\D/g, ''); 
          const numeroFinalSalvo = numeroLimpoDaMensagem || "S/N"; 
          
          atualizarEstado(phone, leadRef, { ENDERECO_NUMERO: numeroFinalSalvo, STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE' });
          await enviarFluxo(phone, TEXTOS.T04, "04");
          configurarTimeoutInatividade(phone, mem.UC);
          break;

      case 'AGUARDANDO_DOC_FRENTE':
          if (!isImage) {
              await enviarFluxo(phone, TEXTOS.T11, "11");
              configurarTimeoutInatividade(phone, mem.UC);
              return;
          }
          try {
              let mediaUrlF = obterMediaUrl(data);
              const base64Frente = await baixarArquivo(mediaUrlF);
              const analiseDoc = await analisarDocumentoIA(base64Frente);

              if (analiseDoc.VALIDO) {
                  const nomeDoc = analiseDoc.NOME_DOCUMENTO || "";
                  const nomeFatura = leadData.NOME_CLIENTE || "";

                  if (nomeDoc !== "Não consta" && !nomesCompativeis(nomeFatura, nomeDoc)) {
                      await enviarFluxo(phone, TEXTOS.T22, "22");
                      configurarTimeoutInatividade(phone, mem.UC);
                      return; 
                  }

                  let dadosDoc = { LINK_DOC_FRENTE: mediaUrlF, STATUS_CADASTRO: 'AGUARDANDO_DOC_VERSO' };
                  if (analiseDoc.CPF && analiseDoc.CPF !== "Não consta") dadosDoc.CPF = analiseDoc.CPF;
                  if (analiseDoc.DATA_NASCIMENTO && analiseDoc.DATA_NASCIMENTO !== "Não consta") dadosDoc.DATA_NASCIMENTO = analiseDoc.DATA_NASCIMENTO;
                  
                  atualizarEstado(phone, leadRef, dadosDoc);
                  await enviarFluxo(phone, TEXTOS.T05, "05");
                  configurarTimeoutInatividade(phone, mem.UC);
              } else {
                  if (analiseDoc.OBJETO_IDENTIFICADO && analiseDoc.OBJETO_IDENTIFICADO.trim() !== "") {
                      const msgVisaoDoc = `Aviso: Identifiquei que você me enviou *${analiseDoc.OBJETO_IDENTIFICADO}* ao invés de um documento de identidade. 👀\n\nPor favor, reenvie a foto do seu RG ou CNH com mais foco.`;
                      await enviarMensagem(phone, msgVisaoDoc);
                      await new Promise(r => setTimeout(r, 2000));
                      await enviarAudioDireto(phone, "27", TEXTOS.T27);
                  } else {
                      await enviarFluxo(phone, TEXTOS.T11, "11");
                  }
                  configurarTimeoutInatividade(phone, mem.UC);
              }
          } catch (e) {
              await enviarFluxo(phone, TEXTOS.T11, "11");
              configurarTimeoutInatividade(phone, mem.UC);
          }
          break;

      case 'AGUARDANDO_DOC_VERSO':
          if (!isImage) {
              await enviarFluxo(phone, TEXTOS.T11, "11");
              configurarTimeoutInatividade(phone, mem.UC);
              return;
          }
          try {
              let mediaUrlV = obterMediaUrl(data);
              const base64Verso = await baixarArquivo(mediaUrlV);
              const analiseDoc = await analisarDocumentoIA(base64Verso); 

              if (analiseDoc.VALIDO) {
                  const nomeDoc = analiseDoc.NOME_DOCUMENTO || "";
                  const nomeFatura = leadData.NOME_CLIENTE || "";

                  if (nomeDoc !== "Não consta" && !nomesCompativeis(nomeFatura, nomeDoc)) {
                      await enviarFluxo(phone, TEXTOS.T22, "22");
                      configurarTimeoutInatividade(phone, mem.UC);
                      return; 
                  }

                  await enviarFluxo(phone, TEXTOS.T06, "06");
                  
                  const jaTemEmail = leadData.EMAIL && String(leadData.EMAIL).includes('@');
                  const proximoStatus = jaTemEmail ? 'CONCLUIDO' : 'AGUARDANDO_EMAIL';
                  
                  let dadosDoc = { LINK_DOC_VERSO: mediaUrlV, STATUS_CADASTRO: proximoStatus };
                  if (analiseDoc.CPF && analiseDoc.CPF !== "Não consta") dadosDoc.CPF = analiseDoc.CPF;
                  if (analiseDoc.DATA_NASCIMENTO && analiseDoc.DATA_NASCIMENTO !== "Não consta") dadosDoc.DATA_NASCIMENTO = analiseDoc.DATA_NASCIMENTO;
                  
                  atualizarEstado(phone, leadRef, dadosDoc);
                  
                  setTimeout(async () => {
                      if (jaTemEmail) {
                          await enviarFluxo(phone, TEXTOS.T26, "26");
                          cancelarTimeout(phone); 
                      } else {
                          await enviarFluxo(phone, TEXTOS.T07, "07");
                          configurarTimeoutInatividade(phone, mem.UC);
                      }
                  }, 4000); 
              } else {
                  if (analiseDoc.OBJETO_IDENTIFICADO && analiseDoc.OBJETO_IDENTIFICADO.trim() !== "") {
                      const msgVisaoDoc = `Aviso: Identifiquei que você me enviou *${analiseDoc.OBJETO_IDENTIFICADO}* ao invés do verso do documento. 👀\n\nPor favor, reenvie a foto do verso do seu RG ou CNH.`;
                      await enviarMensagem(phone, msgVisaoDoc);
                      await new Promise(r => setTimeout(r, 2000));
                      await enviarAudioDireto(phone, "27", TEXTOS.T27);
                  } else {
                      await enviarFluxo(phone, TEXTOS.T11, "11");
                  }
                  configurarTimeoutInatividade(phone, mem.UC);
              }
          } catch (e) {
              await enviarFluxo(phone, TEXTOS.T11, "11");
              configurarTimeoutInatividade(phone, mem.UC);
          }
          break;

      case 'AGUARDANDO_EMAIL':
          if (!textoIn) {
              configurarTimeoutInatividade(phone, mem.UC);
              return;
          }
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (emailRegex.test(textoIn)) {
              atualizarEstado(phone, leadRef, { EMAIL: textoIn, STATUS_CADASTRO: 'CONCLUIDO' });
              await enviarFluxo(phone, TEXTOS.T08, "08");
              cancelarTimeout(phone); 
          } else {
              await enviarFluxo(phone, TEXTOS.T12, "12");
              configurarTimeoutInatividade(phone, mem.UC);
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
        await leadRef.set(dados, { merge: true }).catch(e => console.error("Aviso: Falha ao salvar no DB.", e));
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
        await enviarAudioDireto(phone, prefixoAudio, texto);
    }
}

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

// 🧠 MOTOR IA DEFINITIVO COM IDENTIFICAÇÃO DE OBJETOS + DATAS EXTRAS
async function auditarFaturaIA(base64, mimeType) {
  if (!GEMINI_API_KEY) throw new Error("Chave Gemini ausente!");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${GEMINI_API_KEY}`;
  const prompt = `
    Aja como um auditor de dados rigoroso da iGreen.
    ATENÇÃO: O documento anexo PODE SER UMA FOTO DE UMA TELA DE COMPUTADOR. Isso é 100% VÁLIDO. 

    🚨 REGRA ANTI-LIXO VISUAL E ILEGIBILIDADE 🚨:
    Você tem a capacidade de visão computacional. Se a imagem enviada for uma selfie humana, uma foto de paisagem, de um animal, uma lata de bebida, ou QUALQUER objeto que NÃO SEJA uma fatura de luz, você DEVE retornar "VALIDO": false.
    ⭐ MUITO IMPORTANTE: Se você identificar que NÃO É UMA FATURA, descreva de forma curta e direta o que você está vendo (ex: "uma lata de bebida", "um teclado", "uma foto de pessoa") no campo "OBJETO_IDENTIFICADO". Se for uma fatura, deixe como "".

    🚨 REGRA - DADOS GERAIS E DATAS EXTRAS 🚨:
    1. Identifique o Mês de Referência da fatura (ex: 04/2026, Abril/2026, etc) e coloque no campo "CONTA_MES".
    2. Identifique a Data de Vencimento e coloque no campo "VENCIMENTO" (formato DD/MM/AAAA).
    3. Se não encontrar, preencha com "Não consta".

    🚨 REGRA - CPF E CNPJ MASCARADOS (PARA IDENTIFICAR PF OU PJ) 🚨:
    1. Procure a máscara (ex: ***.123.456-** ou **.***.***/0001-**).
    2. Formato CPF -> "MASCARA_CPF" e "TIPO_PERFIL" = "PESSOA FISICA".
    3. Formato CNPJ -> "MASCARA_CNPJ" e "TIPO_PERFIL" = "PESSOA JURIDICA".
    4. "CPF", "CNPJ" completos e "DATA_NASCIMENTO" devem continuar como "Não consta".

    🚨 REGRA DE HISTÓRICO DE CONSUMO 🚨:
    Extraia apenas os NÚMEROS de kWh para os meses. Se não existir, preencha com 0. Retorne 0 no campo "MEDIA_CONSUMO".
    
    Responda EXATAMENTE com este objeto JSON:
    {
      "VALIDO": true,
      "OBJETO_IDENTIFICADO": "",
      "TARIFA_SOCIAL": false,
      "TIPO_PERFIL": "PESSOA FISICA",
      "NOME_CLIENTE": "Nome",
      "MASCARA_CPF": "Não consta",
      "CPF": "Não consta",
      "MASCARA_CNPJ": "Não consta",
      "CNPJ": "Não consta",
      "DATA_NASCIMENTO": "Não consta",
      "EMAIL": "Não consta",
      "CEP": "00000-000",
      "ENDERECO": "Endereco",
      "ENDERECO_NUMERO": "Numero",
      "ESTADO": "UF",
      "DISTRIBUIDORA": "Nome",
      "TIPO_LIGACAO": "Monofasico",
      "UC": "Numero da UC",
      "CONTA_MES": "Não consta",
      "VENCIMENTO": "Não consta",
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
  return JSON.parse(textoLimpo);
}

async function analisarDocumentoIA(base64) {
  if (!GEMINI_API_KEY) throw new Error("Chave Gemini ausente!");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${GEMINI_API_KEY}`;
  const prompt = `
    A imagem anexa é uma foto CLARA de um documento de identidade brasileiro (RG ou CNH)? 
    🚨 REGRA ANTI-LIXO VISUAL 🚨: 
    Se a imagem for uma xícara de café, selfie, uma paisagem, ou qualquer objeto que NÃO SEJA um RG/CNH válido, defina "VALIDO": false.
    ⭐ MUITO IMPORTANTE: Se não for um documento válido, descreva de forma curta o que você está vendo (ex: "uma lata", "uma caneca", "uma parede") no campo "OBJETO_IDENTIFICADO". Se for um documento, deixe "".
    
    Responda APENAS com este JSON:
    {
      "VALIDO": true,
      "OBJETO_IDENTIFICADO": "",
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
            if (arquivo.startsWith(prefixo) && arquivo.toLowerCase().includes('.mp3')) {
                return caminhoCompleto; 
            }
        }
    }
    return null;
}

// MOTOR DE ÁUDIO COM BUSCA INTELIGENTE (KILL SWITCH DO GOOGLE)
async function enviarAudioDireto(phone, prefixo, textoDaMensagem) {
    try {
        const numeroLimpo = String(phone).replace(/\D/g, ''); 
        let dataUri = "";

        console.log(`[ÁUDIO] Procurando o arquivo MP3 com prefixo '${prefixo}' no GitHub...`);
        const filePath = buscarAudioRecursivo(__dirname, prefixo);
        
        if (filePath) {
            console.log(`🔊 [ÁUDIO] Arquivo FÍSICO encontrado! Usando voz profissional da Kore: ${filePath}`);
            const base64Audio = fs.readFileSync(filePath, { encoding: 'base64' });
            dataUri = `data:audio/mpeg;base64,${base64Audio}`;
        } else {
            console.log(`⚠️ [AVISO] O áudio '${prefixo}' não foi encontrado no seu GitHub. Por favor, faça o upload dele.`);
            return; 
        }

        if (dataUri) {
            await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-audio`, 
                { phone: numeroLimpo, audio: dataUri }, 
                { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } }
            );
        }
    } catch (e) {
        console.error(`❌ Erro ao enviar áudio ${prefixo}:`, e.message);
    }
}

app.listen(process.env.PORT || 10000, () => console.log(`🚀 SERVIDOR ON! (VERSÃO 24 - PROTEÇÃO DE DADOS)`));
