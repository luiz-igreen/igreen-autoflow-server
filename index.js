/**
 * SERVIDOR AUTOFLOW iGREEN - VERSÃO INTELIGÊNCIA ARTIFICIAL
 * Processa faturas via WhatsApp, analisa com Gemini e salva no Firestore.
 */

const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 10000;

// 1. CONFIGURAÇÃO DO BANCO DE DADOS (FIRESTORE)
const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;

if (firebaseConfig) {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig)
    });
  }
}

const db = admin.apps.length ? admin.firestore() : null;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

app.use(express.json());

// Rota de Teste (Página Inicial)
app.get('/', (req, res) => {
  res.send(`
    <div style="font-family: sans-serif; text-align: center; padding: 50px; background-color: #0f172a; color: white; min-height: 100vh;">
      <h1 style="color: #10b981;">iGreen AI Engine Online! 🤖</h1>
      <p style="color: #94a3b8;">O motor de processamento de faturas está ativo e pronto para receber dados.</p>
    </div>
  `);
});

// ROTA DO WEBHOOK (Onde o WhatsApp entrega as faturas)
app.post('/webhook/igreen', async (req, res) => {
  const data = req.body;
  if (data.fromMe) return res.sendStatus(200);

  const phone = data.phone;
  const tipoMsg = data.type; 

  console.log(`[LOG] Mensagem de ${phone} | Tipo: ${tipoMsg}`);

  // Se receber uma imagem (Fatura)
  if (tipoMsg === 'image' || tipoMsg === 'document') {
    const mediaUrl = data.image?.imageUrl || data.document?.documentUrl;
    
    console.log(`[IA] Iniciando análise de fatura...`);
    
    // Avisar o cliente
    await enviarMensagem(phone, "Recebi a sua fatura! 📄 Estou a analisá-la agora mesmo para calcular o seu desconto. Um momento...");

    try {
      // 1. Extração Inteligente (Simulado para este passo)
      const resultadoIA = {
        nome_cliente: "CLIENTE IDENTIFICADO",
        media_consumo: 450,
        is_apto: true,
        uc: "12345678"
      };

      // 2. Gravar no Dashboard Cloud (Firestore)
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
        
        console.log(`[DB] Lead salvo no Dashboard Cloud!`);
      }

      // 3. Responder ao Cliente no Zap
      await enviarMensagem(phone, `Boas notícias! Verifiquei que o seu consumo é de ${resultadoIA.media_consumo} kWh. Você é elegível para o desconto iGreen! 🎉\n\nEu já enviei os seus dados para o consultor Luiz Jorge.`);

    } catch (error) {
      console.error("[ERRO]", error);
      await enviarMensagem(phone, "Tive um problema ao ler a imagem. Pode enviar novamente com mais foco?");
    }
  }

  res.status(200).send('Processed');
});

async function enviarMensagem(phone, message) {
  const instance = "3F14E2A7F66AC2180C0BBA4D31290A14";
  const token = "88F232A54C5DC27793994637";
  const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-text`;
  try {
    await axios.post(url, { phone, message });
  } catch (e) { console.error("Erro Zap:", e.message); }
}

app.listen(port, () => {
  console.log(`Motor iGreen rodando na porta ${port}`);
});
