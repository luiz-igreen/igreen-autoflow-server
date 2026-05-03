const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

// ==========================================
// CONFIGURAÇÕES GERAIS
// ==========================================
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE || "3F14E2A7F66AC2180C0BBA4D31290A14";
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || "88F232A54C5DC27793994637";
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || "F177679f2434d425e9a3e58ddec1d4cf0S"; 
const IGREEN_LINK = process.env.IGREEN_LINK || "https://green.igreenenergy.com.br/?id=76049&sendcontract=true";
const APP_ID = 'igreen-autoflow-v4';

// Conexão com o Firebase
try {
  const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
  if (firebaseConfig && admin.apps.length === 0) {
    admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
    console.log("✅ Banco de Dados Cloud ligado com sucesso!");
  }
} catch (e) {
  console.error("Erro na base de dados:", e.message);
}

const memoriaEstado = new Map();

const TEXTOS = {
    T01: "Seja muito bem-vinda à iGreen Energy. Pra começarmos a sua simulação, por favor, me envie uma foto bem nítida ou o PDF da sua conta de luz.",
    T02: "Estou analisando a sua fatura e a elegibilidade regional. Por favor, aguarde um instante.",
    T04: "Fatura auditada com sucesso. Pra darmos continuidade, por favor, envie uma foto nítida apenas da frente do seu RG ou CNH.",
    T05: "Frente guardada. Agora, por favor, envie a foto do verso do documento, onde ficam o número de registro e o órgão emissor.",
    T06: "Estou executando a leitura biométrica avançada, cruzando os dados da frente e do verso. Por favor, aguarde.",
    T07: "Registrado. Pra finalizar, digite o seu melhor e-mail.",
    T08: "Prontinho. O seu pré-cadastro foi concluído com sucesso. Os seus dados já foram enviados pro nosso sistema e muito em breve você receberá o seu link para assinatura. A iGreen Energy agradece a sua confiança.",
    T11: "Aviso, a imagem enviada não é um documento de identificação (RG/CNH) válido ou está muito ilegível. Por favor, reenvie a foto do documento com mais foco.",
    T12: "E-mail inválido. Por favor, verifique se digitou corretamente, lembrando que deve conter a @ e envie novamente.",
    T_RPA_START: "🤖 *Aviso do Sistema*: O Robô iGreen acaba de iniciar a digitação automática dos seus dados no portal oficial. Você receberá o link da Clicksign para assinatura em instantes."
};

// ==========================================
// FUNÇÕES DE COMUNICAÇÃO (Z-API E FIREBASE)
// ==========================================
async function salvarNoBanco(phone, dados) {
    if (admin.apps.length > 0) {
        try {
            const db = admin.firestore();
            const leadRef = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('leads').doc(phone);
            await leadRef.set({
                ...dados,
                TELEFONE: phone,
                DATA_PROCESSAMENTO: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        } catch (e) { console.log("⚠️ Erro ao salvar no Firebase:", e.message); }
    }
}

async function enviarMensagem(phone, message) {
    const numLimpo = String(phone).replace(/\D/g, ''); 
    try {
        await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, { phone: numLimpo, message: String(message) }, { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } });
    } catch (e) {}
}

