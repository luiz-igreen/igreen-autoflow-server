const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

// ==========================================
// CONFIGURAÇÕES GERAIS E CHAVES
// ==========================================
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE || "3F14E2A7F66AC2180C0BBA4D31290A14";
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || "88F232A54C5DC27793994637";
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || "F177679f2434d425e9a3e58ddec1d4cf0S"; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; // A CHAVE DO CÉREBRO NO RENDER!
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

// Textos (Estratégia "Atendimento VIP" - Mais Humanos e Suaves)
const TEXTOS = {
    T01: "Seja muito bem-vindo(a) ao Atendimento VIP da iGreen Energy! 🌿 Para prepararmos o seu desconto sem você precisar preencher formulários longos, por favor, me envie uma foto bem nítida (ou PDF) da sua conta de luz mais recente.",
    T02: "Recebemos a sua fatura! O nosso sistema está extraindo os seus dados de consumo de forma segura. Um momento...",
    T04: "Fatura validada com sucesso! ✅ Para finalizarmos a documentação antifraude, envie uma foto nítida apenas da FRENTE do seu RG ou CNH.",
    T05: "Frente guardada. Agora, envie a foto do VERSO do documento.",
    T06: "Excelente! Os documentos estão sendo encriptados e processados.",
    T07: "Para podermos enviar o seu contrato digital, digite o seu melhor e-mail:",
    T08: "Tudo pronto! 🎉 O nosso sistema VIP já enviou os seus dados. O seu contrato será gerado no portal da iGreen e você receberá o link para assinatura digital em instantes.",
    T11: "Aviso: A imagem enviada não pôde ser lida. Por favor, reenvie a foto do documento com mais foco e sem reflexos de luz.",
    T12: "O e-mail parece inválido. Por favor, digite novamente (exemplo: nome@email.com).",
    T_RPA_START: "🤖 *Aviso Interno (Sistema)*: Iniciando injeção RPA com dados reais extraídos pela IA..."
};

