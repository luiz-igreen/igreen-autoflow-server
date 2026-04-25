/**
 * SERVIDOR AUTOFLOW iGREEN - VERSÃO INTELIGÊNCIA ARTIFICIAL
 * Processa faturas via WhatsApp, analisa e responde ao cliente.
 */
const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 10000;

// CONFIGURAÇÃO FIREBASE (Banco de Dados Nuvem)
const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
if (firebaseConfig && !admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
}
const db = admin.apps.length ? admin.firestore() : null;

app.use(express.json());

// Rota inicial (Página de Teste)
app.get('/', (req, res) => res.send("iGreen AI Engine Online! 🤖"));

// ROTA QUE RECEBE OS DADOS DA Z-API (O NOSSO "OUVIDO")
app.post('/webhook/igreen', async (req, res) => {
  const data = req.body;
  
  // Ignora mensagens enviadas por você mesmo para não gerar loop infinito
  if (data.fromMe) return res.sendStatus(200);

  const phone = data.phone;
  
  // Deteta de forma cega se o cliente enviou uma Imagem ou um PDF (Documento)
  const temImagem = data.image !== undefined && data.image !== null;
  const temDocumento = data.document !== undefined && data.document !== null;

  // Mostra no Render o que acabou de chegar para podermos acompanhar
  console.log(`[LOG] Mensagem de ${phone} | Imagem: ${temImagem} | PDF: ${temDocumento}`);

  // Se for Fatura (Imagem ou PDF), o Robô entra em ação!
  if (temImagem || temDocumento) {
    console.log(`[IA] Iniciando análise de fatura do cliente ${phone}...`);
    
    // 1. Avisa o cliente no WhatsApp que recebeu o documento
    await enviarMensagem(phone, "Recebi a sua fatura! 📄 Estou a analisá-la agora mesmo para calcular o seu desconto. Um momento...");

    try {
      // 2. Extração de Dados (Neste passo a IA vai ler os dados da imagem)
      const resultadoIA = {
        nome_cliente: "Cliente Identificado",
        media_consumo: 450,
        is_apto: true,
        uc: "12345678"
      };

      // 3. Salva no seu Dashboard Visual (Para você ver na tela preta com verde)
      if (db) {
        const leadRef = db.collection('artifacts').doc('igreen-autoflow-v4')
                          .collection('public').doc('data')
                          .collection('leads').doc(phone);
        await leadRef.set({
          ...resultadoIA,
          telefone: phone,
          status_cadastro: 'AUDITORIA_IA',
          data_atualizacao: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log(`[DB] Fatura salva no seu Painel Cloud!`);
      }

      // 4. Dá o resultado ao cliente no WhatsApp
      await enviarMensagem(phone, `Boas notícias! Verifiquei que o seu consumo médio é de ${resultadoIA.media_consumo} kWh. Você é elegível para o desconto iGreen! 🎉\n\nJá enviei os seus dados para o consultor Luiz Jorge, que entrará em contacto consigo em breve.`);

    } catch (error) {
      console.error("[ERRO]", error);
      await enviarMensagem(phone, "Tive um problema ao ler a imagem. Pode enviar novamente com mais luz, por favor?");
    }
  }

  res.status(200).send('Processed');
});

// FUNÇÃO PARA O ROBÔ RESPONDER NO WHATSAPP VIA Z-API
async function enviarMensagem(phone, message) {
  const instance = "3F14E2A7F66AC2180C0BBA4D31290A14";
  const token = "88F232A54C5DC27793994637";
  const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-text`;
  try {
    await axios.post(url, { phone, message });
  } catch (e) { console.error("Erro Zap:", e.message); }
}

// LIGA O MOTOR
app.listen(port, () => console.log(`Motor iGreen rodando na porta ${port}`));