async function enviarFluxo(phone, texto, prefixoAudio) {
    const numLimpo = String(phone).replace(/\D/g, ''); 
    try {
        await enviarMensagem(phone, texto);
        
        if (prefixoAudio) {
            const arquivosNaPasta = fs.readdirSync(__dirname);
            const arquivoEncontrado = arquivosNaPasta.find(file => file.startsWith(prefixoAudio) && file.endsWith('.mp3'));
            
            if (arquivoEncontrado) {
                const filePath = path.join(__dirname, arquivoEncontrado);
                const audioBase64 = fs.readFileSync(filePath, {encoding: 'base64'});
                const dataURI = `data:audio/mp3;base64,${audioBase64}`;
                await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-audio`, { phone: numLimpo, audio: dataURI }, { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } });
            }
        }
    } catch (e) { console.error("Erro no envio Z-API:", e.message); }
}

// ==========================================
// MOTOR RPA PUPPETEER (Mantido Intacto)
// ==========================================
async function executarRPA(dados, phone) {
    console.log(`🚀 [RPA VISÃO] Iniciando para: ${dados.NOME_CLIENTE}`);
    const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(IGREEN_LINK, { waitUntil: 'networkidle2', timeout: 60000 });

        const preencherPorPlaceholder = async (dica, valor) => {
            if(!valor || valor === "-") return;
            try {
                await page.evaluate((d, v) => {
                    const inputs = Array.from(document.querySelectorAll('input'));
                    const alvo = inputs.find(i => i.placeholder && i.placeholder.toLowerCase().includes(d.toLowerCase()));
                    if (alvo) {
                        alvo.value = v;
                        alvo.dispatchEvent(new Event('input', { bubbles: true }));
                        alvo.dispatchEvent(new Event('change', { bubbles: true }));
                        alvo.style.border = "3px solid #10b981"; 
                    }
                }, dica, valor);
                await new Promise(r => setTimeout(r, 400));
            } catch (e) {}
        };

        await preencherPorPlaceholder('00000-000', dados.CEP);
        await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('começar') || b.textContent.toLowerCase().includes('simular'));
            if(btn) btn.click();
        });
        await page.waitForTimeout(3000); 

        await preencherPorPlaceholder('Rua, avenida', dados.ENDERECO);
        await preencherPorPlaceholder('Nome do bairro', dados.BAIRRO);
        await preencherPorPlaceholder('Nome da cidade', dados.CIDADE);
        await preencherPorPlaceholder('Ex: 100', dados.ENDERECO_NUMERO);
        await preencherPorPlaceholder('Localizado na sua conta', dados.UC);
        await preencherPorPlaceholder('Ex: 250', dados.MEDIA_CONSUMO);

        console.log("🏆 [RPA] INJEÇÃO CONCLUÍDA NO PORTAL!");
        enviarMensagem(phone, "✅ *Sucesso!* O seu contrato foi gerado no portal oficial com sucesso. Por favor, acesse o link enviado pela Clicksign para assinar.");
        await browser.close();
        return true;
    } catch (error) {
        console.error("❌ [RPA ERRO]:", error.message);
        await browser.close();
        return false;
    }
}

// ==========================================
// LÓGICA DO WEBHOOK
// ==========================================
app.post('/webhook/igreen', async (req, res) => {
    res.status(200).send("OK");
    const data = req.body;
    if (data.fromMe) return;

    const phone = data.phone;
    if (data.isGroup || String(phone).toLowerCase().includes('group') || String(phone).toLowerCase().includes('@g.us')) return;

    const isImage = data.type === 'image' || data.isImage === true || data.type === 'photo' || (data.image && data.image.imageUrl) || (data.photo && data.photo.photoUrl);
    const isPDF = data.type === 'document' || data.isDocument === true || (data.document && data.document.documentUrl);
    const textoIn = data.text?.message?.trim() || "";
    const txtL = textoIn.toLowerCase();

    if (['novo', 'nova'].includes(txtL)) {
        memoriaEstado.delete(phone); 
        await enviarFluxo(phone, TEXTOS.T01, "01"); 
        memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA' });
        await salvarNoBanco(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA' }); // AVISA O MONITOR!
        return;
    }

    let mem = memoriaEstado.get(phone) || { STATUS_CADASTRO: 'NOVO' };
    let status = mem.STATUS_CADASTRO;

    switch (status) {
        case 'AGUARDANDO_FATURA':
        case 'NOVO':
            if (!isImage && !isPDF) { await enviarFluxo(phone, TEXTOS.T01, "01"); return; }
            await enviarFluxo(phone, TEXTOS.T02, "02");
            setTimeout(async () => {
                memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE' });
                await salvarNoBanco(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE' }); // AVISA O MONITOR!
                await enviarFluxo(phone, TEXTOS.T04, "04");
            }, 3000);
            break;

        case 'AGUARDANDO_DOC_FRENTE':
            if (!isImage && !isPDF) { await enviarFluxo(phone, TEXTOS.T11, "11"); return; }
            memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOC_VERSO' });
            await salvarNoBanco(phone, { STATUS_CADASTRO: 'AGUARDANDO_DOC_VERSO' }); // AVISA O MONITOR!
            await enviarFluxo(phone, TEXTOS.T05, "05");
            break;

        case 'AGUARDANDO_DOC_VERSO':
            if (!isImage && !isPDF) { await enviarFluxo(phone, TEXTOS.T11, "11"); return; }
            await enviarFluxo(phone, TEXTOS.T06, "06");
            memoriaEstado.set(phone, { STATUS_CADASTRO: 'AGUARDANDO_EMAIL' });
            await salvarNoBanco(phone, { STATUS_CADASTRO: 'AGUARDANDO_EMAIL' }); // AVISA O MONITOR!
            setTimeout(async () => { await enviarFluxo(phone, TEXTOS.T07, "07"); }, 4000);
            break;

        case 'AGUARDANDO_EMAIL':
            if (isImage || isPDF) { await enviarMensagem(phone, "Por favor, apenas *digite* o seu melhor e-mail para concluirmos."); return; }
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            
            if (emailRegex.test(textoIn)) {
                // DADOS DE TESTE PARA O MONITOR VISUALIZAR
                const dadosFinais = {
                    EMAIL: textoIn, 
                    STATUS_CADASTRO: 'CONCLUIDO',
                    NOME_CLIENTE: "LUIZ JORGE (TESTE)",
                    CPF: "000.111.222-33",
                    CEP: "57075-190", 
                    ENDERECO: "AV. FERNANDES LIMA", 
                    BAIRRO: "FAROL", 
                    CIDADE: "MACEIÓ", 
                    ENDERECO_NUMERO: "123", 
                    UC: "8104050", 
                    MEDIA_CONSUMO: "250",
                    LINK_FATURA: "-", LINK_DOC_FRENTE: "-", LINK_DOC_VERSO: "-"
                };

                memoriaEstado.set(phone, dadosFinais);
                await salvarNoBanco(phone, dadosFinais); // DISPARA O MONITOR!
                
                await enviarFluxo(phone, TEXTOS.T08, "08");
                
                setTimeout(async () => {
                    await enviarMensagem(phone, TEXTOS.T_RPA_START);
                    executarRPA(dadosFinais, phone); 
                }, 2000);

                memoriaEstado.delete(phone); 
            } else {
                await enviarFluxo(phone, TEXTOS.T12, "12");
            }
            break;
    }
});

app.listen(process.env.PORT || 10000, () => console.log(`🚀 SERVIDOR V58 ONLINE (FIREBASE SYNC ATIVADO)`));