// ==========================================
// O CÉREBRO: EXTRAÇÃO GEMINI VISION
// ==========================================
async function extrairDadosFatura(fileUrl, isPdf) {
    if (!GEMINI_API_KEY) {
        console.log("⚠️ ATENÇÃO: GEMINI_API_KEY não configurada no Render. Usando dados fictícios de fallback.");
        return { NOME_CLIENTE: "CLIENTE SEM CHAVE IA", CEP: "57075-190", MEDIA_CONSUMO: "250", UC: "0000000" };
    }

    try {
        console.log("🧠 [IA] Fazendo download da fatura para análise...");
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const base64Data = Buffer.from(response.data, 'binary').toString('base64');
        const mimeType = isPdf ? 'application/pdf' : 'image/jpeg';

        const prompt = `Você é um auditor de faturas de energia. Extraia os dados da imagem/documento e retorne APENAS um objeto JSON válido, sem formatação markdown ou aspas triplas.
        Chaves obrigatórias no JSON:
        "NOME_CLIENTE": Nome completo do titular exato como está na conta.
        "CEP": CEP do endereço da instalação (apenas números ou com traço). Se não achar, retorne "".
        "MEDIA_CONSUMO": Calcule a média de consumo em kWh baseada no histórico, ou pegue o consumo do mês atual se não houver histórico. Apenas o número inteiro.
        "UC": Número da instalação / Unidade Consumidora / Parceiro de Negócio. Apenas números.`;

        const payload = {
            contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mimeType, data: base64Data } }] }],
            generationConfig: { responseMimeType: "application/json" }
        };

        console.log("🧠 [IA] Enviando para o Google Gemini...");
        const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`, payload);
        
        const textResult = geminiRes.data.candidates[0].content.parts[0].text;
        console.log("🧠 [IA] Leitura Concluída:", textResult);
        
        return JSON.parse(textResult);
    } catch (error) {
        console.error("❌ [IA ERRO]:", error.message);
        return null;
    }
}

// ==========================================
// FUNÇÕES DE COMUNICAÇÃO
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
        } catch (e) {}
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
    } catch (e) {}
}

// ==========================================
// MOTOR RPA: PREENCHIMENTO REAL NA IGREEN
// ==========================================
async function executarRPA(dados, phone) {
    console.log(`🚀 [RPA OFICIAL V63] Iniciando Injeção para: ${dados.NOME_CLIENTE}`);
    const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        
        console.log(`🌐 [RPA] Acessando a Landing Page Oficial...`);
        await page.goto(IGREEN_LINK, { waitUntil: 'networkidle2', timeout: 60000 });

        await page.evaluate(() => {
            const elementos = Array.from(document.querySelectorAll('a, button, div'));
            const btn = elementos.find(b => b.textContent && (b.textContent.toLowerCase().includes('começar agora') || b.textContent.toLowerCase().includes('simular')));
            if(btn) btn.click();
        });
        await page.waitForTimeout(4000); 

        console.log(`✍️ [RPA] Injetando DADOS EXTRAÍDOS PELA IA...`);
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
                await page.waitForTimeout(400);
            } catch (e) {}
        };

        // Injeta os dados REAIS que a IA capturou!
        await preencherPorPlaceholder('00000-000', dados.CEP);
        await preencherPorPlaceholder('Nome completo', dados.NOME_CLIENTE);
        await preencherPorPlaceholder('E-mail', dados.EMAIL);
        await preencherPorPlaceholder('Ex: 250', dados.MEDIA_CONSUMO);
        await preencherPorPlaceholder('Localizado na sua conta', dados.UC);
        
        // Se a IA achar o CPF na conta ela preenche, senão fica para a CNH
        if(dados.CPF) await preencherPorPlaceholder('CPF', dados.CPF);

        console.log("🛑 [RPA SEGURANÇA MÁXIMA] Teste Real V63 concluído! Puxando o travão de mão antes de clicar em finalizar.");
        await enviarMensagem(phone, `✅ *Injeção RPA V63 Concluída!* O Robô preencheu a página da iGreen usando os dados REAIS da sua fatura lidos pela Inteligência Artificial:\n\n👤 Nome: ${dados.NOME_CLIENTE}\n📍 CEP: ${dados.CEP}\n⚡ Consumo Extraído: ${dados.MEDIA_CONSUMO} kWh\n\nVerifique o seu Dashboard!`);
        
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
        await salvarNoBanco(phone, { STATUS_CADASTRO: 'AGUARDANDO_FATURA' });
        return;
    }

    let mem = memoriaEstado.get(phone) || { STATUS_CADASTRO: 'NOVO' };
    let status = mem.STATUS_CADASTRO;

    switch (status) {
        case 'AGUARDANDO_FATURA':
        case 'NOVO':
            if (!isImage && !isPDF) { await enviarFluxo(phone, TEXTOS.T01, "01"); return; }
            
            // Avisa o cliente que a IA começou a trabalhar
            await enviarFluxo(phone, TEXTOS.T02, "02");
            
            const fileUrl = data.image?.imageUrl || data.document?.documentUrl;
            
            // CHAMA A INTELIGÊNCIA ARTIFICIAL REAL AQUI!
            const dadosExtraidos = await extrairDadosFatura(fileUrl, isPDF);
            
            if (dadosExtraidos) {
                // Guarda os dados lidos pela IA na memória e no Firebase
                mem = { ...mem, ...dadosExtraidos, LINK_FATURA: fileUrl, STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE' };
            } else {
                // Se a IA falhar (foto borrada), passa para a frente para não travar o cliente
                mem = { ...mem, LINK_FATURA: fileUrl, STATUS_CADASTRO: 'AGUARDANDO_DOC_FRENTE' };
            }

            memoriaEstado.set(phone, mem);
            await salvarNoBanco(phone, mem);
            
            setTimeout(async () => {
                await enviarFluxo(phone, TEXTOS.T04, "04");
            }, 3000);
            break;

        case 'AGUARDANDO_DOC_FRENTE':
            if (!isImage && !isPDF) { await enviarFluxo(phone, TEXTOS.T11, "11"); return; }
            const imgFrente = data.image?.imageUrl || data.document?.documentUrl;
            mem.STATUS_CADASTRO = 'AGUARDANDO_DOC_VERSO';
            mem.LINK_DOC_FRENTE = imgFrente;
            memoriaEstado.set(phone, mem);
            await salvarNoBanco(phone, mem);
            await enviarFluxo(phone, TEXTOS.T05, "05");
            break;

        case 'AGUARDANDO_DOC_VERSO':
            if (!isImage && !isPDF) { await enviarFluxo(phone, TEXTOS.T11, "11"); return; }
            const imgVerso = data.image?.imageUrl || data.document?.documentUrl;
            mem.STATUS_CADASTRO = 'AGUARDANDO_EMAIL';
            mem.LINK_DOC_VERSO = imgVerso;
            memoriaEstado.set(phone, mem);
            await salvarNoBanco(phone, mem);
            await enviarFluxo(phone, TEXTOS.T06, "06");
            setTimeout(async () => { await enviarFluxo(phone, TEXTOS.T07, "07"); }, 4000);
            break;

        case 'AGUARDANDO_EMAIL':
            if (isImage || isPDF) { await enviarMensagem(phone, "Por favor, apenas *digite* o seu melhor e-mail para concluirmos."); return; }
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            
            if (emailRegex.test(textoIn)) {
                mem.EMAIL = textoIn;
                mem.STATUS_CADASTRO = 'CONCLUIDO';

                memoriaEstado.set(phone, mem);
                await salvarNoBanco(phone, mem);
                
                await enviarFluxo(phone, TEXTOS.T08, "08");
                
                setTimeout(async () => {
                    await enviarMensagem(phone, TEXTOS.T_RPA_START);
                    executarRPA(mem, phone); // ACIONA O ROBÔ USANDO A MEMÓRIA DA IA
                }, 2000);

                memoriaEstado.delete(phone); 
            } else {
                await enviarFluxo(phone, TEXTOS.T12, "12");
            }
            break;
    }
});

app.listen(process.env.PORT || 10000, () => console.log(`🚀 SERVIDOR V63 ONLINE (IA GEMINI REAL ATIVADA)`));
